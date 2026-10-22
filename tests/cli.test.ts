import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/ilearn/api.js';
import { upsertFile, upsertItem, type StoredFile, type StoredItem } from '../src/db/repo.js';
import { runSync } from '../src/sync/sync.js';
import { CliExit, createContext, createReadContext, loadRules, type CliContext } from '../src/cli/context.js';
import {
  ackCommand,
  announcementsCommand,
  courseCommand,
  coursesCommand,
  eventsCommand,
  fileTextCommand,
  filesSearchCommand,
  gradesCommand,
  markTeammateCommand,
  statusCommand,
  tasksCommand,
} from '../src/cli/commands/query.js';
import { rulesEditCommand, rulesTestCommand, validateRules } from '../src/cli/commands/rules.js';
import { reloadCommand, runHandler, runTick, syncCommand, syncHandler } from '../src/cli/commands/sync.js';
import {
  DEFAULT_WEBHOOK_URL,
  deliverySummary,
  detectEnvironment,
  formatFetchDone,
  formatProgress,
  formatSummary,
  KEYS_HELP_CHECKBOX,
  KEYS_HELP_SELECT,
  setupDefaults,
  stepHeader,
  summaryExtras,
} from '../src/cli/setup.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { tasksText } from '../src/cli/format.js';
import { courseViewHtml, createFakeApi, standardData, type FakeData } from './helpers/fakeApi.js';

const HOUR = 3600_000;

interface Env {
  ctx: CliContext;
  fake: ReturnType<typeof createFakeApi>;
  clock: { now: Date };
  root: string;
}

function mk(over: { data?: FakeData; relogin?: (c: CliContext) => Promise<boolean> } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-cli-'));
  const fake = createFakeApi(over.data ?? standardData());
  const clock = { now: new Date('2026-10-22T04:00:00Z') }; // 12:00 台北
  const ctx = createContext({
    root,
    api: fake.api,
    fetchText: () => Promise.resolve(courseViewHtml()),
    now: () => clock.now,
    userId: 777,
    ...(over.relogin ? { relogin: over.relogin } : {}),
  });
  return { ctx, fake, clock, root };
}

/** 跑一次完整的首次同步，並把時間推進一小時。 */
async function seeded(over: Parameters<typeof mk>[0] = {}): Promise<Env> {
  const env = mk(over);
  await runSync(env.ctx);
  env.clock.now = new Date(env.clock.now.getTime() + HOUR);
  return env;
}

const json = (v: unknown): string => JSON.stringify(v);

describe('tasks', () => {
  it('lists pending assignments and videos as JSON without secrets or raw columns', async () => {
    const { ctx } = await seeded();
    const r = tasksCommand(ctx);
    const text = json(r);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toMatch(/password|session|cookie|"raw"/i);
    expect(r.initial_sync_in_progress).toBe(false);
    expect(r.tasks.map((t) => t.id).sort()).toEqual(['assignment:101', 'video:103']);
    const hw = r.tasks.find((t) => t.id === 'assignment:101');
    expect(hw).toMatchObject({ kind: 'assignment', course: '資料結構', overdue: false, teammate_hint: false });
    expect(hw?.due_at).toBe('2026-10-30T23:59:00+08:00');
  });

  it('marks not_started for assignments whose start time is in the future', async () => {
    const env = mk();
    const act = env.fake.data.activities[1]?.find((a) => a.id === 101);
    if (act) act.start_time = '2026-11-27T00:00:00Z';
    await runSync(env.ctx);
    env.clock.now = new Date(env.clock.now.getTime() + HOUR);
    const r = tasksCommand(env.ctx);
    expect(r.tasks.find((t) => t.id === 'assignment:101')?.not_started).toBe(true);
    expect(r.tasks.find((t) => t.id === 'video:103')?.not_started).toBe(false);
    expect(tasksText(r)).toContain('（尚未開放）');
    const todo = courseCommand(env.ctx, '1').todo;
    expect(todo.find((t) => t.id === 'assignment:101')?.not_started).toBe(true);
    env.clock.now = new Date('2026-11-28T00:00:00Z');
    expect(tasksCommand(env.ctx).tasks.find((t) => t.id === 'assignment:101')?.not_started).toBe(false);
  });

  it('not_started is false when there is no start time', async () => {
    const { ctx } = await seeded();
    expect(tasksCommand(ctx).tasks.every((t) => t.not_started === false)).toBe(true);
  });

  it('flags overdue items', async () => {
    const env = await seeded();
    env.clock.now = new Date('2026-11-02T04:00:00Z');
    expect(tasksCommand(env.ctx).tasks.find((t) => t.id === 'assignment:101')?.overdue).toBe(true);
  });

  it('reports initial_sync_in_progress before the first sync completes', async () => {
    const env = mk();
    expect(tasksCommand(env.ctx).initial_sync_in_progress).toBe(true);

    env.fake.data.fail['homework:1'] = new ApiError(500, '/api/courses/1/homework-activities');
    await syncCommand(env.ctx, { force: true });
    const r = tasksCommand(env.ctx);
    expect(r.initial_sync_in_progress).toBe(true);
    expect(r.incomplete_courses).toEqual(['資料結構']);
  });
});

