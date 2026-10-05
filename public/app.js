/* لوحة تحكم الأكاديمية — SPA */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { data: null, page: 'overview', memberFilter: '', tick: null };

const api = async (path, body) => {
  const r = await fetch('/api/dash/' + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'خطأ غير متوقع');
  return j;
};

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3200);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'"': '&#39;' }[c]));

const fmt = (iso, withDate = true) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
    timeZone: TZ, ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit', minute: '2-digit',
  }).format(d);
};
let TZ = 'Asia/Riyadh';

/* ---------- boot ---------- */
async function load() {
  try { state.data = await api('data'); TZ = state.data.tz || TZ; }
  catch (e) { toast('تعذر تحميل البيانات: ' + e.message, true); return; }
  $('#live-dot').className = 'dot' + (state.data.botOk ? '' : ' off');
  $('#live-label').textContent = state.data.botOk ? 'المدرب متصل' : 'المدرب غير متصل';
  render();
}

async function refresh() {
  try { state.data = await api('data'); render(); } catch {}
}

/* ---------- navigation ---------- */
const TITLES = { overview: 'نظرة عامة', lessons: 'الدروس والحصص', members: 'الأعضاء', quests: 'المهام', settings: 'الإعدادات' };
$$('.nav').forEach(a => a.onclick = () => {
  state.page = a.dataset.page;
  $$('.nav').forEach(x => x.classList.toggle('on', x === a));
  $('#page-title').textContent = TITLES[state.page];
  render();
});

function render() {
  const v = $('#view');
  $('#top-actions').innerHTML = '';
  clearInterval(state.tick);
  if (state.page === 'overview') renderOverview(v);
  if (state.page === 'lessons') renderLessons(v);
  if (state.page === 'members') renderMembers(v);
  if (state.page === 'quests') renderQuests(v);
  if (state.page === 'settings') renderSettings(v);
}

/* ---------- overview ---------- */
function renderOverview(v) {
  const d = state.data;
  const live = d.live;
  const ns = d.nextSession;

  let hero = '';
  if (live) {
    hero = `<div class="live-banner">
      <div><span class="pulse"></span><b>الحصة مباشرة الآن</b>
        <div class="stat" style="font-size:22px">${esc(live.lesson_title)}</div>
        <div class="dim">${live.attendees} في الغرفة · بدأت ${fmt(live.scheduled_at)}</div></div>
      <button class="btn stop big" onclick="act('action/finish')">⏹ إنهاء الحصة وصرف النقاط</button>
    </div>`;
  } else if (d.lessons.some(l => !l.done)) {
    hero = `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px">
      <div><h3 style="margin:0 0 6px">▶ ابدأ حصة الآن</h3>
        <select id="pick-lesson" style="width:auto;min-width:240px">
          ${d.lessons.filter(l => !l.done).map(l => `<option value="${l.id}">${l.position}. ${esc(l.title)}</option>`).join('')}
        </select></div>
      <button class="btn go big" onclick="act('action/start', {lessonId: +$('#pick-lesson').value})">▶ ابدأ الدرس الآن</button>
    </div>`;
  } else {
    hero = `<div class="card" style="margin-bottom:14px"><h3>لا توجد دروس</h3>
      <div class="empty">أضف أول درس من صفحة «الدروس والحصص» 📚</div></div>`;
  }

  let next = '';
  if (ns && !live) {
    next = `<div class="card"><h3>⏰ الحصة القادمة</h3>
      <div class="stat">${esc(ns.lesson_title)}</div>
      <div class="muted">${fmt(ns.scheduled_at)}</div>
      <div class="countdown" id="cd">—</div>
      <div style="margin-top:12px"><button class="btn ghost sm" onclick="act('action/start',{lessonId:${ns.lesson_id}})">ابدأها الآن</button></div>
    </div>`;
    state.tick = setInterval(() => {
      const ms = new Date(ns.scheduled_at) - Date.now();
      const el = $('#cd'); if (!el) return clearInterval(state.tick);
      if (ms <= 0) { el.textContent = 'حان الوقت!'; return; }
      const h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
      el.textContent = (h ? h + ' س ' : '') + m + ' د ' + s + ' ث ';
    }, 1000);
  }

  const o = d.overview;
  const lb = d.participants
    .slice().sort((a, b) => b.xp - a.xp).slice(0, 5)
    .map((p, i) => `<tr><td><span class="medal">${['🥇', '🥈', '🥉'][i] ?? '▫️'}</span></td>
      <td><b>${esc(p.name)}</b></td><td>${p.xp}</td>
      <td>${p.level.emoji} ${esc(p.level.name)}</td><td>🔥 ${p.streak}</td></tr>`).join('');

  v.innerHTML = hero + `
    <div class="grid ${next ? 'c2' : 'c4'}" style="margin-bottom:14px">
      ${next}
      <div class="card"><h3>📊 إحصائيات</h3>
        <div class="stat">${o.lessonsDone}/${o.lessonsTotal} <small>درس مكتمل</small></div>
        <div class="stat">${d.participants.length} <small>عضو مشترك</small></div>
        <div class="stat">${d.quests.filter(q => q.status === 'active').length} <small>مهمة نشطة</small></div>
        <div class="stat">${o.templateText} <small>القالب الأسبوعي</small></div>
      </div>
    </div>
    <div class="card"><h3>🏆 المتصدرون</h3>
      <table><thead><tr><th></th><th>العضو</th><th>النقاط</th><th>المستوى</th><th>السلسلة</th></tr></thead>
      <tbody>${lb || '<tr><td colspan="5" class="empty">لا نقاط بعد</td></tr>'}</tbody></table>
    </div>`;
}

