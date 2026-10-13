// قناة التسجيل بالدورات: لكل دورة بطاقة ثابتة فيها زر «🔔 الاشتراك» —
// الضغط يضيف العضو لقائمة التنبيهات ويمنحه رول الدورة (يُنشأ تلقائيًا)،
// فيصبح الping على شكل منشن للرول بدل المنشن الفردي.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as A from '../core/academy.js';
import { getDb, getSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { fmtInTz } from '../core/time.js';
import { ensureDashboardChannel } from './acadashboard.js';

// NOTE: discord normalizes channel names (spaces -> dashes)
const CHANNEL_NAME = '🔔-التسجيل-بالدورات';
const roleColor = 0xe2a13c; // amber — لون هوية الأكاديمية

const cadenceText = (tpl) => {
  const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  if (tpl.mode === 'daily') return `يوميًا الساعة ${tpl.time}`;
  if (tpl.mode === 'interval') return `كل ${tpl.everyN} أيام الساعة ${tpl.time}`;
  const names = (tpl.days || []).map(d => DAYS[d] ?? d).join(' و');
  return `${names || 'حسب الجدول'} الساعة ${tpl.time}`;
};

function nextSessionOf(courseId) {
  return getDb().prepare(
    "SELECT s.scheduled_at, l.title AS lesson_title FROM sessions s JOIN lessons l ON l.id = s.lesson_id " +
    "WHERE l.course_id = ? AND s.status IN ('scheduled','reminded','live') ORDER BY s.scheduled_at LIMIT 1"
  ).get(courseId);
}

function cardContent(course) {
  const ns = nextSessionOf(course.id);
  const next = ns
    ? `الحصة القادمة: **${ns.lesson_title}** — ${fmtInTz(new Date(ns.scheduled_at), config.tz)}`
    : 'لا توجد حصص مجدولة حاليًا.';
  return [
    `# 🎓 ${course.title}`,
    `التكرار: ${cadenceText(course.template)} · ${next}`,
    'اضغط **🔔 الاشتراك** لتصلك منشنات هذه الدورة (وتُمنح رول الدورة تلقائيًا).',
  ].join('\n');
}

function cardRows(courseId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`csub:${courseId}`).setLabel('🔔 الاشتراك بالتنبيهات').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cunsub:${courseId}`).setLabel('🔕 إلغاء الاشتراك').setStyle(ButtonStyle.Secondary),
  )];
}



// تنظيف القناة القديمة المنفصلة (إن وُجدت) — البطاقات كلها في إعلانات الأكاديمية الآن
async function removeLegacyChannel(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const old = guild.channels.cache.find(c => c.name === CHANNEL_NAME);
  if (!old) return;
  try { await old.delete(); console.log('[coursereg] legacy channel removed'); } catch (e) { console.log('[coursereg] legacy channel delete failed:', e.message); }
  getDb().prepare('UPDATE courses SET reg_msg_id = NULL').run();
}

// رول الدورة — يُنشأ مرة واحدة ويُخزن مع الدورة
async function ensureRole(client, course) {
  const guild = client.guilds.cache.get(config.guildId);
  if (course.role_id && guild.roles.cache.has(course.role_id)) return course.role_id;
  const name = `🔔 ${course.title}`;
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) {
    try {
      role = await guild.roles.create({ name, colors: [roleColor], mentionable: false, reason: `تنبيهات دورة ${course.title}` });
      console.log('[coursereg] role created:', name);
    } catch (e) {
      console.log('[coursereg] cannot create role (need Manage Roles):', e.message);
      return null; // بدون رول — يبقى الاشتراك بالمنشن الفردي
    }
  }
  getDb().prepare('UPDATE courses SET role_id = ? WHERE id = ?').run(role.id, course.id);
  return role.id;
}

// زر الاشتراك/إلغاء الاشتراك — يُستدعى من handleButton (idempotent)
export async function handleSubscribe(interaction, courseId, wantJoin) {
  const course = A.getCourse(Number(courseId));
  if (!course) return interaction.reply({ content: '⚠️ هذه الدورة لم تعد موجودة.', ephemeral: true }).catch(() => {});
  const isSubscribed = A.courseSubscribers(course.id).includes(interaction.user.id);
  const nowSubscribed = wantJoin ?? !isSubscribed;
  if (nowSubscribed !== isSubscribed) A.toggleCourseSub(course.id, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
  if (course.role_id && interaction.member?.roles) {
    try {
      if (nowSubscribed) await interaction.member.roles.add(course.role_id, 'اشتراك بتنبيهات الدورة');
      else await interaction.member.roles.remove(course.role_id, 'إلغاء اشتراك الدورة');
    } catch (e) { console.log('[coursereg] role toggle failed:', e.message); }
  }
  const n = A.courseSubscribers(course.id).length;
  return interaction.reply({
    content: nowSubscribed
      ? `✅ تم تفعيل تنبيهات **${course.title}** — سنذكّرك قبل كل حصة. (المشتركون: ${n})`
      : `🔕 تم إيقاف تنبيهات **${course.title}**. نرحب بعودتك في أي وقت.`,
    ephemeral: true,
  }).catch(() => {});
}

// مزامنة البطاقات: تنشر/تحدّث بطاقة كل دورة، وتحذف بطاقات الدورات الميتة
export async function syncCourseCards(client) {
  if (!client?.isReady?.()) return;
  await removeLegacyChannel(client);
  const ch = await ensureDashboardChannel(client);
  if (!ch) return;
  const courses = A.listCourses();
  const liveIds = new Set(courses.map(c => String(c.id)));
  for (const course of courses) {
    await ensureRole(client, course);
    try {
      const payload = { content: cardContent(course), components: cardRows(course.id) };
      if (course.reg_msg_id) {
        try {
          const msg = await ch.messages.fetch(course.reg_msg_id);
          await msg.edit(payload);
          continue;
        } catch {
          // ليست في قناة اللوحة — أزلها من الإعلانات ثم انشرها هنا
          try {
            const ann = await client.channels.fetch(getSetting('channel_dashboard'));
            const old = await ann.messages.fetch(course.reg_msg_id);
            await old.delete();
          } catch {}
        }
      }
      const m = await ch.send(payload);
      getDb().prepare('UPDATE courses SET reg_msg_id = ? WHERE id = ?').run(m.id, course.id);
    } catch (e) { console.log(`[coursereg] card sync failed for #${course.id}:`, e.message); }
  }
  // تنظيف بطاقات الدورات المحذوفة
  const stale = getDb().prepare('SELECT id, reg_msg_id FROM courses WHERE reg_msg_id IS NOT NULL').all()
    .filter(c => !liveIds.has(String(c.id)));
  for (const c of stale) {
    if (liveIds.has(String(c.id))) continue;
    try { const msg = await ch.messages.fetch(c.reg_msg_id); await msg.delete(); } catch {}
    getDb().prepare('UPDATE courses SET reg_msg_id = NULL WHERE id = ?').run(c.id);
  }
}
