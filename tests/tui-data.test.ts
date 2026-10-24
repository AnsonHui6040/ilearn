import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createContext, type CliContext } from '../src/cli/context.js';
import { upsertCourse, upsertItem, markReminderSent, setSyncState, type StoredItem } from '../src/db/repo.js';
import { makeEvent } from '../src/events/outbox.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { courseDetail, displayName, loadTuiData } from '../src/tui/data.js';

const NOW = new Date('2026-10-22T04:00:00Z'); // 12:00 台北
const H = 3600_000;
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

function mk(): CliContext {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-tui-'));
  return createContext({ root, now: () => NOW, userId: 1 });
}

function course(ctx: CliContext, id: string, name: string, code: string, semester: string): void {
  upsertCourse(ctx.db, { id, name, code, semester, start_date: '', end_date: '', raw: '{}' });
}

function item(ctx: CliContext, p: Partial<StoredItem> & Pick<StoredItem, 'id' | 'kind' | 'course_id'>): void {
  upsertItem(ctx.db, {
    title: p.id, body: null, due_at: null, start_at: null, url: null, completion: 'pending',
    teammate_hint: false, group: false, score: null, score_published: false, feedback: null,
    categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: iso(-24 * H), updated_at: iso(-24 * H),
    ...p,
  });
}

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => `${join(d.parentPath, d.name)}:${statSync(join(d.parentPath, d.name)).size}`)
    .sort();
}

describe('displayName', () => {
  it('去掉開頭括號與最後一個冒號之前的部分', () => {
    expect(displayName('(1151_1212)會計學')).toBe('會計學');
    expect(displayName('(115-1)永續實踐:勞作教育-所有修習學生虛擬課程')).toBe('勞作教育-所有修習學生虛擬課程');
    expect(displayName('資料結構')).toBe('資料結構');
    expect(displayName('a:b:c')).toBe('c');
    expect(displayName('(x)')).toBe('');
  });
});

describe('home', () => {
  it('四組互斥，總數等於 tasks 數量', () => {
    const ctx = mk();
    course(ctx, '1', '資料結構', '1151_CS101', '115-1');
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', due_at: iso(-2 * H) });
    item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', due_at: iso(3 * 24 * H) });
    item(ctx, { id: 'assignment:3', kind: 'assignment', course_id: '1', due_at: iso(10 * 24 * H) });
    item(ctx, { id: 'assignment:4', kind: 'assignment', course_id: '1', due_at: iso(2 * 24 * H), start_at: iso(24 * H) });
    item(ctx, { id: 'video:5', kind: 'video', course_id: '1', due_at: null });
    item(ctx, { id: 'assignment:6', kind: 'assignment', course_id: '1', due_at: iso(-H), start_at: iso(H) });
    const d = loadTuiData(ctx);
    expect(d.home.overdue.map((t) => t.id)).toEqual(['assignment:1']);
    expect(d.home.within7d.map((t) => t.id)).toEqual(['assignment:2']);
    expect(d.home.later.map((t) => t.id).sort()).toEqual(['assignment:3', 'video:5']);
    expect(d.home.notStarted.map((t) => t.id)).toEqual(['assignment:6', 'assignment:4']);
    const total = d.home.overdue.length + d.home.within7d.length + d.home.later.length + d.home.notStarted.length;
    expect(total).toBe(d.tasks.tasks.length);
    expect(d.now).toEqual(NOW);
  });
});

describe('courses and archived', () => {
  it('code、name、schedule、rooms、todo、announcements', () => {
    const ctx = mk();
    course(ctx, '1', '(1151_CS101)資料結構', '1151_CS101', '115-1');
    course(ctx, '2', '管理學', 'labor1151gra', '115-1');
    course(ctx, '3', '(1142_OLD)舊課程', '1142_OLD', '114-2');
    course(ctx, '4', '更舊', '1141_X', '114-1');
    item(ctx, {
      id: 'course_info:1', kind: 'course_info', course_id: '1',
      raw: JSON.stringify({ schedule: { raw: 'x', slots: [
        { weekday: 3, periods: ['2', '3', '4'], room: 'M134' },
        { weekday: 4, periods: ['6'], room: 'M134' },
        { weekday: 5, periods: ['1'], room: null },
      ] } }),
    });
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1' });
    item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', completion: 'completed' });
    item(ctx, { id: 'announcement:1', kind: 'announcement', course_id: '1' });
    item(ctx, { id: 'announcement:2', kind: 'announcement', course_id: '1' });
    const d = loadTuiData(ctx);
    expect(d.courses.map((c) => c.code)).toEqual(['CS101', 'labor1151gra']);
    expect(d.courses[0]).toEqual({
      id: '1', code: 'CS101', name: '資料結構',
      schedule: '三 09:10–12:10（2–4 節）、四 14:10–15:00（6 節）、五 08:10–09:00（1 節）',
      rooms: 'M134', todo: 1, announcements: 2,
    });
    expect(d.courses[1]).toMatchObject({ schedule: '未提供', rooms: '', todo: 0, announcements: 0 });
    expect(d.archived.map((a) => a.semester)).toEqual(['114-2', '114-1']);
    expect(d.archived[0]?.courses.map((c) => c.id)).toEqual(['3']);
  });
});

