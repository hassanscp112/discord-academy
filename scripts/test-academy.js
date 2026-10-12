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
getDb().exec("DELETE FROM lessons; DELETE FROM sessions; DELETE FROM xp_events; DELETE FROM progress; DELETE FROM attendance; DELETE FROM quests; DELETE FROM participants; DELETE FROM settings WHERE key LIKE 'quest_%'; DELETE FROM course_subs; DELETE FROM questions; DELETE FROM question_answers; DELETE FROM book_progress; DELETE FROM study_group_members; DELETE FROM study_groups; DELETE FROM books;");
setSetting('tz', 'UTC');

console.log('\n— time helpers —');
{
  const d = T.zonedToUtc('2026-01-15', '20:00', 'Africa/Cairo'); // winter: UTC+2
  eq(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(d), '18:00', 'zonedToUtc Cairo winter 20:00 -> 18:00Z');
  const tpl = { days: [0, 3], time: '20:00' }; // Sun + Wed
  const slots = T.nextSlots(tpl, new Date('2026-10-02T12:00:00Z'), 3, 'UTC'); // Friday Oct 2
  eq(slots.map(s => s.toISOString()), ['2026-10-04T20:00:00.000Z', '2026-10-07T20:00:00.000Z', '2026-10-11T20:00:00.000Z'], 'nextSlots Sun/Wed from Friday');
}

console.log('\n— cadence templates (daily / every-N-days / legacy) —');
{
  const daily = T.nextSlots(T.normalizeTemplate({ mode: 'daily', time: '09:00' }), new Date('2026-10-02T12:00:00Z'), 3, 'UTC');
  eq(daily.map(s => s.toISOString()), ['2026-10-03T09:00:00.000Z', '2026-10-04T09:00:00.000Z', '2026-10-05T09:00:00.000Z'], 'daily: consecutive days');
  const every2 = T.nextSlots(T.normalizeTemplate({ mode: 'interval', everyN: 2, time: '18:00' }), new Date('2026-10-02T19:00:00Z'), 3, 'UTC');
  eq(every2.map(s => s.toISOString()), ['2026-10-03T18:00:00.000Z', '2026-10-05T18:00:00.000Z', '2026-10-07T18:00:00.000Z'], 'every-2-days anchored to next 18:00');
  const legacy = T.normalizeTemplate({ days: [0, 3], time: '20:00' });
  eq(legacy, { mode: 'days', days: [0, 3], time: '20:00' }, 'legacy template normalizes to days mode');
  ok(!T.normalizeTemplate({ mode: 'interval', everyN: 0, time: '20:00' }), 'invalid everyN rejected');
  ok(!T.normalizeTemplate({ mode: 'daily', time: '25:00' }), 'invalid time rejected');
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
  const created = A.generateSchedule({ from: new Date('2026-10-02T12:00:00Z') });
  eq(created.length, 3, 'three sessions generated');
  const days = created.map(s => new Date(s.scheduled_at).getUTCDay());
  eq(days, [0, 3, 0], 'sessions land on Sun/Wed/Sun');
  ok(A.nextSession().lesson_title === 'Intro', 'next session is first lesson');
  const again = A.generateSchedule({ from: new Date('2026-10-02T12:00:00Z') });
  eq(again.length, 0, 'generate is idempotent while sessions exist');
}

