// one-shot restyle: band+body wrappers for onboarding/list cards + palette map
const fs = require('fs');
let c = fs.readFileSync('src/coach/card.js', 'utf8');

// onboarding: head -> top, wrap content in .body
c = c.replace(`  return page(\`
  <div class="head">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">🎓 أهلاً بك في الأكاديمية</div></div>
    <div class="pills"><span class="pill">دورات · حصص مباشرة · كتب</span></div>
  </div>`,
`  return page(\`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">🎓 أهلاً بك في هُدَى</div></div>
    <div class="pills"><span class="pill">دورات · حصص مباشرة · كتب</span></div>
  </div>
  <div class="body">`);
c = c.replace(`  <div class="foot">ابدأ الآن: ادخل أول حصة وستجد لوحتك جاهزة</div>
  \`);`,
`  <div class="foot">ابدأ الآن: ادخل أول حصة وستجد لوحتك جاهزة</div>
  </div>\`);`);

// listCardHTML: head -> top, body wrap
c = c.replace(`  return page(\`
  <div class="head">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">${icon} ${esc(title)}</div></div>
    ${subtitle ? `<div class="pills"><span class="pill">${esc(subtitle)}</span></div>` : ''}
  </div>`,
`  return page(\`
  <div class="top">
    <div class="who"><img class="hlogo" src="${EMBLEM}" alt=""><div class="name">${icon} ${esc(title)}</div></div>
    ${subtitle ? `<div class="pills"><span class="pill">${esc(subtitle)}</span></div>` : ''}
  </div>
  <div class="body">`);
c = c.replace(`  <div class="foot">الأكاديمية</div>
  \`);`,
`  <div class="foot">هُدَى</div>
  </div>\`);`);

// palette map for everything left (inline styles)
const MAP = { '#e2a13c': '#C9992E', '#a89b80': '#59687F', '#6e6650': '#75849B', '#cabda2': '#2A4A8B', '#2a2318': '#EEF2F8', '#4a4028': '#E4CE92', '#f3ecdc': '#22314E', '#37301f': '#E3E8F0', '#1a1610': '#F7F9FC', '#241d12': '#E4EAF4', '#6b4d1e': '#E4CE92', '#5e5540': '#75849B', '#8ab87a': '#2F7D4F', '#2e2617': '#E3E8F0', '#14110c': '#16294F' };
for (const [o, n] of Object.entries(MAP)) c = c.split(o).join(n);
fs.writeFileSync('src/coach/card.js', c);
console.log('card.js fully restyled');

// memberdash.js: palette map its inline styles too
let m = fs.readFileSync('src/coach/memberdash.js', 'utf8');
for (const [o, n] of Object.entries(MAP)) m = m.split(o).join(n);
fs.writeFileSync('src/coach/memberdash.js', m);
console.log('memberdash palette mapped; head refs left:', (m.match(/class="head"/g) || []).length);