describe('reminders', () => {
  it('作業與考試、課程覆寫、已送出、排序、過濾今天之前', () => {
    const ctx = mk();
    course(ctx, '1', '(1151_CS101)資料結構', '1151_CS101', '115-1');
    course(ctx, '2', '管理學', '1151_BA201', '115-1');
    // 10/23 12:00 台北截止 → P1D = 10/22 12:00，PT3H = 10/23 09:00
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', title: '作業一', due_at: iso(24 * H) });
    // 已完成不列
    item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', due_at: iso(24 * H), completion: 'completed' });
    // 已過期不列
    item(ctx, { id: 'assignment:3', kind: 'assignment', course_id: '1', due_at: iso(-H) });
    // 考試以 start_at 為準；課程 2 覆寫為 P2D
    item(ctx, { id: 'exam:1', kind: 'exam', course_id: '2', title: '期中考', due_at: iso(99 * H), start_at: iso(5 * 24 * H) });
    // P1D 的提醒時間在今天 00:00 之前（due 為今天 20:00 → 昨天 20:00）
    item(ctx, { id: 'assignment:4', kind: 'assignment', course_id: '1', title: '晚作業', due_at: iso(8 * H) });
    markReminderSent(ctx.db, 'assignment:1', 'P1D', iso(0));
    ctx.config.course_overrides['2'] = { reminders: ['P2D'] };
    const r = loadTuiData(ctx).reminders;
    expect(r.map((x) => [x.itemId, x.offset, x.at, x.sent, x.course])).toEqual([
      ['assignment:1', 'P1D', '2026-10-22T12:00:00+08:00', true, '資料結構'],
      ['assignment:4', 'PT3H', '2026-10-22T17:00:00+08:00', false, '資料結構'],
      ['assignment:1', 'PT3H', '2026-10-23T09:00:00+08:00', false, '資料結構'],
      ['exam:1', 'P2D', '2026-10-25T12:00:00+08:00', false, '管理學'],
    ]);
    expect(r[3]?.title).toBe('期中考');
    expect(r.some((x) => x.itemId === 'assignment:4' && x.offset === 'P1D')).toBe(false);
  });
});

describe('reminders after the semester ends', () => {
  it('保留學期的作業與考試不列提醒', () => {
    const ctx = mk();
    course(ctx, '1', '資料結構', '1151_CS101', '115-1');
    course(ctx, '9', '舊課', '1142_OLD', '114-2');
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', due_at: iso(3 * 24 * H) });
    item(ctx, { id: 'assignment:9', kind: 'assignment', course_id: '9', due_at: iso(3 * 24 * H) });
    item(ctx, { id: 'exam:9', kind: 'exam', course_id: '9', start_at: iso(3 * 24 * H) });
    const ids = new Set(loadTuiData(ctx).reminders.map((r) => r.itemId));
    expect(ids).toEqual(new Set(['assignment:1']));
  });
});

describe('announcements', () => {
  it('只留今天（台北）之後，新到舊，附 body 與 url', () => {
    const ctx = mk();
    course(ctx, '1', '(1151_CS101)資料結構', '1151_CS101', '115-1');
    const post = (id: string, at: string, extra: Partial<StoredItem> = {}): void =>
      item(ctx, { id, kind: 'announcement', course_id: '1', title: id, raw: JSON.stringify({ created_at: at }), ...extra });
    post('announcement:old', '2026-10-21T15:59:00Z'); // 10/21 23:59 台北
    post('announcement:a', '2026-10-21T16:00:00Z', { categories: ['room_change'], delivery: 'push', url: 'https://x/a', body: '內文' }); // 10/22 00:00
    post('announcement:b', '2026-10-22T02:00:00Z');
    const a = loadTuiData(ctx).announcements;
    expect(a.map((x) => x.id)).toEqual(['announcement:b', 'announcement:a']);
    expect(a[1]).toEqual({
      id: 'announcement:a', title: 'announcement:a', course: '資料結構', postedAt: '2026-10-22T00:00:00+08:00',
      categories: ['room_change'], delivery: 'push', url: 'https://x/a', body: '內文',
    });
  });
});