describe('events and ack', () => {
  async function withNightEvent(): Promise<Env> {
    const env = await seeded();
    env.fake.data.activities[1]?.push({ id: 105, type: 'homework', title: '作業二', end_time: '2026-11-20T15:59:00Z', published: true });
    env.fake.data.homework[1]?.push({
      id: 105, title: '作業二', end_time: '2026-11-20T15:59:00Z', submit_by_group: false, submitted: false,
      submitted_status: null, is_closed: false, score: null, score_published: false,
    });
    env.clock.now = new Date('2026-10-22T17:30:00Z'); // 翌日 01:30 台北，夜間
    await syncCommand(env.ctx, { force: true });
    return env;
  }

  it('--deliverable hides events whose deliver_after has not arrived', async () => {
    const env = await withNightEvent();
    const all = eventsCommand(env.ctx, { agent: 'a' });
    const night = all.find((e) => e.type === 'assignment.new');
    expect(night).toBeDefined();
    expect(night?.deliver_after).toBe('2026-10-23T07:00:00+08:00');

    const now = eventsCommand(env.ctx, { deliverable: true, agent: 'a' });
    expect(now.map((e) => e.event_id)).not.toContain(night?.event_id);
    expect(json(now)).not.toContain('2026-10-23T07:00:00+08:00');

    env.clock.now = new Date('2026-10-22T23:30:00Z'); // 07:30 台北
    const later = eventsCommand(env.ctx, { deliverable: true, agent: 'a' });
    expect(later.map((e) => e.event_id)).toContain(night?.event_id);
  });

  it('ack removes events from that agent only', async () => {
    const env = await withNightEvent();
    env.clock.now = new Date('2026-10-22T23:30:00Z');
    const before = eventsCommand(env.ctx, { deliverable: true, agent: 'a' });
    expect(before.length).toBeGreaterThan(0);
    const target = before[0];
    ackCommand(env.ctx, 'a', target?.event_id ?? '');
    const after = eventsCommand(env.ctx, { deliverable: true, agent: 'a' });
    expect(after.map((e) => e.event_id)).not.toContain(target?.event_id);
    expect(eventsCommand(env.ctx, { deliverable: true, agent: 'b' }).map((e) => e.event_id)).toContain(target?.event_id);
  });

  it('rejects unknown event ids, bad agent names and unknown types', async () => {
    const env = await seeded();
    expect(() => ackCommand(env.ctx, 'a', 'nope')).toThrow(CliExit);
    expect(() => eventsCommand(env.ctx, { type: 'bogus' })).toThrow(CliExit);
    const id = eventsCommand(env.ctx, {})[0]?.event_id ?? '';
    expect(() => ackCommand(env.ctx, '../x', id)).toThrow();
  });
});

