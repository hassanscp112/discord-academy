// HTML -> PNG card renderer (headless Edge/Chromium via puppeteer-core, no
// bundled browser). Falls back to null when no browser exists — callers then
// keep their plain embeds, so nothing ever breaks.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import puppeteer from 'puppeteer-core';

// قائمة تسلسل: بطاقة واحدة فقط في كل لحظة — كروميوم الجهاز لا يتحمل التوازي
let renderQueue = Promise.resolve();
export function renderCard(html, opts = {}) {
  const run = renderQueue.then(() => doRender(html, opts));
  renderQueue = run.catch(() => {});
  return run;
}
const FONTS_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fonts.css'), 'utf8');

// هُدَى emblem, inlined as a data URI so setContent() renders it without a server
const here = dirname(fileURLToPath(import.meta.url));
const EMBLEM = `data:image/png;base64,${readFileSync(join(here, '../../public/logo-card.png')).toString('base64')}`;

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

const exePath = () => CANDIDATES.find(p => existsSync(p)) ?? null;

export function cardRendererAvailable() {
  return !!exePath();
}

let browser = null;
let launching = null;
async function getBrowser() {
  if (browser?.connected) return browser;
  if (!launching) {
    const exe = exePath();
    launching = puppeteer.launch({
      executablePath: exe,
      // chrome-headless-shell (scripts/start.js on container hosts) needs the 'shell' mode
      headless: /chrome-headless-shell/i.test(exe ?? '') ? 'shell' : true,
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
      protocolTimeout: 90000,
    }).then(b => { browser = b; launching = null; return b; })
      .catch(e => { console.log('[card] browser launch failed:', e.message); launching = null; return null; });
  }
  return launching;
}

// html must contain one element with id="card" — that element is screenshotted
// one reusable page — page creation is expensive on weak hardware
let pagePool = null;
// slow hosts (bot-hosting.net gives 20% of a core) need far longer than a PC; CARD_TIMEOUT_MS to tune
const RENDER_TIMEOUT_MS = Number(process.env.CARD_TIMEOUT_MS) || 60000;
// boot warm-up: launch + one throwaway render, so the first member card doesn't pay for
// Chromium start, font parsing and the fontconfig cache build
export async function warmCardRenderer() {
  if (!await getBrowser()) return;
  const t0 = Date.now();
  const ok = await renderCard(page('<div style="padding:20px;font-weight:800">هُدَى 📖🔔</div>'));
  console.log(`[card] warm-up ${ok ? 'ok' : 'failed'} in ${Math.round((Date.now() - t0) / 1000)}s`);
}

async function doRender(html, { width = 860 } = {}) {
  const b = await getBrowser();
  if (!b) return null;
  try {
    if (!pagePool || pagePool.isClosed()) { // reuse the one page; only reopen if it died
      pagePool = await b.newPage();
      await pagePool.setViewport({ width: width + 40, height: 600, deviceScaleFactor: 1.5 });
    }
    // everything is inlined (fonts, logo) — wait for load + fonts, not for network silence
    await pagePool.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    await pagePool.evaluate(() => document.fonts.ready);
    const el = await pagePool.$('#card');
    return await (el ?? pagePool).screenshot({ type: 'jpeg', quality: 88 });
  } catch (e) {
    console.log('[card] render failed:', e.message);
    await pagePool?.close().catch(() => {});
    pagePool = null;
    return null;
  }
}

// ---------- shared ink & amber card chrome (matches the web dashboard) ----------
const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent}
#card{width:860px;background:#FFFFFF;border:1px solid #E3E8F0;border-radius:14px;overflow:hidden;
  font-family:'Tajawal',Tahoma,'Segoe UI',sans-serif;color:#22314E;
  box-shadow:0 6px 24px rgba(22,41,79,.10)}
