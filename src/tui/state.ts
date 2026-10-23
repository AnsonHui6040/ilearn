import type { Line, TabId } from './frame.js';

export type Key =
  | 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown'
  | 'space' | 'enter' | 'esc' | 'q'
  | '1' | '2' | '3' | '4' | '5';

export type Change =
  | { kind: 'teammate'; itemId: string; mark: boolean }
  | { kind: 'rule'; ruleId: string; enabled: boolean }
  | { kind: 'courseRule'; courseId: string; ruleId: string; enabled: boolean }
  | { kind: 'reset' };

export type Prompt =
  | { kind: 'quietHours' }
  | { kind: 'reminderOffsets'; courseId: string | null }
  | { kind: 'courseRuleAction'; courseId: string; ruleId: string }
  | { kind: 'editRule'; ruleId: string | null }
  | { kind: 'delivery' }
  | { kind: 'interfaces' };

/** 需要暫時離開全螢幕執行的動作。 */
export type RunKind = 'sync' | 'login' | 'logout' | 'serviceInstall' | 'serviceUninstall' | 'uninstallAll';

export type OpenTarget = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export type View =
  | { kind: 'tab' }
  | { kind: 'course'; courseId: string; section: number }
  | { kind: 'detail'; title: string; lines: string[]; target: OpenTarget | null }
  | { kind: 'confirm'; changes: Change[]; fromTicks: boolean };

export type Activate =
  | { view: View }
  | { open: OpenTarget }
  | { prompt: Prompt }
  | { reload: true }
  | { editRules: true }
  | { run: RunKind }
  | { focusRight: true }
  | { confirm: Change[] };

/** 畫面上的一列；有 key 的列才可選取。 */
export interface Row extends Line {
  key?: string;
  tick?: Change;
  activate?: Activate;
}

interface Saved {
  focus: 0 | 1;
  cursor: [number, number];
  scroll: [number, number];
}

export interface TuiState {
  tab: TabId;
  stack: View[];
  /** 與 stack 對應，返回時還原的游標位置。 */
  saved: Saved[];
  focus: 0 | 1;
  cursor: [number, number];
  scroll: [number, number];
  ticked: Map<string, Change>;
  message: string | null;
}

export type Effect =
  | { type: 'apply'; changes: Change[] }
  | { type: 'open'; target: OpenTarget }
  | { type: 'prompt'; prompt: Prompt }
  | { type: 'reload' }
  | { type: 'editRules' }
  | { type: 'run'; what: RunKind }
  | { type: 'quit' };

export function changeKey(c: Change): string {
  switch (c.kind) {
    case 'teammate':
      return `teammate:${c.itemId}`;
    case 'rule':
      return `rule:${c.ruleId}`;
    case 'courseRule':
      return `courseRule:${c.courseId}:${c.ruleId}`;
    case 'reset':
      return 'reset';
  }
}

export function initialState(): TuiState {
  return { tab: 1, stack: [], saved: [], focus: 0, cursor: [0, 0], scroll: [0, 0], ticked: new Map(), message: null };
}

const selectable = (rows: Row[], i: number): boolean => rows[i]?.key !== undefined;

/** 由 from 往 dir 方向找第一個可選列（含 from）；找不到回傳 null。 */
function seek(rows: Row[], from: number, dir: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < rows.length; i += dir) if (selectable(rows, i)) return i;
  return null;
}

function setCursor(s: TuiState, pane: 0 | 1, value: number): TuiState {
  const cursor: [number, number] = [...s.cursor];
  cursor[pane] = value;
  return { ...s, cursor };
}

/** 游標落在可選列上並限制在清單範圍內；沒有可選列時為 0。 */
export function normalize(s: TuiState, panes: Row[][]): TuiState {
  let out = s;
  for (const pane of [0, 1] as const) {
    const rows = panes[pane];
    if (!rows) continue;
    const at = Math.min(out.cursor[pane], Math.max(0, rows.length - 1));
    out = setCursor(out, pane, seek(rows, at, 1) ?? seek(rows, at, -1) ?? 0);
  }
  if (out.focus === 1 && panes.length < 2) out = { ...out, focus: 0 };
  return out;
}

