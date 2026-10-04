// Coach web dashboard (password) + private token API.
// Framework-free server-rendered pages; works with or without Discord.
import express from 'express';
import { createHash } from 'node:crypto';
import * as A from '../core/academy.js';
import { getSetting, setSetting, allSettings } from '../core/db.js';
import { fmtInTz, zonedToUtc } from '../core/time.js';
import { config } from '../core/config.js';
import { applyPublish, currentRevision } from './publish.js';
import { refreshDashboard, markDashboardDirty } from './dashboard.js';
import { stopStream } from './streamer.js';

const dashCookie = () => createHash('sha256').update(`academy:${config.dashPassword}`).digest('hex').slice(0, 32);

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function page(title, body, nav = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Academy</title><style>
 body{font-family:system-ui,sans-serif;background:#0f1420;color:#e6e9f0;margin:0}
 nav{background:#161c2c;padding:10px 18px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
 nav a{color:#9aa5c0;text-decoration:none;font-size:14px} nav a:hover{color:#fff}
 .brand{color:#fff;font-weight:700;margin-right:12px}
 main{max-width:980px;margin:24px auto;padding:0 16px}
 h1{font-size:22px} table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
 th,td{padding:8px 10px;border-bottom:1px solid #232b40;text-align:left}
 th{color:#9aa5c0;font-weight:600} .card{background:#161c2c;border-radius:10px;padding:16px;margin:14px 0}
 input,select,button{background:#0f1420;color:#e6e9f0;border:1px solid #2c3554;border-radius:6px;padding:7px 10px;font-size:14px}
 button{background:#5865f2;border:none;cursor:pointer} button:hover{filter:brightness(1.15)}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:end} label{font-size:12px;color:#9aa5c0;display:block;margin-bottom:4px}
 .ok{color:#3ba55c}.warn{color:#faa61a}.muted{color:#9aa5c0;font-size:13px} form{display:inline}
</style></head><body>
${nav ? `<nav><span class="brand">🎓 Academy</span><a href="/">Overview</a><a href="/schedule">Schedule</a><a href="/members">Members</a><a href="/quests">Quests</a><a href="/settings">Settings</a></nav>` : ''}
<main>${body}</main></body></html>`;
}

export function startWeb({ client = null, bus }) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));

  const auth = (req, res, next) => {
    if (req.cookies?.dash === dashCookie()) return next();
    if (req.path === '/login') return next();
    return res.redirect('/login');
  };
  // tiny cookie parser (avoid the cookie-parser dep)
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

  // ---------- auth ----------
  app.get('/login', (_req, res) => {
    res.send(page('Login', `<div class="card" style="max-width:360px;margin:80px auto"><h1>🎓 Academy</h1>
      <form method="post" action="/login"><label>Dashboard password</label>
      <input type="password" name="password" style="width:100%" autofocus><br><br>
      <button style="width:100%">Sign in</button></form></div>`, false));
  });
  app.post('/login', (req, res) => {
    if (req.body.password === config.dashPassword) {
      res.setHeader('Set-Cookie', `dash=${dashCookie()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
      return res.redirect('/');
    }
    res.status(401).send(page('Login', '<div class="card">Wrong password. <a href="/login">Try again</a></div>', false));
  });
  app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', 'dash=; Max-Age=0'); res.redirect('/login'); });

  app.use(auth);

  // ---------- pages ----------
  app.get('/', (_req, res) => {
    const o = A.overview();
    const ns = o.next_session;
    const lb = o.leaderboard.map((r, i) => `<tr><td>${['🥇','🥈','🥉'][i] ?? '▫️'}</td><td>${esc(r.name)}</td><td>${r.xp}</td><td>${r.level.emoji} ${esc(r.level.name)}</td><td>🔥 ${r.streak}</td></tr>`).join('');
    res.send(page('Overview', `
      <h1>Overview</h1>
      <div class="card"><b>Next session:</b> ${ns ? `${esc(ns.lesson_title)} — ${fmtInTz(new Date(ns.scheduled_at), config.tz)} <span class="muted">(${esc(ns.status)})</span>` : '<span class="warn">nothing scheduled</span>'}<br>
      <b>Current lesson:</b> ${o.current_lesson ? esc(o.current_lesson.title) : '—'}<br>
      <b>Progress:</b> ${o.lessons_done}/${o.lessons_total} lessons · <b>Members:</b> ${o.participants} ·
      <b>Template:</b> ${o.template ? o.template.days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join('/') + ' ' + esc(o.template.time) : '<span class="warn">not set</span>'}</div>
      <div class="card"><h1 style="font-size:16px">🏆 Leaderboard</h1><table><tr><th></th><th>Member</th><th>XP</th><th>Level</th><th>Streak</th></tr>${lb || '<tr><td colspan="5" class="muted">No XP yet</td></tr>'}</table></div>`));
  });

  app.get('/schedule', (_req, res) => {
    const lessons = A.listLessons().map(l => `<tr><td>#${l.id}</td><td>${esc(l.title)}</td><td>${l.status}</td><td>${l.duration_min}m</td>
      <td><form method="post" action="/schedule/lesson/move"><input type="hidden" name="id" value="${l.id}"><input name="position" value="${l.position}" style="width:44px" title="position"></form></td>
      <td><form method="post" action="/schedule/lesson/remove" onsubmit="return confirm('Remove lesson #${l.id}?')"><input type="hidden" name="id" value="${l.id}"><button>🗑</button></form></td></tr>`).join('');
    const sessions = A.listSessions({ future: true, limit: 50 }).map(s => `<tr><td>#${s.id}</td><td>${esc(A.getLesson(s.lesson_id)?.title ?? '?')}</td>
      <td>${fmtInTz(new Date(s.scheduled_at), config.tz)}</td><td>${esc(s.status)}</td>
      <td><form method="post" action="/schedule/session/move" class="row"><input type="hidden" name="id" value="${s.id}">
      <input name="date" placeholder="YYYY-MM-DD" style="width:110px"><input name="time" placeholder="HH:mm" style="width:70px"><button>Move</button></form>
      <form method="post" action="/schedule/session/cancel"><input type="hidden" name="id" value="${s.id}"><button>✖</button></form></td></tr>`).join('');
    const tpl = A.overview().template;
    res.send(page('Schedule', `
      <h1>Schedule</h1>
      <div class="card"><h1 style="font-size:16px">Weekly template</h1>
        <form method="post" action="/schedule/template" class="row">
          <div><label>Days (e.g. sun,wed)</label><input name="days" value="${tpl ? tpl.days.map(d => ['sun','mon','tue','wed','thu','fri','sat'][d]).join(',') : ''}"></div>
          <div><label>Time (HH:mm)</label><input name="time" value="${tpl ? esc(tpl.time) : ''}" style="width:90px"></div>
          <button>Save template</button>
        </form>
        <form method="post" action="/schedule/generate" style="margin-top:10px"><button>⚡ Generate sessions from template</button></form>
      </div>
      <div class="card"><h1 style="font-size:16px">Upcoming sessions</h1><table><tr><th>ID</th><th>Lesson</th><th>When</th><th>Status</th><th>Actions</th></tr>${sessions || '<tr><td colspan="5" class="muted">None</td></tr>'}</table></div>
      <div class="card"><h1 style="font-size:16px">Lessons</h1><table><tr><th>ID</th><th>Title</th><th>Status</th><th>Duration</th><th>Pos</th><th></th></tr>${lessons || '<tr><td colspan="6" class="muted">None</td></tr>'}</table>
        <form method="post" action="/schedule/lesson/add" class="row">
          <div><label>New lesson title</label><input name="title" required></div>
          <div><label>YouTube URL</label><input name="url" style="width:240px"></div>
          <div><label>Minutes</label><input name="duration" value="60" style="width:60px"></div>
          <button>Add lesson</button>
        </form></div>`));
  });

  app.post('/schedule/template', (req, res) => {
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const days = String(req.body.days ?? '').toLowerCase().split(',').map(d => map[d.trim()]).filter(d => d !== undefined);
    const time = String(req.body.time ?? '');
    if (days.length && /^\d{2}:\d{2}$/.test(time)) { A.setTemplate({ days, time }); markDashboardDirty(); }
    res.redirect('/schedule');
  });
  app.post('/schedule/generate', async (req, res) => {
    try { A.generateSchedule({}); markDashboardDirty(); await refreshDashboard(client, { force: true }); } catch {}
    res.redirect('/schedule');
  });
  app.post('/schedule/lesson/add', (req, res) => {
    if (req.body.title) {
      A.addLesson({ title: req.body.title, url: req.body.url ?? '', durationMin: Number(req.body.duration) || 60 });
      markDashboardDirty();
    }
    res.redirect('/schedule');
  });
  app.post('/schedule/lesson/move', (req, res) => {
    const l = A.getLesson(Number(req.body.id));
    if (l && req.body.position) {
      const ids = A.listLessons().map(x => x.id).filter(id => id !== l.id);
      ids.splice(Math.max(0, Number(req.body.position) - 1), 0, l.id);
      A.reorder(ids); markDashboardDirty();
    }
    res.redirect('/schedule');
  });
  app.post('/schedule/lesson/remove', (req, res) => {
    A.removeLesson(Number(req.body.id)); markDashboardDirty(); res.redirect('/schedule');
  });
  app.post('/schedule/session/move', async (req, res) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.date ?? '') && /^\d{2}:\d{2}$/.test(req.body.time ?? '')) {
      A.setSession(Number(req.body.id), zonedToUtc(req.body.date, req.body.time, config.tz).toISOString());
      markDashboardDirty(); await refreshDashboard(client, { force: true });
    }
    res.redirect('/schedule');
  });
  app.post('/schedule/session/cancel', (req, res) => {
    A.cancelSession(Number(req.body.id)); stopStream(); markDashboardDirty(); res.redirect('/schedule');
  });

  app.get('/members', (_req, res) => {
    const rows = A.listParticipants().map(p => {
      const xp = A.xpTotal(p.user_id), lvl = A.levelFor(xp);
      return `<tr><td>${esc(p.display_name || p.user_id)}</td><td>${xp}</td><td>${lvl.emoji} ${esc(lvl.name)}</td>
      <td>🔥 ${A.currentStreak(p.user_id)}</td><td>${A.listProgress(p.user_id).length}</td>
      <td>${p.dms_enabled ? 'DMs on' : 'opted out'}</td><td class="muted">${p.last_nudged_at ? p.last_nudged_at.slice(0, 16).replace('T', ' ') : '—'}</td></tr>`;
    }).join('');
    res.send(page('Members', `<h1>Members</h1><div class="card"><table>
      <tr><th>Member</th><th>XP</th><th>Level</th><th>Streak</th><th>Lessons done</th><th>Nudges</th><th>Last nudge</th></tr>
      ${rows || '<tr><td colspan="7" class="muted">Nobody yet — members appear when they attend or complete a lesson.</td></tr>'}</table></div>`));
  });

  app.get('/quests', (_req, res) => {
    const rows = A.listQuests({ activeOnly: false }).slice(0, 20).map(q => `<tr><td>#${q.id}</td><td>${esc(q.title)}</td>
      <td>${q.lesson_ids.join(', ')}</td><td>${q.ends_at.slice(0, 10)}</td><td>${q.xp_reward}</td><td>${q.status}</td>
      <td>${q.status === 'active' ? `<form method="post" action="/quests/end"><input type="hidden" name="id" value="${q.id}"><button>End</button></form>` : ''}</td></tr>`).join('');
    res.send(page('Quests', `<h1>Quests</h1><div class="card"><table>
      <tr><th>ID</th><th>Title</th><th>Lessons</th><th>Ends</th><th>XP</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="7" class="muted">None</td></tr>'}</table></div>
      <div class="card"><form method="post" action="/quests/create" class="row">
        <div><label>Title</label><input name="title" required></div>
        <div><label>Lesson ids (1,2)</label><input name="lessons" required></div>
        <div><label>Ends (YYYY-MM-DD)</label><input name="ends" required></div>
        <button>Create quest</button></form></div>`));
  });
  app.post('/quests/create', (req, res) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.ends ?? '')) {
      A.createQuest({
        title: req.body.title, lessonIds: String(req.body.lessons).split(',').map(s => parseInt(s, 10)).filter(Boolean),
        startsAt: new Date().toISOString(), endsAt: new Date(req.body.ends + 'T23:59:00Z').toISOString(),
      });
      markDashboardDirty();
    }
    res.redirect('/quests');
  });
  app.post('/quests/end', (req, res) => { A.endQuest(Number(req.body.id)); res.redirect('/quests'); });

  app.get('/settings', (_req, res) => {
    const s = allSettings();
    const f = (k, label, width = 90) => `<div><label>${label}</label><input name="${k}" value="${esc(s[k] ?? '')}" style="width:${width}px"></div>`;
    res.send(page('Settings', `<h1>Settings</h1><div class="card">
      <form method="post" action="/settings/save" class="row">
        ${f('tz', 'Timezone (e.g. Africa/Cairo)', 160)}
        ${f('xp_attendance', 'XP attendance')}
        ${f('xp_completion', 'XP lesson done')}
        ${f('xp_quest', 'XP quest')}
        ${f('nudge_hour', 'Nudge hour (0-23)')}
        ${f('nudge_over_dm', 'Nudge: 1=DM 0=channel')}
        ${f('nudge_cooldown_hours', 'Nudge cooldown (h)')}
        ${f('recap_day', 'Recap day (0=Sun)')}
        ${f('recap_hour', 'Recap hour')}
        ${f('reminder_minutes_before', 'Reminder (min before)')}
        ${f('missed_after_minutes', 'Missed after (min)')}
        ${f('level_roles', 'Level roles: 1=on 0=off')}
        <button>Save settings</button>
      </form></div>
      <div class="card"><b>Channels:</b> dashboard <code>${esc(s.channel_dashboard || 'not set')}</code> · study VC <code>${esc(s.study_vc || 'not set')}</code> · ping role <code>${esc(s.ping_role || 'not set')}</code><br>
      <span class="muted">Set channels with /setup in Discord.</span></div>`));
  });
  app.post('/settings/save', (req, res) => {
    const allowed = ['tz','xp_attendance','xp_completion','xp_quest','nudge_hour','nudge_over_dm','nudge_cooldown_hours','recap_day','recap_hour','reminder_minutes_before','missed_after_minutes','level_roles'];
    for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== '') setSetting(k, req.body[k]);
    markDashboardDirty();
    res.redirect('/settings');
  });

  return app.listen(config.port, '0.0.0.0', () => console.log(`[coach] dashboard+api on :${config.port}`));
}
