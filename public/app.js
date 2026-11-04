/* لوحة الأكاديمية — SPA · هُدَى (navy & gold) */
const $ = s => document.querySelector(s);
const state = { data: null, page: 'overview', memberFilter: '', memberSeg: 'all', editing: null, cd: null, pp: null, poll: null };

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]);

const TITLES = { overview: 'نظرة عامة', courses: 'الدورات', books: 'الكتب والمجموعات', members: 'الأعضاء', quests: 'الإنجازات', settings: 'الإعدادات' };
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

const icon = name => `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;

/* ---------- router ---------- */
function route() {
  const h = (location.hash || '#/overview').replace('#/', '');
  if (h.startsWith('course/')) { state.page = 'course'; state.courseId = Number(h.split('/')[1]) || 0; }
  else state.page = TITLES[h] ? h : 'overview';
  $$('#nav a').forEach(a => a.classList.toggle('on',
    a.dataset.page === state.page || (state.page === 'course' && a.dataset.page === 'courses')));
  $('#page-title').textContent = TITLES[state.page] ?? 'دورة';
  render();
}
const $$ = s => [...document.querySelectorAll(s)];
window.addEventListener('hashchange', route);

/* ---------- data ---------- */
// A soft refresh (the 15s poll) must never clobber what the user is doing:
// skip the re-render while they're in a form field, and skip it entirely when
// nothing changed — otherwise every page's inputs wipe themselves mid-typing.
let pendingRender = false;
async function refresh(soft = true) {
  if (!soft) $('#view').innerHTML = skeletonFor(state.page);
  try {
    const prev = state.data;
    const next = await api('data');
    TZ = next.tz || TZ;
    $('#bot-dot').className = 'dot' + (next.botOk ? '' : ' off');
    $('#bot-label').textContent = next.botOk ? 'المدرب متصل' : 'المدرب غير متصل';
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(next);
    state.data = next;
    if (soft) {
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
      if (typing) { if (changed || pendingRender) pendingRender = true; return; }
      if (!changed && !pendingRender) return;
    }
    pendingRender = false;
    render();
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
  if (page === 'overview' || page === 'members' || page === 'courses' || page === 'course') {
    return `<div class="surface">${rows(5)}</div><div class="surface">${rows(3)}</div>`;
  }
  return `<div class="surface">${rows(4)}</div>`;
}

/* ---------- render dispatch ---------- */
function render() {
  const v = $('#view');
  clearInterval(state.cd);
  clearInterval(state.pp);
  $('#page-actions').innerHTML = '';
  if (!state.data) return;
  ({ overview: rOverview, courses: rCourses, course: rCourse, books: rBooks, members: rMembers, quests: rQuests, settings: rSettings })[state.page](v);
}

/* ============ OVERVIEW ============ */
function rOverview(v) {
  const d = state.data;
  const live = d.live;
  const next = d.nextSession;
  const notDone = d.lessons.filter(l => !l.done);

  let liveHtml = '';
  if (live) {
    const partTag = live.parts > 1 ? ` · الجزء ${live.part}/${live.parts}` : '';
    liveHtml = `<div id="live-banner">
      <span class="live-dot"></span>
      <div class="what">
        <div class="title">${esc(live.lesson_title)} <span id="pb-audio" class="pill plain">…</span></div>
        <div class="sub">${(live.present?.length ?? 0)} في الغرفة الآن · ${live.attendees} حضروا${partTag} · بدأت ${fmt(live.scheduled_at)}</div>
        ${live.present?.length ? `<div class="present">${live.present.slice(0, 12).map(n => `<span>${esc(n)}</span>`).join('')}${live.present.length > 12 ? `<span>+${live.present.length - 12}</span>` : ''}</div>` : ''}
      </div>
      <div id="player-bar" dir="ltr">
        <button class="pbtn" title="من البداية" onclick="pctl('restart')">${icon('restart')}</button>
        <button class="pbtn" title="رجوع 10 ثوانٍ" onclick="pctl('seek',{delta:-10})">${icon('rew')}<span class="pnum">10</span></button>
        <button class="pbtn big" id="pb-toggle" title="إيقاف / استئناف" onclick="pctlToggle()">${icon('pause')}</button>
        <button class="pbtn" title="تقديم 10 ثوانٍ" onclick="pctl('seek',{delta:10})"><span class="pnum">10</span>${icon('fwd')}</button>
        <span id="pb-pos" class="pb-time">…</span>
        <input id="pb-vol" type="range" min="0" max="200" value="100" title="مستوى الصوت" onchange="pctlVol(this.value)">
      </div>
      <button class="btn danger" onclick="if(confirm('إنهاء الحصة الآن؟ يتوقف الصوت ويُرسل ملخص الحضور للأعضاء.'))act('action/finish')">${icon('stop')} إنهاء الحصة</button>
    </div>`;
    pollPlayer();
    clearInterval(state.pp);
    state.pp = setInterval(pollPlayer, 3000);
  }

  let startHtml;
  if (live) {
    startHtml = ''; // the live banner is up — no second class can start
  } else if (notDone.length) {
    const multi = d.courses.length > 1;
    startHtml = `<div class="surface"><h2>تشغيل درس الآن</h2>
      <div class="frow">
        <div style="flex:3"><select id="pick-lesson" style="width:100%">
          ${notDone.map(l => {
            const c = multi ? d.courses.find(x => x.id === l.course_id) : null;
            return `<option value="${l.id}">${c ? esc(c.title) + ' — ' : ''}${l.position}. ${esc(l.title)}</option>`;
          }).join('')}
        </select></div>
        <div style="flex:0 0 auto"><button class="btn" onclick="act('action/start',{lessonId:+$('#pick-lesson').value})">${icon('play')} ابدأ الحصة</button></div>
      </div>
      <div class="vdim" style="margin-top:9px">المدرب ينضم لغرفة الصوت ويشغّل صوت الدرس مباشرة.</div>
    </div>`;
  } else if (d.lessons.length === 0) {
    startHtml = `<div class="surface"><h2>لا دورات بعد</h2>
      <div class="empty">لا دروس بعد.<br><b>أنشئ دورة من قائمة يوتيوب في صفحة الدورات.</b></div>
      <div style="text-align:center"><a class="btn" href="#/courses">${icon('plus')} إنشاء أول دورة</a></div>
    </div>`;
  } else {
    startHtml = `<div class="surface"><h2>تشغيل درس الآن</h2>
      <div class="empty">كل الدروس مكتملة — أضف دورة جديدة للمتابعة.</div></div>`;
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

  const o = d.overview;
  const qDone = d.quests.reduce((n, q) => n + (q.done || 0), 0);
  const drifting = d.participants.filter(p => ['slipping', 'inactive'].includes(p.engagement?.status));
  const regular = d.participants.filter(p => p.engagement?.status === 'regular').length;
  const summary = `<div class="surface sum-grid">
    <div><b>${o.lessonsDone}/${o.lessonsTotal}</b><span>درس مكتمل · ${d.courses.length} دورة</span></div>
    <div><b>${d.participants.length}</b><span>عضو · ${regular} منتظم</span></div>
    <div><b>${d.quests.length}</b><span>عنصر إنجاز · أُنجز ${qDone} مرة</span></div>
    ${drifting.length
      ? `<a class="sum-alert" href="#/members" onclick="state.memberSeg='all'"><b>${drifting.length}</b><span>يحتاجون متابعة — متراجع أو منقطع ←</span></a>`
      : `<div><b>0</b><span>يحتاج متابعة — الجميع منتظم</span></div>`}
  </div>`;

  v.innerHTML = liveHtml + `<div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
    ${startHtml}${nextHtml}
  </div>` + summary;
}

/* ============ LIVE PLAYER (تحكم بالبث) ============ */
const fmtSec = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
};

function paintPlayer(p) {
  // the one thing the owner must know mid-class: can the room hear the lesson?
  const a = $('#pb-audio');
  if (a) {
    const [cls, txt] = !p?.live ? ['bad', 'لا صوت — تحقّق من الكوكيز']
      : p.buffering ? ['warn', 'جارٍ تجهيز الصوت'] : p.paused ? ['plain', 'متوقف مؤقتاً']
      : p.streaming ? ['ok', 'الصوت يعمل'] : ['bad', 'لا صوت — تحقّق من الكوكيز'];
    a.className = 'pill ' + cls; a.textContent = txt;
  }
  const el = $('#pb-pos');
  if (!el || !p?.live) return;
  $('#pb-toggle').innerHTML = p.paused ? icon('play') : icon('pause');
  el.textContent = p.buffering
    ? 'جارٍ تجهيز الصوت…'
    : fmtSec(p.positionSec) + (p.durationSec ? ' / ' + fmtSec(p.durationSec) : '') + (p.paused ? ' · متوقف' : '');
  const vol = $('#pb-vol');
  if (vol && document.activeElement !== vol) vol.value = Math.round((p.volume ?? 1) * 100);
}

async function pollPlayer() {
  let p;
  try { p = await api('player'); } catch { return; }
  if (!$('#pb-pos')) { clearInterval(state.pp); return; }
  paintPlayer(p);
}

async function pctl(op, extra = {}) {
  try {
    const r = await api('player', { op, ...extra });
    paintPlayer(r.player);
  } catch (e) { toast(e.message, true); }
}

async function pctlToggle() {
  let p;
  try { p = await api('player'); } catch { return; }
  pctl(p.paused ? 'resume' : 'pause');
}

function pctlVol(v) { pctl('volume', { value: (+v || 0) / 100 }); }

/* ============ COURSES ============ */
const fmtMin = m => fmtSec((m || 0) * 60);

// shared cadence picker (days / daily / every-N-days) — ids prefixed so the
// create form and each course page can use it independently
function cadenceFields(p, tpl) {
  const mode = tpl?.mode ?? 'days';
  return `
      <div style="max-width:160px"><label>التكرار</label>
        <select id="${p}-mode" onchange="tplMode('${p}')">
          <option value="days" ${mode === 'days' ? 'selected' : ''}>أيام محددة</option>
          <option value="daily" ${mode === 'daily' ? 'selected' : ''}>كل يوم</option>
          <option value="interval" ${mode === 'interval' ? 'selected' : ''}>كل عدة أيام</option>
        </select></div>
      <div id="${p}-days-wrap" style="flex:2;min-width:170px" ${mode === 'interval' ? 'hidden' : ''}><label>الأيام <span class="vdim">(الأحد,الأربعاء)</span></label>
        <input id="${p}-days" value="${tpl && tpl.mode !== 'interval' ? esc(tpl.daysText) : ''}" placeholder="الأحد,الأربعاء"></div>
      <div id="${p}-n-wrap" style="max-width:110px" ${mode !== 'interval' ? 'hidden' : ''}><label>كل كم يوم؟</label>
        <input id="${p}-n" type="number" min="2" max="30" value="${tpl?.everyN ?? 2}" style="width:100%"></div>
      <div style="max-width:104px"><label>الوقت</label><input id="${p}-time" dir="ltr" value="${tpl ? esc(tpl.time) : '21:00'}" placeholder="21:00"></div>`;
}
function readCadence(p) {
  const mode = $('#' + p + '-mode').value;
  const body = { mode, time: $('#' + p + '-time').value.trim() };
  if (mode === 'days') body.days = $('#' + p + '-days').value.trim();
  if (mode === 'interval') body.everyN = +$('#' + p + '-n').value || 2;
  return body;
}
// clear message before sending a bad cadence to the server
function cadenceError(p) {
  const c = readCadence(p);
  if (!/^\d{1,2}:\d{2}$/.test(c.time)) return 'اكتب وقت الحصة بصيغة SS:DD — مثال 21:00';
  if (c.mode === 'days' && !c.days) return 'حدّد أيام الدورة (مثال: الأحد,الأربعاء) أو اختر «كل يوم»';
  if (c.mode === 'interval' && (!(c.everyN >= 1) || c.everyN > 30)) return '«كل كم يوم» يجب أن يكون بين 1 و 30';
  return null;
}
// ISO (UTC) -> 'YYYY-MM-DD HH:mm' in the academy timezone, for date/time inputs
const dtLocal = iso => {
  const parts = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso))) if (x.type !== 'literal') parts[x.type] = x.value;
  return `${parts.year}-${parts.month}-${parts.day} ${(parts.hour === '24' ? '00' : parts.hour)}:${parts.minute}`;
};
function tplMode(p) {
  const mode = $('#' + p + '-mode').value;
  $('#' + p + '-days-wrap').hidden = mode === 'interval';
  $('#' + p + '-n-wrap').hidden = mode !== 'interval';
}

function rCourses(v) {
  const d = state.data;
  $('#page-actions').innerHTML = `<span class="dim">${d.courses.length} دورة</span>`;
  const cards = d.courses.map(c => `
    <a class="course-card" href="#/course/${c.id}">
      <div class="cc-head"><h3>${esc(c.title)}</h3>${icon('cal')}</div>
      <div class="cc-cadence">${esc(c.daysText)} · <span dir="ltr">${esc(c.time)}</span></div>
      <div class="cc-meta dim">${c.lessons_total} دروس · ${c.lessons_done} مكتمل · ${c.upcoming} حصص قادمة</div>
      <div class="cc-next vdim">${c.next_session ? 'القادمة: ' + esc(c.next_session.lesson_title) + ' — ' + fmt(c.next_session.scheduled_at) : 'لا حصص مجدولة بعد'}</div>
    </a>`).join('');

  v.innerHTML = `
  <div class="surface"><h2>إنشاء دورة جديدة</h2>
    <div class="frow">
      <div style="flex:2;min-width:170px"><label>عنوان الدورة</label><input id="nc-title" placeholder="مثال: شرح الأربعين النووية"></div>
      <div style="flex:3;min-width:200px"><label>رابط قائمة يوتيوب <span class="vdim">(اختياري — يستورد دروس الدورة فوراً)</span></label><input id="nc-url" dir="ltr" placeholder="https://youtube.com/playlist?list=…"></div>
      <div style="flex:0;min-width:100px"><label>مدة الحصة (دقيقة)</label><input id="nc-dur" type="number" value="60" style="width:100%"></div>
    </div>
    <div class="frow" style="margin-top:4px">
      ${cadenceFields('nc', null)}
    </div>
    <div style="margin-top:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <button class="btn" id="nc-btn" onclick="createCourse()">${icon('plus')} إنشاء الدورة</button>
      <label style="display:flex;gap:7px;align-items:center;margin:0;font-weight:400"><input type="checkbox" id="nc-gen" checked style="width:auto"> جدولة تلقائية بعد الإنشاء</label>
    </div>
    <div class="vdim" style="margin-top:9px">لكل دورة دروسها وإيقاعها الخاص (يومياً / كل عدة أيام / أيام محددة) — والفيديو الأطول من الحصة يُقسَّم تلقائياً على حصص متتالية تكمل من حيث توقفت.</div>
  </div>
  <div class="courses-grid">${cards || '<div class="surface"><div class="empty">لا دورات بعد — أنشئ أول دورة من الأعلى.</div></div>'}</div>`;
}

async function createCourse() {
  const title = $('#nc-title').value.trim();
  if (!title) return toast('اكتب عنوان الدورة أولاً', true);
  const err = cadenceError('nc');
  if (err) return toast(err, true);
  const btn = $('#nc-btn');
  btn.disabled = true;
  btn.innerHTML = 'جارٍ الإنشاء والاستيراد…';
  try {
    await act('course/add', {
      title, playlistUrl: $('#nc-url').value.trim(),
      durationMin: +$('#nc-dur').value || 60,
      generate: $('#nc-gen').checked,
      ...readCadence('nc'),
    });
    const c = (state.data?.courses || []).find(x => x.title === title);
    if (c) location.hash = '#/course/' + c.id;
    else location.hash = '#/courses';
  } catch (e) { /* toast already shown by act */ }
  finally { btn.disabled = false; btn.innerHTML = `${icon('plus')} إنشاء الدورة`; }
}

/* ============ COURSE DETAIL ============ */
function rCourse(v) {
  const d = state.data;
  const c = d.courses.find(x => x.id === state.courseId);
  if (!c) {
    v.innerHTML = `<div class="surface"><div class="empty">هذه الدورة غير موجودة.<br><a class="btn" style="margin-top:12px" href="#/courses">عودة إلى الدورات</a></div></div>`;
    return;
  }
  $('#page-title').textContent = c.title;
  const lessons = d.lessons.filter(l => l.course_id === c.id);
  const sessions = d.sessions.filter(s => s.course_id === c.id && s.status !== 'cancelled');

  const importForm = `<div class="surface"><h2>استيراد قائمة تشغيل إلى هذه الدورة</h2>
    <div class="frow">
      <div style="flex:3;min-width:220px"><label>رابط قائمة يوتيوب</label><input id="pl-url" dir="ltr" placeholder="https://youtube.com/playlist?list=…"></div>
      <div style="flex:0;min-width:110px"><label>مدة الحصة (دقيقة)</label><input id="pl-dur" type="number" value="60" style="width:100%"></div>
      <div style="flex:0 0 auto"><button class="btn" id="pl-btn" onclick="importPlaylist()">${icon('plus')} استيراد</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">كل فيديو يصبح درساً بعنوانه. الفيديو الأطول من مدة الحصة يُقسَّم تلقائياً على حصص متتالية، وكل حصة تكمل من حيث توقّفت السابقة.</div>
  </div>`;

  const addForm = `<div class="surface"><h2>درس جديد في هذه الدورة</h2>
    <div class="frow">
      <div style="flex:3;min-width:200px"><label>العنوان</label><input id="nl-title" placeholder="مثال: الدرس الأول — المدخلات"></div>
      <div style="flex:3;min-width:200px"><label>رابط يوتيوب <span class="vdim">(بدونه لن يعمل البث)</span></label><input id="nl-url" dir="ltr" placeholder="https://youtube.com/watch?v=…"></div>
      <div style="flex:0;min-width:86px"><label>الدقائق</label><input id="nl-dur" type="number" value="60" style="width:100%"></div>
      <div style="flex:0 0 auto"><button class="btn" onclick="addLesson()">${icon('plus')} إضافة</button></div>
    </div>
  </div>`;

  const rows = lessons.map(l => {
    if (state.editing === l.id) return editRow(l);
    const s = l.session;
    const sched = l.done
      ? '<span class="pill ok">مكتمل</span>'
      : s
        ? (s.status === 'live' ? '<span class="pill bad">مباشر الآن</span>' : `<span class="dim">${fmt(s.scheduled_at)}</span>`)
        : '<span class="vdim">غير مجدول</span>';
    const partsInfo = l.video_sec && l.parts > 1
      ? `<div class="vdim">طول الفيديو ${fmtSec(l.video_sec)} · ${l.parts} حصص متتالية</div>` : '';
    return `<tr>
      <td class="vdim">${l.position}</td>
      <td><b>${esc(l.title)}</b><div class="vdim" dir="ltr">${l.url ? esc(l.url) : 'بدون رابط — لا بث'}</div>${partsInfo}</td>
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

  const sess = sessions.map(s => `<tr>
    <td class="vdim">#${s.id}</td>
    <td><b>${esc(s.lesson_title)}</b></td>
    <td>${s.parts > 1 ? `<span class="pill plain">الجزء ${s.part}/${s.parts}</span><div class="vdim">من ${fmtMin(s.from_min)}${s.to_min != null ? ' إلى ' + fmtMin(s.to_min) : ''}</div>` : '<span class="vdim">كامل</span>'}</td>
    <td>${s.status === 'live' ? '<span class="pill bad">مباشر</span>' : `<span class="dim">${fmt(s.scheduled_at)}</span>`}</td>
    <td class="actions"><div class="acts" dir="ltr">
      <input type="date" id="sd-${s.id}" value="${dtLocal(s.scheduled_at).slice(0, 10)}" style="padding:5px 8px;width:132px">
      <input type="time" id="st-${s.id}" value="${dtLocal(s.scheduled_at).slice(11)}" style="padding:5px 8px;width:86px">
      <button class="btn quiet sm" onclick="moveSess(${s.id})">نقل</button>
      <button class="btn danger sm icon" title="إلغاء" onclick="act('session/cancel',{id:${s.id}})">${icon('x')}</button>
    </div></td>
  </tr>`).join('');

  v.innerHTML = `
  <div class="surface" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <a href="#/courses" class="btn quiet sm">← كل الدورات</a>
    <div style="flex:1;min-width:200px">
      <b style="font-size:16px">${esc(c.title)}</b>
      <span class="dim" style="margin-inline-start:8px">${esc(c.daysText)} · <span dir="ltr">${esc(c.time)}</span> · ${lessons.length} دروس</span>
    </div>
  </div>` + importForm + addForm + `
  <div class="surface"><h2>الدروس (${lessons.length})</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>الدرس</th><th>الموعد</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">لا دروس في هذه الدورة.<br><b>الصق رابط قائمة التشغيل بالأعلى — تُستورد كاملة في دقيقة.</b></td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="surface"><h2>حصص هذه الدورة (${sessions.length})</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>الرقم</th><th>الدرس</th><th>الجزء</th><th>الموعد</th><th></th></tr></thead>
      <tbody>${sess || `<tr><td colspan="5" class="empty">لا حصص مجدولة.<br>حدّد الإيقاع بالأسفل ثم «جدولة تلقائية».</td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="surface"><h2>تقدّم الأعضاء في هذه الدورة</h2>
    <div id="roster-body"><div class="skel" style="height:34px;margin:10px 0"></div></div>
  </div>
  <div class="surface"><h2>أسئلة الدورة (تُرسل تلقائياً بعد الحصة)</h2>
    <div class="frow">
      <div style="flex:2;min-width:200px"><label>السؤال</label><input id="q-text" placeholder="مثال: ما حكم كذا؟"></div>
      <div style="flex:2;min-width:180px"><label>الدرس <span class="vdim">(اختياري — بدون درس لا يُرسل تلقائياً)</span></label>
        <select id="q-lesson" style="width:100%"><option value="">— بدون —</option>
          ${lessons.map(l => `<option value="${l.id}">${l.position}. ${esc(l.title)}</option>`).join('')}
        </select></div>
    </div>
    <div class="frow" style="margin-top:4px">
      ${[1, 2, 3, 4].map(n => `<div style="flex:1;min-width:120px"><label>الخيار ${n}</label><input id="q-opt${n}" ${n <= 2 ? '' : 'placeholder="اختياري"'}></div>`).join('')}
      <div style="flex:0;min-width:120px"><label>الإجابة الصحيحة</label>
        <select id="q-correct" style="width:100%"><option value="0">الخيار 1</option><option value="1">الخيار 2</option><option value="2">الخيار 3</option><option value="3">الخيار 4</option></select></div>
      <div style="flex:0 0 auto"><button class="btn" onclick="addQuestion()">${icon('plus')} إضافة</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">عند انتهاء حصة الدرس يُرسل سؤاله في قناة الإعلانات بأزرار اختيار — كن أول من يجيب إجابة صحيحة.</div>
    <div class="tbl-wrap" style="margin-top:12px"><table>
      <thead><tr><th>السؤال</th><th>الدرس</th><th>الإجابات</th><th></th></tr></thead>
      <tbody>${(d.questions || []).filter(q => q.course_id === c.id).map(q => `<tr>
        <td><b>${esc(q.question)}</b><div class="vdim">✅: ${esc(q.options[q.correct_index] ?? '')}</div></td>
        <td class="dim">${q.lesson_id ? esc((lessons.find(l => l.id === q.lesson_id) || {}).title ?? '—') : 'عام'}</td>
        <td class="dim">${q.answers}</td>
        <td class="actions"><div class="acts">
          <button class="btn quiet sm" onclick="act('question/send',{id:${q.id}})">إرسال الآن</button>
          <button class="btn danger sm icon" title="حذف" onclick="act('question/remove',{id:${q.id}},true)">${icon('trash')}</button>
        </div></td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty">لا أسئلة بعد — أضف أول سؤال من الأعلى.</td></tr>`}</tbody>
    </table></div>
  </div>
  <div class="surface"><h2>إعدادات الدورة</h2>
    <div class="frow">
      <div style="flex:2;min-width:180px"><label>العنوان</label><input id="c-title" value="${esc(c.title)}"></div>
    </div>
    <div class="frow" style="margin-top:4px">
      ${cadenceFields('tpl', c)}
      <div style="flex:0 0 auto"><button class="btn quiet" onclick="saveCourse()">حفظ</button></div>
      <div style="flex:0 0 auto"><button class="btn" onclick="genCourse()">${icon('bolt')} جدولة تلقائية</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">الإيقاع خاص بهذه الدورة وحدها — «جدولة تلقائية» توزع دروسها غير المكتملة على مواعيده بالترتيب، والدرس الطويل يأخذ عدة مواعيد متتالية.</div>
    <div style="margin-top:14px"><button class="btn danger sm" onclick="delCourse(${c.id},${JSON.stringify(c.title).replace(/"/g, '&quot;')})">${icon('trash')} حذف الدورة بدروسها ومواعيدها</button></div>
  </div>`;
  loadRoster(c.id);
}

// members' standing in the current course — who finished what, who's next
async function loadRoster(courseId) {
  let r;
  try { r = await api('course/' + courseId + '/progress'); }
  catch (e) {
    const errEl = $('#roster-body');
    if (errEl) errEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const el = $('#roster-body');
  if (!el) return; // page changed while fetching
  const rows = r.roster.map(m => {
    const pct = m.total ? Math.min(1, m.done / m.total) : 0;
    return `<tr style="cursor:pointer" onclick="openMember('${m.user_id}')">
      <td><b>${esc(m.name)}</b></td>
      <td style="min-width:130px"><div class="dim" style="margin-bottom:5px">${m.done}/${m.total}</div><div class="bar" style="margin-top:0"><i style="transform:scaleX(${pct.toFixed(3)})"></i></div></td>
      <td class="dim">${m.next_lesson ? esc(m.next_lesson.title) : 'أكمل الدورة 🎉'}</td>
      <td class="vdim">${m.last_completed_at ? fmt(m.last_completed_at) : '—'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>العضو</th><th>التقدّم</th><th>الدرس التالي له</th><th>آخر إنجاز</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="empty">لا أعضاء بعد.<br><b>يظهر العضو هنا من أول حضور له حصة أو أول درس يُكمله.</b></td></tr>`}</tbody>
  </table></div>
  <div class="vdim" style="margin-top:8px">اضغط على أي عضو لفتح قائمة إنجازه الكاملة في كل الدورات.</div>`;
}