describe('mark-teammate', () => {
  it('refuses to run without a TTY', async () => {
    const { ctx } = await seeded();
    let code = 0;
    try {
      markTeammateCommand(ctx, { itemId: 'assignment:101', isTTY: false });
    } catch (e) {
      code = e instanceof CliExit ? e.code : -1;
    }
    expect(code).toBe(1);
    expect(tasksCommand(ctx).tasks.map((t) => t.id)).toContain('assignment:101');
  });

  it('marks and undoes in a TTY; the mark survives a sync and undo is recomputed', async () => {
    const env = await seeded();
    expect(markTeammateCommand(env.ctx, { itemId: '101', isTTY: true }).completion).toBe('teammate_marked');
    expect(tasksCommand(env.ctx).tasks.map((t) => t.id)).not.toContain('assignment:101');
    await syncCommand(env.ctx, { force: true });
    expect(tasksCommand(env.ctx).tasks.map((t) => t.id)).not.toContain('assignment:101');
    markTeammateCommand(env.ctx, { itemId: 'assignment:101', undo: true, isTTY: true });
    expect(tasksCommand(env.ctx).tasks.map((t) => t.id)).toContain('assignment:101');
  });

  it('rejects unknown items', async () => {
    const { ctx } = await seeded();
    expect(() => markTeammateCommand(ctx, { itemId: '999', isTTY: true })).toThrow(CliExit);
  });
});

describe('courses, announcements, grades, files', () => {
  it('grades lists published scores', async () => {
    const env = await seeded();
    expect(gradesCommand(env.ctx, {})).toEqual([]);
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) {
      hw.score = 95;
      hw.score_published = true;
    }
    await syncCommand(env.ctx, { force: true });
    const g = gradesCommand(env.ctx, {});
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: '作業一', score: '95', score_published: true, course: '資料結構' });
    expect(gradesCommand(env.ctx, { course: '2' })).toEqual([]);
    expect(json(g)).not.toMatch(/"raw"/);
  });

  it('course returns everything for one course with local paths under the data root', async () => {
    const { ctx, root } = await seeded();
    const c = courseCommand(ctx, '1');
    expect(c.course.name).toBe('資料結構');
    expect(c.schedule.text).not.toBe('');
    expect(c.todo.map((t) => t.id)).toEqual(['assignment:101']);
    expect(c.exams.map((t) => t.id)).toEqual(['exam:301']);
    expect(c.announcements[0]?.categories).toBeDefined();
    expect(c.videos.map((t) => t.id)).toEqual(['video:103']);
    expect(c.files.length).toBeGreaterThan(0);
    for (const f of c.files) if (f.local_path) expect(f.local_path.startsWith(root)).toBe(true);
    expect(json(c)).not.toMatch(/"raw"/);
    expect(() => courseCommand(ctx, '404')).toThrow(CliExit);
  });

  it('courses lists current and retained semesters', async () => {
    const { ctx } = await seeded();
    const rows = coursesCommand(ctx);
    expect(rows.map((r) => r.id).sort()).toEqual(['1', '2']);
    expect(rows.every((r) => r.current)).toBe(true);
  });

  it('announcements filters by category', async () => {
    const { ctx } = await seeded();
    expect(announcementsCommand(ctx, {})).toHaveLength(1);
    expect(announcementsCommand(ctx, { category: 'no_such_category' })).toHaveLength(0);
    const cat = announcementsCommand(ctx, {})[0]?.categories[0] ?? '';
    expect(announcementsCommand(ctx, { category: cat })).toHaveLength(1);
  });

  it('files search finds by name; file text reads .md and reports other formats as unsupported', async () => {
    const data = standardData();
    const m = data.activities[1]?.[1];
    if (m?.uploads?.[0]) m.uploads[0].name = '講義1.md';
    data.blobs[5002] = '# 第一週\n內容';
    const { ctx } = await seeded({ data });
    const hits = filesSearchCommand(ctx, '講義');
    expect(hits.map((h) => h.id)).toEqual(['5002']);
    expect(fileTextCommand(ctx, '5002')).toEqual({ supported: true, text: '# 第一週\n內容' });

    const pdf = filesSearchCommand(ctx, '課程簡介')[0];
    expect(fileTextCommand(ctx, pdf?.id ?? '')).toMatchObject({ supported: false });
    expect(() => fileTextCommand(ctx, 'nope')).toThrow(CliExit);
  });
});

