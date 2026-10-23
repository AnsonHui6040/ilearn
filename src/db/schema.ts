import { DatabaseSync } from 'node:sqlite';

/** 新增式 migration：只可在尾端加入，不可改動已發佈的項目。 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    semester TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    raw TEXT NOT NULL
  );

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    due_at TEXT,
    start_at TEXT,
    url TEXT,
    completion TEXT NOT NULL DEFAULT 'pending',
    completion_source TEXT NOT NULL DEFAULT 'ilearn',
    teammate_hint INTEGER NOT NULL DEFAULT 0,
    is_group INTEGER NOT NULL DEFAULT 0,
    score TEXT,
    score_published INTEGER NOT NULL DEFAULT 0,
    feedback TEXT,
    categories TEXT NOT NULL DEFAULT '[]',
    matched_rules TEXT NOT NULL DEFAULT '[]',
    manual_categories TEXT,
    delivery TEXT,
    raw TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX items_course ON items(course_id);
  CREATE INDEX items_kind ON items(kind);

  CREATE TABLE due_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    old_due TEXT,
    new_due TEXT,
    changed_at TEXT NOT NULL
  );

  CREATE TABLE reminders_sent (
    item_id TEXT NOT NULL,
    offset TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (item_id, offset)
  );

  CREATE TABLE files (
    upload_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    course_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT,
    local_path TEXT,
    status TEXT NOT NULL,
    link TEXT,
    allow_download INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX files_course ON files(course_id);

  CREATE TABLE sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    initial_completed INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    next_sync_at TEXT,
    in_progress_courses TEXT NOT NULL DEFAULT '[]',
    incomplete_courses TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO sync_state (id) VALUES (1);
  `,
  // 新學期首次同步進行中的學期代碼；NULL 表示沒有
  `ALTER TABLE sync_state ADD COLUMN initializing_semester TEXT;`,
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // cron 同步與介面同時使用時，等待鎖定而不是立即失敗
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER NOT NULL)');
  const row = db.prepare('SELECT schema_version AS v FROM meta').get() as { v: number } | undefined;
  let current = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO meta (schema_version) VALUES (0)').run();
  for (; current < MIGRATIONS.length; current++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[current] as string);
      db.prepare('UPDATE meta SET schema_version = ?').run(current + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
