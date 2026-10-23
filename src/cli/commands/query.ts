import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { getSyncState, listFiles, listItems, setCompletion, type StoredCourse, type StoredFile, type StoredItem } from '../../db/repo.js';
import type { EventType, IlearnEvent } from '../../types.js';
import { summaryTexts } from '../../summaries/summaries.js';
import { toTaipeiIso } from '../../time.js';
import { absPath, CliExit, readAccount, type CliContext } from '../context.js';
import { readLastError, readProgress } from './state.js';

export const EVENT_TYPES = [
  'assignment.new', 'assignment.due_reminder', 'assignment.returned', 'exam.new', 'exam.reminder',
  'video.new', 'announcement.new', 'material.new', 'survey.new', 'course.info_changed', 'grade.posted',
  'feedback.posted', 'auth.expired', 'sync.incomplete', 'sync.initial_completed',
] as const satisfies readonly EventType[];

const tp = (s: string | null): string | null => (s === null ? null : toTaipeiIso(new Date(s)));

export function currentSemester(ctx: CliContext): string | null {
  return (ctx.db.prepare('SELECT MAX(semester) AS s FROM courses').get() as { s: string | null }).s;
}

function courseNames(ctx: CliContext): Map<string, string> {
  const rows = ctx.db.prepare('SELECT id, name FROM courses').all() as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** 公告的 iLearn 發布時間（ISO UTC）；沒有時以首次偵測時間代替。 */
export function postedAt(it: StoredItem): string {
  try {
    const v = (JSON.parse(it.raw) as { created_at?: unknown }).created_at;
    if (typeof v === 'string' && v !== '') return v;
  } catch {
    // raw 損毀時沿用首次偵測時間
  }
  return it.first_seen_at;
}

const newestPosted = (a: StoredItem, b: StoredItem): number => Date.parse(postedAt(b)) - Date.parse(postedAt(a));

/** 對外輸出的項目：不含 raw，時間一律 +08:00。 */
export function publicItem(it: StoredItem, names: Map<string, string>) {
  return {
    id: it.id,
    kind: it.kind,
    course_id: it.course_id,
    course: names.get(it.course_id) ?? null,
    title: it.title,
    body: it.body,
    due_at: tp(it.due_at),
    start_at: tp(it.start_at),
    url: it.url,
    completion: it.completion,
    teammate_hint: it.teammate_hint,
    group: it.group,
    score: it.score,
    score_published: it.score_published,
    feedback: it.feedback,
    categories: it.manual_categories ?? it.categories,
    matched_rules: it.matched_rules,
    delivery: it.delivery,
    first_seen_at: tp(it.first_seen_at),
    posted_at: it.kind === 'announcement' ? tp(postedAt(it)) : null,
  };
}

function byDue(a: StoredItem, b: StoredItem): number {
  const x = a.due_at === null ? Infinity : Date.parse(a.due_at);
  const y = b.due_at === null ? Infinity : Date.parse(b.due_at);
  return x - y || (a.id < b.id ? -1 : 1);
}

/* ---------- tasks ---------- */

export interface TaskRow {
  id: string;
  kind: 'assignment' | 'video';
  course_id: string;
  course: string | null;
  title: string;
  due_at: string | null;
  overdue: boolean;
  not_started: boolean;
  group: boolean;
  teammate_hint: boolean;
  completion: StoredItem['completion'];
  url: string | null;
}

export function tasksCommand(ctx: CliContext): {
  initial_sync_in_progress: boolean;
  incomplete_courses: string[];
  tasks: TaskRow[];
} {
  const st = getSyncState(ctx.db);
  const names = courseNames(ctx);
  const sem = currentSemester(ctx);
  const now = ctx.now().getTime();
  const items =
    sem === null
      ? []
      : [...listItems(ctx.db, { kind: 'assignment', semester: sem }), ...listItems(ctx.db, { kind: 'video', semester: sem })]
          .filter((i) => i.completion === 'pending')
          .sort(byDue);
  return {
    initial_sync_in_progress: !st.initial_completed,
    incomplete_courses: st.incomplete_courses.map((id) => names.get(id) ?? id),
    tasks: items.map((i) => ({
      id: i.id,
      kind: i.kind as 'assignment' | 'video',
      course_id: i.course_id,
      course: names.get(i.course_id) ?? null,
      title: i.title,
      due_at: tp(i.due_at),
      overdue: i.due_at !== null && Date.parse(i.due_at) < now,
      not_started: i.start_at !== null && Date.parse(i.start_at) > now,
      group: i.group,
      teammate_hint: i.teammate_hint,
      completion: i.completion,
      url: i.url,
    })),
  };
}

/* ---------- courses ---------- */

export function coursesCommand(ctx: CliContext) {
  const cur = currentSemester(ctx);
  const rows = ctx.db
    .prepare('SELECT id, name, code, semester FROM courses ORDER BY semester DESC, name')
    .all() as unknown as Pick<StoredCourse, 'id' | 'name' | 'code' | 'semester'>[];
  return rows.map((c) => ({ ...c, current: c.semester === cur }));
}

function findCourse(ctx: CliContext, id: string): StoredCourse {
  const c = ctx.db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as unknown as StoredCourse | undefined;
  if (!c) throw new CliExit(1, `找不到課程 ${id}`);
  return c;
}

function fileRow(ctx: CliContext, f: StoredFile, summaries?: Map<string, string>) {
  return {
    id: f.upload_id,
    item_id: f.item_id,
    course_id: f.course_id,
    name: f.name,
    size: f.size,
    status: f.status,
    local_path: absPath(ctx.root, f.local_path),
    link: f.link,
    ...(summaries !== undefined ? { summary: summaries.get(`file:${f.upload_id}`) ?? null } : {}),
  };
}

interface InfoSnapshot {
  fields?: { key: string; title: string; description: string }[];
  schedule?: { raw: string; slots: unknown[] };
}

export function courseCommand(ctx: CliContext, id: string) {
  const c = findCourse(ctx, id);
  const names = courseNames(ctx);
  const summaries = summaryTexts(ctx.db);
  const now = ctx.now().getTime();
  const items = listItems(ctx.db, { course_id: id });
  const out = (kind: StoredItem['kind']): ReturnType<typeof publicItem>[] =>
    items.filter((i) => i.kind === kind).sort(byDue).map((i) => publicItem(i, names));

  let info: InfoSnapshot = {};
  const infoItem = items.find((i) => i.kind === 'course_info');
  if (infoItem) {
    try {
      info = JSON.parse(infoItem.raw) as InfoSnapshot;
    } catch {
      info = {};
    }
  }
  const assignments = items.filter((i) => i.kind === 'assignment').sort(byDue);
  const announcements = items.filter((i) => i.kind === 'announcement').sort(newestPosted);
  const grades = items
    .filter((i) => (i.kind === 'assignment' || i.kind === 'exam' || i.kind === 'grade') && (i.score !== null || i.feedback !== null))
    .map((i) => publicItem(i, names));

  return {
    course: { id: c.id, name: c.name, code: c.code, semester: c.semester },
    schedule: { text: info.schedule?.raw ?? '', slots: info.schedule?.slots ?? [] },
    info_fields: info.fields ?? [],
    todo: assignments
      .filter((i) => i.completion === 'pending')
      .map((i) => ({ ...publicItem(i, names), not_started: i.start_at !== null && Date.parse(i.start_at) > now })),
    completed: assignments.filter((i) => i.completion !== 'pending').map((i) => publicItem(i, names)),
    exams: out('exam'),
    announcements: announcements.map((i) => ({ ...publicItem(i, names), summary: summaries.get(i.id) ?? null })),
    materials: out('material'),
    files: listFiles(ctx.db, { course_id: id }).map((f) => fileRow(ctx, f, summaries)),
    surveys: out('survey'),
    videos: out('video'),
    grades,
  };
}

/* ---------- announcements / grades ---------- */

export function announcementsCommand(ctx: CliContext, o: { category?: string; course?: string }) {
  const names = courseNames(ctx);
  const summaries = summaryTexts(ctx.db);
  return listItems(ctx.db, { kind: 'announcement', ...(o.course !== undefined ? { course_id: o.course } : {}) })
    .filter((i) => o.category === undefined || (i.manual_categories ?? i.categories).includes(o.category))
    .sort(newestPosted)
    .map((i) => ({ ...publicItem(i, names), summary: summaries.get(i.id) ?? null }));
}

export function gradesCommand(ctx: CliContext, o: { course?: string }) {
  const names = courseNames(ctx);
  const filter = o.course !== undefined ? { course_id: o.course } : {};
  return (['assignment', 'exam', 'grade'] as const)
    .flatMap((kind) => listItems(ctx.db, { kind, ...filter }))
    .filter((i) => i.score !== null)
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      course_id: i.course_id,
      course: names.get(i.course_id) ?? null,
      title: i.title,
      score: i.score,
      score_published: i.score_published,
      feedback: i.feedback,
    }));
}

