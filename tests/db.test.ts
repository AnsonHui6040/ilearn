import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDb } from '../src/db/schema.js';
import {
  getItem,
  getSyncState,
  listFiles,
  listItems,
  markReminderSent,
  recordDueChange,
  reminderSent,
  setCompletion,
  setManualCategory,
  setSyncState,
  upsertCourse,
  upsertFile,
  upsertItem,
  type StoredFile,
  type StoredItem,
} from '../src/db/repo.js';

const course = {
  id: 'c1',
  name: '行銷管理',
  code: 'BA101',
  semester: '115-1',
  start_date: '2026-09-01',
  end_date: '2027-01-15',
  raw: '{}',
};

function item(over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 'a1',
    kind: 'assignment',
    course_id: 'c1',
    title: '作業一',
    body: null,
    due_at: '2026-11-01T15:59:00Z',
    start_at: null,
    url: 'https://ilearn.thu.edu.tw/x',
    completion: 'pending',
    teammate_hint: false,
    group: false,
    score: null,
    score_published: false,
    feedback: null,
    categories: ['homework'],
    matched_rules: [],
    manual_categories: null,
    delivery: 'push',
    raw: '{}',
    first_seen_at: '2026-10-22T00:00:00Z',
    updated_at: '2026-10-22T00:00:00Z',
    ...over,
  };
}

describe('db', () => {
  it('records schema version', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT schema_version AS v FROM meta').get() as { v: number };
    expect(row.v).toBe(SCHEMA_VERSION);
  });

  it('upsertItem reports isNew and changed fields', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    expect(upsertItem(db, item())).toEqual({ isNew: true, changed: [] });
    expect(upsertItem(db, item())).toEqual({ isNew: false, changed: [] });
    const r = upsertItem(db, item({ due_at: '2026-11-02T15:59:00Z', categories: ['homework', 'x'] }));
    expect(r.isNew).toBe(false);
    expect(r.changed).toContain('due_at');
    expect(r.changed).toContain('categories');
    expect(getItem(db, 'a1', 'assignment')?.due_at).toBe('2026-11-02T15:59:00Z');
    expect(getItem(db, 'a1', 'assignment')?.first_seen_at).toBe('2026-10-22T00:00:00Z');
    expect(getItem(db, 'a1', 'exam')).toBeUndefined();
  });

  it('upsertItem does not overwrite user-managed state', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    upsertItem(db, item());
    setCompletion(db, 'a1', 'completed', 'user');
    setManualCategory(db, 'a1', ['exam']);
    upsertItem(db, item({ title: '作業一（改）' }));
    const got = getItem(db, 'a1', 'assignment');
    expect(got?.completion).toBe('completed');
    expect(got?.manual_categories).toEqual(['exam']);
    expect(got?.title).toBe('作業一（改）');
    setManualCategory(db, 'a1', null);
    expect(getItem(db, 'a1', 'assignment')?.manual_categories).toBeNull();
  });

  it('setCompletion', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    upsertItem(db, item());
    setCompletion(db, 'a1', 'teammate_marked', 'user');
    expect(getItem(db, 'a1', 'assignment')?.completion).toBe('teammate_marked');
  });

  it('listItems filters', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    upsertCourse(db, { ...course, id: 'c2', semester: '115-2' });
    upsertItem(db, item());
    upsertItem(db, item({ id: 'e1', kind: 'exam' }));
    upsertItem(db, item({ id: 'a2', course_id: 'c2' }));
    expect(listItems(db, {})).toHaveLength(3);
    expect(listItems(db, { course_id: 'c1' })).toHaveLength(2);
    expect(listItems(db, { kind: 'exam' }).map((i) => i.id)).toEqual(['e1']);
    expect(listItems(db, { semester: '115-2' }).map((i) => i.id)).toEqual(['a2']);
  });

  it('reminders and due history', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    upsertItem(db, item());
    expect(reminderSent(db, 'a1', 'PT3H')).toBe(false);
    markReminderSent(db, 'a1', 'PT3H', '2026-10-30T00:00:00Z');
    markReminderSent(db, 'a1', 'PT3H', '2026-10-30T00:00:00Z');
    expect(reminderSent(db, 'a1', 'PT3H')).toBe(true);
    expect(reminderSent(db, 'a1', 'P1D')).toBe(false);
    recordDueChange(db, 'a1', 'x', 'y');
    const n = db.prepare('SELECT COUNT(*) AS n FROM due_history').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('sync state', () => {
    const db = openDb(':memory:');
    expect(getSyncState(db)).toEqual({
      initial_completed: false,
      last_sync_at: null,
      next_sync_at: null,
      in_progress_courses: [],
      incomplete_courses: [],
    });
    setSyncState(db, { initial_completed: true, incomplete_courses: ['c1'] });
    setSyncState(db, { last_sync_at: '2026-10-22T00:00:00Z' });
    const s = getSyncState(db);
    expect(s.initial_completed).toBe(true);
    expect(s.incomplete_courses).toEqual(['c1']);
    expect(s.last_sync_at).toBe('2026-10-22T00:00:00Z');
  });

  it('files', () => {
    const db = openDb(':memory:');
    upsertCourse(db, course);
    const f: StoredFile = {
      upload_id: 'u1',
      item_id: 'm1',
      course_id: 'c1',
      name: 'a.pdf',
      size: 10,
      hash: null,
      local_path: null,
      status: 'pending',
      link: null,
      allow_download: true,
    };
    upsertFile(db, f);
    upsertFile(db, { ...f, upload_id: 'u2', status: 'skipped', allow_download: false, link: 'https://x' });
    upsertFile(db, { ...f, status: 'done', hash: 'abc', local_path: '/p/a.pdf' });
    expect(listFiles(db, {})).toHaveLength(2);
    expect(listFiles(db, { status: 'done' })[0]).toMatchObject({ upload_id: 'u1', hash: 'abc', allow_download: true });
    expect(listFiles(db, { status: 'skipped' })[0]?.allow_download).toBe(false);
    expect(listFiles(db, { course_id: 'nope' })).toEqual([]);
  });

  it('reopen does not rerun migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbtest-'));
    try {
      const file = join(dir, 'x.db');
      const db = openDb(file);
      upsertCourse(db, course);
      upsertItem(db, item());
      db.close();
      const db2 = openDb(file);
      expect(listItems(db2, {})).toHaveLength(1);
      const row = db2.prepare('SELECT schema_version AS v FROM meta').get() as { v: number };
      expect(row.v).toBe(SCHEMA_VERSION);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('concurrent access', () => {
  it('waits for a busy database instead of failing at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ilearn-db-busy-'));
    const db = openDb(join(dir, 'x.sqlite3'));
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
