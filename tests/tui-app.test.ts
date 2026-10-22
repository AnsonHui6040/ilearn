import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliExit, createContext, rulesPath, type CliContext } from '../src/cli/context.js';
import { DEFAULT_RULES } from '../src/rules/engine.js';
import { stringifyRules } from '../src/rules/yaml.js';
import { setSyncState, upsertCourse, upsertItem } from '../src/db/repo.js';
import { assertInteractive, defaultOpener, mapKey, nodeTerm, runUi, type PromptDeps, type Term, type UiKey } from '../src/tui/app.js';

const ESC = String.fromCharCode(27);
const ENTER_ALT = `${ESC}[?1049h`;
const LEAVE_ALT = `${ESC}[?1049l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;

function seeded(): { ctx: CliContext; clock: { now: Date } } {
  const clock = { now: new Date('2026-10-22T04:00:00Z') };
  const ctx = createContext({ root: mkdtempSync(join(tmpdir(), 'ilearn-app-')), now: () => clock.now, userId: 1 });
  setSyncState(ctx.db, { initial_completed: true, last_sync_at: '2026-10-22T03:00:00.000Z' });
  upsertCourse(ctx.db, { id: '1', name: '(1151_1236)數位行銷', code: '1151_1236', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  upsertItem(ctx.db, {
    id: 'assignment:1', kind: 'assignment', course_id: '1', title: '小組作業五', body: null, due_at: '2026-10-28T01:00:00.000Z',
    start_at: null, url: null, completion: 'pending', teammate_hint: false, group: true, score: null, score_published: false,
    feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z',
  });
  return { ctx, clock };
}

interface FakeTerm extends Term {
  out: string[];
  press: (k: UiKey) => void;
  resize: (cols: number, rows: number) => void;
  raw: boolean[];
}

function fakeTerm(cols = 100, rows = 30): FakeTerm {
  let size = { cols, rows };
  let keyFn: ((k: UiKey) => void) | null = null;
  let resizeFn: (() => void) | null = null;
  const t: FakeTerm = {
    out: [],
    raw: [],
    write: (s) => void t.out.push(s),
    size: () => size,
    onKey: (fn) => {
      keyFn = fn;
      return () => (keyFn = null);
    },
    onResize: (fn) => {
      resizeFn = fn;
      return () => (resizeFn = null);
    },
    setRaw: (on) => void t.raw.push(on),
    press: (k) => keyFn?.(k),
    resize: (c, r) => {
      size = { cols: c, rows: r };
      resizeFn?.();
    },
  };
  return t;
}

function fakeClock() {
  let tick: (() => void) | null = null;
  return { every: (_ms: number, fn: () => void) => ((tick = fn), () => (tick = null)), fire: () => tick?.() };
}

const noPrompts: PromptDeps = {
  input: () => Promise.reject(new Error('unexpected input')),
  checkbox: () => Promise.reject(new Error('unexpected checkbox')),
  select: () => Promise.reject(new Error('unexpected select')),
  confirm: () => Promise.resolve(false),
};

const deps = (over: Partial<Parameters<typeof runUi>[2]> = {}) => ({
  prompts: noPrompts,
  opener: () => ({ ok: true, message: '已開啟' }),
  clock: fakeClock(),
  color: false,
  ...over,
});

const last = (t: FakeTerm): string => t.out.filter((s) => s.startsWith(`${ESC}[H`)).at(-1) ?? '';
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runUi', () => {
  it('enters the alternate screen and restores the terminal on q', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.press('q');
    await done;
    const all = t.out.join('');
    expect(all.indexOf(ENTER_ALT)).toBeLessThan(all.indexOf(HIDE));
    expect(all.lastIndexOf(SHOW)).toBeGreaterThan(all.lastIndexOf(HIDE));
    expect(all.endsWith(LEAVE_ALT)).toBe(true);
    expect(t.raw).toEqual([true, false]);
  });

  it('quits and restores on Ctrl-C', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.press('ctrl-c');
    await done;
    expect(t.out.join('').endsWith(LEAVE_ALT)).toBe(true);
  });

  it('shows an unexpected prompt error and stays open', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const boom: PromptDeps = { ...noPrompts, input: () => Promise.reject(new Error('boom')) };
    const done = runUi(ctx, t, deps({ prompts: boom }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'down', 'enter'] as const) t.press(k); // 夜間時段
    for (let i = 0; i < 5; i++) await tick();
    expect(last(t)).toContain('boom');
    t.press('q');
    await done;
    expect(t.out.join('').endsWith(LEAVE_ALT)).toBe(true);
  });

  it('restores the terminal and rethrows when a timer callback breaks', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const c = fakeClock();
    const done = runUi(ctx, t, deps({ clock: c }));
    await tick();
    ctx.db.close();
    c.fire();
    await expect(done).rejects.toThrow();
    expect(t.out.join('').endsWith(LEAVE_ALT)).toBe(true);
    expect(t.raw.at(-1)).toBe(false);
  });

  it('quits on SIGTERM even while a prompt is open', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const hang: PromptDeps = { ...noPrompts, input: () => new Promise<string>(() => {}) };
    const done = runUi(ctx, t, deps({ prompts: hang }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'down', 'enter'] as const) t.press(k);
    await tick();
    t.press('sigterm');
    await done;
    expect(t.out.join('').endsWith(LEAVE_ALT)).toBe(true);
  });

  it('shows rules.yaml edited outside the UI after the next refresh', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const c = fakeClock();
    const done = runUi(ctx, t, deps({ clock: c }));
    await tick();
    writeFileSync(rulesPath(ctx.root), stringifyRules(DEFAULT_RULES.map((r) => ({ ...r, enabled: false }))));
    c.fire();
    t.press('3');
    expect(last(t)).toContain('通知規則全部停用');
    t.press('q');
    await done;
  });

  it('ignores keys while the window is too small', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.resize(30, 8);
    for (const k of ['2', 'enter', 'space'] as const) t.press(k);
    t.resize(100, 30);
    expect(last(t)).toContain('需要處理');
    expect(last(t)).not.toContain('[x]');
    t.press('q');
    await done;
  });

  it('opens a course from the course list and goes back with Esc', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.press('2');
    t.press('enter');
    expect(last(t)).toContain('課程資訊');
    expect(last(t)).toContain('待辦 1');
    t.press('esc');
    expect(last(t)).toContain('本學期');
    t.press('q');
    await done;
  });

  it('switches to one column after the window shrinks', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.press('5');
    expect(last(t)).toContain('│');
    t.resize(60, 30);
    expect(last(t)).not.toContain('│');
    t.press('q');
    await done;
  });

  it('updates the clock and reloads data every minute', async () => {
    const { ctx, clock } = seeded();
    const t = fakeTerm();
    const c = fakeClock();
    const done = runUi(ctx, t, deps({ clock: c }));
    await tick();
    expect(last(t)).toContain('2026-10-22（四）12:00');
    clock.now = new Date('2026-10-22T04:01:00Z');
    c.fire();
    expect(last(t)).toContain('2026-10-22（四）12:01');
    t.press('q');
    await done;
  });

  it('leaves the full screen for a prompt, saves the answer and comes back', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const answers = ['23:00', '06:30'];
    const prompts: PromptDeps = { ...noPrompts, input: () => Promise.resolve(answers.shift() ?? '') };
    const done = runUi(ctx, t, deps({ prompts }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'down', 'enter'] as const) t.press(k);
    await tick();
    await tick();
    expect(ctx.config.quiet_hours).toEqual({ start: '23:00', end: '06:30' });
    const all = t.out.join('');
    expect(all.split(ENTER_ALT)).toHaveLength(3);
    expect(last(t)).toContain('23:00–06:30');
    t.press('q');
    await done;
  });

  it('marks a group assignment after Space and two Enters', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const done = runUi(ctx, t, deps());
    await tick();
    t.press('space');
    expect(last(t)).toContain('[x]');
    t.press('enter');
    expect(last(t)).toContain('將變更 1 項');
    t.press('enter');
    await tick();
    expect(ctx.db.prepare("SELECT completion FROM items WHERE id = 'assignment:1'").get()).toMatchObject({ completion: 'teammate_marked' });
    expect(last(t)).toContain('已套用 1 項');
    t.press('q');
    await done;
  });
});

describe('settings prompts', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await tick();
  };

  it('edits the keywords of a rule after showing the trial', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const inputs = ['考試／測驗', '期末考、final', '', '成績'];
    const prompts: PromptDeps = {
      ...noPrompts,
      input: () => Promise.resolve(inputs.shift() ?? ''),
      select: (() => Promise.resolve('push')) as PromptDeps['select'],
      confirm: () => Promise.resolve(true),
    };
    const done = runUi(ctx, t, deps({ prompts }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'down', 'down', 'down', 'right', 'enter'] as const) t.press(k); // 通知規則 > exam
    await settle();
    const exam = ctx.rules.find((r) => r.id === 'exam');
    expect(exam?.any).toEqual(['期末考', 'final']);
    expect(exam?.none).toEqual(['成績']);
    expect(t.out.join('')).toContain('規則有效');
    expect(last(t)).toContain('已儲存規則「考試／測驗」');
    t.press('q');
    await done;
  });

  it('adds a new rule', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const inputs = ['field_trip', '校外教學', '參訪、校外教學', '', ''];
    const prompts: PromptDeps = {
      ...noPrompts,
      input: () => Promise.resolve(inputs.shift() ?? ''),
      select: (() => Promise.resolve('push')) as PromptDeps['select'],
      confirm: () => Promise.resolve(true),
    };
    const done = runUi(ctx, t, deps({ prompts }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'down', 'down', 'down', 'right', 'pagedown', 'pagedown', 'pagedown', 'pagedown', 'up', 'enter'] as const) t.press(k);
    await settle();
    expect(ctx.rules.at(-1)).toMatchObject({ id: 'field_trip', name: '校外教學', any: ['參訪', '校外教學'], enabled: true, action: 'push' });
    t.press('q');
    await done;
  });

  it('changes the delivery settings', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const prompts: PromptDeps = {
      ...noPrompts,
      checkbox: (() => Promise.resolve(['hook'])) as PromptDeps['checkbox'],
      input: () => Promise.resolve('my-agent notify'),
    };
    const done = runUi(ctx, t, deps({ prompts }));
    await tick();
    for (const k of ['5', 'down', 'down', 'down', 'enter', 'down', 'down', 'down', 'down', 'enter'] as const) t.press(k); // 推送方式 > 修改推送方式
    await settle();
    expect(ctx.config.delivery.hook).toEqual({ enabled: true, command: 'my-agent notify' });
    expect(last(t)).toContain('已儲存推送方式');
    t.press('q');
    await done;
  });

  it('turns the folder view off', async () => {
    const { ctx } = seeded();
    const t = fakeTerm();
    const prompts: PromptDeps = { ...noPrompts, checkbox: (() => Promise.resolve(['terminal'])) as PromptDeps['checkbox'] };
    const done = runUi(ctx, t, deps({ prompts }));
    await tick();
    for (const k of ['5', 'down', 'down', 'enter', 'down', 'down', 'down', 'down', 'enter'] as const) t.press(k); // 介面啟用 > 修改
    await settle();
    expect(ctx.config.interfaces.folder).toBe(false);
    t.press('q');
    await done;
  });
});

describe('mapKey', () => {
  it('maps terminal keys to UI keys', () => {
    expect(mapKey('q', { name: 'q' })).toBe('q');
    expect(mapKey('3', { name: '3' })).toBe('3');
    expect(mapKey(undefined, { name: 'up' })).toBe('up');
    expect(mapKey(undefined, { name: 'return' })).toBe('enter');
    expect(mapKey(' ', { name: 'space' })).toBe('space');
    expect(mapKey(undefined, { name: 'escape' })).toBe('esc');
    expect(mapKey(undefined, { name: 'pagedown' })).toBe('pagedown');
    expect(mapKey(undefined, { name: 'c', ctrl: true })).toBe('ctrl-c');
    expect(mapKey('x', { name: 'x' })).toBeNull();
  });
});

describe('defaultOpener', () => {
  it('only shows the path when there is no desktop to open it', () => {
    const r = defaultOpener('linux', {})({ kind: 'file', path: '/tmp/a.pdf' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('/tmp/a.pdf');
  });
});

describe('assertInteractive', () => {
  it('refuses to start without an interactive terminal', () => {
    expect(() => assertInteractive(false, true)).toThrow(CliExit);
    expect(() => assertInteractive(true, false)).toThrow('介面需要在互動終端機執行');
    expect(() => assertInteractive(true, true)).not.toThrow();
  });
});

describe('nodeTerm', () => {
  it('receives keys again after a prompt paused the input', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    const term = nodeTerm(input as never, output as never);
    const got: string[] = [];
    const stop = term.onKey((k) => void got.push(k));
    input.pause(); // @inquirer/prompts 結束時會暫停 stdin
    term.setRaw(true);
    input.write('q');
    await tick();
    stop();
    expect(got).toEqual(['q']);
  });
});