/* ---------- files ---------- */

export function filesSearchCommand(ctx: CliContext, keyword: string) {
  const k = keyword.toLowerCase();
  const names = courseNames(ctx);
  return listFiles(ctx.db, {})
    .filter((f) => f.name.toLowerCase().includes(k))
    .map((f) => ({ ...fileRow(ctx, f), course: names.get(f.course_id) ?? null }));
}

const TEXT_EXT = new Set(['.txt', '.md']);

export function fileTextCommand(ctx: CliContext, id: string): { supported: boolean; text: string } {
  const f = listFiles(ctx.db, {}).find((x) => x.upload_id === id);
  if (!f) throw new CliExit(1, `找不到檔案 ${id}`);
  if (!TEXT_EXT.has(extname(f.name).toLowerCase())) {
    return { supported: false, text: '尚未支援：目前只能直接輸出 .txt 與 .md 檔案的文字' };
  }
  if (f.status !== 'done' || f.local_path === null) throw new CliExit(1, '檔案尚未下載，請先執行 ilearn sync');
  const abs = resolve(ctx.root, f.local_path);
  if (!abs.startsWith(resolve(ctx.root) + sep) || !existsSync(abs)) throw new CliExit(1, '本機找不到該檔案');
  return { supported: true, text: readFileSync(abs, 'utf8') };
}