describe('reload', () => {
  it('--yes reports the pushed count and writes one reload_id batch', async () => {
    const env = await seeded();
    const r = await reloadCommand(env.ctx, { yes: true });
    expect(r.cancelled).toBe(false);
    expect(r.pushed).toBeGreaterThan(0);
    expect(r.pushed).toBe(r.planned);
    expect(r.reload_id).not.toBeNull();
    const batch = eventsCommand(env.ctx, {}).filter((e) => e.reason === 'reload');
    expect(batch).toHaveLength(r.pushed);
    expect(new Set(batch.map((e) => e.reload_id))).toEqual(new Set([r.reload_id]));
  });

  it('delivers to the hook immediately, even at night', async () => {
    const env = await seeded();
    env.clock.now = new Date('2026-10-22T17:00:00Z'); // 01:00 台北
    const out = join(env.root, 'hook.jsonl');
    env.ctx.config.delivery.hook = { enabled: true, command: `cat >> "${out}"` };
    const r = await reloadCommand(env.ctx, { yes: true });
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(r.pushed);
    const ids = new Set(lines.map((l) => (JSON.parse(l) as { reload_id?: string }).reload_id));
    expect(ids.has(r.reload_id ?? '')).toBe(true);
  });

  it('asks for confirmation and pushes nothing when declined', async () => {
    const env = await seeded();
    const r = await reloadCommand(env.ctx, { isTTY: true, confirm: () => Promise.resolve(false) });
    expect(r.cancelled).toBe(true);
    expect(r.pushed).toBe(0);
    expect(eventsCommand(env.ctx, {}).filter((e) => e.reason === 'reload')).toHaveLength(0);
  });

  it('refuses without --yes in a non-interactive shell, and before the first sync is complete', async () => {
    const env = await seeded();
    await expect(reloadCommand(env.ctx, { isTTY: false })).rejects.toMatchObject({ code: 1 });

    const fresh = mk();
    fresh.fake.data.fail['homework:1'] = new ApiError(500, '/x');
    await expect(reloadCommand(fresh.ctx, { yes: true })).rejects.toMatchObject({ code: 1 });
  });
});

describe('login expiry', () => {
  it('without a saved password: appends auth.expired once per day and exits with code 2', async () => {
    const env = await seeded({ relogin: () => Promise.resolve(false) });
    env.fake.data.fail.myCourses = new ApiError(401, '/api/my-courses');
    await expect(syncCommand(env.ctx, { force: true })).rejects.toMatchObject({ code: 2 });
    await expect(syncCommand(env.ctx, { force: true })).rejects.toMatchObject({ code: 2 });
    const ev = eventsCommand(env.ctx, { type: 'auth.expired' });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.delivery).toBe('push');
    expect(json(ev)).not.toMatch(/password|cookie/i);
  });

  it('with a working re-login: retries once and succeeds', async () => {
    let calls = 0;
    const env = await seeded({
      relogin: () => {
        calls++;
        return Promise.resolve(true);
      },
    });
    env.fake.data.fail.myCourses = new ApiError(401, '/api/my-courses');
    env.fake.data.hooks.myCourses = (): void => {
      if (calls > 0) delete env.fake.data.fail.myCourses;
    };
    const r = await syncCommand(env.ctx, { force: true });
    expect(r.skipped).toBe(false);
    expect(calls).toBe(1);
    expect(eventsCommand(env.ctx, { type: 'auth.expired' })).toHaveLength(0);
  });

  it('records the last error for status without leaking secrets', async () => {
    const env = await seeded({ relogin: () => Promise.resolve(false) });
    env.fake.data.fail.myCourses = new ApiError(500, '/api/my-courses');
    await expect(syncCommand(env.ctx, { force: true })).rejects.toThrow();
    const s = statusCommand(env.ctx);
    expect(s.last_error?.message).toContain('500');
    expect(json(s)).not.toMatch(/password|cookie|"raw"/i);
  });
});

