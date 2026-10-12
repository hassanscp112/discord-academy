// HTML -> PNG card renderer (headless Edge/Chromium via puppeteer-core, no
// bundled browser). Falls back to null when no browser exists — callers then
// keep their plain embeds, so nothing ever breaks.
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

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
    launching = puppeteer.launch({
      executablePath: exePath(),
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
    }).then(b => { browser = b; launching = null; return b; })
      .catch(e => { console.log('[card] browser launch failed:', e.message); launching = null; return null; });
  }
  return launching;
}

// html must contain one element with id="card" — that element is screenshotted
export async function renderCard(html, { width = 860 } = {}) {
  const b = await getBrowser();
  if (!b) return null;
  let page;
  try {
    page = await b.newPage();
    await page.setViewport({ width: width + 40, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const el = await page.$('#card');
    return await (el ?? page).screenshot({ type: 'png' });
  } catch (e) {
    console.log('[card] render failed:', e.message);
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

// ---------- shared ink & amber card chrome (matches the web dashboard) ----------
const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent}
#card{width:860px;background:#14110c;border:1px solid #37301f;border-radius:18px;
  padding:32px 36px;font-family:'Tajawal',Tahoma,'Segoe UI',sans-serif;color:#f3ecdc}
.head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:20px}
.name{font-size:30px;font-weight:800;line-height:1.2}
.pills{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.pill{background:#2a2318;border:1px solid #4a4028;color:#e2a13c;font-weight:700;
  font-size:14.5px;padding:6px 14px;border-radius:99px;white-space:nowrap}
.stats{display:flex;gap:12px}
.stat{flex:1;background:#1a1610;border:1px solid #37301f;border-radius:12px;padding:13px 16px;text-align:center}
.stat .v{font-size:25px;font-weight:800;color:#e2a13c}
.stat .l{font-size:13px;color:#a89b80;margin-top:2px}
.sec{margin-top:22px}
.sec h3{font-size:16px;color:#cabda2;margin-bottom:10px;font-weight:700}
.row{display:flex;align-items:center;gap:12px;margin-bottom:9px}
.row .t{width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:15px}
.track{flex:1;height:10px;background:#241d12;border:1px solid #2e2617;border-radius:8px;overflow:hidden}
.fill{height:100%;background:#e2a13c;border-radius:8px;display:block}
.row .n{font-size:13.5px;color:#a89b80;white-space:nowrap;min-width:66px;text-align:left;font-weight:700}
.chip{font-size:13.5px;font-weight:700;white-space:nowrap}
.chip.ok{color:#8ab87a}.chip.no{color:#6e6650}
.next{margin-top:22px;background:#1a1610;border:1px solid #6b4d1e;border-radius:12px;
  padding:15px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.next .w{color:#a89b80;font-size:13.5px;white-space:nowrap}
.foot{margin-top:20px;color:#5e5540;font-size:12px;text-align:center}
`;

const page = body => `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style></head><body><div id="card">${body}</div></body></html>`;

const barRow = (t, sub, done, total, rightText) => `
<div class="row">
  <div class="t">${t}${sub ? ` <span style="color:#6e6650;font-weight:500;font-size:12.5px">· ${sub}</span>` : ''}</div>
  <div class="track"><i class="fill" style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
  <div class="n">${rightText}</div>
</div>`;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- member overview card ----------
export function memberCardHTML(d) {
  const courses = d.courses.slice(0, 4).map(c =>
    barRow(esc(c.title), c.next ? 'التالي: ' + esc(c.next).slice(0, 40) : 'مكتملة 🎉',
      c.done, c.total, `${c.done}/${c.total}`)).join('');
  const books = d.books.slice(0, 3).map(b =>
    barRow(esc(b.title), b.finished ? 'أكمله 🎉' : '', b.page, b.total_pages,
      b.finished ? '✅' : `${b.page}/${b.total_pages}`)).join('');
  return page(`
  <div class="head">
    <div class="name">📊 ${esc(d.name)}</div>
    <div class="pills">
      <span class="pill">${esc(d.level.emoji)} ${esc(d.level.name)}</span>
      ${d.rank ? `<span class="pill">🏅 المركز ${d.rank}</span>` : ''}
      <span class="pill">🔥 ${d.streak}</span>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="v">${d.xp}</div><div class="l">نقطة</div></div>
    <div class="stat"><div class="v">${d.lessonsDone}/${d.lessonsTotal}</div><div class="l">درس مكتمل</div></div>
    <div class="stat"><div class="v">${d.quests.done}/${d.quests.total}</div><div class="l">من قائمة الإنجاز</div></div>
  </div>
  ${courses ? `<div class="sec"><h3>📖 الدورات</h3>${courses}</div>` : ''}
  ${books ? `<div class="sec"><h3>📚 الكتب</h3>${books}</div>` : ''}
  ${d.nextSession ? `<div class="next"><b>${esc(d.nextSession.title)}</b><span class="w">⏰ ${esc(d.nextSession.when)}</span></div>` : ''}
  <div class="foot">لوحة تقدمك في الأكاديمية — تتحدث تلقائياً بعد كل إنجاز</div>
  `);
}

// ---------- library book card (one per book, posted in the library channel) ----------
export function bookCardHTML(book) {
  return page(`
  <div class="head">
    <div class="name">📖 ${esc(book.title)}</div>
    <div class="pills"><span class="pill">${book.total_pages} صفحة</span></div>
  </div>
  <div class="row" style="margin-top:6px">
    <div class="t" style="width:auto;color:#a89b80;font-weight:500">من مكتبة الأكاديمية — اضغط «📝 سجّل صفحتك» بالأسفل وابدأ تتبع قراءتك، حتى ولو بدأت من الصفحة الأولى. وصولك لآخر صفحة يعني إنهاء الكتاب 🎉</div>
  </div>
  `);
}

// ---------- onboarding guide card ----------
export function onboardingCardHTML() {
  const step = (n, t, d) => `
  <div style="display:flex;gap:14px;margin-bottom:14px;align-items:flex-start">
    <div style="width:34px;height:34px;border-radius:10px;background:#2a2318;border:1px solid #4a4028;color:#e2a13c;
      font-weight:800;font-size:17px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${n}</div>
    <div><div style="font-weight:800;font-size:16px">${t}</div>
    <div style="color:#a89b80;font-size:14px;margin-top:2px;line-height:1.5">${d}</div></div>
  </div>`;
  return page(`
  <div class="head">
    <div class="name">🎓 أهلاً بك في الأكاديمية</div>
    <div class="pills"><span class="pill">دورات · حصص مباشرة · كتب</span></div>
  </div>
  ${step(1, '🔊 احضر الحصة المباشرة',
    'في موعد الحصة يدخل المدرب غرفة الصوت ويشغّل صوت الدرس — ادخل الغرفة فقط، وكل دقيقة حضور تُحسب في نقاطك وسلسلتك.')}
  ${step(2, '📊 لوحتك الخاصة',
    'من أول حضور تظهر لك قناة خاصة باسمك فيها لوحة تقدمك: الدورات، الكتب، والإنجازات — تتحدث تلقائياً بعد كل إنجاز.')}
  ${step(3, '📖 دوراتك وكتبك',
    'أنهِ الدروس بزر «✅ أنهيت الدرس» من لوحتك، وتصفّح قناة «📚 المكتبة» واختر كتابك — سجّل صفحتك بضغطة زر، بدون مجموعة وبأي وقت.')}
  ${step(4, '🔔 اختر ما يُشعرك',
    'من تبويب «الإشعارات» في لوحتك فعّل التنبيه لدوراتك فقط — لا إزعاج بما لا تتابعه.')}
  ${step(5, '❓ أسئلة بعد الحصة',
    'بعد كل حصة قد يظهر سؤال في قناة الإعلانات — الإجابة الصحيحة تكسبك نقاطاً إضافية.')}
  <div class="next"><b>أوامر سريعة</b>
    <span class="w">/myprogress · /books · /group · /leaderboard</span></div>
  <div class="foot">ابدأ الآن: ادخل أول حصة وستجد لوحتك جاهزة</div>
  `);
}
// rows: { t, sub, done, total, right } or { t, ok } for plain status rows
export function listCardHTML({ icon, title, subtitle, rows }) {
  const body = rows.slice(0, 10).map(r => r.ok === undefined
    ? barRow(esc(r.t), r.sub ? esc(r.sub) : '', r.done, r.total, esc(r.right))
    : `<div class="row"><div class="t">${esc(r.t)}</div><div style="flex:1"></div><span class="chip ${r.ok ? 'ok' : 'no'}">${r.ok ? '✅ أنجزته' : '⬜ لم ينجزه بعد'}</span></div>`
  ).join('');
  return page(`
  <div class="head">
    <div class="name">${icon} ${esc(title)}</div>
    ${subtitle ? `<div class="pills"><span class="pill">${esc(subtitle)}</span></div>` : ''}
  </div>
  ${body || '<div class="row"><div class="t" style="color:#6e6650">لا يوجد شيء هنا بعد</div></div>'}
  <div class="foot">الأكاديمية</div>
  `);
}
