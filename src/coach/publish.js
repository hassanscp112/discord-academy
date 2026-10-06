// Cloud side of the studio sync: apply a published draft with optimistic
// concurrency. Kept framework-free so tests can call it directly.
import * as A from '../core/academy.js';
import { getSetting, setSetting, getDb } from '../core/db.js';

export function currentRevision() {
  return Number(getSetting('revision', '0'));
}

function bumpRevision() {
  const next = currentRevision() + 1;
  setSetting('revision', String(next));
  return next;
}

// payload: {
//   base_revision, announce?,
//   template?: {days,time}|null,
//   lessons?: [{id?, position, title, url?, duration_min?, _delete?}],
//   sessions?: [{id, scheduled_at?, _cancel?}],
//   generate?: {count?}          // rebuild future sessions from template
//   quests?: [{title, description?, category?}]   // checklist items: book/lecture/course
// }
export function applyPublish(payload) {
  if (payload.base_revision !== currentRevision()) {
    return { ok: false, code: 409, error: 'State changed since you pulled — re-pull and re-apply.', revision: currentRevision() };
  }
  const applied = { lessons: 0, sessions: 0, quests: 0, template: false, generated: 0 };

  if (payload.template !== undefined) {
    if (payload.template === null) A.clearTemplate();
    else A.setTemplate(payload.template);
    applied.template = true;
  }

  if (Array.isArray(payload.lessons)) {
    for (const l of payload.lessons) {
      if (l._delete && l.id) { A.removeLesson(l.id); applied.lessons++; continue; }
      if (l.id) {
        const existing = A.getLesson(l.id);
        if (!existing) continue;
        updateLesson(l.id, l);
      } else {
        A.addLesson({ title: l.title, url: l.url ?? '', durationMin: l.duration_min ?? 60, position: l.position ?? null });
      }
      applied.lessons++;
    }
    const ids = A.listLessons().map(x => x.id).sort((a, b) => {
      const pa = payload.lessons.find(pl => pl.id === a)?.position ?? a;
      const pb = payload.lessons.find(pl => pl.id === b)?.position ?? b;
      return pa - pb;
    });
    A.reorder(ids);
  }

  if (payload.generate) {
    // rebuild: cancel everything future, then refill from the template
    for (const s of A.listSessions({ future: true })) A.cancelSession(s.id);
    const created = A.generateSchedule({ count: payload.generate.count });
    applied.generated = created.length;
  }

  if (Array.isArray(payload.sessions)) {
    for (const s of payload.sessions) {
      if (!s.id) continue;
      if (s._cancel) A.cancelSession(s.id);
      else if (s.scheduled_at) A.setSession(s.id, s.scheduled_at);
      applied.sessions++;
    }
  }

  if (Array.isArray(payload.quests)) {
    for (const q of payload.quests) {
      A.createQuest({ title: q.title, description: q.description ?? '', category: q.category });
      applied.quests++;
    }
  }

  const revision = bumpRevision();
  return { ok: true, revision, applied, announce: payload.announce ?? null };
}

function updateLesson(id, l) {
  // direct update to avoid the position-shifting behavior of addLesson
  const cur = A.getLesson(id);
  getDb().prepare('UPDATE lessons SET title = ?, url = ?, duration_min = ? WHERE id = ?')
    .run(l.title ?? cur.title, l.url ?? cur.url, l.duration_min ?? cur.duration_min, id);
}
