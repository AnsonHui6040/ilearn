import { describe, expect, it } from 'vitest';
import { changeKey, initialState, normalize, reduce, type Change, type Row, type TuiState } from '../src/tui/state.js';

const tick = (itemId: string): Change => ({ kind: 'teammate', itemId, mark: true });
const left: Row[] = [
  { text: '逾期 2' },
  { text: 'a', key: 'a', tick: tick('assignment:1'), activate: { view: { kind: 'course', courseId: '1', section: 0 } } },
  { text: 'b', key: 'b' },
  { text: '7 日內 1' },
  { text: 'c', key: 'c', activate: { open: { kind: 'url', url: 'https://ilearn.thu.edu.tw/x' } } },
  { text: 'd', key: 'd', activate: { prompt: { kind: 'quietHours' } } },
];
const right: Row[] = [{ text: 'r0', key: 'r0' }, { text: 'r1', key: 'r1', tick: { kind: 'rule', ruleId: 'exam', enabled: false } }];

const start = (panes: Row[][] = [left]): TuiState => normalize(initialState(), panes);
const press = (s: TuiState, keys: string[], panes: Row[][] = [left]) => {
  let state = s;
  let effect;
  for (const k of keys) ({ state, effect } = reduce(state, k as never, panes, 3));
  return { state, effect };
};

describe('navigation', () => {
  it('starts on the first selectable row of the first tab', () => {
    const s = start();
    expect(s.tab).toBe(1);
    expect(s.cursor[0]).toBe(1);
  });

  it('skips rows without a key and stops at both ends', () => {
    const s = start();
    expect(press(s, ['down']).state.cursor[0]).toBe(2);
    expect(press(s, ['down', 'down']).state.cursor[0]).toBe(4);
    expect(press(s, ['down', 'down', 'down', 'down', 'down']).state.cursor[0]).toBe(5);
    expect(press(s, ['up']).state.cursor[0]).toBe(1);
  });

  it('moves a page with pagedown and pageup', () => {
    const s = start();
    expect(press(s, ['pagedown']).state.cursor[0]).toBe(4);
    expect(press(s, ['pagedown', 'pageup']).state.cursor[0]).toBe(1);
  });

  it('switches tabs with 1 to 5 and resets the view', () => {
    const { state } = press(start(), ['down', '3']);
    expect(state.tab).toBe(3);
    expect(state.stack).toEqual([]);
    expect(state.focus).toBe(0);
    expect(state.cursor).toEqual([0, 0]);
  });

  it('switches panes with left and right only when there are two', () => {
    const two = [left, right];
    expect(press(start(two), ['right'], two).state.focus).toBe(1);
    expect(press(start(two), ['right', 'left'], two).state.focus).toBe(0);
    expect(press(start(), ['right']).state.focus).toBe(0);
  });
});

describe('ticks and confirmation', () => {
  it('space toggles a tick on a tickable row', () => {
    const s1 = press(start(), ['space']).state;
    expect([...s1.ticked.keys()]).toEqual([changeKey(tick('assignment:1'))]);
    expect(press(s1, ['space']).state.ticked.size).toBe(0);
  });

  it('space on a row that cannot be ticked shows a message', () => {
    expect(press(start(), ['down', 'space']).state.message).toBe('這一項不能剔選');
  });

  it('enter with ticks opens the confirm view; enter again applies and clears ticks', () => {
    const s1 = press(start(), ['space', 'enter']).state;
    expect(s1.stack.at(-1)).toEqual({ kind: 'confirm', changes: [tick('assignment:1')], fromTicks: true });
    const r = reduce(s1, 'enter', [[]], 3);
    expect(r.effect).toEqual({ type: 'apply', changes: [tick('assignment:1')] });
    expect(r.state.ticked.size).toBe(0);
    expect(r.state.stack).toEqual([]);
  });

  it('esc or q in the confirm view goes back and keeps the ticks', () => {
    const s1 = press(start(), ['space', 'enter']).state;
    for (const k of ['esc', 'q'] as const) {
      const r = reduce(s1, k, [[]], 3);
      expect(r.effect).toBeUndefined();
      expect(r.state.stack).toEqual([]);
      expect(r.state.ticked.size).toBe(1);
      expect(r.state.cursor[0]).toBe(1);
    }
  });

  it('keeps ticks across tabs and says how many are waiting', () => {
    const { state } = press(start(), ['space', '2']);
    expect(state.ticked.size).toBe(1);
    expect(state.message).toBe('尚有 1 項未確認');
  });

  it('a confirm activation opens the confirm view without touching ticks', () => {
    const rows: Row[] = [{ text: 'Reset', key: 'reset', activate: { confirm: [{ kind: 'reset' }] } }];
    const s1 = press(start(rows.length ? [rows] : []), ['enter'], [rows]).state;
    expect(s1.stack.at(-1)).toEqual({ kind: 'confirm', changes: [{ kind: 'reset' }], fromTicks: false });
  });
});