/* ---------- events ---------- */

export function eventsCommand(
  ctx: CliContext,
  o: { deliverable?: boolean; agent?: string; type?: string; since?: string },
): IlearnEvent[] {
  if (o.type !== undefined && !EVENT_TYPES.includes(o.type as EventType)) {
    throw new CliExit(1, `未知的事件類型：${o.type}`);
  }
  return ctx.outbox.read({
    ...(o.deliverable ? { deliverableAt: ctx.now() } : {}),
    ...(o.agent !== undefined ? { agent: o.agent } : {}),
    ...(o.type !== undefined ? { type: o.type as EventType } : {}),
    ...(o.since !== undefined ? { since: o.since } : {}),
  });
}

export function ackCommand(ctx: CliContext, agent: string, eventId: string): { agent: string; last_event_id: string } {
  if (!ctx.outbox.read().some((e) => e.event_id === eventId)) throw new CliExit(1, `找不到事件 ${eventId}`);
  ctx.outbox.ack(agent, eventId);
  return { agent, last_event_id: eventId };
}

/* ---------- mark-teammate ---------- */

export function markTeammateCommand(
  ctx: CliContext,
  o: { itemId: string; undo?: boolean; isTTY: boolean },
): { id: string; completion: StoredItem['completion'] } {
  if (!o.isTTY) {
    throw new CliExit(1, '標記「隊員已交」必須由本人在互動終端操作，agent 不可代為標記');
  }
  const id = o.itemId.startsWith('assignment:') ? o.itemId : `assignment:${o.itemId}`;
  const it = listItems(ctx.db, { kind: 'assignment' }).find((i) => i.id === id);
  if (!it) throw new CliExit(1, `找不到作業 ${o.itemId}`);
  if (o.undo) {
    setCompletion(ctx.db, id, 'pending', 'ilearn');
    return { id, completion: 'pending' };
  }
  setCompletion(ctx.db, id, 'teammate_marked', 'user');
  return { id, completion: 'teammate_marked' };
}

/* ---------- status ---------- */

export function statusCommand(ctx: CliContext) {
  const st = getSyncState(ctx.db);
  const names = courseNames(ctx);
  const files = listFiles(ctx.db, {});
  const count = (s: StoredFile['status']): number => files.filter((f) => f.status === s).length;
  const progress = readProgress(ctx.root);
  return {
    username: readAccount(ctx.root)?.username ?? ctx.username,
    environment: ctx.config.environment,
    credential_saved: ctx.config.password_saved,
    initial_sync_in_progress: !st.initial_completed,
    first_sync_progress: st.initial_completed
      ? null
      : {
          courses_done: st.in_progress_courses.length,
          courses_total: progress?.coursesTotal ?? null,
          files_done: progress?.filesDone ?? 0,
          files_total: progress?.filesTotal ?? 0,
        },
    last_sync_at: tp(st.last_sync_at),
    incomplete_courses: st.incomplete_courses.map((id) => names.get(id) ?? id),
    files: { pending: count('pending'), done: count('done'), skipped: count('skipped'), failed: count('failed'), link: count('link') },
    last_error: readLastError(ctx.root),
    rules_warning: ctx.rulesWarning ?? null,
    // 只回報是否啟用與失敗數，不輸出指令或網址本身
    delivery: Object.fromEntries(
      (['hook', 'webhook'] as const).map((ch) => [
        ch,
        { enabled: ctx.config.delivery[ch].enabled, ...ctx.outbox.hookStats(ch, ctx.now()) },
      ]),
    ) as Record<'hook' | 'webhook', { enabled: boolean; retrying: number; gave_up: number; last_error: string | null }>,
  };
}
