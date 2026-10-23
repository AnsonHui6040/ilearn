import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CompletionState, Delivery, ItemKind } from '../types.js';

export interface StoredCourse {
  id: string;
  name: string;
  code: string;
  semester: string;
  start_date: string;
  end_date: string;
  raw: string;
}

export interface StoredItem {
  id: string;
  kind: ItemKind;
  course_id: string;
  title: string;
  body: string | null;
  due_at: string | null;
  start_at: string | null;
  url: string | null;
  completion: CompletionState;
  teammate_hint: boolean;
  group: boolean;
  score: string | null;
  score_published: boolean;
  feedback: string | null;
  categories: string[];
  matched_rules: string[];
  manual_categories: string[] | null;
  delivery: Delivery | null;
  raw: string;
  first_seen_at: string;
  updated_at: string;
}

export interface StoredFile {
  upload_id: string;
  item_id: string;
  course_id: string;
  name: string;
  size: number;
  hash: string | null;
  local_path: string | null;
  status: 'pending' | 'done' | 'skipped' | 'failed' | 'link';
  link: string | null;
  allow_download: boolean;
}

export interface SyncState {
  initial_completed: boolean;
  last_sync_at: string | null;
  next_sync_at: string | null;
  in_progress_courses: string[];
  incomplete_courses: string[];
  /** 新學期首次同步尚未完成時的學期代碼，否則為 null */
  initializing_semester: string | null;
}

type Row = Record<string, SQLInputValue>;

export function upsertCourse(db: DatabaseSync, c: StoredCourse): void {
  db.prepare(
    `INSERT INTO courses (id, name, code, semester, start_date, end_date, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code,
       semester = excluded.semester, start_date = excluded.start_date,
       end_date = excluded.end_date, raw = excluded.raw`,
  ).run(c.id, c.name, c.code, c.semester, c.start_date, c.end_date, c.raw);
}

function rowToItem(r: Row): StoredItem {
  return {
    id: r.id as string,
    kind: r.kind as ItemKind,
    course_id: r.course_id as string,
    title: r.title as string,
    body: r.body as string | null,
    due_at: r.due_at as string | null,
    start_at: r.start_at as string | null,
    url: r.url as string | null,
    completion: r.completion as CompletionState,
    teammate_hint: r.teammate_hint === 1,
    group: r.is_group === 1,
    score: r.score as string | null,
    score_published: r.score_published === 1,
    feedback: r.feedback as string | null,
    categories: JSON.parse(r.categories as string) as string[],
    matched_rules: JSON.parse(r.matched_rules as string) as string[],
    manual_categories:
      r.manual_categories === null ? null : (JSON.parse(r.manual_categories as string) as string[]),
    delivery: r.delivery as Delivery | null,
    raw: r.raw as string,
    first_seen_at: r.first_seen_at as string,
    updated_at: r.updated_at as string,
  };
}

/** 比較時忽略的欄位：時間戳、原始資料，以及使用者管理的欄位。 */
const COMPARED: (keyof StoredItem)[] = [
  'course_id', 'title', 'body', 'due_at', 'start_at', 'url', 'completion',
  'teammate_hint', 'group', 'score', 'score_published', 'feedback',
  'categories', 'matched_rules', 'delivery',
];

export function getItem(db: DatabaseSync, id: string, kind: ItemKind): StoredItem | undefined {
  const r = db.prepare('SELECT * FROM items WHERE id = ? AND kind = ?').get(id, kind) as Row | undefined;
  return r ? rowToItem(r) : undefined;
}

