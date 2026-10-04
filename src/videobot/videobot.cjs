// VideoBot sidecar: a dysnomia-based voice client (same Coach bot token) that
// joins the study VC and pushes the lesson VIDEO as an H264 screen share,
// with audio. Controlled over localhost HTTP by the Coach.
"use strict";
require("dotenv").config();
const Dysnomia = require("@projectdysnomia/dysnomia");
const VideoVoiceConnection = require("./VideoVoiceConnection.cjs");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, statSync, unlinkSync } = require("node:fs");
const express = require("express");

const TOKEN = process.env.COACH_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const YTDLP = process.env.YTDLP_PATH ?? "tools/yt-dlp.exe";
const PORT = Number(process.env.VIDEOBOT_PORT ?? 8422);
const MAX_PAYLOAD = 1100; // safe RTP payload under MTU

if (!TOKEN || !GUILD_ID) { console.error("[videobot] COACH_TOKEN/GUILD_ID missing"); process.exit(1); }

const bot = new Dysnomia.Client(`Bot ${TOKEN}`, {
    intents: ["guilds", "guildVoiceStates"],
    maxShards: 1,
});
// swap in the video-capable connection class
bot.voiceConnections = new Dysnomia.VoiceConnectionManager(VideoVoiceConnection, { opusOnly: true, daveEncryption: true });

let state = { active: false, lessonId: null, conn: null, procs: [], url: null };

const log = (...a) => console.log("[videobot]", new Date().toISOString(), ...a);
const swallow = (...ss) => { for (const s of ss) { try { s.on?.("error", e => log("stream err (ignored):", e.code ?? e.message)); } catch {} } };
const killProcs = () => { for (const p of state.procs) { try { p.kill("SIGKILL"); } catch {} } state.procs = []; };

// ---------- H264 Annex-B NAL parsing ----------
class NalParser {
    constructor(onFrame) { this.buf = Buffer.alloc(0); this.frame = []; this.hasSlice = false; this.pendingMeta = []; this.onFrame = onFrame; }

    push(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        let idx;
        while ((idx = findStartCode(this.buf, 0)) !== -1) {
            const scLen = this.buf[idx + 2] === 1 ? 3 : 4;
            const next = findStartCode(this.buf, idx + scLen);
            const end = next === -1 ? this.buf.length : next;
            const nal = this.buf.subarray(idx + scLen, end);
            if (nal.length) this.handleNal(nal);
            this.buf = this.buf.subarray(end);
            if (next === -1) break;
        }
    }

    handleNal(nal) {
        const type = nal[0] & 0x1F;
        if (type === 7 || type === 8 || type === 6) { this.pendingMeta.push(nal); return; } // SPS/PPS/SEI
        if (type === 9) { // AUD: previous frame ends here
            if (this.hasSlice) this.flush();
            return;
        }
        if (type === 5 || type === 1) { // coded slice
            // x264 zerolatency emits multiple slices per frame — a new FRAME starts
            // only when a slice has first_mb_in_slice === 0 (first slice of picture)
            const firstSlice = firstMbInSlice(nal) === 0;
            if (firstSlice && this.hasSlice) this.flush();
            if (!this.hasSlice) {
                this.hasSlice = true;
                this.currentSliceNals = [...this.pendingMeta];
                this.pendingMeta = [];
            }
            this.currentSliceNals.push(nal);
            return;
        }
        if (this.hasSlice) this.currentSliceNals.push(nal);
    }

    flush() {
        if (this.hasSlice && this.currentSliceNals?.length) {
            this.onFrame(this.currentSliceNals);
        }
        this.hasSlice = false;
        this.currentSliceNals = null;
    }
}

function findStartCode(buf, from) {
    for (let i = from; i < buf.length - 3; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) return i;
    }
    return -1;
}

// first_mb_in_slice = first ue(v) field of the slice header, after the 1-byte NAL header
function firstMbInSlice(nal) {
    let bitPos = 8, zeros = 0;
    for (let i = 0; i < 32 && bitPos < nal.length * 8; i++) {
        const byte = nal[bitPos >> 3];
        const bit = (byte >> (7 - (bitPos & 7))) & 1;
        bitPos++;
        if (bit === 0) zeros++;
        else {
            if (zeros === 0) return 0; // ue(v) "1" = 0
            // leading zeros count k -> read k more bits after the 1
            let value = 0;
            for (let j = 0; j < zeros; j++) {
                const b = nal[bitPos >> 3];
                value = (value << 1) | ((b >> (7 - (bitPos & 7))) & 1);
                bitPos++;
            }
            return (1 << zeros) - 1 + value;
        }
    }
    return -1;
}

