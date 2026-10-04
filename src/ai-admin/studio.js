// Local studio UI: chat with the AI over the draft, inspect it, publish.
import express from 'express';
import { config } from '../core/config.js';

export function startStudio({ planner, ollama }) {
  const app = express();
  app.use(express.json());

  app.get('/', async (_req, res) => {
    const healthy = await ollama.healthy();
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Admin Studio</title><style>
 body{font-family:system-ui,sans-serif;background:#12101a;color:#e8e6f0;margin:0;display:flex;height:100vh}
 #side{width:300px;background:#1a1726;padding:14px;overflow:auto;border-right:1px solid #2a2440}
 #main{flex:1;display:flex;flex-direction:column}
 #chat{flex:1;overflow:auto;padding:18px;max-width:820px}
 .msg{margin:10px 0;padding:10px 14px;border-radius:10px;white-space:pre-wrap}
 .you{background:#2b2a45;margin-left:60px} .ai{background:#20283a;margin-right:60px}
 #bar{padding:12px;background:#1a1726;display:flex;gap:10px}
 textarea{flex:1;background:#12101a;color:#e8e6f0;border:1px solid #3a3358;border-radius:8px;padding:10px;font-family:inherit;resize:vertical;min-height:60px}
 button{background:#7c5cff;color:#fff;border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:15px}
 button.sec{background:#3a3358}
 .pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;margin:2px}
 .on{background:#1d3b2a;color:#6ee7a0}.off{background:#3b1d1d;color:#ff8f8f}
 h3{color:#9a8fd0;font-size:14px;text-transform:uppercase;letter-spacing:.08em}
 .li{font-size:13px;padding:6px 8px;border-radius:6px;margin:3px 0;background:#221e33}
 .dirty{background:#3b2f1d;color:#ffc46e}.clean{background:#1d3b2a;color:#6ee7a0}
</style></head><body>
<div id="side">
  <h3>AI Admin Studio</h3>
  <div>Ollama: <span class="pill ${healthy ? 'on' : 'off'}">${healthy ? 'running (' + ollama.model + ')' : 'NOT RUNNING'}</span></div>
  <div>Draft: <span class="pill clean" id="rev"></span> <span id="dirty"></span></div>
  <div class="muted" style="font-size:12px;color:#7a7398">pulled <span id="pulled">—</span></div>
  <h3 style="margin-top:14px">Draft plan</h3><div id="plan"></div>
  <h3 style="margin-top:14px">Actions</h3>
  <button class="sec" onclick="repull()">↺ Re-pull from Coach</button>
  <button style="width:100%;margin-top:8px;background:#3ba55c" onclick="publish()">🚀 Publish to Coach</button>
  <div style="margin-top:8px"><label style="font-size:12px;color:#7a7398">Announcement (optional)</label>
  <input id="announce" style="width:100%;background:#12101a;color:#e8e6f0;border:1px solid #3a3358;border-radius:6px;padding:8px" placeholder="Posted in Discord after publish"></div>
  <div id="pubout" style="font-size:13px;margin-top:8px"></div>
</div>
<div id="main"><div id="chat"><div class="msg ai">Plan the academy with me — e.g. "restructure the course into 3 lessons per week, sunset+wednesday 8pm, and add a quest for the first two lessons." Nothing goes live until you Publish.</div></div>
<div id="bar"><textarea id="t" placeholder="Talk to your planning coach…"></textarea><button onclick="send()">Send</button></div></div>
<script>
const $=s=>document.querySelector(s);
async function refresh(){
 const d=await (await fetch('/draft')).json();
 $('#rev').textContent='rev '+(d.revision??'—');
 $('#dirty').innerHTML=(d.dirtyCount?'<span class="pill dirty">● unsaved changes</span>':'<span class="pill clean">in sync with Coach</span>');
 $('#pulled').textContent=(d.pulledAt??'').replace('T',' ').slice(0,16);
 $('#plan').innerHTML=(d.lessons||[]).map(l=>'<div class="li">#'+l.id+' '+l.position+'. '+esc(l.title)+'</div>').join('')
  +'<div class="li">'+(d.sessions||[]).length+' upcoming session(s)</div>';
}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function send(){const t=$('#t').value.trim();if(!t)return;$('#t').value='';
 const c=$('#chat');c.insertAdjacentHTML('beforeend','<div class="msg you">'+esc(t)+'</div><div class="msg ai" id="w">…thinking…</div>');c.scrollTop=c.scrollHeight;
 const r=await (await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})})).json();
 $('#w').textContent=r.reply||r.error;c.scrollTop=c.scrollHeight;refresh();}
async function repull(){await fetch('/repull',{method:'POST'});refresh();}
async function publish(){
 const r=await (await fetch('/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({announce:$('#announce').value})})).json();
 $('#pubout').innerHTML='<span class="'+(r.ok?'on':'off')+' pill">'+(r.ok?('Published! rev '+r.revision):esc(r.message))+'</span>';refresh();}
refresh();setInterval(refresh,10000);
</script></body></html>`);
  });

  app.get('/draft', (_req, res) => {
    const d = planner.draft;
    const dirtyCount = (d.dirty.template ? 1 : 0) + (d.dirty.regenerate ? 1 : 0) + d.dirty.quests.length + d._deletes.length;
    res.json({
      revision: d.revision, pulledAt: d.pulledAt, lessons: d.lessons, sessions: d.sessions,
      quests: d.quests, template: d.template, dirtyCount,
    });
  });

  app.post('/chat', async (req, res) => {
    try { res.json({ reply: await planner.chat(String(req.body.text ?? '').slice(0, 4000)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/repull', async (_req, res) => {
    try { await planner.pull(); res.json({ ok: true }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/publish', async (req, res) => {
    try { res.json(await planner.publish(req.body.announce ? String(req.body.announce).slice(0, 1800) : undefined)); }
    catch (e) { res.status(502).json({ ok: false, message: e.message }); }
  });

  return app.listen(config.studio.port, '127.0.0.1', () =>
    console.log(`[studio] AI Admin studio on http://localhost:${config.studio.port}`));
}