describe('enter without ticks', () => {
  it('pushes a view and esc restores the previous cursor', () => {
    const s1 = press(start(), ['enter']).state;
    expect(s1.stack.at(-1)).toEqual({ kind: 'course', courseId: '1', section: 0 });
    expect(s1.cursor).toEqual([0, 0]);
    const back = reduce(s1, 'esc', [[]], 3).state;
    expect(back.stack).toEqual([]);
    expect(back.cursor[0]).toBe(1);
  });

  it('places the cursor on the requested course section', () => {
    const rows: Row[] = [{ text: 'x', key: 'x', activate: { view: { kind: 'course', courseId: '1', section: 3 } } }];
    expect(press(start([rows]), ['enter'], [rows]).state.cursor).toEqual([3, 0]);
  });

  it('returns open, prompt, reload and editRules effects', () => {
    expect(press(start(), ['down', 'down', 'enter']).effect).toEqual({ type: 'open', target: { kind: 'url', url: 'https://ilearn.thu.edu.tw/x' } });
    expect(press(start(), ['down', 'down', 'down', 'enter']).effect).toEqual({ type: 'prompt', prompt: { kind: 'quietHours' } });
    const rows: Row[] = [{ text: 'Reload', key: 'r', activate: { reload: true } }, { text: 'e', key: 'e', activate: { editRules: true } }];
    expect(press(start([rows]), ['enter'], [rows]).effect).toEqual({ type: 'reload' });
    expect(press(start([rows]), ['down', 'enter'], [rows]).effect).toEqual({ type: 'editRules' });
  });

  it('q quits and esc on an empty stack does nothing', () => {
    expect(press(start(), ['q']).effect).toEqual({ type: 'quit' });
    const r = reduce(start(), 'esc', [left], 3);
    expect(r.effect).toBeUndefined();
    expect(r.state.stack).toEqual([]);
  });
});

describe('normalize', () => {
  it('moves the cursor to a selectable row and clamps it to the list', () => {
    const s: TuiState = { ...initialState(), cursor: [99, 0] };
    expect(normalize(s, [left]).cursor[0]).toBe(5);
    expect(normalize(initialState(), [[{ text: '沒有' }]]).cursor[0]).toBe(0);
  });
});

describe('settings actions', () => {
  it('enter on a row that leads to the right pane moves the focus there', () => {
    const l: Row[] = [{ text: '同步狀態', key: 's', activate: { focusRight: true } }];
    const r: Row[] = [{ text: 'x' }, { text: '立即同步', key: 'sync', activate: { run: 'sync' } }];
    const s1 = press(start([l, r]), ['enter'], [l, r]).state;
    expect(s1.focus).toBe(1);
    expect(s1.cursor[1]).toBe(1);
    expect(reduce(s1, 'enter', [l, r], 3).effect).toEqual({ type: 'run', what: 'sync' });
  });

  it('returns prompt effects for rule editing, delivery and interfaces', () => {
    const rows: Row[] = [
      { text: 'a', key: 'a', activate: { prompt: { kind: 'editRule', ruleId: null } } },
      { text: 'b', key: 'b', activate: { prompt: { kind: 'delivery' } } },
      { text: 'c', key: 'c', activate: { prompt: { kind: 'interfaces' } } },
    ];
    expect(press(start([rows]), ['enter'], [rows]).effect).toEqual({ type: 'prompt', prompt: { kind: 'editRule', ruleId: null } });
    expect(press(start([rows]), ['down', 'enter'], [rows]).effect).toEqual({ type: 'prompt', prompt: { kind: 'delivery' } });
    expect(press(start([rows]), ['down', 'down', 'enter'], [rows]).effect).toEqual({ type: 'prompt', prompt: { kind: 'interfaces' } });
  });
});
