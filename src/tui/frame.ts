import { taipeiParts } from '../time.js';
import { fit, strWidth } from './text.js';

export type TabId = 1 | 2 | 3 | 4 | 5;
export const TAB_NAMES: Record<TabId, string> = { 1: '首頁', 2: '課程', 3: '提醒', 4: '課程設定', 5: '系統設定' };
const TABS = [1, 2, 3, 4, 5] as const;

export type Style = 'bold' | 'dim' | 'red' | 'inverse';
export interface Line {
  text: string;
  style?: Style;
}
export interface PaneView {
  lines: Line[];
  cursor: number | null;
  scroll: number;
  /** 兩欄時左欄的寬度；不指定時平分。 */
  width?: number;
}
export interface FrameInput {
  tab: TabId;
  now: Date;
  lastSyncAt: string | null;
  banner: string[];
  panes: PaneView[];
  focus: 0 | 1;
  help: string;
  message: string | null;
}

export const TOO_SMALL = '視窗太小，請放大 Window too small';
export const MIN_COLS = 40;
export const MIN_ROWS = 10;
/** 兩欄所需的最小欄數，以下改單欄。 */
export const TWO_PANE_COLS = 80;

const CODE: Record<Style, string> = { bold: '1', dim: '2', red: '31', inverse: '7' };
const ESC = String.fromCharCode(27);
const paint = (s: string, style: Style | undefined, color: boolean): string =>
  color && style ? `${ESC}[${CODE[style]}m${s}${ESC}[0m` : s;

type Seg = { text: string; style?: Style };

/** 依序輸出各段，總寬度恰為 w（超出即截斷）。 */
function segs(parts: Seg[], w: number, color: boolean): string {
  let out = '';
  let used = 0;
  for (const p of parts) {
    if (used >= w) break;
    const pw = strWidth(p.text);
    const text = used + pw > w ? fit(p.text, w - used) : p.text;
    out += paint(text, p.style, color);
    used += strWidth(text);
  }
  return out + ' '.repeat(Math.max(0, w - used));
}

/** 頁首 2 行、分隔線、訊息列、頁尾分隔線、按鍵說明各 1 行。 */
export function bodyRows(size: { cols: number; rows: number }, bannerCount: number): number {
  return Math.max(0, size.rows - 6 - bannerCount);
}

const WEEKDAY = '日一二三四五六';
const pad = (n: number): string => String(n).padStart(2, '0');