function editRow(l) {
  return `<tr style="background:var(--tint)">
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
  await act('lesson/add', { title, url: $('#nl-url').value.trim(), durationMin: +$('#nl-dur').value || 60, courseId: state.courseId });
}
async function importPlaylist() {
  const url = $('#pl-url').value.trim();
  if (!/^https?:\/\//.test(url)) return toast('الصق رابط قائمة التشغيل أولاً', true);
  const btn = $('#pl-btn');
  btn.disabled = true;
  btn.innerHTML = 'جارٍ قراءة القائمة…';
  try {
    await act('playlist/import', { url, durationMin: +$('#pl-dur').value || 60, courseId: state.courseId });
    $('#pl-url').value = '';
  } catch (e) { /* toast already shown by act */ }
  finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('plus')} استيراد`;
  }
}
async function delLesson(id, title) {
  if (!confirm(`حذف الدرس «${title}»؟ سيُحذف مع مواعيده.`)) return;
  await act('lesson/remove', { id });
}
async function moveSess(id) {
  await act('session/move', { id, date: $('#sd-' + id).value, time: $('#st-' + id).value });
}
async function saveCourse() {
  const title = $('#c-title').value.trim();
  if (!title) return toast('العنوان مطلوب', true);
  const err = cadenceError('tpl');
  if (err) return toast(err, true);
  await act('course/update', { id: state.courseId, title, ...readCadence('tpl') });
}
async function genCourse() {
  await act('course/generate', { id: state.courseId });
}
async function delCourse(id, title) {
  if (!confirm(`حذف دورة «${title}» بكل دروسها ومواعيدها؟ لا يمكن التراجع.`)) return;
  await act('course/remove', { id });
  location.hash = '#/courses';
}
async function addQuestion() {
  const question = $('#q-text').value.trim();
  const options = [1, 2, 3, 4].map(n => $('#q-opt' + n).value.trim()).filter(Boolean);
  if (!question || options.length < 2) return toast('اكتب السؤال وخيارين على الأقل', true);
  await act('question/add', {
    courseId: state.courseId,
    lessonId: $('#q-lesson').value || null,
    question, options,
    correctIndex: +$('#q-correct').value,
  });
}

