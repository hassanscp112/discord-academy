// Self-contained test run: exercises time math, schedule generation, the
// session state machine, XP/levels/quests, and the publish API — all without
// Discord (dry-run mode, throwaway DB).
process.env.DB_PATH = './data/test-academy.db';
process.env.TZ = 'UTC';
process.env.COACH_DISABLE_DISCORD = '1';
process.env.DASH_PASSWORD = 'test';
process.env.API_TOKEN = 'test-token';

const { setSetting } = await import('../src/core/db.js');
const T = await import('../src/core/time.js');
const A = await import('../src/core/academy.js');
const { getDb, getTemplate } = await import('../src/core/db.js');
const S = await import('../src/coach/sessions.js');
const P = await import('../src/coach/publish.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`); }

// clean slate
getDb().exec("DELETE FROM lessons; DELETE FROM sessions; DELETE FROM xp_events; DELETE FROM progress; DELETE FROM attendance; DELETE FROM quests; DELETE FROM participants; DELETE FROM settings WHERE key LIKE 'quest_%'");
setSetting('tz', 'UTC');

console.log('\n— time helpers —');
{
  const d = T.zonedToUtc('2026-01-15', '20:00', 'Africa/Cairo'); // winter: UTC+2
  eq(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(d), '18:00', 'zonedToUtc Cairo winter 20:00 -> 18:00Z');
  const tpl = { days: [0, 3], time: '20:00' }; // Sun + Wed
  const slots = T.nextSlots(tpl, new Date('2026-10-02T12:00:00Z'), 3, 'UTC'); // Friday Oct 2
  eq(slots.map(s => s.toISOString()), ['2026-10-04T20:00:00.000Z', '2026-10-07T20:00:00.000Z', '2026-10-11T20:00:00.000Z'], 'nextSlots Sun/Wed from Friday');
}

console.log('\n— lessons —');
{
  const a = A.addLesson({ title: 'Intro', url: 'https://youtu.be/a', durationMin: 45 });
  const b = A.addLesson({ title: 'Basics', url: 'https://youtu.be/b' });
  const c = A.addLesson({ title: 'Advanced' });
  eq(A.listLessons().map(l => l.title), ['Intro', 'Basics', 'Advanced'], 'three lessons in order');
  A.removeLesson(b);
  eq(A.listLessons().map(l => l.position), [1, 2], 'positions compacted after removal');
  A.addLesson({ title: 'Basics again', url: 'https://youtu.be/b' }); // id c+1
  eq(A.listLessons().length, 3, 'back to three lessons');
  ok(A.getLesson(c).title === 'Advanced', 'getLesson by id');
}

console.log('\n— schedule generation —');
{
  A.setTemplate({ days: [0, 3], time: '20:00' });
  const created = A.generateSchedule({});
  eq(created.length, 3, 'three sessions generated');
  const days = created.map(s => new Date(s.scheduled_at).getUTCDay());
  eq(days, [0, 3, 0], 'sessions land on Sun/Wed/Sun');
  ok(A.nextSession().lesson_title === 'Intro', 'next session is first lesson');
  const again = A.generateSchedule({});
  eq(again.length, 0, 'generate is idempotent while sessions exist');
}

console.log('\n— session state machine (tick) —');
{
  const bus = { postTo: async (k, p) => ({ id: 'msg_' + Math.random(), content: p.content, k }), dm: async () => null, bossDm: async () => null };
  // walk the first session into the past
  const ns = A.nextSession();
  const past = new Date(Date.now() - 20 * 60000); // started 20 min ago
  getDb().prepare('UPDATE sessions SET scheduled_at = ?, status = ? WHERE id = ?').run(past.toISOString(), 'scheduled', ns.id);

  await S.tick({ client: null, bus, now: new Date() });
  let s = A.getSession(ns.id);
  eq(s.status, 'live', 'session went live (start time passed, reminder window skipped)');

  // nobody joins; 16 minutes pass -> missed poll
  await S.tick({ client: null, bus, now: new Date(Date.now() + 16 * 60000) });
  s = A.getSession(ns.id);
  eq(s.status, 'missed_poll', 'empty room 15+ min -> missed_poll');
  ok(!!s.proposed_at && !!s.poll_at, 'proposal + poll timestamp recorded');

  // poll expires -> auto-move to proposed slot
  const proposed = s.proposed_at;
  await S.tick({ client: null, bus, now: new Date(new Date(s.poll_at).getTime() + 25 * 3600000) });
  s = A.getSession(ns.id);
  eq(s.status, 'scheduled', 'poll expiry auto-moved session');
  eq(s.scheduled_at, proposed, 'moved to the proposed slot');

  // attended session flow on the second session
  const ns2 = A.listSessions({ future: true }).find(x => x.id !== ns.id);
  const past2 = new Date(Date.now() - 10 * 60000);
  getDb().prepare('UPDATE sessions SET scheduled_at = ?, status = ? WHERE id = ?').run(past2.toISOString(), 'live', ns2.id);
  A.upsertParticipant('user_bob', 'bob');
  A.recordJoin(ns2.id, 'user_bob');
  A.recordLeave(ns2.id, 'user_bob');
  const before = A.xpTotal('user_bob');
  const fin = await S.finishSession({ client: null, bus, sessionId: ns2.id });
  ok(fin && fin.attendees.length === 1, 'finalize returns one attendee');
  ok(A.xpTotal('user_bob') > before, 'attendee gained attendance XP');
  eq(A.currentStreak('user_bob'), 1, 'streak = 1 after attending one held session');
  const lesson2 = A.getLesson(ns2.lesson_id);
  eq(lesson2.status, 'done', 'lesson marked done after its session');
}

console.log('\n— completion, levels, quests —');
{
  const lesson = A.listLessons().find(l => l.status !== 'done');
  const before = A.xpTotal('user_bob');
  const r1 = A.completeLesson('user_bob', lesson.id);
  ok(!r1.already && r1.total > before, 'lesson completion awards XP');
  const r2 = A.completeLesson('user_bob', lesson.id);
  ok(r2.already === true, 'second completion is a no-op');

  const lvl = A.levelFor(r1.total);
  ok(!!lvl.name, `level derived from XP (${r1.total} -> ${lvl.name})`);

  const qid = A.createQuest({ title: 'Test quest', lessonIds: [lesson.id], startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString() });
  const done = A.tryCompleteQuest(qid, 'user_bob');
  ok(done && done.quest.id === qid, 'quest completes when its lessons are done');
  eq(A.tryCompleteQuest(qid, 'user_bob'), null, 'quest completion is one-time');

  const nudgeable = A.membersToNudge(48);
  ok(Array.isArray(nudgeable), 'membersToNudge runs');
  A.logNudge('user_bob', 'dm');
  ok(!A.membersToNudge(48).some(m => m.user_id === 'user_bob'), 'cooldown suppresses repeat nudges');
}

console.log('\n— publish API —');
{
  const rev = P.currentRevision();
  const bad = P.applyPublish({ base_revision: rev + 5, lessons: [{ position: 1, title: 'X' }] });
  eq(bad.ok, false, 'stale revision is rejected');
  eq(bad.code, 409, 'conflict code 409');

  const good = P.applyPublish({
    base_revision: rev,
    template: { days: [1, 4], time: '19:00' },
    lessons: [{ position: 1, title: 'Published 1', url: 'https://youtu.be/p1', duration_min: 50 }],
    generate: {},
  });
  eq(good.ok, true, 'publish accepted');
  ok(good.applied.generated >= 1, `generate created sessions (${good.applied.generated})`);
  ok(A.listLessons().some(l => l.title === 'Published 1'), 'lesson added via publish');
  eq(getTemplate(), { days: [1, 4], time: '19:00' }, 'template applied');
  ok(A.nextSession() !== null, 'sessions exist after publish+generate');

  const q = P.applyPublish({
    base_revision: P.currentRevision(),
    quests: [{ title: 'Pub quest', lesson_ids: [1], starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString() }],
  });
  eq(q.ok, true, 'quest publish accepted');
  ok(A.listQuests().some(x => x.title === 'Pub quest'), 'quest created via publish');
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
