// Coach-mode planner: pulls live state from the Coach into a local DRAFT,
// lets the model mutate the draft through tools, publishes when told to.
// Nothing here touches Discord or the cloud until publish().
import { nextSlots } from '../core/time.js';
import { config } from '../core/config.js';
import { createOllama } from './ollama.js';

const SYSTEM_PROMPT = `You are "Coach", the assistant of the owner of a study-group Discord server ("the academy").
You help the OWNER plan and manage the course. You are talking to the owner only — never to students.

You work on a DRAFT copy of the academy plan. Your tools mutate the draft only.
Nothing reaches the live server until the owner clicks Publish — say so when relevant.

Rules:
- Use tools to inspect or change the draft; never invent lesson ids or schedule state.
- Times: dates are YYYY-MM-DD, times HH:mm, in the academy timezone (${config.tz}). Weekday numbers: 0=Sun 1=Mon ... 6=Sat.
- After changing the plan, summarize the new structure briefly.
- Be concise, warm, and practical. Suggest concrete study-schedule improvements when asked.
- If the owner asks for something impossible with your tools, explain what you can do instead.`;

const TOOL_DEFS = [
  { type: 'function', function: { name: 'get_state', description: 'Get the full draft state: lessons, upcoming sessions, quests, template, overview stats.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'add_lesson', description: 'Add a lesson to the end of the course.', parameters: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string', description: 'YouTube URL' }, duration_min: { type: 'integer' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'remove_lesson', description: 'Remove a lesson by id.', parameters: { type: 'object', properties: { lesson_id: { type: 'integer' } }, required: ['lesson_id'] } } },
  { type: 'function', function: { name: 'move_lesson', description: 'Move a lesson to a new position (1-based).', parameters: { type: 'object', properties: { lesson_id: { type: 'integer' }, position: { type: 'integer' } }, required: ['lesson_id', 'position'] } } },
  { type: 'function', function: { name: 'set_template', description: 'Set the weekly repeating schedule template.', parameters: { type: 'object', properties: { days: { type: 'array', items: { type: 'integer' }, description: 'weekday numbers 0=Sun..6=Sat' }, time: { type: 'string', description: 'HH:mm' } }, required: ['days', 'time'] } } },
  { type: 'function', function: { name: 'regenerate_schedule', description: 'Rebuild all future sessions from the template: upcoming lessons fill the next template slots in order.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'set_session_time', description: 'Move one scheduled session to a new date/time.', parameters: { type: 'object', properties: { session_id: { type: 'integer' }, date: { type: 'string' }, time: { type: 'string' } }, required: ['session_id', 'date', 'time'] } } },
  { type: 'function', function: { name: 'cancel_session', description: 'Cancel one scheduled session (the lesson stays in the course).', parameters: { type: 'object', properties: { session_id: { type: 'integer' } }, required: ['session_id'] } } },
  { type: 'function', function: { name: 'add_quest', description: 'Create a quest: students must finish the given lessons before a date to earn XP.', parameters: { type: 'object', properties: { title: { type: 'string' }, lesson_ids: { type: 'array', items: { type: 'integer' } }, ends_date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['title', 'lesson_ids', 'ends_date'] } } },
  { type: 'function', function: { name: 'draft_summary', description: 'Short human-readable summary of the current draft.', parameters: { type: 'object', properties: {}, required: [] } } },
];

export function createPlanner({ ollama, coachApiUrl, apiToken, tz }) {
  const draft = {
    revision: null, pulledAt: null, tz,
    template: null, lessons: [], sessions: [], quests: [], overview: null,
    dirty: { template: false, regenerate: false, quests: [] },
    _deletes: [], _pulledLessons: [], _pulledSessions: [],
  };

  async function pull() {
    const r = await fetch(`${coachApiUrl}/api/state`, { headers: { 'x-api-token': apiToken } });
    if (!r.ok) throw new Error(`Coach API ${r.status} — is the Coach running?`);
    const s = await r.json();
    draft.revision = s.revision;
    draft.pulledAt = new Date().toISOString();
    draft.template = s.overview.template;
    draft.lessons = s.lessons.map(l => ({ ...l }));
    draft.sessions = s.sessions.map(x => ({ ...x }));
    draft.quests = s.quests.filter(q => q.status === 'active').map(q => ({ ...q }));
    draft.overview = s.overview;
    draft.dirty = { template: false, regenerate: false, quests: [] };
    draft._deletes = [];
    draft._pulledLessons = s.lessons.map(l => ({ ...l }));
    draft._pulledSessions = s.sessions.map(x => ({ ...x }));
    return draft;
  }

  // ---- draft tools (mutate the draft only) ----
  const tools = {
    get_state: () => JSON.stringify({
      revision: draft.revision,
      current_lesson: draft.overview?.current_lesson?.title,
      lessons_done: draft.overview ? `${draft.overview.lessons_done}/${draft.overview.lessons_total}` : undefined,
      participants: draft.overview?.participants,
      template: draft.template,
      lessons: draft.lessons.map(l => ({ id: l.id, pos: l.position, title: l.title, status: l.status, url: l.url })),
      sessions: draft.sessions.map(s => ({ id: s.id, lesson: s.lesson_title, at: s.scheduled_at, status: s.status })),
      quests: draft.quests.map(q => ({ id: q.id, title: q.title, ends: q.ends_at, lessons: q.lesson_ids })),
    }),
    draft_summary: () => {
      const l = draft.lessons.length;
      const done = draft.lessons.filter(x => x.status === 'done').length;
      const next = draft.sessions[0];
      return `Draft: ${l} lessons (${done} done). ` +
        (draft.template ? `Weekly slot: days [${draft.template.days}] at ${draft.template.time}. ` : 'No weekly template. ') +
        (next ? `Next session: #${next.id} "${next.lesson_title}" at ${next.scheduled_at}.` : 'No upcoming sessions.');
    },
    add_lesson: ({ title, url = '', duration_min = 60 }) => {
      const max = draft.lessons.reduce((m, x) => Math.max(m, x.position), 0);
      const tempId = -(Date.now() % 1000000) - 1; // negative = temp; cloud assigns the real id
      draft.lessons.push({ id: tempId, position: max + 1, title, url, duration_min, status: 'planned', _new: true });
      return `Added lesson "${title}" at position ${max + 1} (draft id ${tempId}).`;
    },
    remove_lesson: ({ lesson_id }) => {
      const l = draft.lessons.find(x => x.id === lesson_id);
      if (!l) return `No lesson ${lesson_id} in the draft.`;
      draft.lessons = draft.lessons.filter(x => x.id !== lesson_id).map((x, i) => ({ ...x, position: i + 1 }));
      draft.sessions = draft.sessions.filter(s => s.lesson_id !== lesson_id);
      if (!l._new) draft._deletes.push({ id: lesson_id, _delete: true, position: 0, title: l.title });
      return `Removed "${l.title}".`;
    },
    move_lesson: ({ lesson_id, position }) => {
      const idx = draft.lessons.findIndex(x => x.id === lesson_id);
      if (idx < 0) return `No lesson ${lesson_id}.`;
      const [l] = draft.lessons.splice(idx, 1);
      draft.lessons.splice(Math.max(0, Math.min(draft.lessons.length, position - 1)), 0, l);
      draft.lessons.forEach((x, i) => { x.position = i + 1; });
      return `"${l.title}" is now at position ${l.position}.`;
    },
    set_template: ({ days, time }) => {
      draft.template = { days, time };
      draft.dirty.template = true;
      return `Template set: days [${days}] at ${time}. Call regenerate_schedule to rebuild sessions from it.`;
    },
    regenerate_schedule: () => {
      if (!draft.template) return 'No template set — call set_template first.';
      const planned = draft.lessons.filter(l => l.status !== 'done');
      const slots = nextSlots(draft.template, new Date(), planned.length + 6, tz);
      draft.sessions = planned.map((l, i) => ({
        id: draft.sessions.find(s => s.lesson_id === l.id)?.id ?? -1,
        lesson_id: l.id, lesson_title: l.title,
        scheduled_at: (slots[i] ?? slots[slots.length - 1]).toISOString(),
        status: 'scheduled',
      }));
      draft.dirty.regenerate = true;
      draft.dirty.template = true; // template must be published too
      return `Draft now has ${draft.sessions.length} future sessions:\n` +
        draft.sessions.map(s => `- #${s.id >= 0 ? s.id : 'new'} ${s.lesson_title} @ ${s.scheduled_at.slice(0, 16).replace('T', ' ')} UTC`).join('\n');
    },
    set_session_time: ({ session_id, date, time }) => {
      const s = draft.sessions.find(x => x.id === session_id);
      if (!s) return `No session ${session_id} in the draft.`;
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      const guess = Date.UTC(y, m - 1, d, hh, mm);
      s.scheduled_at = new Date(guess - tzOffset(new Date(guess), tz)).toISOString();
      return `Session #${session_id} ("${s.lesson_title}") moved to ${date} ${time} (${tz}).`;
    },
    cancel_session: ({ session_id }) => {
      const s = draft.sessions.find(x => x.id === session_id);
      if (!s) return `No session ${session_id} in the draft.`;
      draft.sessions = draft.sessions.filter(x => x.id !== session_id);
      return `Cancelled session #${session_id} ("${s.lesson_title}").`;
    },
    add_quest: ({ title, lesson_ids, ends_date }) => {
      const q = { id: -Date.now(), title, lesson_ids, ends_at: `${ends_date}T23:59:00.000Z`, status: 'active', _new: true };
      draft.quests.push(q);
      draft.dirty.quests.push(q);
      return `Quest "${title}" drafted: finish lessons [${lesson_ids.join(', ')}] before ${ends_date}.`;
    },
  };

  // ---- publish: build a minimal diff and send it ----
  function buildPayload(announce) {
    const payload = { base_revision: draft.revision };
    if (announce) payload.announce = announce;
    if (draft.dirty.template && draft.template) payload.template = draft.template;

    if (draft.dirty.regenerate) {
      payload.generate = {};
    } else {
      const moved = draft.sessions.filter(s => s.id > 0).map(s => {
        const orig = draft._pulledSessions.find(o => o.id === s.id);
        return orig && orig.scheduled_at !== s.scheduled_at ? { id: s.id, scheduled_at: s.scheduled_at } : null;
      }).filter(Boolean);
      const cancelled = draft._pulledSessions.filter(o => !draft.sessions.some(s => s.id === o.id))
        .map(o => ({ id: o.id, _cancel: true }));
      if (moved.length || cancelled.length) payload.sessions = [...moved, ...cancelled];
    }

    const orig = draft._pulledLessons;
    const lessonsPayload = [
      ...draft._deletes,
      ...draft.lessons.map(l => ({
        id: l._new ? undefined : l.id,
        position: l.position, title: l.title, url: l.url ?? '', duration_min: l.duration_min ?? 60,
      })),
    ];
    const lessonsChanged = lessonsPayload.length !== orig.length ||
      !lessonsPayload.every((l, i) => orig[i] && orig[i].id === l.id && orig[i].title === l.title &&
        (orig[i].url ?? '') === (l.url ?? '') && orig[i].duration_min === l.duration_min && orig[i].position === l.position) ||
      draft._deletes.length > 0;
    if (lessonsChanged) payload.lessons = lessonsPayload;

    if (draft.dirty.quests.length) {
      payload.quests = draft.dirty.quests.map(q => ({
        title: q.title, lesson_ids: q.lesson_ids, ends_at: q.ends_at, starts_at: new Date().toISOString(),
      }));
    }
    return payload;
  }

  async function publish(announce) {
    const payload = buildPayload(announce);
    const hasChanges = payload.template !== undefined || payload.lessons || payload.sessions || payload.generate || payload.quests;
    if (!hasChanges) return { ok: true, noop: true, message: 'No changes to publish.' };
    const r = await fetch(`${coachApiUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-token': apiToken },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: body.error ?? `Coach API ${r.status}`, revision: body.revision };
    await pull(); // re-sync to the new cloud revision
    return { ok: true, revision: body.revision, applied: body.applied };
  }

  // ---- chat loop with tool calling ----
  const history = [];

  async function chat(userText) {
    history.push({ role: 'user', content: userText });
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-16)];
    for (let i = 0; i < 8; i++) {
      const msg = await ollama.chat({ messages, tools: TOOL_DEFS });
      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const tc of msg.tool_calls) {
          const fn = tools[tc.function.name];
          let result;
          try {
            const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments ?? {};
            result = fn ? String(await fn(args)) : `Unknown tool ${tc.function.name}`;
          } catch (e) { result = `Tool error: ${e.message}`; }
          messages.push({ role: 'tool', content: result });
        }
        continue;
      }
      history.push({ role: 'assistant', content: msg.content });
      if (history.length > 24) history.splice(0, history.length - 24);
      return msg.content || '(empty reply)';
    }
    return '(I got lost in tool calls — try rephrasing.)';
  }

  return { draft, pull, chat, publish, buildPayload };
}

function tzOffset(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - date.getTime();
}