/* ---------- lessons ---------- */
function renderLessons(v) {
  const d = state.data;
  $('#top-actions').innerHTML = `<button class="btn" onclick="lessonModal()">＋ درس جديد</button>`;

  const rows = d.lessons.map(l => {
    const s = l.session;
    return `<tr>
      <td style="color:var(--dim)">${l.position}</td>
      <td><b>${esc(l.title)}</b><div class="dim" dir="ltr">${l.url ? esc(l.url.length > 52 ? l.url.slice(0, 52) + '…' : l.url) : '⚠️ بدون رابط — لن يعمل البث'}</div></td>
      <td>${l.done ? '<span class="pill ok">مكتمل ✓</span>' : s ? `<span class="pill ${s.status === 'live' ? 'live' : 'idle'}">${s.status === 'live' ? 'مباشر' : fmt(s.scheduled_at)}</span>` : '<span class="pill idle">غير مجدول</span>'}</td>
      <td><div class="row-actions">
        ${!l.done && !d.live ? `<button class="btn go sm" title="ابدأ الآن" onclick="act('action/start',{lessonId:${l.id}})">▶</button>` : ''}
        <button class="btn ghost sm" title="تعديل" onclick="lessonModal(${l.id})">✏️</button>
        <button class="btn ghost sm" title="أعلى" onclick="act('lesson/move',{id:${l.id},dir:-1})">▲</button>
        <button class="btn ghost sm" title="أسفل" onclick="act('lesson/move',{id:${l.id},dir:1})">▼</button>
        <button class="btn stop sm" title="حذف" onclick="delLesson(${l.id},'${esc(l.title).replace(/'/g, '')}')">🗑</button>
      </div></td></tr>`;
  }).join('');

  const sess = d.sessions.map(s => `<tr>
    <td style="color:var(--dim)">#${s.id}</td>
    <td><b>${esc(s.lesson_title)}</b></td>
    <td><span class="pill ${s.status === 'live' ? 'live' : 'idle'}">${s.status === 'live' ? '🔴 مباشر' : s.status === 'missed_poll' ? 'إعادة جدولة' : fmt(s.scheduled_at)}</span></td>
    <td><div class="row-actions" dir="ltr">
      <input type="date" id="sd-${s.id}" value="${s.scheduled_at.slice(0, 10)}" style="width:130px;padding:6px 8px">
      <input type="time" id="st-${s.id}" value="${s.scheduled_at.slice(11, 16)}" style="width:84px;padding:6px 8px">
      <button class="btn sm" onclick="moveSess(${s.id})">نقل</button>
      <button class="btn stop sm" onclick="act('session/cancel',{id:${s.id}})">✖</button>
    </div></td></tr>`).join('');

  const tpl = d.template;
  v.innerHTML = `
    <div class="card"><h3>📚 الدروس</h3>
      <table><thead><tr><th>#</th><th>الدرس</th><th>الحالة / الموعد</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty">لا دروس — أضف أول درس بالزر بالأعلى</td></tr>'}</tbody></table>
    </div>
    <div class="card"><h3>🗓️ الحصص القادمة</h3>
      <table><thead><tr><th>الرقم</th><th>الدرس</th><th>الموعد</th><th></th></tr></thead>
      <tbody>${sess || '<tr><td colspan="4" class="empty">لا حصص مجدولة</td></tr>'}</tbody></table>
    </div>
    <div class="card"><h3>🔁 القالب الأسبوعي</h3>
      <div class="form-row">
        <div><label>الأيام (مثال: sun,wed)</label><input id="tpl-days" dir="ltr" value="${tpl ? tpl.daysText : ''}" placeholder="sun,wed"></div>
        <div style="max-width:130px"><label>الوقت</label><input id="tpl-time" dir="ltr" value="${tpl ? tpl.time : '20:00'}" placeholder="20:00"></div>
        <div style="flex:0;align-self:flex-end"><button class="btn" onclick="saveTpl()">حفظ</button></div>
        <div style="flex:0;align-self:flex-end"><button class="btn warn" onclick="act('generate',{})">⚡ جدولة تلقائية للدروس</button></div>
      </div>
      <div class="dim" style="margin-top:10px">الجدولة التلقائية توزع الدروس غير المكتملة على مواعيد القالب بالترتيب.</div>
    </div>`;
}

