// Pull cookies from Edge via CDP (port 9223, temp profile copy) and write Netscape cookies.txt
import { writeFileSync } from 'node:fs';

const PORT = 9223;
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('no page target', targets.map(t => t.type)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
await new Promise(r => ws.onopen = r);

const { cookies } = await send('Storage.getCookies'); // browser-wide
console.log('total cookies in jar:', cookies.length);

const keep = cookies.filter(c => /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)google\.com$/.test(c.domain));
console.log('youtube/google cookies:', keep.length);
const names = keep.map(c => c.name).sort();
console.log('names:', names.join(','));

const lines = [
  '# Netscape HTTP Cookie File',
  '# Exported from Edge (midad.azkar@gmail.com) via CDP for yt-dlp',
  '',
];
for (const c of keep) {
  const domain = c.domain;
  const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
  lines.push([domain, includeSub, c.path ?? '/', c.secure ? 'TRUE' : 'FALSE', expiry, c.name, c.value].join('\t'));
}
writeFileSync('data/cookies.txt', lines.join('\n') + '\n');
console.log('wrote data/cookies.txt with', keep.length, 'cookies');

// quick sanity: do we have the login-bearing cookies?
for (const want of ['SID', 'SAPISID', 'LOGIN_INFO', '__Secure-3PAPISID']) {
  console.log(want, keep.some(c => c.name === want) ? '✓' : '✗ MISSING');
}
ws.close();