function clockText(now: Date): string {
  const p = taipeiParts(now);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}（${WEEKDAY[p.weekday] ?? ''}）${pad(p.hh)}:${pad(p.mm)}`;
}

function tabsLine(tab: TabId, cols: number, color: boolean): string {
  const full: Seg[] = [{ text: ' ' }, { text: 'thu-ilearn', style: 'bold' }, { text: '  ' }];
  const roomy = TABS.flatMap((t, i): Seg[] => [
    ...(i > 0 ? [{ text: ' ' }] : []),
    { text: ` ${t} ${TAB_NAMES[t]} `, ...(t === tab ? { style: 'inverse' as const } : {}) },
  ]);
  const width = (s: Seg[]): number => s.reduce((n, x) => n + strWidth(x.text), 0);
  if (width(full) + width(roomy) <= cols) return segs([...full, ...roomy], cols, color);
  if (1 + width(roomy) <= cols) return segs([{ text: ' ' }, ...roomy], cols, color);
  const compact = TABS.flatMap((t, i): Seg[] => [
    { text: i > 0 ? ' ' : ' ' },
    { text: `${t}${TAB_NAMES[t]}`, ...(t === tab ? { style: 'inverse' as const } : {}) },
  ]);
  return segs(compact, cols, color);
}

function clockLine(now: Date, lastSyncAt: string | null, cols: number, color: boolean): string {
  const clock = clockText(now);
  const when = lastSyncAt === null ? null : lastSyncAt.slice(5, 16).replace('T', ' ');
  let right = when === null ? '尚未同步' : `最近同步 ${when}`;
  if (1 + strWidth(clock) + 2 + strWidth(right) + 1 > cols && when !== null) right = `同步 ${when}`;
  const gap = Math.max(1, cols - 1 - strWidth(clock) - strWidth(right) - 1);
  return segs([{ text: ' ' }, { text: clock, style: 'bold' }, { text: ' '.repeat(gap) }, { text: right, style: 'dim' }], cols, color);
}

export function visibleStart(cursor: number | null, scroll: number, h: number, len: number): number {
  let s = scroll;
  if (cursor !== null) {
    if (cursor < s) s = cursor;
    if (cursor >= s + h) s = cursor - h + 1;
  }
  return Math.max(0, Math.min(s, Math.max(0, len - h)));
}

function cell(line: Line | undefined, w: number, highlight: Style | null, color: boolean): string {
  if (!line) return ' '.repeat(w);
  return paint(fit(line.text, w), highlight ?? line.style, color);
}

export function renderFrame(f: FrameInput, size: { cols: number; rows: number }, color: boolean): string[] {
  const { cols, rows } = size;
  if (cols < MIN_COLS || rows < MIN_ROWS) return [TOO_SMALL];
  const h = bodyRows(size, f.banner.length);
  const sep = '─'.repeat(cols);
  const out = [tabsLine(f.tab, cols, color), clockLine(f.now, f.lastSyncAt, cols, color), sep];
  for (const b of f.banner) out.push(segs([{ text: ' ' }, { text: b, style: 'red' }], cols, color));

  const [left, right] = f.panes;
  if (left && right && cols >= TWO_PANE_COLS) {
    const lw = Math.max(10, Math.min(left.width ?? Math.floor((cols - 3) / 2), cols - 23));
    const rw = cols - 3 - lw;
    const ls = visibleStart(left.cursor, left.scroll, h, left.lines.length);
    const rs = visibleStart(right.cursor, right.scroll, h, right.lines.length);
    const mark = (p: PaneView, i: number, focused: boolean): Style | null =>
      p.cursor === i ? (focused ? 'inverse' : 'bold') : null;
    for (let i = 0; i < h; i++) {
      out.push(
        ' ' +
          cell(left.lines[ls + i], lw, mark(left, ls + i, f.focus === 0), color) +
          '│ ' +
          cell(right.lines[rs + i], rw, mark(right, rs + i, f.focus === 1), color),
      );
    }
  } else {
    // 單欄：左欄在上，右欄在下
    const lines: Line[] = left ? [...left.lines] : [];
    let cursor: number | null = left?.cursor ?? null;
    let scroll = left?.scroll ?? 0;
    if (left && right) {
      const offset = left.lines.length + 1;
      lines.push({ text: '' }, ...right.lines);
      if (f.focus === 1) {
        cursor = right.cursor === null ? offset : offset + right.cursor;
        scroll = offset + right.scroll;
      }
    }
    const s = visibleStart(cursor, scroll, h, lines.length);
    for (let i = 0; i < h; i++) {
      out.push(' ' + cell(lines[s + i], cols - 1, cursor === s + i ? 'inverse' : null, color));
    }
  }

  out.push(sep);
  const helpLine = (t: string): string => segs([{ text: ' ' }, { text: t, style: 'dim' }], cols, color);
  if (f.message === null && strWidth(f.help) > cols - 1) {
    // 窄終端：按鍵說明借用訊息列分成兩行，以兩個空白分隔的項目為單位
    const items = f.help.split('  ');
    let first = '';
    while (items.length > 0 && strWidth(first ? `${first}  ${items[0]}` : (items[0] ?? '')) <= cols - 1) {
      first = first ? `${first}  ${items.shift()}` : (items.shift() ?? '');
    }
    out.push(helpLine(first), helpLine(items.join('  ')));
  } else {
    out.push(segs([{ text: ' ' }, { text: f.message ?? '', style: 'red' }], cols, color), helpLine(f.help));
  }
  return out;
}