// ---------- FU-A packetization: one frame -> RTP payloads ----------
function packetizeFrame(nals) {
    const out = [];
    for (const nal of nals) {
        if (nal.length <= MAX_PAYLOAD) { out.push(Buffer.from(nal)); continue; }
        const nri = nal[0] & 0x60;
        const nalType = nal[0] & 0x1F;
        const data = nal.subarray(1);
        const chunks = Math.ceil(data.length / MAX_PAYLOAD);
        for (let i = 0; i < chunks; i++) {
            const piece = data.subarray(i * MAX_PAYLOAD, (i + 1) * MAX_PAYLOAD);
            const fu = Buffer.allocUnsafe(2 + piece.length);
            fu[0] = nri | 28; // FU-A indicator, keep NRI
            fu[1] = (i === 0 ? 0x80 : 0) | (i === chunks - 1 ? 0x40 : 0) | nalType;
            piece.copy(fu, 2);
            out.push(fu);
        }
    }
    return out; // RTP payloads; last one gets the marker bit
}

// ---------- stream resolution: direct YouTube -> ffmpeg, no downloads ----------
function runYt(args) {
    return new Promise((res, rej) => {
        const p = spawn(YTDLP, [...args, "--js-runtimes", "node"], { stdio: ["ignore", "pipe", "pipe"] });
        swallow(p.stderr);
        let out = "";
        p.stdout.on("data", d => out += d);
        p.on("close", code => code === 0 ? res(out.trim()) : rej(new Error("yt-dlp failed code " + code)));
    });
}

async function resolveStream(url) {
    // direct media URLs for the selected formats (video+audio preferred)
    const urls = (await runYt([
        "--print", "urls",
        "-f", "bv*[vcodec^=avc1][height<=720]+ba/b[height<=720][vcodec^=avc1]/b",
        url,
    ])).split("\n").map(s => s.trim()).filter(Boolean);
    const isLive = (await runYt(["--print", "%(is_live)s", url])) === "True";
    return {
        isLive,
        videoUrl: urls.length > 1 ? urls[0] : null,   // separate video stream
        audioUrl: urls.length > 1 ? urls[urls.length - 1] : null,
        combined: urls.length === 1 ? urls[0] : null,  // progressive single stream
    };
}