describe('run', () => {
  it('syncs only when due and always runs reminders', async () => {
    const env = await seeded(); // 最近一次同步 12:00，現在 13:00
    env.clock.now = new Date('2026-10-22T04:30:00Z'); // 12:30，12:00 的時段已同步過
    expect((await runTick(env.ctx, { jitterMs: 0 })).synced).toBe(false);
    env.clock.now = new Date('2026-10-22T05:10:00Z'); // 13:10，13:00 時段到了
    const r = await runTick(env.ctx, { jitterMs: 0 });
    expect(r.synced).toBe(true);
  });

  it('runs the hook for each deliverable push event, once', async () => {
    const env = await seeded();
    await reloadCommand(env.ctx, { yes: true });
    const out = join(env.root, 'hook.jsonl');
    env.ctx.config.delivery.hook = { enabled: true, command: `cat >> "${out}"` };
    const r1 = await runTick(env.ctx, { jitterMs: 0 });
    const pushable = eventsCommand(env.ctx, { deliverable: true }).filter((e) => e.delivery !== 'record');
    expect(pushable.length).toBeGreaterThan(0);
    expect(r1.delivery.hook).toEqual({ sent: pushable.length, failed: 0 });
    const got = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event_id: string });
    expect(got.map((e) => e.event_id)).toEqual(pushable.map((e) => e.event_id));
    const r2 = await runTick(env.ctx, { jitterMs: 0 });
    expect(r2.delivery.hook.sent).toBe(0);
  });

  it('logs hook failures, shows them in status and keeps events in the outbox', async () => {
    const env = await seeded();
    await reloadCommand(env.ctx, { yes: true });
    const before = eventsCommand(env.ctx, {}).length;
    env.ctx.config.delivery.hook = { enabled: true, command: 'exit 7' };
    const logs: string[] = [];
    const r = await runTick(env.ctx, { jitterMs: 0, log: (s) => logs.push(s) });
    expect(r.delivery.hook.failed).toBeGreaterThan(0);
    expect(logs).toContain(`本機指令 hook：${r.delivery.hook.failed} 則送出失敗，稍後重試（exit code 7）`);
    const s = statusCommand(env.ctx);
    expect(s.delivery.hook).toMatchObject({ enabled: true, retrying: r.delivery.hook.failed, gave_up: 0 });
    expect(json(s)).not.toContain('exit 7"');
    expect(eventsCommand(env.ctx, {})).toHaveLength(before);
  });
});

describe('status', () => {
  it('reports initial progress and file counts', async () => {
    const env = mk();
    env.fake.data.fail['homework:1'] = new ApiError(500, '/x');
    await syncCommand(env.ctx, { force: true });
    const s = statusCommand(env.ctx);
    expect(s.initial_sync_in_progress).toBe(true);
    expect(s.first_sync_progress?.courses_done).toBe(1);
    expect(s.incomplete_courses).toEqual(['資料結構']);
  });
});