export function upsertItem(db: DatabaseSync, it: StoredItem): { isNew: boolean; changed: string[] } {
  const r = db.prepare('SELECT * FROM items WHERE id = ?').get(it.id) as Row | undefined;
  const old = r ? rowToItem(r) : undefined;
  const source = r?.completion_source as string | undefined;

  // 使用者手動設定的完成狀態及分類不被同步覆蓋。
  const next: StoredItem = old
    ? {
        ...it,
        completion: source === 'user' ? old.completion : it.completion,
        manual_categories: old.manual_categories,
        first_seen_at: old.first_seen_at,
      }
    : it;

  if (!old) {
    db.prepare(
      `INSERT INTO items (id, kind, course_id, title, body, due_at, start_at, url, completion,
         completion_source, teammate_hint, is_group, score, score_published, feedback, categories,
         matched_rules, manual_categories, delivery, raw, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ilearn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next.id, next.kind, next.course_id, next.title, next.body, next.due_at, next.start_at,
      next.url, next.completion, next.teammate_hint ? 1 : 0, next.group ? 1 : 0, next.score,
      next.score_published ? 1 : 0, next.feedback, JSON.stringify(next.categories),
      JSON.stringify(next.matched_rules),
      next.manual_categories ? JSON.stringify(next.manual_categories) : null,
      next.delivery, next.raw, next.first_seen_at, next.updated_at,
    );
    return { isNew: true, changed: [] };
  }

  const changed = COMPARED.filter((k) => JSON.stringify(old[k]) !== JSON.stringify(next[k])) as string[];
  db.prepare(
    `UPDATE items SET kind = ?, course_id = ?, title = ?, body = ?, due_at = ?, start_at = ?, url = ?,
       completion = ?, teammate_hint = ?, is_group = ?, score = ?, score_published = ?, feedback = ?,
       categories = ?, matched_rules = ?, delivery = ?, raw = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.kind, next.course_id, next.title, next.body, next.due_at, next.start_at, next.url,
    next.completion, next.teammate_hint ? 1 : 0, next.group ? 1 : 0, next.score,
    next.score_published ? 1 : 0, next.feedback, JSON.stringify(next.categories),
    JSON.stringify(next.matched_rules), next.delivery, next.raw, next.updated_at, next.id,
  );
  return { isNew: false, changed };
}

export function listItems(
  db: DatabaseSync,
  f: { course_id?: string; kind?: ItemKind; semester?: string },
): StoredItem[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (f.course_id !== undefined) { where.push('i.course_id = ?'); args.push(f.course_id); }
  if (f.kind !== undefined) { where.push('i.kind = ?'); args.push(f.kind); }
  if (f.semester !== undefined) { where.push('c.semester = ?'); args.push(f.semester); }
  const sql =
    'SELECT i.* FROM items i LEFT JOIN courses c ON c.id = i.course_id' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY i.first_seen_at, i.id';
  return (db.prepare(sql).all(...args) as Row[]).map(rowToItem);
}

export function setCompletion(
  db: DatabaseSync,
  itemId: string,
  state: CompletionState,
  source: 'ilearn' | 'user',
): void {
  db.prepare('UPDATE items SET completion = ?, completion_source = ? WHERE id = ?').run(state, source, itemId);
}

export function setManualCategory(db: DatabaseSync, itemId: string, categories: string[] | null): void {
  db.prepare('UPDATE items SET manual_categories = ? WHERE id = ?').run(
    categories ? JSON.stringify(categories) : null,
    itemId,
  );
}

export function recordDueChange(
  db: DatabaseSync,
  itemId: string,
  oldDue: string | null,
  newDue: string | null,
): void {
  db.prepare('INSERT INTO due_history (item_id, old_due, new_due, changed_at) VALUES (?, ?, ?, ?)').run(
    itemId, oldDue, newDue, new Date().toISOString(),
  );
}

export function markReminderSent(db: DatabaseSync, itemId: string, offset: string, sentAt: string): void {
  db.prepare('INSERT OR REPLACE INTO reminders_sent (item_id, offset, sent_at) VALUES (?, ?, ?)').run(
    itemId, offset, sentAt,
  );
}

export function reminderSent(db: DatabaseSync, itemId: string, offset: string): boolean {
  return (
    db.prepare('SELECT 1 AS x FROM reminders_sent WHERE item_id = ? AND offset = ?').get(itemId, offset) !==
    undefined
  );
}

export function getSyncState(db: DatabaseSync): SyncState {
  const r = db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as Row;
  return {
    initial_completed: r.initial_completed === 1,
    last_sync_at: r.last_sync_at as string | null,
    next_sync_at: r.next_sync_at as string | null,
    in_progress_courses: JSON.parse(r.in_progress_courses as string) as string[],
    incomplete_courses: JSON.parse(r.incomplete_courses as string) as string[],
    initializing_semester: (r.initializing_semester as string | null) ?? null,
  };
}

export function setSyncState(db: DatabaseSync, patch: Partial<SyncState>): void {
  const s = { ...getSyncState(db), ...patch };
  db.prepare(
    `UPDATE sync_state SET initial_completed = ?, last_sync_at = ?, next_sync_at = ?,
       in_progress_courses = ?, incomplete_courses = ?, initializing_semester = ? WHERE id = 1`,
  ).run(
    s.initial_completed ? 1 : 0, s.last_sync_at, s.next_sync_at,
    JSON.stringify(s.in_progress_courses), JSON.stringify(s.incomplete_courses), s.initializing_semester,
  );
}

export function upsertFile(db: DatabaseSync, f: StoredFile): void {
  db.prepare(
    `INSERT INTO files (upload_id, item_id, course_id, name, size, hash, local_path, status, link, allow_download)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(upload_id) DO UPDATE SET item_id = excluded.item_id, course_id = excluded.course_id,
       name = excluded.name, size = excluded.size, hash = excluded.hash, local_path = excluded.local_path,
       status = excluded.status, link = excluded.link, allow_download = excluded.allow_download`,
  ).run(
    f.upload_id, f.item_id, f.course_id, f.name, f.size, f.hash, f.local_path, f.status, f.link,
    f.allow_download ? 1 : 0,
  );
}

export function listFiles(db: DatabaseSync, f: { status?: StoredFile['status']; course_id?: string }): StoredFile[] {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (f.status !== undefined) { where.push('status = ?'); args.push(f.status); }
  if (f.course_id !== undefined) { where.push('course_id = ?'); args.push(f.course_id); }
  const sql = 'SELECT * FROM files' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY upload_id';
  return (db.prepare(sql).all(...args) as Row[]).map((r) => ({
    upload_id: r.upload_id as string,
    item_id: r.item_id as string,
    course_id: r.course_id as string,
    name: r.name as string,
    size: r.size as number,
    hash: r.hash as string | null,
    local_path: r.local_path as string | null,
    status: r.status as StoredFile['status'],
    link: r.link as string | null,
    allow_download: r.allow_download === 1,
  }));
}

export interface StoredSummary {
  target_id: string;
  kind: 'announcement' | 'material';
  course_id: string;
  source_hash: string;
  text: string;
  agent: string | null;
  written_at: string;
}

export function upsertSummary(db: DatabaseSync, s: StoredSummary): void {
  db.prepare(
    `INSERT INTO summaries (target_id, kind, course_id, source_hash, text, agent, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET kind = excluded.kind, course_id = excluded.course_id,
       source_hash = excluded.source_hash, text = excluded.text, agent = excluded.agent,
       written_at = excluded.written_at`,
  ).run(s.target_id, s.kind, s.course_id, s.source_hash, s.text, s.agent, s.written_at);
}

export function listSummaries(db: DatabaseSync): StoredSummary[] {
  return (db.prepare('SELECT * FROM summaries ORDER BY target_id').all() as Row[]).map((r) => ({
    target_id: r.target_id as string,
    kind: r.kind as StoredSummary['kind'],
    course_id: r.course_id as string,
    source_hash: r.source_hash as string,
    text: r.text as string,
    agent: r.agent as string | null,
    written_at: r.written_at as string,
  }));
}

/** day 為台北日期 YYYY-MM-DD；written_at 以 +08:00 儲存，前 10 碼就是台北日期。 */
export function countSummariesOn(db: DatabaseSync, day: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM summaries WHERE substr(written_at, 1, 10) = ?').get(day) as { n: number };
  return r.n;
}
