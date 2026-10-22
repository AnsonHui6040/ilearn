/** 終端機顯示寬度：中文、全形標點、emoji 佔兩格，零寬字元不佔格。 */

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

const ZERO: readonly [number, number][] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
];

const inRanges = (cp: number, ranges: readonly [number, number][]): boolean => ranges.some(([a, b]) => cp >= a && cp <= b);

export function charWidth(cp: number): number {
  if (cp < 0x20 || inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

export function strWidth(s: string): number {
  let w = 0;
  let prev = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // U+FE0F 令前一個符號以 emoji 顯示，終端機佔兩格
    if (cp === 0xfe0f && prev === 1) w += 1;
    prev = charWidth(cp);
    w += prev;
  }
  return w;
}

/** 換行、tab、跳脫字元等控制字元改成空白，避免老師貼上的內容影響畫面。 */
const isControl = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
export const clean = (s: string): string => Array.from(s, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch)).join('');

/** 補空白或截斷（以「…」結尾）成恰好 w 格。 */
export function fit(raw: string, w: number): string {
  if (w <= 0) return '';
  const s = clean(raw);
  const total = strWidth(s);
  if (total <= w) return s + ' '.repeat(w - total);
  let out = '';
  let used = 0;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…${' '.repeat(w - 1 - used)}`;
}

/** 依寬度分行，不截斷內容。 */
export function wrap(raw: string, w: number): string[] {
  const s = clean(raw);
  const out: string[] = [];
  let cur = '';
  let used = 0;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (used + cw > w && cur !== '') {
      out.push(cur);
      cur = '';
      used = 0;
    }
    cur += ch;
    used += cw;
  }
  out.push(cur);
  return out;
}