console.log('\n— long-video splitting + playlist import —');
{
  // a 2h video with 60-min classes must occupy two consecutive slots
  const id = A.addLesson({ title: 'Marathon', url: 'https://youtu.be/m', durationMin: 60, videoId: 'vid_m', videoDurationSec: 7200 });
  eq(A.lessonParts(A.getLesson(id)).parts, 2, '2h video / 60-min classes -> 2 parts');
  const created = A.generateSchedule({ from: new Date('2026-10-02T12:00:00Z') });
  const mine = created.filter(s => s.lesson_id === id);
  eq(mine.length, 2, 'two sessions created for the long video');
  eq(mine.map(s => s.offset_min), [0, 60], 'second session resumes at minute 60');
  eq(A.sessionPartInfo(A.getSession(mine[1].id)), { part: 2, parts: 2, fromMin: 60, toMin: null }, 'part info for the last part');
  // after the first part is held, an ad-hoc "start now" resumes at part 2
  getDb().prepare("UPDATE sessions SET status = 'done' WHERE id = ?").run(mine[0].id);
  eq(A.nextOffsetForLesson(id), 60, 'start-now resumes where the held session stopped');

  // playlist import dedupes by video id
  const imp = A.importPlaylist([
    { title: 'V1', url: 'https://www.youtube.com/watch?v=dupx', videoId: 'dupx', durationSec: 600 },
    { title: 'V1 again', url: 'https://www.youtube.com/watch?v=dupx', videoId: 'dupx', durationSec: 600 },
    { title: 'Marathon again', url: 'https://youtu.be/m', videoId: 'vid_m', durationSec: 7200 },
  ], { durationMin: 60 });
  eq(imp.added.length, 1, 'duplicate videos skipped on import');
  eq(imp.skipped, 2, 'skips counted (dup + existing lesson)');
  eq(A.lessonParts(A.getLesson(imp.added[0].id)).parts, 1, '10-min video fits one class');
  // clean up: later blocks (state machine, publish) assume only the 3 base lessons
  A.removeLesson(id);
  A.removeLesson(imp.added[0].id);
}

console.log('\n— courses: each with its own cadence —');
{
  const first = A.listCourses()[0];
  ok(!!first, 'default course exists after migration');
  ok(A.listLessons().every(l => l.course_id === first.id), 'existing lessons attached to the default course');

  const bId = A.createCourse({ title: 'دورة المساء', mode: 'interval', everyN: 2, time: '18:00' });
  A.addLesson({ title: 'B1', durationMin: 60, videoDurationSec: 3600, courseId: bId });
  const before = A.listSessions({ future: true }).length;
  const created = A.generateScheduleForCourse(bId, { from: new Date('2026-10-02T12:00:00Z') });
  eq(created.length, 1, 'course B lesson scheduled on its own cadence');
  eq(new Date(created[0].scheduled_at).toISOString(), '2026-10-02T18:00:00.000Z', 'interval cadence anchors at the next 18:00');
  eq(A.listLessons(first.id).length, A.listLessons().length - 1, "course A did not gain course B's lesson");

  ok(A.updateCourse(bId, { title: 'دورة المساء — معدلة', mode: 'daily', time: '09:00' }), 'updateCourse applies');
  eq(A.getCourse(bId).template.mode, 'daily', 'cadence updated to daily');

  ok(A.removeCourse(bId), 'removeCourse deletes course B');
  ok(!A.listLessons().some(l => l.title === 'B1'), "B's lessons gone with it");
  eq(A.listSessions({ future: true }).length, before, "B's sessions gone with it");
  let threw = false;
  try { A.removeCourse(A.listCourses()[0].id); } catch { threw = true; }
  ok(threw, 'cannot delete the last remaining course');
}