describe('notices', () => {
  const event = (type: 'auth.expired', at: Date) =>
    makeEvent({
      type, detectedAt: at, quiet: DEFAULT_CONFIG.quiet_hours, delivery: 'force_push', categories: [],
      matched_rules: [], course: null, item: null, summary: null, dedupe_key: `${type}:${at.toISOString()}`,
    });

  it('首次同步進行中', () => {
    const d = loadTuiData(mk());
    expect(d.notices).toEqual(['首次同步進行中，資料可能不完整（課程 0／?、檔案 0／0）']);
  });

  it('資料不完整、登入過期、規則全停用、CLI Adapter 與 webhook 重試、規則檔問題，依序出現', () => {
    const ctx = mk();
    course(ctx, '1', '資料結構', '1151_CS101', '115-1');
    setSyncState(ctx.db, { initial_completed: true, last_sync_at: iso(-2 * H), incomplete_courses: ['1'] });
    ctx.outbox.append(event('auth.expired', new Date(NOW.getTime() - H)));
    ctx.rules = ctx.rules.map((r) => ({ ...r, enabled: false }));
    ctx.config.delivery.cli.enabled = true;
    ctx.config.delivery.webhook.enabled = false;
    vi.spyOn(ctx.outbox, 'hookStats').mockImplementation((ch) =>
      ch === 'cli' ? { retrying: 2, gave_up: 0, last_error: null } : { retrying: 0, gave_up: 3, last_error: null });
    ctx.rulesWarning = 'rules.yaml 無效';
    expect(loadTuiData(ctx).notices).toEqual([
      '資料可能不完整：資料結構',
      '登入已過期，請在終端執行 ilearn login',
      '通知規則全部停用，新公告不會推送',
      'CLI Adapter（本機指令）：重試中 2 則',
      '本機 webhook（已停用）：放棄 3 則',
      '規則檔有問題：rules.yaml 無效',
    ]);
  });

  it('auth.expired 早於最近同步時不提示', () => {
    const ctx = mk();
    setSyncState(ctx.db, { initial_completed: true, last_sync_at: iso(-H) });
    ctx.outbox.append(event('auth.expired', new Date(NOW.getTime() - 5 * H)));
    expect(loadTuiData(ctx).notices).toEqual([]);
  });

  it('從未同步但有 auth.expired 時提示', () => {
    const ctx = mk();
    setSyncState(ctx.db, { initial_completed: true, last_sync_at: null });
    ctx.outbox.append(event('auth.expired', new Date(NOW.getTime() - 5 * H)));
    expect(loadTuiData(ctx).notices).toEqual(['登入已過期，請在終端執行 ilearn login']);
  });

  it('規則為空時不提示全部停用', () => {
    const ctx = mk();
    setSyncState(ctx.db, { initial_completed: true, last_sync_at: iso(-H) });
    ctx.rules = [];
    expect(loadTuiData(ctx).notices).toEqual([]);
  });
});

describe('空資料', () => {
  it('0 門課不拋例外，回傳空陣列', () => {
    const ctx = mk();
    const d = loadTuiData(ctx);
    expect(d.courses).toEqual([]);
    expect(d.archived).toEqual([]);
    expect(d.reminders).toEqual([]);
    expect(d.announcements).toEqual([]);
    expect(d.home).toEqual({ overdue: [], within7d: [], later: [], notStarted: [] });
    expect(d.notices[0]).toContain('首次同步進行中');
    expect(d.rules).toBe(ctx.rules);
    expect(d.config).toBe(ctx.config);
  });
});

describe('courseDetail', () => {
  it('grades 只留已公布分數的列', () => {
    const ctx = mk();
    course(ctx, '1', '資料結構', '1151_CS101', '115-1');
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', score: '90', score_published: true });
    item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', score: '80', score_published: false });
    item(ctx, { id: 'exam:1', kind: 'exam', course_id: '1', feedback: '好', score_published: false });
    const d = courseDetail(ctx, '1');
    expect(d.grades.map((g) => g.id)).toEqual(['assignment:1']);
    expect(d.course.id).toBe('1');
    expect(d.todo.length).toBe(2);
  });
});

describe('唯讀', () => {
  it('loadTuiData 與 courseDetail 不寫入任何檔案', () => {
    const ctx = mk();
    course(ctx, '1', '資料結構', '1151_CS101', '115-1');
    item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', due_at: iso(H) });
    const before = files(ctx.root);
    loadTuiData(ctx);
    courseDetail(ctx, '1');
    expect(files(ctx.root)).toEqual(before);
  });
});