async function start({ url, lessonId = 0, channelId, guildId }) {
    if (state.active) await stop();
    log("starting stream for lesson", lessonId, url.slice(0, 50));

    const src = await resolveStream(url);
    log(`resolved: ${src.isLive ? "LIVE" : "vod"} · ${src.videoUrl ? "separate A/V" : "progressive"}`);

    // settle after any previous disconnect — Discord drops racy voice state updates
    await sleep(1800);
    let conn = null;
    for (let attempt = 1; attempt <= 3 && !conn; attempt++) {
        try {
            conn = await bot.joinVoiceChannel(channelId, { selfDeaf: true, selfVideo: false });
        } catch (e) {
            log(`join attempt ${attempt} failed: ${e.message}`);
            // discard the poisoned connection object entirely and clear our voice state
            const broken = bot.voiceConnections.get(guildId || GUILD_ID);
            if (broken) { try { broken.disconnect(); } catch {} }
            bot.voiceConnections.delete(guildId || GUILD_ID);
            try { bot.shards.get(0)?.sendWS(4, { guild_id: guildId || GUILD_ID, channel_id: null, self_mute: false, self_deaf: false, self_video: false }); } catch {}
            await sleep(3000);
        }
    }
    if (!conn) throw new Error("could not join voice channel after 3 attempts");
    state.conn = conn;
    log("voice ready. audioCodec=%s videoCodec=%s mediaSession=%s ssrc=%d vssrc=%d dave=%d",
        conn.audioCodec, conn.videoCodecName, conn.mediaSessionId, conn.ssrc, conn.videoSSRC, conn.daveProtocolVersion);

    // flag self_video on the main gateway so members see the stream tile
    const shard = bot.shards.get(0);
    shard.sendWS(4, { guild_id: guildId || GUILD_ID, channel_id: channelId, self_mute: false, self_deaf: true, self_video: true });

    // announce the screenshare: op12 Video publish (the real signal) + op5 legacy form
    conn.publishVideo?.();
    conn.announceScreenshare?.();

    // input pacing: realtime for VOD, low-latency passthrough for live
    const inFlags = src.isLive ? ["-fflags", "nobuffer", "-flags", "low_delay"] : ["-re"];

    // audio pipe (dysnomia play handles ogg/opus + DAVE audio)
    const aFfmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", ...inFlags,
        "-i", src.audioUrl ?? src.combined,
        ...(src.audioUrl ? [] : ["-vn"]),
        "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", "-f", "opus", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    swallow(aFfmpeg.stdin, aFfmpeg.stdout, aFfmpeg.stderr, aFfmpeg);
    conn.play(aFfmpeg.stdout, { format: "ogg" });
    state.procs.push(aFfmpeg);

    // video pipe
    const vFfmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", ...inFlags,
        "-i", src.videoUrl ?? src.combined,
        ...(src.videoUrl ? [] : ["-an"]),
        "-vf", "scale=1280:720", "-r", "30",
        "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1",
        "-preset", "veryfast", "-tune", "zerolatency",
        "-g", "30", "-keyint_min", "30", "-b:v", "2200k", "-maxrate", "2500k", "-bufsize", "1200k",
        "-pix_fmt", "yuv420p", "-an",
        "-f", "h264", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    swallow(vFfmpeg.stdin, vFfmpeg.stdout, vFfmpeg.stderr, vFfmpeg);
    vFfmpeg.stderr.on("data", d => log("[vffmpeg]", String(d).split("\n")[0].slice(0, 150)));
    state.procs.push(vFfmpeg);

    let frames = 0, packets = 0;
    const parser = new NalParser(nals => {
        const pkts = packetizeFrame(nals);
        for (let i = 0; i < pkts.length; i++) {
            conn.sendVideoPacket(pkts[i], i === pkts.length - 1);
            packets++;
        }
        conn.vTimestamp = (conn.vTimestamp + 3000) >>> 0; // 30 fps @ 90kHz
        if (++frames % 150 === 0) log(`video: ${frames} frames, ${packets} packets`);
    });
    vFfmpeg.stdout.on("data", c => parser.push(c));
    vFfmpeg.on("close", () => log("video stream ended"));

    state.active = true;
    state.lessonId = lessonId;
    setTimeout(() => { try { state.conn?.publishVideo?.(); state.conn?.announceScreenshare?.(); } catch {} }, 1500); // re-announce after DAVE settles
    log("STREAMING video+audio");
}

async function stop() {
    if (!state.active && !state.conn) return;
    log("stopping");
    killProcs();
    try { state.conn?.stopPlaying?.(); } catch {}
    try { state.conn?.disconnect(); } catch {}
    try { bot.shards.get(0)?.sendWS(4, { guild_id: GUILD_ID, channel_id: null, self_mute: false, self_deaf: false, self_video: false }); } catch {}
    state = { active: false, lessonId: null, conn: null, procs: [], url: null };
    await sleep(800); // let Discord settle the voice state
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- control API ----------
const app = express();
app.use(express.json());
app.post("/start", async (req, res) => {
    try { await start(req.body ?? {}); res.json({ ok: true }); }
    catch (e) { log("start failed:", e.message); await stop().catch(() => {}); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/stop", async (_req, res) => { await stop(); res.json({ ok: true }); });
app.get("/health", (_req, res) => res.json({ active: state.active, lessonId: state.lessonId }));

bot.on("ready", () => {
    log(`ready as ${bot.user.username}`);
    app.listen(PORT, "127.0.0.1", () => log(`control API on :${PORT}`));
});
bot.on("error", e => log("client error:", e.message));
process.on("uncaughtException", e => log("uncaught:", e?.stack ?? e));
process.on("unhandledRejection", e => log("unrejection:", e?.stack ?? e));

bot.connect();
let botReady = false;
bot.once("ready", () => { botReady = true; });
setTimeout(() => { if (!botReady) { log("gateway timeout"); process.exit(1); } }, 30000).unref();
