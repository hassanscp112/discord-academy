/* لوحة الأكاديمية — SPA · ink & amber */
const $ = s => document.querySelector(s);
const state = { data: null, page: 'overview', memberFilter: '', editing: null, cd: null, poll: null };

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

const TITLES = { overview: 'نظرة عامة', lessons: 'الدروس والجدول', members: 'الأعضاء', quests: 'المهام', settings: 'الإعدادات' };
let TZ = 'Asia/Riyadh';

const api = async (path, body) => {
  const r = await fetch('/api/dash/' + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (r.status === 401) { location.href = '/login'; throw new Error('انتهت الجلسة'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'خطأ غير متوقع');
  return j;
};

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3000);
}

const fmt = (iso, withDate = true) => {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
    timeZone: TZ,
    ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
};

const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------- router ---------- */
function route() {
  const h = (location.hash || '#/overview').replace('#/', '');
  state.page = TITLES[h] ? h : 'overview';
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === state.page));
  $('#page-title').textContent = TITLES[state.page];
  render();
}
const $$ = s => [...document.querySelectorAll(s)];
window.addEventListener('hashchange', route);

/* ---------- data ---------- */
async function refresh(soft = true) {
  if (!soft) $('#view').innerHTML = skeletonFor(state.page);
  try {
    state.data = await api('data');
    TZ = state.data.tz || TZ;
    $('#bot-dot').className = 'dot' + (state.data.botOk ? '' : ' off');
    $('#bot-label').textContent = state.data.botOk ? 'المدرب متصل' : 'المدرب غير متصل';
    if (soft && state.memberFilter !== undefined && state.page === 'members') {
      // keep search focus across soft refresh
      const active = document.activeElement?.id;
      render();
      if (active) { const el = document.getElementById(active); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch {} } }
    } else render();
  } catch (e) {
    if (!soft) $('#view').innerHTML = `<div class="surface"><div class="empty">تعذر تحميل البيانات: ${esc(e.message)}</div></div>`;
  }
}