/* ============ BOOKS & READING GROUPS ============ */
function rBooks(v) {
  const d = state.data;
  $('#page-actions').innerHTML = `<span class="dim">${d.books.length} كتاب · ${d.groups.length} مجموعة</span>`;
  const bookOpts = d.books.map(b => `<option value="${b.id}">${esc(b.title)} — ${b.total_pages} صفحة</option>`).join('');

  const bookRows = d.books.map(b => `<tr>
    <td><b>${esc(b.title)}</b>${b.has_pdf ? ' <span class="pill warn" title="متاح للتحميل من لوحة العضو">📄 PDF</span>' : ''}</td>
    <td class="dim">${b.total_pages}</td>
    <td style="min-width:140px">${b.readers
      ? `<div class="dim" style="margin-bottom:5px">${b.readers} قارئ${b.finished ? ` · أكمله ${b.finished}` : ''}</div><div class="bar" style="margin-top:0"><i style="transform:scaleX(${Math.min(1, b.avg_pct / 100).toFixed(3)})"></i></div><div class="vdim">متوسط التقدّم ${b.avg_pct}%</div>`
      : '<span class="vdim">لا قرّاء بعد</span>'}</td>
    <td class="actions"><button class="btn danger sm icon" title="حذف" onclick="delBook(${b.id},${JSON.stringify(b.title).replace(/"/g, '&quot;')})">${icon('trash')}</button></td>
  </tr>`).join('');

  const groups = d.groups.map(g => {
    const roster = g.roster || [];
    const rows = roster.map(m => {
      const pct = m.total_pages ? Math.min(1, m.page / m.total_pages) : 0;
      return `<tr style="cursor:pointer" onclick="openMember('${m.user_id}')">
        <td><b>${esc(m.name)}</b>${m.finished ? ' <span class="pill ok">أكمله 🎉</span>' : ''}</td>
        <td style="min-width:130px"><div class="dim" style="margin-bottom:5px">${m.page}/${m.total_pages}</div><div class="bar" style="margin-top:0"><i style="transform:scaleX(${pct.toFixed(3)})"></i></div></td>
        <td class="vdim">${m.updated_at ? fmt(m.updated_at) : '—'}</td>
      </tr>`;
    }).join('');
    const done = roster.filter(m => m.finished).length;
    return `<div class="surface">
      <h2 style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span>📚 ${esc(g.title)} — ${esc(g.book_title)}</span>
        <button class="btn danger sm" onclick="act('group/end',{id:${g.id}})">إنهاء المجموعة</button>
      </h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>العضو</th><th>الصفحة</th><th>آخر تحديث</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="empty">لا أعضاء بعد — يضمّون بأنفسهم من زر «📖 أنضم» في إعلان الديسكورد.</td></tr>`}</tbody>
      </table></div>
      <div class="vdim" style="margin-top:8px">${roster.length} أعضاء · أكمل الكتاب ${done} · التقدّم يُحدَّث لحظياً من أزرار الديسكورد.</div>
    </div>`;
  }).join('');

  v.innerHTML = `
  <div class="surface"><h2>كتاب جديد</h2>
    <div class="frow">
      <div style="flex:3;min-width:200px"><label>عنوان الكتاب</label><input id="bk-title" placeholder="مثال: رياض الصالحين"></div>
      <div style="flex:0;min-width:110px"><label>عدد الصفحات</label><input id="bk-pages" type="number" value="200" style="width:100%"></div>
      <div style="flex:0 0 auto"><button class="btn" onclick="addBook()">${icon('plus')} إضافة كتاب</button></div>
    </div>
  </div>
  <div class="surface"><h2>مجموعة قراءة جديدة</h2>
    <div class="frow">
      <div style="flex:2;min-width:170px"><label>اسم المجموعة <span class="vdim">(اختياري)</span></label><input id="gr-title" placeholder="افتراضياً اسم الكتاب"></div>
      <div style="flex:2;min-width:200px"><label>الكتاب</label><select id="gr-book" style="width:100%">${bookOpts}</select></div>
      <div style="flex:0 0 auto"><button class="btn" onclick="addGroup()">${icon('plus')} إنشاء وإعلان</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">يُعلن عنها في الديسكورد مع زر «📖 أنضم» وزر «📝 سجّل صفحتك» — كل عضو يسجّل الصفحة التي وصل إليها وتظهر لك هنا مباشرة.</div>
  </div>
  ${groups}
  <div class="surface"><h2>الكتب (${d.books.length})</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>الكتاب</th><th>الصفحات</th><th>التقدّم</th><th></th></tr></thead>
      <tbody>${bookRows || `<tr><td colspan="4" class="empty">لا كتب بعد — أضف كتاباً من الأعلى ثم أنشئ له مجموعة قراءة.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}
async function addBook() {
  const title = $('#bk-title').value.trim();
  if (!title) return toast('اكتب عنوان الكتاب', true);
  await act('book/add', { title, totalPages: +$('#bk-pages').value || 100 });
}
async function delBook(id, title) {
  if (!confirm(`حذف كتاب «${title}»؟ تنتهي مجموعاته معه.`)) return;
  await act('book/remove', { id });
}
async function addGroup() {
  const bookId = +$('#gr-book').value;
  if (!bookId) return toast('أضف كتاباً أولاً', true);
  await act('group/add', { title: $('#gr-title').value.trim(), bookId });
}

/* ============ MEMBERS ============ */
/* engagement: who keeps coming, who is drifting — owner's job #3 ("see who's engaged") */
const ENG = {
  slipping: { label: 'متراجع', cls: 'warn', hint: 'حضر بعض الحصص الأخيرة فقط' },
  inactive: { label: 'منقطع', cls: 'bad', hint: 'لم يحضر أياً من آخر ٤ حصص' },
  never: { label: 'لم يحضر بعد', cls: 'plain', hint: 'تفاعل لكنه لم يدخل حصة' },
  regular: { label: 'منتظم', cls: 'ok', hint: 'حضر ٣ من آخر ٤ حصص أو أكثر' },
};
const ENG_ORDER = ['slipping', 'inactive', 'never', 'regular']; // who needs attention first
const engOf = p => p.engagement?.status ?? 'never';
// one dot per recent held class, oldest → newest in reading order
const attDots = e => !e?.recent?.length ? '<span class="vdim">—</span>'
  : `<span class="att-dots" title="آخر ${e.recent.length} حصص">${[...e.recent].reverse()
    .map(x => `<i class="${x ? 'on' : ''}"></i>`).join('')}</span>`;

function rMembers(v) {
  const d = state.data;
  $('#page-actions').innerHTML = `<span class="dim">${d.participants.length} عضو</span>`;
  const q = state.memberFilter.trim().toLowerCase();
  const seg = state.memberSeg || 'all';
  const counts = Object.fromEntries(ENG_ORDER.map(k => [k, d.participants.filter(p => engOf(p) === k).length]));
  const list = d.participants
    .filter(p => !q || p.name.toLowerCase().includes(q) || String(p.user_id).includes(q))
    .filter(p => seg === 'all' || engOf(p) === seg)
    .sort((a, b) => ENG_ORDER.indexOf(engOf(a)) - ENG_ORDER.indexOf(engOf(b))
      || String(b.engagement?.lastAt ?? '').localeCompare(String(a.engagement?.lastAt ?? '')));

  const rows = list.map(p => {
    const e = p.engagement, st = ENG[engOf(p)];
    return `<tr style="cursor:pointer" onclick="openMember('${p.user_id}')">
    <td><b>${esc(p.name)}</b>${p.dms_enabled ? '' : ' <span class="pill plain" title="أوقف رسائل البوت الخاصة">بلا رسائل</span>'}
      <div class="vdim m-only">${e?.lastAt ? 'آخر حضور ' + fmt(e.lastAt) : 'لم يحضر بعد'}</div></td>
    <td><span class="pill ${st.cls}" title="${st.hint}">${st.label}</span></td>
    <td>${attDots(e)}</td>
    <td class="dim opt">${e?.lastAt ? fmt(e.lastAt) : '—'}</td>
    <td class="opt">${p.lessons_done}/${d.lessons.length}</td>
    <td class="opt">${p.streak ? `${p.streak}` : '<span class="vdim">0</span>'}</td>
  </tr>`;
  }).join('');

  const segBtn = (k, label, n) => `<button class="seg${seg === k ? ' on' : ''}" onclick="state.memberSeg='${k}';render()">${label} <b>${n}</b></button>`;
  const attention = counts.slipping + counts.inactive;

  v.innerHTML = `
  <div class="surface" style="padding:12px 14px">
    <div class="eng-head">
      <div class="segs" role="group" aria-label="تصفية حسب الحضور">
        ${segBtn('all', 'الكل', d.participants.length)}
        ${ENG_ORDER.map(k => segBtn(k, ENG[k].label, counts[k])).join('')}
      </div>
      <div style="position:relative;flex:1;min-width:200px">
        <span style="position:absolute;inset-inline-start:10px;top:50%;transform:translateY(-50%);color:var(--text-3)">${icon('search')}</span>
        <input id="msearch" placeholder="ابحث بالاسم أو رقم العضو…" value="${esc(state.memberFilter)}" style="width:100%;padding-inline-start:36px">
      </div>
    </div>
    ${attention ? `<div class="eng-note">${counts.slipping ? `<b>${counts.slipping}</b> متراجع` : ''}${counts.slipping && counts.inactive ? ' · ' : ''}${counts.inactive ? `<b>${counts.inactive}</b> منقطع` : ''} — يظهرون أولاً؛ اضغط على العضو لترى سجلّه كاملاً.</div>` : ''}
  </div>
  <div class="surface"><h2>الأعضاء</h2>
    <div class="tbl-wrap eng-table"><table>
      <thead><tr><th>العضو</th><th>الحالة</th><th>آخر ٤ حصص</th><th class="opt">آخر حضور</th><th class="opt">الدروس</th><th class="opt">السلسلة</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">${q ? 'لا نتائج للبحث «' + esc(q) + '»'
        : seg !== 'all' ? `لا أعضاء «${ENG[seg].label}» الآن.`
        : 'لا أعضاء بعد.<br><b>يظهر العضو هنا من لحظة أول حضور أو أول درس يكمله.</b>'}</td></tr>`}</tbody>
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
  const tl = m.timeline.slice(0, 16).map(t => `<div class="tl-item">
    <div class="tl-ico">${icon(t.ico)}</div>
    <div><b>${esc(t.title)}</b><div class="vdim">${esc(t.sub)}</div></div>
    <div class="tl-when">${fmt(t.at)}</div>
  </div>`).join('');
  // per-course checklist: where this member reached in every course
  const courses = (m.courses || []).map(c => {
    const pct = c.total ? Math.min(1, c.done / c.total) : 0;
    const items = c.items.map(i => `<div class="ck-item${i.done ? ' done' : ''}">
      <span class="ck-mark">${i.done ? '✅' : '◻️'}</span>
      <span class="ck-pos">${i.position}</span>
      <span class="ck-title">${esc(i.title)}</span>
      ${i.done && i.completed_at ? `<span class="ck-when">${fmt(i.completed_at)}</span>` : ''}
    </div>`).join('');
    return `<div class="ck-course">
      <div class="ck-head">
        <b>${esc(c.title)}</b>
        <span class="dim">${c.done}/${c.total} · ${c.next ? 'التالي: ' + esc(c.next.title) : 'أكمل الدورة 🎉'}</span>
      </div>
      <div class="bar"><i style="transform:scaleX(${pct.toFixed(3)})"></i></div>
      <div class="ck-list">${items || '<div class="vdim" style="padding:6px 2px">لا دروس في هذه الدورة بعد</div>'}</div>
    </div>`;
  }).join('');
  const shelf = (m.books || []).slice(0, 8).map(b => `<div class="ck-item${b.finished ? ' done' : ''}">
    <span class="ck-mark">${b.finished ? '✅' : '📖'}</span>
    <span class="ck-title">${esc(b.title)}</span>
    <span class="ck-when">${b.finished ? 'أكمله 🎉' : `صفحة ${b.page}/${b.total_pages}`}</span>
  </div>`).join('');
  $('#drawer-body').innerHTML = `
    <div class="d-head">
      <div>
        <h2>${esc(m.name)}</h2>
        <div class="d-sub">سلسلة ${m.streak} · ${m.lessons_done}/${state.data.lessons.length} درساً · ${m.dms_enabled ? 'الإشعارات مفعّلة' : 'مكتوم الإشعارات'}</div>
      </div>
      <button class="d-close" onclick="closeDrawer()" aria-label="إغلاق">${icon('x')}</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn quiet sm" onclick="renameMember('${m.user_id}',${JSON.stringify(m.name).replace(/"/g, '&quot;')})">${icon('edit')} تعديل الاسم</button>
      <button class="btn danger sm" onclick="removeMember('${m.user_id}',${JSON.stringify(m.name).replace(/"/g, '&quot;')})">${icon('trash')} حذف العضو</button>
    </div>
    <div class="ck-wrap">${courses}${shelf ? `<div class="ck-course">
      <div class="ck-head"><b>📚 كتبي</b><span class="dim">${(m.books || []).filter(b => b.finished).length} مكتمل</span></div>
      <div class="ck-list" style="margin-top:8px">${shelf}</div>
    </div>` : ''}</div>
    <div class="tl">
      <h2 style="font-size:14px;color:var(--text-2);margin-bottom:2px">سجل النشاط</h2>
      ${tl || '<div class="empty">لا نشاط بعد</div>'}
    </div>`;
  $('#drawer').hidden = false;
  $('#drawer-scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-scrim').hidden = true; }
async function renameMember(id, name) {
  const n = prompt('الاسم الجديد للعضو:', name);
  if (n == null || !n.trim()) return;
  closeDrawer();
  await act('member/rename', { id, name: n.trim() });
}
async function removeMember(id, name) {
  if (!confirm(`حذف «${name}» نهائياً؟ تُحذف نقاطه وتقدمه وقناته الخاصة.`)) return;
  closeDrawer();
  await act('member/remove', { id });
}
$('#drawer-scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

/* ============ QUESTS ============ */
const QCATS = [
  ['book', 'الكتب'],
  ['lecture', 'المحاضرات'],
  ['course', 'الدورات'],
];
function rQuests(v) {
  const d = state.data;
  const groups = QCATS.map(([key, label]) => {
    const items = d.quests.filter(q => q.category === key);
    const rows = items.map(q => `<tr>
      <td><b>${esc(q.title)}</b></td>
      <td>${q.done ? `<span class="pill ok">أنجزه ${q.done}</span>` : '<span class="pill plain">لم ينجزه أحد بعد</span>'}</td>
      <td class="actions"><button class="btn danger sm" onclick="act('quest/end',{id:${q.id}})">${icon('trash')} حذف</button></td>
    </tr>`).join('');
    return `<div class="surface"><h2>${label} (${items.length})</h2>
      <div class="tbl-wrap"><table><tbody>
        ${rows || `<tr><td class="empty">لا شيء بعد — أضف من الأعلى.</td></tr>`}
      </tbody></table></div>
    </div>`;
  }).join('');

  const catOpts = QCATS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
  v.innerHTML = `
  <div class="surface"><h2>إضافة إلى قائمة الإنجاز</h2>
    <div class="frow">
      <div style="max-width:170px"><label>الفئة</label><select id="q-cat">${catOpts}</select></div>
      <div style="flex:2"><label>العنوان</label><input id="q-title" placeholder="مثال: كتاب فن اللامبالاة"></div>
      <div style="flex:0 0 auto;align-self:flex-end"><button class="btn" onclick="addQuest()">${icon('plus')} إضافة</button></div>
    </div>
    <div class="vdim" style="margin-top:9px">يُعلن العنصر في قناة الديسكورد مع زر «أنجزتها ✅» يضغطه كل طالب عند إتمامه، وتظهر النتيجة هنا مباشرة.</div>
  </div>
  ${groups}`;
}
async function addQuest() {
  const title = $('#q-title').value.trim();
  if (!title) return toast('اكتب العنوان', true);
  await act('quest/add', { title, category: $('#q-cat').value });
}

/* ============ SETTINGS ============ */
const SETTING_DEFS = [
  ['tz', 'المنطقة الزمنية'],
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
  </div>
  <div class="surface" id="sys"><h2>النظام</h2><div class="dim">جارٍ التحميل…</div></div>`;
  loadSystem();
}

/* ---------- system: backups, restore, YouTube cookies ---------- */
const ago = iso => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'اليوم' : d === 1 ? 'أمس' : `قبل ${d} أيام`;
};
async function loadSystem() {
  const box = document.getElementById('sys');
  if (!box) return;
  let st;
  try { st = await api('system'); } catch (e) { box.innerHTML = `<h2>النظام</h2><div class="dim">${esc(e.message)}</div>`; return; }
  const cookiesWarn = !st.cookies || st.cookies.ageDays > 30;
  const row = (label, value, warn = false) =>
    `<tr><td class="dim">${label}</td><td><b${warn ? ' style="color:var(--bad)"' : ''}>${value}</b></td></tr>`;
  box.innerHTML = `<h2>النظام</h2>
    <div class="tbl-wrap"><table style="min-width:0">
      ${row('كوكيز يوتيوب', st.cookies ? `مرفوعة ${ago(st.cookies.at)}` : 'غير موجودة — الصوت قد يُحظر', cookiesWarn)}
      ${row('آخر نسخة احتياطية', st.lastBackupAt ? `${fmt(st.lastBackupAt)} (${ago(st.lastBackupAt)})` : 'لم تُنشأ بعد', !st.lastBackupAt)}
      ${row('قاعدة البيانات', `${st.database.sizeMb} MB`)}
      ${row('ذاكرة الصوت المؤقتة', `${st.cacheMb} / ${st.cacheMaxMb} MB`, st.cacheMb > st.cacheMaxMb)}
      ${row('بطاقات الصور', st.cards ? 'تعمل ✓' : 'لا يوجد متصفح — نصوص بديلة', !st.cards)}
      ${row('آخر مشكلة صوت', st.lastAudioProblem ? `${esc(st.lastAudioProblem.lesson)} · ${fmt(st.lastAudioProblem.at)}` : 'لا شيء ✓')}
      ${row('مدة التشغيل / الذاكرة', `${st.uptimeMin} دقيقة · ${st.memoryMb} MB`)}
    </table></div>
    <div class="frow" style="margin-top:14px;gap:10px;flex-wrap:wrap">
      <label class="btn quiet" style="cursor:pointer">⬆️ رفع cookies.txt
        <input type="file" accept=".txt,text/plain" hidden onchange="uploadCookies(this)"></label>
      <button class="btn quiet" onclick="location.href='/api/dash/system/backup'">⬇️ تحميل نسخة احتياطية الآن</button>
      <label class="btn danger" style="cursor:pointer">♻️ استعادة قاعدة بيانات
        <input type="file" accept=".db,.sqlite,application/octet-stream" hidden onchange="uploadDb(this)"></label>
    </div>
    <div class="dim" style="margin-top:10px;font-size:13px">تُرسل نسخة احتياطية يومياً إلى رسائلك الخاصة في الديسكورد (الساعة ٤ فجراً) ويُحتفظ بآخر ٧ نسخ على الخادم.
    الكوكيز تُصدَّر من متصفح مسجّل الدخول إلى يوتيوب بإضافة «Get cookies.txt LOCALLY».</div>`;
}
async function postFile(path, file) {
  const r = await fetch('/api/dash/' + path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  if (r.status === 401) { location.href = '/login'; throw new Error('انتهت الجلسة'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'خطأ غير متوقع');
  return j;
}
async function uploadCookies(input) {
  const f = input.files?.[0]; input.value = '';
  if (!f) return;
  try { toast((await postFile('system/cookies', await f.text())).message); loadSystem(); }
  catch (e) { toast(e.message, true); }
}
async function uploadDb(input) {
  const f = input.files?.[0]; input.value = '';
  if (!f) return;
  if (!confirm(`استبدال كل بيانات الأكاديمية بمحتوى «${f.name}»؟\nتُحفظ نسخة من البيانات الحالية تلقائياً قبل الاستبدال.`)) return;
  toast('جارٍ الرفع والاستعادة…');
  try { toast((await postFile('system/restore', f)).message); await refresh(false); }
  catch (e) { toast(e.message, true); }
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