.top{background:linear-gradient(135deg,#24468B 0%,#1E3A6E 55%,#152A52 100%);
  padding:24px 32px;display:flex;justify-content:space-between;align-items:center;gap:14px}
.who{display:flex;align-items:center;gap:14px;min-width:0}
.hlogo{width:48px;height:48px;border-radius:12px;flex-shrink:0;background:#FFFFFF;padding:3px}
.name{font-size:28px;font-weight:800;line-height:1.25;color:#FFFFFF}
.pills{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.pill{background:#C9992E;color:#16294F;font-weight:800;
  font-size:14px;padding:6px 14px;border-radius:8px;white-space:nowrap}
.pill.ghost{background:rgba(255,255,255,.10);color:#E4CE92;border:1px solid rgba(228,206,146,.45);font-weight:700}
.body{padding:24px 32px 28px}
.stats{display:flex;gap:12px}
.stat{flex:1;background:#F7F9FC;border:1px solid #E3E8F0;border-radius:10px;padding:13px 16px;text-align:center}
.stat .v{font-size:24px;font-weight:800;color:#1E3A6E}
.stat .l{font-size:13px;color:#75849B;margin-top:2px}
.sec{margin-top:20px}
.sec h3{font-size:15px;color:#2A4A8B;margin-bottom:10px;font-weight:800;display:flex;align-items:center;gap:8px}
.sec h3::before{content:'';width:14px;height:4px;border-radius:4px;background:#C9992E;display:inline-block}
.row{display:flex;align-items:center;gap:12px;margin-bottom:9px}
.row .t{width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:15px;color:#22314E}
.track{flex:1;height:10px;background:#E4EAF4;border-radius:6px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,#C9992E,#DBAF41);border-radius:6px;display:block}
.row .n{font-size:13.5px;color:#59687F;white-space:nowrap;min-width:66px;text-align:left;font-weight:700}
.chip{font-size:13.5px;font-weight:700;white-space:nowrap}
.chip.ok{color:#2F7D4F}.chip.no{color:#75849B}
.next{margin-top:20px;background:#FAF4E3;border:1px solid #E4CE92;border-radius:10px;
  padding:15px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;color:#16294F}
.next .w{color:#8F6B15;font-size:13.5px;white-space:nowrap;font-weight:700}
.foot{margin-top:18px;color:#75849B;font-size:12px;text-align:center}
`;

const page = body => `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<style>${FONTS_CSS}</style>
<style>${BASE_CSS}</style></head><body><div id="card">${body}</div></body></html>`;

const barRow = (t, sub, done, total, rightText) => `
<div class="row">
  <div class="t">${t}${sub ? ` <span style="color:#75849B;font-weight:500;font-size:12.5px">· ${sub}</span>` : ''}</div>
  <div class="track"><i class="fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
  <div class="n">${rightText}</div>
</div>`;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- member overview card ----------
export function memberCardHTML(d) {
  const courses = d.courses.slice(0, 4).map(c =>
    barRow(esc(c.title), !c.total ? 'لا دروس بعد' : c.next ? 'التالي: ' + esc(String(c.next).slice(0, 40)) : 'مكتملة 🎉',
      c.done, c.total, `${c.done}/${c.total}`)).join('');
  const books = d.books.slice(0, 3).map(b =>
    barRow(esc(b.title), b.finished ? 'أكمله 🎉' : '', b.page, b.total_pages,
      b.finished ? '✅' : `${b.page}/${b.total_pages}`)).join('');
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">${esc(d.name)}</div></div>
    <div class="pills">
      <span class="pill ghost">🔥 سلسلة ${d.streak}</span>
    </div>
  </div>
  <div class="body">
  <div class="stats">
    <div class="stat"><div class="v">${d.lessonsDone}/${d.lessonsTotal}</div><div class="l">درس مكتمل</div></div>
    <div class="stat"><div class="v">${d.quests.done}/${d.quests.total}</div><div class="l">من قائمة الإنجاز</div></div>
  </div>
  ${courses ? `<div class="sec"><h3>📖 الدورات</h3>${courses}</div>` : ''}
  ${books ? `<div class="sec"><h3>📚 الكتب</h3>${books}</div>` : ''}
  ${d.nextSession ? nextBox(d.nextSession) : ''}
  <div class="foot">هُدَى · لوحة تقدمك — تتحدث تلقائيًا بعد كل إنجاز</div>
  </div>
  `);
}

// ---------- library book card (one per book, posted in the library channel) ----------
export function bookCardHTML(book) {
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">📖 ${esc(book.title)}</div></div>
    <div class="pills">${book.genre ? `<span class="pill ghost">${esc(book.genre)}</span>` : ''}<span class="pill">${book.total_pages} صفحة</span>${book.pdf_msg_id ? '<span class="pill ghost">⬇️ PDF</span>' : ''}</div>
  </div>
  <div class="body" style="padding:20px 32px 24px">
    <div style="color:#59687F;font-size:14.5px;line-height:1.7">من مكتبة الأكاديمية — اضغط «📝 سجّل صفحتك» بالأسفل وابدأ تتبع قراءتك، حتى ولو بدأت من الصفحة الأولى. وصولك لآخر صفحة يعني إنهاء الكتاب 🎉</div>
  </div>
  `);
}

// ---------- "you attended" card, posted in the member's private channel after class ----------
// d: { name, lesson, partLine, minutes, streak, course: { title, done, total } | null, lessonDone }
export function classDoneCardHTML(d) {
  const c = d.course;
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">✅ حضرت الحصة</div></div>
    <div class="pills"><span class="pill">🔥 سلسلة ${d.streak}</span></div>
  </div>
  <div class="body">
    <div style="font-size:20px;font-weight:800;margin-bottom:4px">${esc(d.lesson)}</div>
    ${d.partLine ? `<div class="dim" style="color:#59687F;font-size:14px">${esc(d.partLine)}</div>` : ''}
    <div class="stats" style="margin-top:16px">
      <div class="stat"><div class="v">${d.minutes}</div><div class="l">دقيقة حضور</div></div>
      <div class="stat"><div class="v">${d.streak}</div><div class="l">حصص متتالية</div></div>
      ${c ? `<div class="stat"><div class="v">${c.done}/${c.total}</div><div class="l">${esc(c.title)}</div></div>` : ''}
    </div>
    <div class="next" style="margin-top:18px"><b>${d.lessonDone
      ? 'اكتمل هذا الدرس — علّمه بالزر أدناه لتحديث تقدّمك'
      : 'يُستكمل الدرس في الحصة القادمة — نراك هناك'}</b><span class="w">بارك الله فيك</span></div>
    <div class="foot">هُدَى · «من سلك طريقًا يلتمس فيه علمًا سهّل الله له به طريقًا إلى الجنة»</div>
  </div>
  `);
}

// ---------- onboarding guide card ----------
export function onboardingCardHTML() {
  const step = (n, t, d) => `
  <div style="display:flex;gap:14px;margin-bottom:14px;align-items:flex-start">
    <div style="width:34px;height:34px;border-radius:10px;background:#EEF2F8;border:1px solid #E4CE92;color:#C9992E;
      font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${n}</div>
    <div><div style="font-weight:800;font-size:16px">${t}</div>
    <div style="color:#59687F;font-size:14px;margin-top:2px;line-height:1.5">${d}</div></div>
  </div>`;
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">🎓 أهلاً بك في هُدَى</div></div>
    <div class="pills"><span class="pill">دورات · حصص مباشرة · كتب</span></div>
  </div>
  <div class="body">
  ${step(1, '🔊 احضر الحصة المباشرة',
    'في موعد الحصة يدخل المدرب غرفة الصوت ويشغّل صوت الدرس — ادخل الغرفة فقط، وكل حضور يُحسب في سلسلتك وتقدّمك.')}
  ${step(2, '📊 لوحتك الخاصة',
    'من أول حضور تظهر لك قناة خاصة باسمك فيها لوحة تقدمك: الدورات، الكتب، والإنجازات — تتحدث تلقائياً بعد كل إنجاز.')}
  ${step(3, '📖 دوراتك وكتبك',
    'أنهِ الدروس بزر «✅ أنهيت الدرس» من لوحتك، وتصفّح قناة «📚 المكتبة» واختر كتابك — سجّل صفحتك بضغطة زر، بدون مجموعة وبأي وقت.')}
  ${step(4, '🔔 اختر ما يُشعرك',
    'من تبويب «الإشعارات» في لوحتك فعّل التنبيه لدوراتك فقط — لا إزعاج بما لا تتابعه.')}
  ${step(5, '❓ أسئلة بعد الحصة',
    'بعد كل حصة قد يظهر سؤال في قناة الإعلانات — أجب عليه لتثبيت ما تعلّمته.')}
  <div class="next"><b>أوامر سريعة</b>
    <span class="w" dir="ltr">/myprogress · /books · /group</span></div>
  <div class="foot">ابدأ الآن: ادخل أول حصة وستجد لوحتك جاهزة</div>
  </div>
  `);
}
// rows: { t, sub, done, total, right } or { t, ok } for plain status rows
export function listCardHTML({ icon, title, subtitle, rows }) {
  const body = rows.slice(0, 10).map(r => r.ok === undefined
    ? barRow(esc(r.t), r.sub ? esc(r.sub) : '', r.done, r.total, esc(r.right))
    : `<div class="row"><div class="t">${esc(r.t)}</div><div style="flex:1"></div><span class="chip ${r.ok ? 'ok' : 'no'}">${r.ok ? '✅ أنجزته' : '⬜ لم ينجزه بعد'}</span></div>`
  ).join('');
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">${icon} ${esc(title)}</div></div>
    ${subtitle ? `<div class="pills"><span class="pill">${esc(subtitle)}</span></div>` : ''}
  </div>
  <div class="body">
  ${body || '<div class="row"><div class="t" style="color:#75849B">لا يوجد شيء هنا بعد</div></div>'}
  <div class="foot">هُدَى</div>
  </div>
  `);
}

// ---------- 📊 academy dashboard card (public board channel) ----------
// "next class" box shared by the member and hub cards
const nextBox = ns => `<div class="next"><div><div class="w" style="margin-bottom:3px">⏰ الحصة القادمة</div>
  <b>${esc(ns.title)}</b></div><span class="w">${esc(ns.when)}</span></div>`;

export function academyCardHTML(d) {
  // a course is complete only when every lesson is done — not merely "nothing scheduled"
  const courseSub = c => !c.total ? 'لا دروس بعد'
    : c.done >= c.total ? 'مكتملة 🎉'
    : c.next ? '🗓️ ' + esc(c.next) : 'لا حصة مجدولة';
  const courses = d.courses.slice(0, 5).map(c => barRow(esc(c.title), courseSub(c),
    c.done, c.total, `${c.done}/${c.total}`)).join('');
  return page(`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">هُدَى · لوحة الأكاديمية</div></div>
    <div class="pills"><span class="pill ghost">${esc(d.now)}</span></div>
  </div>
  <div class="body">
  <div class="stats">
    <div class="stat"><div class="v">${d.members}</div><div class="l">عضوًا</div></div>
    <div class="stat"><div class="v">${d.lessonsDone}/${d.lessonsTotal}</div><div class="l">درسًا أُنجز</div></div>
    <div class="stat"><div class="v">${d.booksRead}/${d.booksTotal}</div><div class="l">كتابًا قُرئ</div></div>
  </div>
  ${courses ? `<div class="sec"><h3>🎓 الدورات</h3>${courses}</div>` : ''}
  ${d.nextSession ? nextBox(d.nextSession) : ''}
  <div class="foot">تتحدث تلقائيًا بعد كل حدث في الأكاديمية · اشترك في دورتك من بطاقتها أدناه</div>
  </div>
  `);
}
