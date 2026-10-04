// Every message the Coach posts lives here. Edit freely — placeholders in
// {{double_braces}} are filled in by the bot.

export const templates = {
  reminder:
    '📚 **Class in {{when}}!**\n' +
    'We\'re covering **{{lesson_title}}**\n' +
    '{{url_line}}\n' +
    '{{ping}} See you in 🔊 {{vc_name}}!',

  starting:
    '🎬 **Class is starting NOW!** — **{{lesson_title}}**\n' +
    '{{url_line}}\n' +
    '{{ping}} I\'m in 🔊 {{vc_name}} playing the lesson audio.\n' +
    '📺 **Want synced video?** Tap the 🚀 rocket in the voice channel → **Watch Together** → paste the link above.',

  missed:
    '😴 **No one showed up** for **{{lesson_title}}** ({{when}}).\n' +
    'Should we move it? React with your pick:\n' +
    '👉 **Next slot:** {{proposed_when}}\n' +
    '👍 = yes, move it there · 🗓️ = pick a different time · ⏭️ = skip this lesson',

  missed_auto_moved:
    '📆 The poll expired, so **{{lesson_title}}** was moved to **{{when}}** automatically.',

  session_done:
    '✅ **Session done** — nice work everyone who joined **{{lesson_title}}**!\n' +
    'Attendees earned **{{xp}} XP**. Don\'t forget to mark the lesson finished:',

  completion_thanks:
    '{{mention}} finished **{{lesson_title}}**! 🎉 (+{{xp}} XP)',

  nudge_dm: [
    'Hey {{member}}! 👋 Have you studied **{{lesson_title}}** yet? We noticed it\'s still open — you\'ve got a {{streak}} streak to protect 🔥',
    '{{member}}, quick check-in: **{{lesson_title}}** is waiting for you. Even 20 minutes tonight keeps your {{streak}} streak alive 🔥',
    'Psst {{member}} — **{{lesson_title}}** hasn\'t been marked done yet. Your {{streak}}-session streak is safe for now... don\'t let it slip 😄',
  ],
  nudge_channel:
    '{{ping}} **Check-in!** Current lesson: **{{lesson_title}}** — mark it with ✅ on the lesson post when you\'re done. Current streak leaders are on the board 👀',

  level_up:
    '🎉 {{mention}} leveled up to **{{emoji}} {{level_name}}** ({{xp}} XP)!',

  quest_new:
    '🗝️ **New quest:** {{title}}\n{{description}}\nReward: **{{xp}} XP** · Ends {{ends}}',

  quest_done:
    '🏅 {{mention}} completed the quest **{{title}}**! (+{{xp}} XP)',

  quest_expired:
    '⌛ Quest **{{title}}** ended. Completed by {{count}} member(s).',

  recap:
    '📋 **Weekly recap**\n' +
    'Sessions held: **{{sessions}}** · Active members: **{{active}}**\n' +
    '🏆 Top learner this week: {{top}}\n' +
    'Lessons completed: **{{completions}}** · Quests finished: **{{quests}}**\n' +
    '{{closing}}',

  recap_closing: ['Keep the momentum going — see you at the next session! 💪', 'Great week. Rest, recharge, repeat. 🔁', 'Consistency beats intensity. Proud of this group. 👏'],

  welcome_dm:
    'Welcome to the academy, {{member}}! 🎓\nI\'ll keep you posted about sessions here. Current lesson: **{{lesson_title}}**. You can mute me anytime with /optout.',
};