describe('rules', () => {
  const GOOD = `- id: only_one
  name: 只有一條
  action: push
  any: [停課]
`;

  it('validateRules reports the line number for an unknown action and does not throw', async () => {
    const { ctx } = await seeded();
    const bad = 'x: [';
    const v1 = validateRules(ctx, bad);
    expect(v1.ok).toBe(false);
    const v2 = validateRules(ctx, `- id: a\n  name: a\n  action: shout\n  any: [x]\n`);
    expect(v2).toMatchObject({ ok: false, line: 3 });
    const v3 = validateRules(ctx, `- id: a\n  action: push\n  regex: ['(']\n`);
    expect(v3).toMatchObject({ ok: false });
    expect(validateRules(ctx, GOOD).ok).toBe(true);
  });

  it('edit refuses to save invalid YAML and saves valid YAML after confirmation', async () => {
    const { ctx, root } = await seeded();
    const file = join(root, 'rules.yaml');
    const retried: string[] = [];
    const bad = await rulesEditCommand(ctx, {
      editor: (p) => writeFileSync(p, '- id: a\n  action: shout\n'),
      confirm: () => Promise.resolve(true),
      retry: (m) => {
        retried.push(m);
        return Promise.resolve(false);
      },
    });
    expect(bad.saved).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(retried[0]).toContain('第');

    let preview = '';
    const good = await rulesEditCommand(ctx, {
      editor: (p) => writeFileSync(p, GOOD),
      confirm: (p) => {
        preview = p;
        return Promise.resolve(true);
      },
      retry: () => Promise.resolve(false),
    });
    expect(good.saved).toBe(true);
    expect(preview).toContain('規則有效');
    expect(readFileSync(file, 'utf8')).toContain('only_one');
    expect(ctx.rules.map((r) => r.id)).toEqual(['only_one']);
  });

  it('edit declined by the user leaves rules.yaml untouched', async () => {
    const { ctx, root } = await seeded();
    const r = await rulesEditCommand(ctx, {
      editor: (p) => writeFileSync(p, GOOD),
      confirm: () => Promise.resolve(false),
      retry: () => Promise.resolve(false),
    });
    expect(r.saved).toBe(false);
    expect(existsSync(join(root, 'rules.yaml'))).toBe(false);
  });

  it('a broken rules.yaml falls back to the last valid rules', async () => {
    const { root } = await seeded();
    writeFileSync(join(root, 'rules.yaml'), GOOD);
    expect(loadRules(root).rules.map((r) => r.id)).toEqual(['only_one']);
    writeFileSync(join(root, 'rules.yaml'), '- id: a\n  action: shout\n');
    const r = loadRules(root);
    expect(r.rules.map((x) => x.id)).toEqual(['only_one']);
    expect(r.warning).toContain('第');
  });

  it('rules test compares a file against the active rules without saving', async () => {
    const env = await seeded();
    env.fake.data.bulletins[1]?.push({ id: 88001, title: '明天停課', content: '<p>停課一次</p>', created_at: '2026-10-22T02:00:00Z' });
    await syncCommand(env.ctx, { force: true });
    const f = join(env.root, 'candidate.yaml');
    writeFileSync(f, GOOD);
    const v = rulesTestCommand(env.ctx, f);
    expect(v.ok).toBe(true);
    expect(existsSync(join(env.root, 'rules.yaml'))).toBe(false);
    expect(() => rulesTestCommand(env.ctx, join(env.root, 'missing.yaml'))).toThrow(CliExit);
  });
});