async function act(path, body = {}, quiet = false) {
  try {
    const r = await api(path, body);
    if (!quiet) toast(r.message || 'تم');
    await refresh(true);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

/* ---------- skeletons ---------- */
function skeletonFor(page) {
  const rows = n => Array(n).fill('<div class="skel" style="height:34px;margin:10px 0"></div>').join('');
  if (page === 'overview' || page === 'members' || page === 'lessons') {
    return `<div class="surface">${rows(5)}</div><div class="surface">${rows(3)}</div>`;
  }
  return `<div class="surface">${rows(4)}</div>`;
}

/* ---------- render dispatch ---------- */
function render() {
  const v = $('#view');
  clearInterval(state.cd);
  $('#page-actions').innerHTML = '';
  if (!state.data) return;
  ({ overview: rOverview, lessons: rLessons, members: rMembers, quests: rQuests, settings: rSettings })[state.page](v);
}

/* ============ OVERVIEW ============ */
function rOverview(v) {
  const d = state.data;
  const live = d.live;
  const next = d.nextSession;
  const notDone = d.lessons.filter(l => !l.done);

  let liveHtml = '';
  if (live) {
    liveHtml = `<div id="live-banner">
      <span class="live-dot"></span>
      <div class="what">
        <div class="title">${esc(live.lesson_title)}</div>
        <div class="sub">${live.attendees} في الغرفة · بدأت ${fmt(live.scheduled_at)}</div>
      </div>
      <button class="btn danger" onclick="act('action/finish')">${icon('stop')} إنهاء الحصة وصرف النقاط</button>
    </div>`;
  }

  let startHtml;
  if (notDone.length) {
    startHtml = `<div class="surface"><h2>تشغيل درس الآن</h2>
      <div class="frow">
        <div style="flex:3"><select id="pick-lesson" style="width:100%">
          ${notDone.map(l => `<option value="${l.id}">${l.position}. ${esc(l.title)}</option>`).join('')}
        </select></div>
        <div style="flex:0"><button class="btn" onclick="act('action/start',{lessonId:+$('#pick-lesson').value})">${icon('play')} ابدأ الحصة</button></div>
      </div>
      <div class="vdim" style="margin-top:9px">المدرب ينضم لغرفة الصوت ويشغّل صوت الدرس مباشرة.</div>
    </div>`;
  } else if (d.lessons.length === 0) {
    startHtml = `<div class="surface"><h2>الدورة فارغة</h2>
      <div class="empty">لا دروس بعد.<br><b>أول درس تضيفه يظهر لطلابك في الديسكورد.</b></div>
      <div style="text-align:center"><a class="btn" href="#/lessons">${icon('plus')} إضافة أول درس</a></div>
    </div>`;
  } else {
    startHtml = `<div class="surface"><h2>تشغيل درس الآن</h2>
      <div class="empty">كل الدروس مكتملة — أضف دروساً جديدة للمتابعة.</div></div>`;
  }

  let nextHtml = '';
  if (next && !live) {
    nextHtml = `<div class="surface"><h2>الحصة القادمة</h2>
      <div style="font-size:16px;font-weight:800">${esc(next.lesson_title)}</div>
      <div class="dim" style="margin-top:3px">${fmt(next.scheduled_at)}</div>
      <div class="cd"><b id="cd-val">—</b><span>حتى البداية</span></div>
      <div style="margin-top:12px"><button class="btn quiet sm" onclick="act('action/start',{lessonId:${next.lesson_id}})">${icon('play')} ابدأها الآن</button></div>
    </div>`;
    const tick = () => {
      const el = $('#cd-val');
      if (!el) return clearInterval(state.cd);
      const ms = new Date(next.scheduled_at) - Date.now();
      if (ms <= 0) { el.textContent = 'حان الوقت'; return clearInterval(state.cd); }
      const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
      el.textContent = (h ? h + ' س ' : '') + m + ' د ' + s + ' ث';
    };
    tick(); state.cd = setInterval(tick, 1000);
  }

  const sorted = [...d.participants].sort((a, b) => b.xp - a.xp).slice(0, 5);
  const lb = sorted.map((p, i) => `<tr class="r${i + 1}">
    <td><span class="rank">${i + 1}</span></td>
    <td><b>${esc(p.name)}</b></td>
    <td>${p.xp}</td>
    <td>${esc(p.level.name)}</td>
    <td>سلسلة ${p.streak}</td>
  </tr>`).join('');

  const o = d.overview;
  const activeQ = d.quests.filter(q => q.status === 'active').length;
  const summary = `<div class="surface" style="display:flex;gap:26px;flex-wrap:wrap;align-items:baseline">
    <div><b style="font-size:17px">${o.lessonsDone}/${o.lessonsTotal}</b> <span class="dim">درس مكتمل</span></div>
    <div><b style="font-size:17px">${d.participants.length}</b> <span class="dim">عضو</span></div>
    <div><b style="font-size:17px">${activeQ}</b> <span class="dim">مهمة نشطة</span></div>
    <div><b style="font-size:17px">${d.template ? d.template.daysText + ' ' + d.template.time : '—'}</b> <span class="dim">القالب الأسبوعي</span></div>
  </div>`;

  v.innerHTML = liveHtml + `<div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
    ${startHtml}${nextHtml}
  </div>` + summary + `
  <div class="surface"><h2>المتصدرون</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th></th><th>العضو</th><th>النقاط</th><th>المستوى</th><th>السلسلة</th></tr></thead>
      <tbody>${lb || `<tr><td colspan="5" class="empty">لا نقاط بعد — تبدأ النقاط بأول حصة.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}

/* ============ LESSONS ============ */
function rLessons(v) {
  const d = state.data;

  const addForm = `<div class="surface"><h2>درس جديد</h2>
    <div class="frow">
      <div style="flex:3;min-width:200px"><label>العنوان</label><input id="nl-title" placeholder="مثال: الدرس الأول — المدخلات"></div>
      <div style="flex:3;min-width:200px"><label>رابط يوتيوب <span class="vdim">(بدونه لن يعمل البث)</span></label><input id="nl-url" dir="ltr" placeholder="https://youtube.com/watch?v=…"></div>
      <div style="flex:0;min-width:86px"><label>الدقائق</label><input id="nl-dur" type="number" value="60" style="width:100%"></div>
      <div style="flex:0"><button class="btn" onclick="addLesson()">${icon('plus')} إضافة</button></div>
    </div>
  </div>`;

  const rows = d.lessons.map(l => {
    if (state.editing === l.id) return editRow(l);
    const s = l.session;
    const sched = l.done
      ? '<span class="pill ok">مكتمل</span>'
      : s
        ? (s.status === 'live' ? '<span class="pill bad">مباشر الآن</span>' : `<span class="dim">${fmt(s.scheduled_at)}</span>`)
        : '<span class="vdim">غير مجدول</span>';
    return `<tr>
      <td class="vdim">${l.position}</td>
      <td><b>${esc(l.title)}</b><div class="vdim" dir="ltr">${l.url ? esc(l.url) : 'بدون رابط — لا بث'}</div></td>
      <td>${sched}</td>
      <td class="actions"><div class="acts">
        ${!l.done && !d.live ? `<button class="btn quiet sm icon" title="ابدأ الآن" onclick="act('action/start',{lessonId:${l.id}})">${icon('play')}</button>` : ''}
        <button class="btn quiet sm icon" title="تعديل" onclick="editLesson(${l.id})">${icon('edit')}</button>
        <button class="btn quiet sm icon" title="أعلى" onclick="act('lesson/move',{id:${l.id},dir:-1},true)">${icon('up')}</button>
        <button class="btn quiet sm icon" title="أسفل" onclick="act('lesson/move',{id:${l.id},dir:1},true)">${icon('down')}</button>
        <button class="btn danger sm icon" title="حذف" onclick="delLesson(${l.id},${JSON.stringify(l.title).replace(/"/g, '&quot;')})">${icon('trash')}</button>
      </div></td>
    </tr>`;
  }).join('');

  const sess = d.sessions.filter(s => s.status !== 'cancelled').map(s => `<tr>
    <td class="vdim">#${s.id}</td>
    <td><b>${esc(s.lesson_title)}</b></td>
    <td>${s.status === 'live' ? '<span class="pill bad">مباشر</span>' : `<span class="dim">${fmt(s.scheduled_at)}</span>`}</td>
    <td class="actions"><div class="acts" dir="ltr">
      <input type="date" id="sd-${s.id}" value="${s.scheduled_at.slice(0, 10)}" style="padding:5px 8px;width:132px">
      <input type="time" id="st-${s.id}" value="${s.scheduled_at.slice(11, 16)}" style="padding:5px 8px;width:86px">
      <button class="btn quiet sm" onclick="moveSess(${s.id})">نقل</button>
      <button class="btn danger sm icon" title="إلغاء" onclick="act('session/cancel',{id:${s.id}})">${icon('x')}</button>
    </div></td>
  </tr>`).join('');

  const tpl = d.template;
  v.innerHTML = addForm + `
  <div class="surface"><h2>الدروس (${d.lessons.length})</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>الدرس</th><th>الموعد</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">لا دروس.<br><b>النموذج بالأعلى يضيف أول درس — العنوان يظهر لطلابك كما تكتبه.</b></td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="surface"><h2>الحصص القادمة</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>الرقم</th><th>الدرس</th><th>الموعد</th><th></th></tr></thead>
      <tbody>${sess || `<tr><td colspan="4" class="empty">لا حصص مجدولة.<br>حدّد القالب بالأسفل ثم «جدولة تلقائية».</td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="surface"><h2>القالب الأسبوعي</h2>
    <div class="frow">
      <div><label>الأيام <span class="vdim">(الأحد,الأربعاء)</span></label><input id="tpl-days" value="${tpl ? esc(tpl.daysText) : ''}" placeholder="الأحد,الأربعاء"></div>
      <div style="max-width:120px"><label>الوقت</label><input id="tpl-time" dir="ltr" value="${tpl ? esc(tpl.time) : '21:00'}" placeholder="21:00"></div>
      <div style="flex:0"><button class="btn quiet" onclick="saveTpl()">حفظ القالب</button></div>
      <div style="flex:0"><button class="btn" onclick="act('generate',{})">${icon('bolt')} جدولة تلقائية</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">«جدولة تلقائية» توزع الدروس غير المكتملة على مواعيد القالب بالترتيب.</div>
  </div>`;
}

function editRow(l) {
  return `<tr style="background:var(--ink-3)">
    <td class="vdim">${l.position}</td>
    <td colspan="2">
      <div class="frow" style="align-items:center">
        <div style="flex:2"><label>العنوان</label><input id="el-title" value="${esc(l.title)}"></div>
        <div style="flex:2"><label>الرابط</label><input id="el-url" dir="ltr" value="${esc(l.url || '')}"></div>
        <div style="flex:0;min-width:80px"><label>الدقائق</label><input id="el-dur" type="number" value="${l.duration_min}"></div>
      </div>
    </td>
    <td class="actions"><div class="acts">
      <button class="btn sm" onclick="saveEdit(${l.id})">${icon('check')} حفظ</button>
      <button class="btn quiet sm" onclick="cancelEdit()">إلغاء</button>
    </div></td>
  </tr>`;
}
function editLesson(id) { state.editing = id; render(); }
function cancelEdit() { state.editing = null; render(); }
async function saveEdit(id) {
  const title = $('#el-title').value.trim();
  if (!title) return toast('العنوان مطلوب', true);
  state.editing = null;
  await act('lesson/update', { id, title, url: $('#el-url').value.trim(), durationMin: +$('#el-dur').value || 60 });
}
async function addLesson() {
  const title = $('#nl-title').value.trim();
  if (!title) return toast('اكتب عنوان الدرس أولاً', true);
  await act('lesson/add', { title, url: $('#nl-url').value.trim(), durationMin: +$('#nl-dur').value || 60 });
}
async function delLesson(id, title) {
  if (!confirm(`حذف الدرس «${title}»؟ سيُحذف مع مواعيده.`)) return;
  await act('lesson/remove', { id });
}
async function moveSess(id) {
  await act('session/move', { id, date: $('#sd-' + id).value, time: $('#st-' + id).value });
}
async function saveTpl() {
  await act('template', { days: $('#tpl-days').value, time: $('#tpl-time').value });
}

/* ============ MEMBERS ============ */
function rMembers(v) {
  const d = state.data;
  $('#page-actions').innerHTML = `<span class="dim">${d.participants.length} عضو</span>`;
  const q = state.memberFilter.trim().toLowerCase();
  const list = d.participants.filter(p =>
    !q || p.name.toLowerCase().includes(q) || String(p.user_id).includes(q));

  const rows = list.map(p => `<tr style="cursor:pointer" onclick="openMember('${p.user_id}')">
    <td><b>${esc(p.name)}</b>${p.dms_enabled ? '' : ' <span class="pill warn">مكتوم الإشعارات</span>'}</td>
    <td>${p.xp}</td>
    <td>${esc(p.level.name)}</td>
    <td>${p.streak}</td>
    <td>${p.lessons_done}/${d.lessons.length}</td>
    <td class="dim">${p.last_activity ? fmt(p.last_activity) : '—'}</td>
  </tr>`).join('');

  v.innerHTML = `
  <div class="surface" style="padding:12px 14px">
    <div style="position:relative">
      <span style="position:absolute;inset-inline-start:10px;top:50%;transform:translateY(-50%);color:var(--text-3)">${icon('search')}</span>
      <input id="msearch" placeholder="ابحث بالاسم أو رقم العضو…" value="${esc(state.memberFilter)}" style="width:100%;padding-inline-start:36px">
    </div>
  </div>
  <div class="surface"><h2>الأعضاء</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>العضو</th><th>النقاط</th><th>المستوى</th><th>السلسلة</th><th>الدروس</th><th>آخر نشاط</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">${q ? 'لا نتائج للبحث «' + esc(q) + '»' : 'لا أعضاء بعد.<br><b>يظهر العضو هنا من لحظة أول حضور أو أول درس يكمله.</b>'}</td></tr>`}</tbody>
    </table></div>
  </div>`;
  const inp = $('#msearch');
  inp.oninput = () => {
    state.memberFilter = inp.value;
    const active = document.activeElement?.id;
    render();
    const el = document.getElementById(active || 'msearch');
    if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
  };
  setTimeout(() => { if (document.activeElement?.id !== 'msearch') inp.focus(); }, 0);
}

async function openMember(id) {
  let m;
  try { m = await api('member/' + id); } catch (e) { return toast(e.message, true); }
  const total = Math.max(state.data.lessons.length, 1);
  const pct = Math.min(1, m.lessons_done / total);
  const tl = m.timeline.slice(0, 16).map(t => `<div class="tl-item">
    <div class="tl-ico">${icon(t.ico)}</div>
    <div><b>${esc(t.title)}</b><div class="vdim">${esc(t.sub)}</div></div>
    <div class="tl-when">${fmt(t.at)}</div>
  </div>`).join('');
  $('#drawer-body').innerHTML = `
    <div class="d-head">
      <div>
        <h2>${esc(m.name)}</h2>
        <div class="d-sub">${m.xp} نقطة · ${esc(m.level.name)} · سلسلة ${m.streak}</div>
      </div>
      <button class="d-close" onclick="closeDrawer()" aria-label="إغلاق">${icon('x')}</button>
    </div>
    <div style="margin-top:14px">
      <div class="dim">الدروس المكتملة: ${m.lessons_done} / ${state.data.lessons.length}</div>
      <div class="bar"><i style="transform:scaleX(${pct.toFixed(3)})"></i></div>
    </div>
    <div class="tl">
      <h2 style="font-size:14px;color:var(--text-2);margin-bottom:2px">سجل النشاط</h2>
      ${tl || '<div class="empty">لا نشاط بعد</div>'}
    </div>`;
  $('#drawer').hidden = false;
  $('#drawer-scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-scrim').hidden = true; }
$('#drawer-scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* ============ QUESTS ============ */
function rQuests(v) {
  const d = state.data;
  const rows = d.quests.map(q => `<tr>
    <td><b>${esc(q.title)}</b></td>
    <td class="dim">${q.lesson_ids.length} درس</td>
    <td class="dim">${fmt(q.ends_at)}</td>
    <td>${q.xp_reward}</td>
    <td>${q.status === 'active' ? '<span class="pill ok">نشطة</span>' : '<span class="pill plain">منتهية</span>'}</td>
    <td class="actions">${q.status === 'active' ? `<button class="btn danger sm" onclick="act('quest/end',{id:${q.id}})">إنهاء</button>` : ''}</td>
  </tr>`).join('');

  const checks = d.lessons.map(l => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0;font-weight:400">
    <input type="checkbox" value="${l.id}" class="q-l" style="width:auto"> ${esc(l.title)}</label>`).join('');

  v.innerHTML = `
  <div class="surface"><h2>مهمة جديدة</h2>
    <div class="frow">
      <div style="flex:2"><label>العنوان</label><input id="q-title" placeholder="تحدّي الأسبوع"></div>
      <div><label>تنتهي في</label><input id="q-ends" type="date" dir="ltr"></div>
    </div>
    <label>الدروس المطلوبة</label>
    <div style="max-height:150px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;padding:8px 12px">
      ${checks || '<div class="empty">لا دروس — أضف دروساً أولاً.</div>'}
    </div>
    <div style="margin-top:12px"><button class="btn" onclick="addQuest()">${icon('plus')} إنشاء وإعلان</button>
    <span class="vdim" style="margin-inline-start:8px">تُعلن المهمة تلقائياً في قناة الديسكورد.</span></div>
  </div>
  <div class="surface"><h2>المهام (${d.quests.length})</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>المهمة</th><th>الدروس</th><th>تنتهي</th><th>المكافأة</th><th>الحالة</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">لا مهام بعد.<br><b>المهمة تدفع الطلاب لإكمال الدروس قبل الموعد مقابل نقاط.</b></td></tr>`}</tbody>
    </table></div>
  </div>`;
}
async function addQuest() {
  const ids = $$('.q-l').filter(c => c.checked).map(c => +c.value);
  if (!$('#q-title').value.trim() || !ids.length || !$('#q-ends').value)
    return toast('أكمل العنوان والدروس والتاريخ', true);
  await act('quest/add', { title: $('#q-title').value.trim(), lessonIds: ids, ends: $('#q-ends').value });
}

/* ============ SETTINGS ============ */
const SETTING_DEFS = [
  ['tz', 'المنطقة الزمنية'],
  ['xp_attendance', 'نقاط الحضور'],
  ['xp_completion', 'نقاط إكمال الدرس'],
  ['xp_quest', 'نقاط المهمة'],
  ['nudge_hour', 'ساعة التنبيه (0-23)'],
  ['nudge_cooldown_hours', 'فترة التنبيه (ساعات)'],
  ['recap_day', 'يوم الملخص (0=الأحد)'],
  ['recap_hour', 'ساعة الملخص'],
  ['reminder_minutes_before', 'التذكير قبل (دقيقة)'],
  ['missed_after_minutes', 'غياب بعد (دقيقة)'],
];
function rSettings(v) {
  const s = state.data.settings;
  v.innerHTML = `
  <div class="surface"><h2>قيم الأكاديمية</h2>
    <div class="frow">${SETTING_DEFS.map(([k, label]) => `
      <div style="min-width:150px"><label>${label}</label>
      <input id="set-${k}" dir="ltr" value="${esc(s[k] ?? '')}" style="width:100%"></div>`).join('')}
    </div>
    <div style="margin-top:14px"><button class="btn" onclick="saveSettings()">حفظ الإعدادات</button></div>
  </div>
  <div class="surface"><h2>الربط مع الديسكورد</h2>
    <div class="tbl-wrap"><table style="min-width:0">
      <tr><td class="dim">قناة الإعلانات</td><td><b>${esc(s.channel_dashboard_name || s.channel_dashboard || '—')}</b></td></tr>
      <tr><td class="dim">غرفة الحصة الصوتية</td><td><b>${esc(s.study_vc_name || s.study_vc || '—')}</b></td></tr>
      <tr><td class="dim">دور التنبيه</td><td dir="ltr"><b>${esc(s.ping_role || '—')}</b></td></tr>
    </table></div>
  </div>`;
}
async function saveSettings() {
  const body = {};
  for (const [k] of SETTING_DEFS) body[k] = document.getElementById('set-' + k).value;
  await act('settings', body);
}

/* ---------- boot ---------- */
route();
refresh(false);
state.poll = setInterval(() => refresh(true), 15000);