function move(s: TuiState, rows: Row[], dir: 1 | -1, step: number): TuiState {
  const cur = s.cursor[s.focus];
  if (step === 1) return setCursor(s, s.focus, seek(rows, cur + dir, dir) ?? cur);
  const target = Math.max(0, Math.min(rows.length - 1, cur + dir * step));
  return setCursor(s, s.focus, seek(rows, target, dir) ?? seek(rows, target, dir === 1 ? -1 : 1) ?? cur);
}

function push(s: TuiState, view: View): TuiState {
  const cursor: [number, number] = view.kind === 'course' ? [view.section, 0] : [0, 0];
  return {
    ...s,
    stack: [...s.stack, view],
    saved: [...s.saved, { focus: s.focus, cursor: s.cursor, scroll: s.scroll }],
    focus: 0,
    cursor,
    scroll: [0, 0],
  };
}

function pop(s: TuiState): TuiState {
  const back = s.saved.at(-1);
  if (!back) return s;
  return { ...s, stack: s.stack.slice(0, -1), saved: s.saved.slice(0, -1), ...back };
}

export function reduce(s0: TuiState, key: Key, panes: Row[][], pageRows: number): { state: TuiState; effect?: Effect } {
  const s: TuiState = { ...s0, message: null };
  const top = s.stack.at(-1);
  const rows = panes[s.focus] ?? [];
  const row = rows[s.cursor[s.focus]];

  switch (key) {
    case '1': case '2': case '3': case '4': case '5': {
      const waiting = s.ticked.size;
      return {
        state: {
          ...s, tab: Number(key) as TabId, stack: [], saved: [], focus: 0, cursor: [0, 0], scroll: [0, 0],
          message: waiting > 0 ? `尚有 ${waiting} 項未確認` : null,
        },
      };
    }
    case 'up':
      return { state: move(s, rows, -1, 1) };
    case 'down':
      return { state: move(s, rows, 1, 1) };
    case 'pageup':
      return { state: move(s, rows, -1, Math.max(1, pageRows)) };
    case 'pagedown':
      return { state: move(s, rows, 1, Math.max(1, pageRows)) };
    case 'left':
    case 'right': {
      if (panes.length < 2) return { state: s };
      return { state: normalize({ ...s, focus: key === 'left' ? 0 : 1 }, panes) };
    }
    case 'space': {
      if (!row?.tick || row.key === undefined) return { state: { ...s, message: '這一項不能剔選' } };
      const ticked = new Map(s.ticked);
      const k = changeKey(row.tick);
      if (ticked.has(k)) ticked.delete(k);
      else ticked.set(k, row.tick);
      return { state: { ...s, ticked } };
    }
    case 'esc':
      return { state: pop(s) };
    case 'q':
      return top?.kind === 'confirm' ? { state: pop(s) } : { state: s, effect: { type: 'quit' } };
    case 'enter': {
      if (top?.kind === 'confirm') {
        const after = pop(s);
        return {
          state: top.fromTicks ? { ...after, ticked: new Map() } : after,
          effect: { type: 'apply', changes: top.changes },
        };
      }
      if (s.ticked.size > 0) return { state: push(s, { kind: 'confirm', changes: [...s.ticked.values()], fromTicks: true }) };
      const a = row?.key !== undefined ? row.activate : undefined;
      if (!a) return { state: s };
      if ('view' in a) return { state: push(s, a.view) };
      if ('open' in a) return { state: s, effect: { type: 'open', target: a.open } };
      if ('prompt' in a) return { state: s, effect: { type: 'prompt', prompt: a.prompt } };
      if ('reload' in a) return { state: s, effect: { type: 'reload' } };
      if ('editRules' in a) return { state: s, effect: { type: 'editRules' } };
      if ('run' in a) return { state: s, effect: { type: 'run', what: a.run } };
      if ('focusRight' in a) return { state: panes.length < 2 ? s : normalize({ ...s, focus: 1 }, panes) };
      return { state: push(s, { kind: 'confirm', changes: a.confirm, fromTicks: false }) };
    }
  }
}
