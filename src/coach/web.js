// Coach web dashboard (password) + private token API.
import express from 'express';
import { createHash } from 'node:crypto';
import * as A from '../core/academy.js';
import { getSetting, setSetting, allSettings } from '../core/db.js';
import { fmtInTz, zonedToUtc, humanDuration } from '../core/time.js';
import { config } from '../core/config.js';
import { applyPublish, currentRevision } from './publish.js';
import { refreshDashboard, markDashboardDirty } from './dashboard.js';
import { stopStream } from './streamer.js';
import { startSessionNow, finishSession } from './sessions.js';

const dashCookie = () => createHash('sha256').update(`academy:${config.dashPassword}`).digest('hex').slice(0, 32);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0b0e17;color:#e8eaf2;margin:0;padding-bottom:60px}
header{background:linear-gradient(135deg,#131a2e,#1a1330);padding:16px 22px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:9;border-bottom:1px solid #232b45}
header .brand{font-weight:800;font-size:17px;margin-right:14px}
header a{color:#98a2c0;text-decoration:none;padding:7px 13px;border-radius:8px;font-size:14px}
header a:hover{background:#1e2742;color:#fff} header a.on{background:#2b3560;color:#fff}
main{max-width:880px;margin:0 auto;padding:20px 16px}
.card{background:#141a2c;border:1px solid #222b47;border-radius:14px;padding:18px;margin:14px 0}
.card h2{margin:0 0 12px;font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#8b95b5}
.btn{display:inline-block;background:#4f5dff;color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{filter:brightness(1.15)} .btn:disabled{opacity:.4;cursor:default}
.btn.go{background:#22a55b}.btn.stop{background:#d83c3e}.btn.warn{background:#b87d2a}.btn.sm{padding:7px 12px;font-size:13px;border-radius:8px}
input,select{background:#0b0e17;color:#e8eaf2;border:1px solid #2c3554;border-radius:9px;padding:11px 12px;font-size:15px;width:100%}
label{font-size:12px;color:#8b95b5;display:block;margin:10px 0 5px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.row>div{flex:1;min-width:130px}
table{width:100%;border-collapse:collapse;font-size:14px} th{color:#8b95b5;text-align:left;font-weight:600;padding:8px 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
td{padding:9px 6px;border-top:1px solid #222b47;vertical-align:middle}
.pill{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600}
.live{background:#3b1d1d;color:#ff8f8f}.ok{background:#1d3b2a;color:#6ee7a0}.idle{background:#2b2f45;color:#9aa5c0}
.big{font-size:26px;font-weight:800;margin:4px 0}
.muted{color:#8b95b5;font-size:13px} .hero{background:linear-gradient(135deg,#1a2140,#241a40)}
form.inline{display:inline} .actions{display:flex;gap:6px;flex-wrap:wrap}
.flash{background:#1d3b2a;color:#6ee7a0;padding:10px 14px;border-radius:10px;margin:10px 0;font-size:14px}
@media(max-width:640px){header{padding:12px}main{padding:12px}.btn{width:100%}.row>div{min-width:100%}}`;

function page(title, body, active) {
  const nav = ['/', 'Overview', '/schedule', 'Schedule', '/members', 'Members', '/quests', 'Quests', '/settings', 'Settings'];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Academy</title><style>${CSS}</style></head><body>
<header><span class="brand">🎓 Academy</span>${nav.reduce((h, v, i) => i % 2 === 0 ? h + `<a href="${v}" class="${active === v ? 'on' : ''}">${nav[i + 1]}</a>` : h, '')}</header>
<main>${body}</main></body></html>`;
}

function flash(req) { return req.query.ok ? `<div class="flash">${esc(req.query.ok)}</div>` : ''; }

function liveSession() { return A.listSessions({ future: true }).find(s => s.status === 'live') ?? null; }

export function startWeb({ client = null, bus }) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(a => a[0]));
    next();
  });

  // ---------- token API ----------
  const apiAuth = (req, res, next) => {
    if ((req.headers['x-api-token'] ?? '') !== config.apiToken) return res.status(401).json({ error: 'bad token' });
    next();
  };
  app.get('/api/state', apiAuth, (_req, res) => {
    res.json({
      revision: currentRevision(),
      tz: config.tz,
      overview: A.overview(),
      lessons: A.listLessons(),
      sessions: A.listSessions({ future: true, limit: 200 }).map(s => ({ ...s, lesson_title: A.getLesson(s.lesson_id)?.title })),
      participants: A.listParticipants().map(p => ({
        ...p, xp: A.xpTotal(p.user_id), level: A.levelFor(A.xpTotal(p.user_id)),
        streak: A.currentStreak(p.user_id), lessons_done: A.listProgress(p.user_id).length,
      })),
      quests: A.listQuests({ activeOnly: false }),
      settings: allSettings(),
    });
  });
  app.post('/api/publish', apiAuth, (req, res) => {
    const result = applyPublish(req.body ?? {});
    if (!result.ok) return res.status(result.code).json({ error: result.error, revision: result.revision });
    markDashboardDirty();
    refreshDashboard(client, { force: true }).finally(() => {
      if (result.announce && bus) bus.postTo('channel_dashboard', { content: String(result.announce).slice(0, 1800) });
      res.json({ ok: true, revision: result.revision, applied: result.applied });
    });
  });
  app.post('/api/action', apiAuth, async (req, res) => {
    const { type, lesson_id: lessonId, session_id: sessionId } = req.body ?? {};
    try {
      if (type === 'start_now') {
        const r = await startSessionNow({ client, bus, lessonId: Number(lessonId) });
        return res.status(r.ok ? 200 : 409).json(r);
      }
      if (type === 'finish') {
        const live = liveSession();
        const id = Number(sessionId) || live?.id;
        if (!id) return res.status(409).json({ error: 'no live session' });
        const r = await finishSession({ client, bus, sessionId: id });
        return res.json({ ok: !!r, attendees: r?.attendees?.length ?? 0 });
      }
      res.status(400).json({ error: 'unknown action' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- auth ----------
  app.get('/login', (_req, res) => {
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Academy</title><style>${CSS}</style></head>
<body><main><div class="card" style="max-width:380px;margin:12vh auto"><h2 style="font-size:22px;color:#fff">🎓 Academy control</h2>
<form method="post" action="/login"><label>Password</label><input type="password" name="password" autofocus><br><br><button class="btn" style="width:100%">Sign in</button></form></div></main></body></html>`);
  });
  app.post('/login', (req, res) => {
    if (req.body.password === config.dashPassword) {
      res.setHeader('Set-Cookie', `dash=${dashCookie()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
      return res.redirect('/');
    }
    res.status(401).send(page('Login', '<div class="card">Wrong password. <a href="/login" style="color:#7c8cff">Try again</a></div>', false));
  });
  app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', 'dash=; Max-Age=0'); res.redirect('/login'); });
  app.use(auth);
  function auth(req, res, next) {
    if (req.cookies?.dash === dashCookie()) return next();
    res.redirect('/login');
  }

  // ---------- overview ----------
  app.get('/', async (req, res) => {
    const o = A.overview();
    const live = liveSession();
    const ns = o.next_session;
    const lessons = A.listLessons().filter(l => l.status !== 'done');
    const lb = o.leaderboard.slice(0, 5).map((r, i) =>
      `<tr><td>${['🥇', '🥈', '🥉'][i] ?? '▫️'}</td><td>${esc(r.name)}</td><td>${r.xp} XP</td><td>${r.level.emoji} ${esc(r.level.name)}</td><td>🔥 ${r.streak}</td></tr>`).join('');

    let hero;
    if (live) {
      const lesson = A.getLesson(live.lesson_id);
      const att = A.sessionAttendance(live.id).length;
      hero = `<div class="card hero"><h2>🔴 Class is live</h2><div class="big">${esc(lesson?.title ?? '?')}</div>
        <div class="muted">${att} in the room · started ${fmtInTz(new Date(live.scheduled_at), config.tz)}</div><br>
        <form method="post" action="/control/finish"><input type="hidden" name="session_id" value="${live.id}"><button class="btn stop">⏹ Finish class & pay XP</button></form></div>`;
    } else if (lessons.length) {
      hero = `<div class="card hero"><h2>▶ Start a class</h2>
        <form method="post" action="/control/start">
          <label>Which lesson?</label>
          <select name="lesson_id">${lessons.map(l => `<option value="${l.id}">#${l.position} — ${esc(l.title)}</option>`).join('')}</select><br><br>
          <button class="btn go">▶ Start class now</button>
          <span class="muted" style="margin-left:10px">bot joins 🔊-study-room instantly</span>
        </form></div>`;
    } else {
      hero = `<div class="card hero"><h2>📚 No lessons yet</h2><p class="muted">Add your first lesson on the Schedule page.</p><a class="btn" href="/schedule">Add lesson</a></div>`;
    }

    const next = ns && !live ? `<div class="card"><h2>⏰ Next scheduled class</h2><div class="big">${esc(ns.lesson_title)}</div>
      <div class="muted">${fmtInTz(new Date(ns.scheduled_at), config.tz)} — in <b>${humanDuration(new Date(ns.scheduled_at).getTime() - Date.now())}</b></div><br>
      <div class="actions">
        <form class="inline" method="post" action="/control/start-early"><input type="hidden" name="lesson_id" value="${ns.lesson_id}"><button class="btn sm go">Start early</button></form>
        <a class="btn sm warn" href="/schedule">Reschedule</a>
      </div></div>` : '';

    res.send(page('Overview', flash(req) + hero + next + `
      <div class="card"><h2>📊 Academy</h2>
      <table><tr><td><b>${o.lessons_done}/${o.lessons_total}</b><br><span class="muted">lessons done</span></td>
      <td><b>${o.participants}</b><br><span class="muted">students</span></td>
      <td><b>${o.active_quests.length}</b><br><span class="muted">active quests</span></td>
      <td><b>${o.template ? o.template.days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/') + ' ' + esc(o.template.time) : '—'}</b><br><span class="muted">weekly slot</span></td></tr></table></div>
      <div class="card"><h2>🏆 Leaderboard</h2><table><tr><th></th><th>Member</th><th>XP</th><th>Level</th><th>Streak</th></tr>${lb || '<tr><td colspan="5" class="muted">No XP yet</td></tr>'}</table></div>`, '/'));
  });

  app.post('/control/start', async (req, res) => {
    const r = await startSessionNow({ client, bus, lessonId: Number(req.body.lesson_id) });
    return res.redirect('/' + (r.ok ? '?ok=' + encodeURIComponent('Class started — the bot is in the room!') : '?ok=' + encodeURIComponent('⚠ ' + r.error)));
  });
  app.post('/control/start-early', async (req, res) => {
    const r = await startSessionNow({ client, bus, lessonId: Number(req.body.lesson_id) });
    return res.redirect('/' + (r.ok ? '?ok=' + encodeURIComponent('Started early!') : '?ok=' + encodeURIComponent('⚠ ' + r.error)));
  });
  app.post('/control/finish', async (req, res) => {
    const live = liveSession();
    const id = Number(req.body.session_id) || live?.id;
    if (id) { await finishSession({ client, bus, sessionId: id }); return res.redirect('/?ok=' + encodeURIComponent('Class finished — attendees paid.')); }
    res.redirect('/?ok=' + encodeURIComponent('⚠ No live class.'));
  });

  // ---------- schedule ----------
  app.get('/schedule', (req, res) => {
    const lessons = A.listLessons();
    const live = liveSession();
    const rows = lessons.map(l => {
      const s = A.sessionForLesson(l.id);
      return `<tr><td>${l.position}</td><td><b>${esc(l.title)}</b><br><span class="muted">${l.url ? esc(l.url.slice(0, 46)) : 'no link'}</span></td>
        <td>${s ? `<span class="pill ${s.status === 'live' ? 'live' : 'idle'}">${s.status}</span><br><span class="muted">${fmtInTz(new Date(s.scheduled_at), config.tz)}</span>` : '<span class="muted">unscheduled</span>'}</td>
        <td><div class="actions">
          <form class="inline" method="post" action="/schedule/lesson/up"><input type="hidden" name="id" value="${l.id}"><button class="btn sm" title="move up">▲</button></form>
          <form class="inline" method="post" action="/schedule/lesson/down"><input type="hidden" name="id" value="${l.id}"><button class="btn sm" title="move down">▼</button></form>
          ${!live && l.status !== 'done' ? `<form class="inline" method="post" action="/control/start"><input type="hidden" name="lesson_id" value="${l.id}"><button class="btn sm go">▶</button></form>` : ''}
          <form class="inline" method="post" action="/schedule/lesson/remove" onsubmit="return confirm('Remove this lesson?')"><input type="hidden" name="id" value="${l.id}"><button class="btn sm stop">🗑</button></form>
        </div></td></tr>`;
    }).join('');
    const sessions = A.listSessions({ future: true, limit: 50 }).map(s => `<tr><td>#${s.id}</td><td>${esc(A.getLesson(s.lesson_id)?.title ?? '?')}</td>
      <td><span class="pill ${s.status === 'live' ? 'live' : 'idle'}">${esc(s.status)}</span> ${fmtInTz(new Date(s.scheduled_at), config.tz)}</td>
      <td><div class="actions">
      <form class="inline row" method="post" action="/schedule/session/move" style="gap:6px"><input type="hidden" name="id" value="${s.id}">
      <input name="date" placeholder="YYYY-MM-DD" style="width:120px" value="${s.scheduled_at.slice(0, 10)}"><input name="time" placeholder="HH:mm" style="width:76px" value="${s.scheduled_at.slice(11, 16)}"><button class="btn sm">Move</button></form>
      <form class="inline" method="post" action="/schedule/session/cancel"><input type="hidden" name="id" value="${s.id}"><button class="btn sm stop">✖</button></form></div></td></tr>`).join('');
    const tpl = A.overview().template;
    res.send(page('Schedule', flash(req) + `
      <div class="card"><h2>➕ Add lesson</h2>
        <form method="post" action="/schedule/lesson/add">
          <div class="row">
            <div style="flex:2"><label>Lesson title</label><input name="title" required placeholder="Lesson 3 — Recursion basics"></div>
            <div style="flex:2"><label>YouTube URL</label><input name="url" placeholder="https://youtube.com/watch?v=..."></div>
            <div style="max-width:110px"><label>Minutes</label><input name="duration" value="60"></div>
          </div><br><button class="btn go">➕ Add to course</button>
        </form></div>
      <div class="card"><h2>📚 Course lessons</h2>
        <table><tr><th>#</th><th>Lesson</th><th>Next class</th><th>Actions</th></tr>${rows || '<tr><td colspan="4" class="muted">Nothing yet — add your first lesson above.</td></tr>'}</table></div>
      <div class="card"><h2>🗓️ Upcoming sessions</h2>
        <table><tr><th>ID</th><th>Lesson</th><th>When</th><th>Actions</th></tr>${sessions || '<tr><td colspan="4" class="muted">Nothing scheduled.</td></tr>'}</table></div>
      <div class="card"><h2>🔁 Weekly template</h2>
        <form method="post" action="/schedule/template" class="row">
          <div><label>Days (sun,wed)</label><input name="days" value="${tpl ? tpl.days.map(d => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d]).join(',') : ''}"></div>
          <div style="max-width:110px"><label>Time HH:mm</label><input name="time" value="${tpl ? esc(tpl.time) : ''}"></div>
          <div style="flex:0"><button class="btn">Save</button></div>
        </form>
        <br><form method="post" action="/schedule/generate"><button class="btn warn">⚡ Auto-fill upcoming classes from template</button></form></div>`, '/schedule'));
  });

  app.post('/schedule/template', (req, res) => {
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const days = String(req.body.days ?? '').toLowerCase().split(',').map(d => map[d.trim()]).filter(d => d !== undefined);
    const time = String(req.body.time ?? '');
    if (days.length && /^\d{2}:\d{2}$/.test(time)) { A.setTemplate({ days, time }); markDashboardDirty(); }
    res.redirect('/schedule?ok=' + encodeURIComponent('Template saved.'));
  });
  app.post('/schedule/generate', async (req, res) => {
    try {
      A.generateSchedule({});
      markDashboardDirty();
      await refreshDashboard(client, { force: true });
      res.redirect('/schedule?ok=' + encodeURIComponent('Sessions generated from template.'));
    } catch (e) { res.redirect('/schedule?ok=' + encodeURIComponent('⚠ ' + e.message)); }
  });
  app.post('/schedule/lesson/add', (req, res) => {
    if (req.body.title) {
      A.addLesson({ title: req.body.title, url: req.body.url ?? '', durationMin: Number(req.body.duration) || 60 });
      markDashboardDirty();
    }
    res.redirect('/schedule?ok=' + encodeURIComponent('Lesson added.'));
  });
  app.post('/schedule/lesson/up', (req, res) => { shiftLesson(Number(req.body.id), -1); res.redirect('/schedule'); });
  app.post('/schedule/lesson/down', (req, res) => { shiftLesson(Number(req.body.id), 1); res.redirect('/schedule'); });
  app.post('/schedule/lesson/remove', (req, res) => {
    A.removeLesson(Number(req.body.id)); markDashboardDirty();
    res.redirect('/schedule?ok=' + encodeURIComponent('Lesson removed.'));
  });
  app.post('/schedule/session/move', async (req, res) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.date ?? '') && /^\d{2}:\d{2}$/.test(req.body.time ?? '')) {
      A.setSession(Number(req.body.id), zonedToUtc(req.body.date, req.body.time, config.tz).toISOString());
      markDashboardDirty(); await refreshDashboard(client, { force: true });
    }
    res.redirect('/schedule');
  });
  app.post('/schedule/session/cancel', (req, res) => {
    A.cancelSession(Number(req.body.id)); stopStream(); markDashboardDirty();
    res.redirect('/schedule?ok=' + encodeURIComponent('Session cancelled.'));
  });

  function shiftLesson(id, dir) {
    const ids = A.listLessons().map(x => x.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i >= 0 && j >= 0 && j < ids.length) { [ids[i], ids[j]] = [ids[j], ids[i]]; A.reorder(ids); markDashboardDirty(); }
  }

  // ---------- members ----------
  app.get('/members', (_req, res) => {
    const rows = A.listParticipants().map(p => {
      const xp = A.xpTotal(p.user_id), lvl = A.levelFor(xp);
      return `<tr><td><b>${esc(p.display_name || p.user_id)}</b></td><td>${xp}</td><td>${lvl.emoji} ${esc(lvl.name)}</td>
      <td>🔥 ${A.currentStreak(p.user_id)}</td><td>${A.listProgress(p.user_id).length}</td>
      <td>${p.dms_enabled ? '<span class="pill ok">DMs on</span>' : '<span class="pill idle">opted out</span>'}</td></tr>`;
    }).join('');
    res.send(page('Members', `<h1>Members</h1><div class="card"><table>
      <tr><th>Member</th><th>XP</th><th>Level</th><th>Streak</th><th>Lessons</th><th>Nudges</th></tr>
      ${rows || '<tr><td colspan="6" class="muted">Nobody yet — students appear when they attend or complete a lesson.</td></tr>'}</table></div>`, '/members'));
  });

  // ---------- quests ----------
  app.get('/quests', (_req, res) => {
    const rows = A.listQuests({ activeOnly: false }).slice(0, 20).map(q => `<tr><td>#${q.id}</td><td><b>${esc(q.title)}</b></td>
      <td>${q.lesson_ids.join(', ')}</td><td>${q.ends_at.slice(0, 10)}</td><td>${q.xp_reward}</td><td><span class="pill ${q.status === 'active' ? 'ok' : 'idle'}">${q.status}</span></td>
      <td>${q.status === 'active' ? `<form class="inline" method="post" action="/quests/end"><input type="hidden" name="id" value="${q.id}"><button class="btn sm warn">End</button></form>` : ''}</td></tr>`).join('');
    res.send(page('Quests', `<h1>Quests</h1><div class="card"><table>
      <tr><th>ID</th><th>Title</th><th>Lessons</th><th>Ends</th><th>XP</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="7" class="muted">No quests yet.</td></tr>'}</table></div>
      <div class="card"><h2>➕ New quest</h2>
      <form method="post" action="/quests/create"><div class="row">
        <div><label>Title</label><input name="title" required placeholder="Week 1 challenge"></div>
        <div><label>Lesson ids (1,2)</label><input name="lessons" required></div>
        <div><label>Ends (YYYY-MM-DD)</label><input name="ends" required></div>
      </div><br><button class="btn go">Create quest</button></form></div>`, '/quests'));
  });
  app.post('/quests/create', (req, res) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.ends ?? '')) {
      A.createQuest({
        title: req.body.title, lessonIds: String(req.body.lessons).split(',').map(s => parseInt(s, 10)).filter(Boolean),
        startsAt: new Date().toISOString(), endsAt: new Date(req.body.ends + 'T23:59:00Z').toISOString(),
      });
      markDashboardDirty();
    }
    res.redirect('/quests?ok=' + encodeURIComponent('Quest created.'));
  });
  app.post('/quests/end', (req, res) => { A.endQuest(Number(req.body.id)); res.redirect('/quests'); });

  // ---------- settings ----------
  app.get('/settings', (_req, res) => {
    const s = allSettings();
    const f = (k, label, width = 100) => `<div><label>${label}</label><input name="${k}" value="${esc(s[k] ?? '')}" style="width:${width}px"></div>`;
    res.send(page('Settings', `<h1>Settings</h1><div class="card">
      <form method="post" action="/settings/save" class="row">
        ${f('tz', 'Timezone (e.g. Asia/Riyadh)', 150)}
        ${f('xp_attendance', 'XP / attendance')}
        ${f('xp_completion', 'XP / lesson done')}
        ${f('xp_quest', 'XP / quest')}
        ${f('nudge_hour', 'Nudge hour (0-23)')}
        ${f('nudge_cooldown_hours', 'Nudge cooldown (h)')}
        ${f('recap_day', 'Recap day (0=Sun)')}
        ${f('recap_hour', 'Recap hour')}
        ${f('reminder_minutes_before', 'Reminder (min before)')}
        ${f('missed_after_minutes', 'Missed after (min)')}
        <div style="flex:0"><button class="btn">Save settings</button></div>
      </form></div>
      <div class="card"><b>Wired channels:</b> dashboard <code>${esc(s.channel_dashboard || 'not set')}</code> · study VC <code>${esc(s.study_vc || 'not set')}</code> · ping role <code>${esc(s.ping_role || 'not set')}</code></div>`, '/settings'));
  });
  app.post('/settings/save', (req, res) => {
    const allowed = ['tz', 'xp_attendance', 'xp_completion', 'xp_quest', 'nudge_hour', 'nudge_cooldown_hours', 'recap_day', 'recap_hour', 'reminder_minutes_before', 'missed_after_minutes', 'level_roles', 'nudge_over_dm'];
    for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== '') setSetting(k, req.body[k]);
    markDashboardDirty();
    res.redirect('/settings?ok=' + encodeURIComponent('Saved.'));
  });

  return app.listen(config.port, '0.0.0.0', () => console.log(`[coach] dashboard+api on :${config.port}`));
}
