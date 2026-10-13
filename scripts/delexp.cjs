const fs = require('fs');
const rd = f => fs.readFileSync(f, 'utf8');
const wr = (f, s) => fs.writeFileSync(f, s);

// 1) acadashboard.js — drop leaderboard data
let a = rd('src/coach/acadashboard.js');
a = a.replace("    top: o.leaderboard.slice(0, 3),\n", "");
wr('src/coach/acadashboard.js', a);

// 2) card.js — academy card: remove المتصدرون; member card: remove xp tile + level/rank pills; onboarding line
let c = rd('src/coach/card.js');
c = c.replace("  const top = d.top.map((r, i) => `${medal[i] ?? '▫️'} **${esc(r.name ?? r.display_name ?? 'عضو')}** — ${r.xp} نقطة`).join('\\n');\n", "");
c = c.replace("  const medal = ['🥇', '🥈', '🥉'];\n", "");
c = c.replace("  ${top ? `<div class=\"sec\"><h3>🏆 المتصدرون</h3><div style=\"font-size:15px;line-height:2\">${top}</div></div>` : ''}\n", "");
c = c.replace(`    <div class="stat"><div class="v">\${d.xp}</div><div class="l">نقطة</div></div>\n`, "");
c = c.replace(`      <span class="pill">\${esc(d.level.emoji)} \${esc(d.level.name)}</span>\n`, "");
c = c.replace(`      \${d.rank ? `<span class="pill ghost">🏅 المركز \${d.rank}</span>` : ''}\n`, "");
c = c.replace("/myprogress · /books · /group · /leaderboard", "/myprogress · /books · /group");
wr('src/coach/card.js', c);

// 3) templates.js — de-XP texts, drop level_up
let t = rd('src/core/templates.js');
t = t.replace("'✅ **انتهت الحصة** — بارك الله في كل من حضر **{{lesson_title}}**!{{part_line}}\\n' +\n    'للحاضرين **{{xp}} نقطة**. لا تنسوا تعليم الدرس كمكتمل:',",
              "'✅ **انتهت الحصة** — بارك الله في كل من حضر **{{lesson_title}}**!{{part_line}}\\n' +\n    'لا تنسوا تعليم الدرس كمكتمل:'");
t = t.replace("'{{mention}} أكمل **{{lesson_title}}**! 🎉 (+{{xp}} نقطة)'",
              "'{{mention}} أكمل **{{lesson_title}}**! 🎉'");
t = t.replace(/  level_up:\n    '[^\n]*\n\n/, "");
wr('src/core/templates.js', t);

// 4) sessions.js — quiz text without نقطة
let s = rd('src/coach/sessions.js');
s = s.replace("_أول إجابة صحيحة تكسب ${q.xp} نقطة_", "_كن أول من يجيب إجابة صحيحة_");
wr('src/coach/sessions.js', s);

// 5) memberdash.js — text-fallback embed without XP line
let m = rd('src/coach/memberdash.js');
m = m.replace("    value: `**${xp} XP** · ${lvl.emoji} **${lvl.name}** · 🔥 سلسلة **${streak}**${rank ? ` · المركز **${rank}**` : ''}`,",
              "    value: `🔥 سلسلة **${streak}** · دروس مكتملة **${A.lessonsDoneBy ? A.lessonsDoneBy(userId) : ''}**`,");
wr('src/coach/memberdash.js', m);

// 6) commands.js — remove /leaderboard command + handler; fix myprogress line
let k = rd('src/coach/commands.js');
k = k.replace("  new SlashCommandBuilder().setName('leaderboard').setDescription('XP leaderboard'),\n", "");
wr('src/coach/commands.js', k);
console.log('patched; leaderboard cmd removed');