describe('pure setup helpers', () => {
  it('detectEnvironment', () => {
    expect(detectEnvironment({ SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' }, 'darwin')).toBe('vps');
    expect(detectEnvironment({}, 'linux')).toBe('vps');
    expect(detectEnvironment({ DISPLAY: ':0' }, 'linux')).toBe('desktop');
    expect(detectEnvironment({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe('desktop');
    expect(detectEnvironment({}, 'darwin')).toBe('desktop');
    expect(detectEnvironment({}, 'win32')).toBe('desktop');
  });

  it('formatSummary lists courses, pending, upcoming items and failures in zh-TW', () => {
    const text = formatSummary(
      {
        initial: true, courses: 5, pendingAssignments: 3,
        upcoming3d: [{ title: '作業一', due_at: '2026-10-25T23:59:00+08:00' }],
        incompleteCourses: ['管理學'], filesFailed: [{ name: 'a.pdf', reason: 'HTTP 500' }], eventsEmitted: 1,
      },
      { exams: [{ title: '期中考', start_at: '2026-10-24T09:00:00+08:00' }] },
    );
    expect(text).toContain('首次同步完成');
    expect(text).toContain('課程數：5');
    expect(text).toContain('未完成作業：3');
    expect(text).toContain('作業 作業一，截止 10-25 23:59');
    expect(text).toContain('考試 期中考');
    expect(text).toContain('a.pdf');
    expect(text).toContain('管理學');
    expect(text).not.toMatch(/·|→|[\u{1F300}-\u{1FAFF}]/u);
  });

  it('summaryExtras splits pending assignments and file states; formatSummary prints exact lines', () => {
    const { ctx } = mk();
    const now = new Date('2026-10-22T04:00:00Z');
    const iso = (d: number): string => new Date(now.getTime() + d * 86400_000).toISOString();
    const base = (id: string, over: Partial<StoredItem>): StoredItem => ({
      id, kind: 'assignment', course_id: 'c1', title: id, body: null, due_at: null, start_at: null, url: null,
      completion: 'pending', teammate_hint: false, group: false, score: null, score_published: false,
      feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
      first_seen_at: iso(-10), updated_at: iso(-10), ...over,
    });
    const items: StoredItem[] = [
      base('open1', { due_at: iso(5) }),
      base('open2', { due_at: null }),
      base('future1', { start_at: iso(10), due_at: iso(17) }),
      base('over1', { due_at: iso(-1) }),
      base('over2', { due_at: iso(-2), teammate_hint: true, group: true }),
      base('done1', { due_at: iso(-3), completion: 'completed' }),
      base('exam1', { kind: 'exam', due_at: iso(-3) }),
    ];
    for (const it of items) upsertItem(ctx.db, it);
    const file = (id: string, status: StoredFile['status'], size: number): StoredFile => ({
      upload_id: id, item_id: 'open1', course_id: 'c1', name: id, size, hash: null,
      local_path: null, status, link: null, allow_download: status !== 'skipped',
    });
    upsertFile(ctx.db, file('f1', 'done', 150 * 1024 * 1024));
    upsertFile(ctx.db, file('f2', 'done', 72 * 1024 * 1024));
    upsertFile(ctx.db, file('f3', 'skipped', 5));
    upsertFile(ctx.db, file('f4', 'skipped', 5));
    upsertFile(ctx.db, file('f5', 'link', 0));
    const extras = summaryExtras(ctx.db, now);
    const report = {
      initial: false, courses: 2, pendingAssignments: 5, upcoming3d: [], incompleteCourses: [],
      filesFailed: [], eventsEmitted: 0,
    };
    const lines = formatSummary(report, extras).split('\n');
    expect(lines).toContain('未完成作業：進行中 2、尚未開放 1、逾期 2（其中 1 份系統顯示隊員已交）');
    expect(lines).toContain('檔案：已下載 2 個（222 MB）、略過 2 個（老師關閉下載）、外部連結 1 個');
    expect(lines).toContain('3 日內截止或考試：沒有');
    expect(lines).toContain('下載失敗：沒有');
  });

  it('formatSummary omits zero parts and formats small sizes', () => {
    const { ctx } = mk();
    upsertFile(ctx.db, {
      upload_id: 'a', item_id: 'x', course_id: 'c1', name: 'a', size: 3 * 1024 * 1024 + 512 * 1024, hash: null,
      local_path: null, status: 'done', link: null, allow_download: true,
    });
    const report = {
      initial: false, courses: 1, pendingAssignments: 0, upcoming3d: [], incompleteCourses: [],
      filesFailed: [], eventsEmitted: 0,
    };
    const lines = formatSummary(report, summaryExtras(ctx.db, new Date('2026-10-22T04:00:00Z'))).split('\n');
    expect(lines).toContain('未完成作業：進行中 0、尚未開放 0、逾期 0');
    expect(lines).toContain('檔案：已下載 1 個（3.5 MB）');
  });

  it('formatFetchDone summarises the finished background fetch', () => {
    const p = { coursesDone: 12, coursesTotal: 12, filesDone: 75, filesTotal: 75, bytes: 229114880 };
    expect(formatFetchDone(true, p)).toBe('✔ 首次提取完成：課程 12/12、檔案 75/75（218.5 MB）');
    expect(formatFetchDone(false, { ...p, filesDone: 0, filesTotal: 0, bytes: 0 })).toBe(
      '✔ 背景同步完成：課程 12/12、檔案 0/0（0 B）',
    );
  });

  it('formatProgress shows courses, files and size', () => {
    expect(formatProgress({ coursesDone: 2, coursesTotal: 5, filesDone: 3, filesTotal: 10, bytes: 2 * 1024 * 1024 })).toBe(
      '課程 2/5，檔案 3/10，已下載 2.0 MB',
    );
  });
});

describe('not set up yet', () => {
  const missingRoot = (): string => join(mkdtempSync(join(tmpdir(), 'ilearn-notsetup-')), 'root');

  it('sync and run exit with code 2 and create nothing', async () => {
    const root = missingRoot();
    await expect(syncHandler({ force: true }, { root })).rejects.toMatchObject({ code: 2, message: '尚未設定，請先執行 ilearn setup' });
    await expect(runHandler({ root })).rejects.toMatchObject({ code: 2, message: '尚未設定，請先執行 ilearn setup' });
    expect(existsSync(root)).toBe(false);
  });

  it('query context on a missing root creates nothing and returns empty results', () => {
    const root = missingRoot();
    const ctx = createReadContext({ root });
    expect(tasksCommand(ctx).tasks).toEqual([]);
    expect(tasksCommand(ctx).initial_sync_in_progress).toBe(true);
    expect(eventsCommand(ctx, {})).toEqual([]);
    expect(coursesCommand(ctx)).toEqual([]);
    expect(statusCommand(ctx)).toBeDefined();
    expect(existsSync(root)).toBe(false);
  });
});

describe('setup delivery step', () => {
  it('summarises the chosen delivery methods', () => {
    const d = structuredClone(DEFAULT_CONFIG.delivery);
    expect(deliverySummary(d)).toBe('outbox 檔案');
    d.hook = { enabled: true, command: 'my-agent notify' };
    d.webhook = { enabled: true, url: DEFAULT_WEBHOOK_URL };
    expect(deliverySummary(d)).toBe('outbox 檔案、本機指令 hook（my-agent notify）、本機 webhook（http://127.0.0.1:8787/ilearn）');
  });
});

describe('setup layout helpers', () => {
  it('stepHeader prints the exact three-line block', () => {
    const rule = '\u2500'.repeat(30);
    expect(stepHeader(5, 8, '要啟用的介面').split('\n')).toEqual([rule, '步驟 5／8\u3000要啟用的介面', rule]);
  });

  it('key help strings are bilingual', () => {
    expect(KEYS_HELP_CHECKBOX).toBe('↑↓ 移動 Move  Space 剔選 Select  a 全選 All  i 反選 Invert  Enter 確認 Confirm');
    expect(KEYS_HELP_SELECT).toBe('↑↓ 移動 Move  Enter 確認 Confirm');
  });

  it('setupDefaults uses detection without a config and saved answers with one', () => {
    expect(setupDefaults(null, 'vps')).toEqual({
      environment: 'vps', folder: true, passwordSaved: false, materials: [], announcements: [],
    });
    expect(setupDefaults(null, 'desktop')).toMatchObject({ environment: 'desktop', folder: false });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.environment = 'vps';
    cfg.interfaces.folder = false;
    cfg.password_saved = true;
    cfg.summaries.courses = { a: { materials: true, announcements: false }, b: { materials: false, announcements: true } };
    expect(setupDefaults(cfg, 'desktop')).toEqual({
      environment: 'vps', folder: false, passwordSaved: true, materials: ['a'], announcements: ['b'],
    });
  });
});