console.log('\n— session state machine (tick) —');
{
  const bus = { postTo: async (k, p) => ({ id: 'msg_' + Math.random(), content: p.content, k }), dm: async () => null, bossDm: async () => null };
  // isolated, date-proof: clear the board, then run one controlled session
  // (previous sessions pinned to 2026-10 dates would race the one-live guard)
  for (const s of A.listSessions({ future: true })) A.cancelSession(s.id);
  const intro = A.listLessons().find(l => l.title === 'Intro');
  const r = getDb().prepare("INSERT INTO sessions (lesson_id, scheduled_at, status) VALUES (?, ?, 'scheduled')")
    .run(intro.id, new Date(Date.now() - 20 * 60000).toISOString());
  const ns = A.getSession(Number(r.lastInsertRowid));

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

  // attended session flow: a fresh controlled session for the next lesson
  const advanced = A.listLessons().find(l => l.title === 'Advanced');
  const r2 = getDb().prepare("INSERT INTO sessions (lesson_id, scheduled_at, status) VALUES (?, ?, 'live')")
    .run(advanced.id, new Date(Date.now() - 10 * 60000).toISOString());
  const ns2 = A.getSession(Number(r2.lastInsertRowid));
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

console.log('\n— completion, levels, quests (checklist) —');
{
  const lesson = A.listLessons().find(l => l.status !== 'done');
  const before = A.xpTotal('user_bob');
  const r1 = A.completeLesson('user_bob', lesson.id);
  ok(!r1.already && r1.total > before, 'lesson completion awards XP');
  const r2 = A.completeLesson('user_bob', lesson.id);
  ok(r2.already === true, 'second completion is a no-op');

  const lvl = A.levelFor(r1.total);
  ok(!!lvl.name, `level derived from XP (${r1.total} -> ${lvl.name})`);

  const qid = A.createQuest({ title: 'كتاب الأسبوع', category: 'book' });
  const c1 = A.checkQuest(qid, 'user_bob');
  ok(c1 && c1.first === true, 'first checklist tick recorded');
  const c2 = A.checkQuest(qid, 'user_bob');
  ok(c2 && c2.first === false, 're-ticking the same item is a no-op');
  A.checkQuest(qid, 'user_alice');
  eq(A.questCompletionCount(qid), 2, 'completion count spans members');
  ok(A.listQuests().every(q => ['book', 'lecture', 'course'].includes(q.category)), 'categories normalized');

  const nudgeable = A.membersToNudge(48);
  ok(Array.isArray(nudgeable), 'membersToNudge runs');
  A.logNudge('user_bob', 'dm');
  ok(!A.membersToNudge(48).some(m => m.user_id === 'user_bob'), 'cooldown suppresses repeat nudges');

  // per-course member checklist
  const cid = A.listCourses()[0].id;
  const cp = A.courseProgress(cid, 'user_bob');
  eq(cp.total, A.listLessons(cid).length, 'courseProgress covers every course lesson');
  ok(cp.done >= 1 && cp.items.some(i => i.done && i.completed_at), 'courseProgress marks finished lessons with dates');
  ok(cp.next && !cp.next.done, 'courseProgress points at the next unfinished lesson');
  const roster = A.courseRoster(cid);
  const bob = roster.find(r => r.user_id === 'user_bob');
  ok(!!bob && bob.done === cp.done, 'courseRoster counts match courseProgress');
  ok(roster.every(r => r.total === cp.total), 'roster rows carry the course total');

  // member dashboard embed builds headless (no Discord needed)
  const { buildMemberEmbed, buildMemberView } = await import('../src/coach/memberdash.js');
  const emb = buildMemberEmbed('user_bob');
  ok(!!emb?.data?.title && emb.data.fields?.length >= 3, 'member progress embed builds with courses + session fields');
  for (const v of ['overview', 'courses', 'books', 'quests']) {
    const view = buildMemberView('user_bob', v);
    ok(!!view?.embeds?.[0] && Array.isArray(view.components) && view.components.length >= 1, `interactive view "${v}" builds with components`);
  }
}

console.log('\n— books & study groups —');
{
  const bid = A.addBook({ title: 'رياض الصالحين', totalPages: 100 });
  const p1 = A.setBookProgress('user_bob', bid, 40);
  eq(p1.page, 40, 'page recorded and clamped to the book');
  eq(A.bookShelf('user_bob').find(b => b.id === bid).page, 40, 'shelf shows the page');
  const clamped = A.setBookProgress('user_bob', bid, 150);
  ok(clamped.finished && clamped.page === 100, 'page clamps to total');
  const fin = A.setBookProgress('user_bob', bid, 100);
  ok(fin.finished && A.bookShelf('user_bob').find(b => b.id === bid).finished, 'reaching the last page finishes the book');

  const gid = A.createGroup({ bookId: bid, title: 'مجموعة الرياض' });
  A.joinGroup(gid, 'user_bob', 'bob');
  A.joinGroup(gid, 'user_alice', 'alice');
  A.setBookProgress('user_alice', bid, 70);
  const r = A.groupRoster(gid);
  eq(r.roster.length, 2, 'roster lists both members');
  ok(r.roster[0].user_id === 'user_bob' && r.roster[0].page === 100, 'roster sorted furthest-page first');
  ok(r.roster[1].user_id === 'user_alice' && r.roster[1].page === 70, 'second member at their page');
  const st = A.bookStats().find(b => b.id === bid);
  ok(st.readers === 2 && st.finished === 1, 'bookStats counts readers and finishers');

  A.leaveGroup(gid, 'user_alice');
  eq(A.groupRoster(gid).roster.length, 1, 'leave removes from the roster');
  A.endGroup(gid);
  eq(A.listGroups().length, 0, 'ended group leaves the active list');
  ok(A.removeBook(bid), 'book removed');
  ok(!A.getBook(bid), 'book gone');
}

console.log('\n— subscriptions, questions, member management —');
{
  const course = A.listCourses()[0];
  // per-course notification opt-in
  ok(A.toggleCourseSub(course.id, 'user_bob', 'bob') === true, 'sub toggles on');
  ok(A.toggleCourseSub(course.id, 'user_alice', 'alice') === true, 'second subscriber on');
  eq(JSON.stringify(A.courseSubscribers(course.id).sort()), JSON.stringify(['user_alice', 'user_bob']), 'subscribers listed');
  ok(A.subscribedCourses('user_bob').has(course.id), 'subscribedCourses set works');
  ok(A.toggleCourseSub(course.id, 'user_bob') === false, 'sub toggles off');

  // quiz questions
  const lesson = A.listLessons().find(l => l.status !== 'done');
  const qid = A.addQuestion({ courseId: course.id, lessonId: lesson.id, question: 'ما حكم العلم؟', options: ['فرض', 'ندب', 'مكروه'], correctIndex: 0, xp: 15 });
  const q = A.getQuestion(qid);
  eq(q.options.length, 3, 'question stored with options');
  const wrong = A.answerQuestion('user_bob', qid, 1);
  ok(wrong && !wrong.correct && wrong.first, 'wrong answer recorded once');
  ok(A.answerQuestion('user_bob', qid, 0).already, 'second answer is rejected');
  const right = A.answerQuestion('user_alice', qid, 0);
  ok(right && right.correct && right.first, 'correct answer recorded');
  let threw = false;
  try { A.addQuestion({ courseId: course.id, question: 'x', options: ['واحد'] }); } catch { threw = true; }
  ok(threw, 'question needs at least two options');

  // member rename/remove cascades across every table
  const mid = 'user_temp';
  A.upsertParticipant(mid, 'مؤقت');
  A.completeLesson(mid, lesson.id);
  A.toggleCourseSub(course.id, mid);
  A.setBookProgress(mid, A.addBook({ title: 'كتاب مؤقت', totalPages: 50 }), 10);
  const renamed = A.renameParticipant(mid, 'مؤقت ٢');
  eq(renamed.display_name, 'مؤقت ٢', 'rename works');
  ok(!!A.removeMember(mid), 'removeMember works');
  ok(!A.getParticipant(mid), 'participant gone');
  ok(!A.subscribedCourses(mid).has(course.id), 'subscription gone with member');
  eq(A.listProgress(mid).length, 0, 'progress gone with member');

  // PDF metadata on books (books are academy content — they survive member removal)
  ok(A.findBookByTitle('كتاب مؤقت') != null, 'findBookByTitle: book survives member removal');
  const pdfBook = A.getBook(A.addBook({ title: 'كتاب الاختبار النهائي', totalPages: 30 }));
  A.setBookPdf(pdfBook.id, { msgId: 'thread_1', name: 'test.pdf', size: 2048, genre: 'عقيدة' });
  ok(A.bookStats().find(b => b.id === pdfBook.id)?.has_pdf === true, 'bookStats flags PDF availability');
  ok(A.findBookByTitle('الاختبار النهائي')?.id === pdfBook.id, 'findBookByTitle fuzzy match works');
  A.clearBookPdf(pdfBook.id);
  ok(A.bookStats().find(b => b.id === pdfBook.id)?.has_pdf === false, 'clearBookPdf removes the flag');
  A.removeBook(pdfBook.id);
  A.removeBook(A.findBookByTitle('كتاب مؤقت').id);
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
  eq(getTemplate(), { mode: 'days', days: [1, 4], time: '19:00' }, 'template applied (normalized)');
  ok(A.nextSession() !== null, 'sessions exist after publish+generate');

  const q = P.applyPublish({
    base_revision: P.currentRevision(),
    quests: [{ title: 'Pub quest', category: 'course' }],
  });
  eq(q.ok, true, 'quest publish accepted');
  const pubQ = A.listQuests().find(x => x.title === 'Pub quest');
  ok(!!pubQ, 'quest created via publish');
  eq(pubQ.category, 'course', 'published quest carries its category');
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