function lessonModal(id) {
  const l = state.data.lessons.find(x => x.id === id);
  openModal(l ? '✏️ تعديل الدرس' : '＋ درس جديد', l ? 'عدّل بيانات الدرس' : 'أضف درساً إلى المقرر', `
    <label>عنوان الدرس *</label><input id="m-title" value="${l ? esc(l.title) : ''}" placeholder="الدرس الأول — أساسيات...">
    <label>رابط يوتيوب (إلزامي للبث)</label><input id="m-url" dir="ltr" value="${l ? esc(l.url) : ''}" placeholder="https://youtube.com/watch?v=...">
    <div class="form-row"><div><label>المدة (دقائق)</label><input id="m-dur" type="number" value="${l ? l.duration_min : 60}"></div></div>
    <div class="modal-actions">
      <button class="btn" onclick="saveLesson(${id ?? 'null'})">حفظ</button>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
  setTimeout(() => $('#m-title').focus(), 50);
}
async function saveLesson(id) {
  const body = {
    id,
    title: $('#m-title').value.trim(),
    url: $('#m-url').value.trim(),
    durationMin: +$('#m-dur').value || 60,
  };
  if (!body.title) return toast('العنوان مطلوب', true);
  await act(id ? 'lesson/update' : 'lesson/add', body, true);
  closeModal();
}
async function delLesson(id, title) {
  if (!confirm(`حذف الدرس «${title}»؟`)) return;
  await act('lesson/remove', { id });
}
async function moveSess(id) {
  await act('session/move', { id, date: $('#sd-' + id).value, time: $('#st-' + id).value });
}
async function saveTpl() {
  await act('template', { days: $('#tpl-days').value, time: $('#tpl-time').value });
}

/* ---------- members ---------- */
function renderMembers(v) {
  const d = state.data;
  $('#top-actions').innerHTML = `<span class="dim">${d.participants.length} عضو</span>`;
  const q = state.memberFilter.trim().toLowerCase();
  const list = d.participants.filter(p =>
    !q || p.name.toLowerCase().includes(q) || (p.user_id + '').includes(q));
  const rows = list.map(p => `<tr style="cursor:pointer" onclick="memberModal('${p.user_id}')">
    <td><b>${esc(p.name)}</b>${p.dms_enabled ? '' : ' <span class="pill warn">كتم الإشعارات</span>'}</td>
    <td>${p.xp} XP</td>
    <td>${p.level.emoji} ${esc(p.level.name)}</td>
    <td>🔥 ${p.streak}</td>
    <td>${p.lessons_done}/${d.lessons.length}</td>
    <td class="dim">${p.last_activity ? fmt(p.last_activity) : '—'}</td>
  </tr>`).join('');

  v.innerHTML = `
    <div class="search-wrap"><input id="msearch" placeholder="ابحث بالاسم أو رقم العضو…" value="${esc(state.memberFilter)}"></div>
    <div class="card"><table>
      <thead><tr><th>العضو</th><th>النقاط</th><th>المستوى</th><th>السلسلة</th><th>الدروس</th><th>آخر نشاط</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">لا نتائج${q ? ' للبحث «' + esc(q) + '»' : ''}</td></tr>`}</tbody>
    </table></div>`;
  const inp = $('#msearch');
  inp.oninput = () => { state.memberFilter = inp.value; renderMembers(v); };
  inp.focus();
}

async function memberModal(id) {
  let m;
  try { m = await api('member/' + id); } catch (e) { return toast(e.message, true); }
  const total = state.data.lessons.length || 1;
  const pct = Math.round(m.lessons_done / total * 100);
  const events = m.timeline.slice(0, 14).map(t => `<div class="tl-item">
    <div class="ico">${t.ico}</div>
    <div><b>${esc(t.title)}</b><div class="dim">${esc(t.sub)}</div></div>
    <div class="when">${fmt(t.at)}</div>
  </div>`).join('');
  openModal(`👤 ${esc(m.name)}`, `${m.xp} نقطة · ${m.level.emoji} ${esc(m.level.name)} · سلسلة 🔥${m.streak}`, `
    <div><b>الدروس المكتملة: ${m.lessons_done} / ${state.data.lessons.length}</b>
      <div class="xpbar"><i style="width:${pct}%"></i></div></div>
    <h3 style="margin:16px 0 4px;font-size:13px;color:var(--muted)">سجل النشاط</h3>
    <div class="timeline">${events || '<div class="empty">لا نشاط بعد</div>'}</div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
    </div>`);
}

/* ---------- quests ---------- */
function renderQuests(v) {
  const d = state.data;
  $('#top-actions').innerHTML = `<button class="btn" onclick="questModal()">＋ مهمة جديدة</button>`;
  const rows = d.quests.map(q => `<tr>
    <td><b>${esc(q.title)}</b></td>
    <td class="dim">${q.lesson_ids.length} درس</td>
    <td>${fmt(q.ends_at)}</td>
    <td>${q.xp_reward} XP</td>
    <td><span class="pill ${q.status === 'active' ? 'ok' : 'idle'}">${q.status === 'active' ? 'نشطة' : 'منتهية'}</span></td>
    <td>${q.status === 'active' ? `<button class="btn warn sm" onclick="act('quest/end',{id:${q.id}})">إنهاء</button>` : ''}</td>
  </tr>`).join('');
  v.innerHTML = `<div class="card"><table>
    <thead><tr><th>المهمة</th><th>الدروس</th><th>تنتهي</th><th>المكافأة</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">لا مهام</td></tr>'}</tbody></table></div>`;
}
function questModal() {
  const opts = state.data.lessons.map(l => `<option value="${l.id}">${l.position}. ${esc(l.title)}</option>`).join('');
  openModal('＋ مهمة جديدة', 'من أكمل دروس المهمة قبل التاريخ يحصل على المكافأة', `
    <label>العنوان *</label><input id="q-title" placeholder="تحدّي الأسبوع الأول">
    <label>الدروس المطلوبة (اختر بالضغط مع Ctrl)</label>
    <select id="q-lessons" multiple size="5">${opts}</select>
    <label>تنتهي في *</label><input id="q-ends" type="date" dir="ltr">
    <div class="modal-actions">
      <button class="btn" onclick="saveQuest()">إنشاء</button>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
}
async function saveQuest() {
  const ids = [...$('#q-lessons').selectedOptions].map(o => +o.value);
  if (!$('#q-title').value.trim() || !ids.length || !$('#q-ends').value) return toast('أكمل الحقول', true);
  await act('quest/add', { title: $('#q-title').value.trim(), lessonIds: ids, ends: $('#q-ends').value }, true);
  closeModal();
}

/* ---------- settings ---------- */
const SETTING_DEFS = [
  ['tz', 'المنطقة الزمنية', 160], ['xp_attendance', 'نقاط الحضور', 90], ['xp_completion', 'نقاط إنهاء الدرس', 90],
  ['xp_quest', 'نقاط المهمة', 90], ['nudge_hour', 'ساعة التنبيه (0-23)', 110], ['nudge_cooldown_hours', 'فترة التنبيه (ساعات)', 110],
  ['recap_day', 'يوم الملخص (0=الأحد)', 120], ['recap_hour', 'ساعة الملخص', 90],
  ['reminder_minutes_before', 'التذكير قبل (دقيقة)', 110], ['missed_after_minutes', 'غياب بعد (دقيقة)', 110],
];
function renderSettings(v) {
  const s = state.data.settings;
  v.innerHTML = `
    <div class="card"><h3>⚙️ إعدادات الأكاديمية</h3>
      <div class="form-row">${SETTING_DEFS.map(([k, label, w]) => `
        <div style="max-width:${w + 60}px"><label>${label}</label>
        <input id="set-${k}" dir="ltr" value="${esc(s[k] ?? '')}"></div>`).join('')}
      </div>
      <div style="margin-top:16px"><button class="btn" onclick="saveSettings()">حفظ الإعدادات</button></div>
    </div>
    <div class="card"><h3>📡 القنوات المرتبطة</h3>
      <table><tbody>
        <tr><td>لوحة الإعلانات</td><td><code>${esc(s.channel_dashboard_name || s.channel_dashboard || '—')}</code></td></tr>
        <tr><td>غرفة الدرس الصوتية</td><td><code>${esc(s.study_vc_name || s.study_vc || '—')}</code></td></tr>
        <tr><td>دور التنبيه</td><td><code>${esc(s.ping_role || '—')}</code></td></tr>
      </tbody></table>
    </div>`;
}
async function saveSettings() {
  const body = {};
  for (const [k] of SETTING_DEFS) body[k] = $('#set-' + k).value;
  await act('settings', body);
}

/* ---------- actions & modal helpers ---------- */
async function act(path, body = {}, quiet = false) {
  try {
    const r = await api(path, body);
    if (!quiet) toast(r.message || 'تم ✓');
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}
function openModal(title, sub, html) {
  $('#modal').innerHTML = `<h2>${title}</h2><div class="sub">${sub}</div>${html}`;
  $('#modal-overlay').hidden = false;
}
function closeModal() { $('#modal-overlay').hidden = true; }
$('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

load();
setInterval(refresh, 15000);
