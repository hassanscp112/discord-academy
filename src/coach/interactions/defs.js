// Slash-command + context-menu definitions, registered per guild at boot.
import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, PermissionFlagsBits } from 'discord.js';

export const commandDefs = [
  new SlashCommandBuilder().setName('lesson').setDescription('إدارة دروس الدورة (للإدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('add').setDescription('إضافة درس')
      .addStringOption(o => o.setName('title').setDescription('عنوان الدرس').setRequired(true))
      .addStringOption(o => o.setName('url').setDescription('رابط يوتيوب'))
      .addIntegerOption(o => o.setName('duration').setDescription('المدة بالدقائق (الافتراضي 60)')))
    .addSubcommand(sc => sc.setName('list').setDescription('عرض الدروس'))
    .addSubcommand(sc => sc.setName('remove').setDescription('حذف درس')
      .addIntegerOption(o => o.setName('id').setDescription('رقم الدرس (انظر /lesson list)').setRequired(true))),
  new SlashCommandBuilder().setName('schedule').setDescription('إدارة جدول الحصص (للإدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('template').setDescription('موعد أسبوعي متكرر، مثل الأحد والأربعاء 20:00')
      .addStringOption(o => o.setName('days').setDescription('أيام مفصولة بفاصلة: sun,wed').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('الوقت HH:mm، مثل 20:00').setRequired(true)))
    .addSubcommand(sc => sc.setName('generate').setDescription('ملء المواعيد القادمة بالدروس التالية'))
    .addSubcommand(sc => sc.setName('list').setDescription('عرض الحصص المجدولة'))
    .addSubcommand(sc => sc.setName('move').setDescription('نقل حصة إلى تاريخ/وقت جديد')
      .addIntegerOption(o => o.setName('id').setDescription('رقم الحصة (انظر /schedule list)').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('التاريخ YYYY-MM-DD').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('الوقت HH:mm').setRequired(true)))
    .addSubcommand(sc => sc.setName('cancel').setDescription('إلغاء حصة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم الحصة').setRequired(true))),
  new SlashCommandBuilder().setName('setup').setDescription('إعداد قنوات الأكاديمية (للإدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('dashboard').setDescription('قناة اللوحة والإعلانات').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('study_vc').setDescription('القناة الصوتية للحصص').addChannelTypes(ChannelType.GuildVoice))
    .addRoleOption(o => o.setName('ping_role').setDescription('الرتبة التي تُنبَّه بتذكير الحصص')),
  new SlashCommandBuilder().setName('myprogress').setDescription('عرض تقدمك'),
  new SlashCommandBuilder().setName('quest').setDescription('قائمة إنجازات الأكاديمية')
    .addSubcommand(sc => sc.setName('list').setDescription('عرض عناصر القائمة')),
  new SlashCommandBuilder().setName('books').setDescription('📚 كتبي — تقدم القراءة'),
  new SlashCommandBuilder().setName('group').setDescription('📚 مجموعات القراءة')
    .addSubcommand(sc => sc.setName('list').setDescription('المجموعات النشطة'))
    .addSubcommand(sc => sc.setName('join').setDescription('انضم لمجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true)))
    .addSubcommand(sc => sc.setName('page').setDescription('سجّل صفحتك في كتاب المجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true))
      .addIntegerOption(o => o.setName('page').setDescription('الصفحة التي وصلت إليها').setRequired(true)))
    .addSubcommand(sc => sc.setName('leave').setDescription('خرج من مجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true))),
  new SlashCommandBuilder().setName('pdf').setDescription('📚 مكتبة PDF — نشر في فورم المكتبة (إدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('add').setDescription('أنزل PDF كتاب كمنشور في فورم المكتبة')
      .addStringOption(o => o.setName('book').setDescription('عنوان الكتاب (موجود أو جديد)').setRequired(true))
      .addAttachmentOption(o => o.setName('file').setDescription('ملف الـPDF').setRequired(true))
      .addStringOption(o => o.setName('genre').setDescription('التصنيف (تاغ الفورم): عقيدة، فقه، حديث…'))
      .addIntegerOption(o => o.setName('pages').setDescription('عدد الصفحات (إن كان كتاباً جديداً)')))
    .addSubcommand(sc => sc.setName('remove').setDescription('فك ربط PDF عن كتاب وحذف منشوره')
      .addStringOption(o => o.setName('book').setDescription('عنوان الكتاب').setRequired(true))),
  new SlashCommandBuilder().setName('optout').setDescription('تشغيل/إيقاف رسائل المتابعة الخاصة'),
  new ContextMenuCommandBuilder().setName('📚 نشر في المكتبة').setType(ApplicationCommandType.Message),
];
