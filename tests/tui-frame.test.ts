import { describe, expect, it } from 'vitest';
import { bodyRows, renderFrame, TOO_SMALL, type FrameInput, type Line } from '../src/tui/frame.js';
import { strWidth } from '../src/tui/text.js';

const now = new Date('2026-10-22T17:45:00Z'); // 2026-10-23（五）01:45 台北
const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');
const lines = (n: number, prefix: string): Line[] => Array.from({ length: n }, (_, i) => ({ text: `${prefix}${i}` }));

function input(over: Partial<FrameInput> = {}): FrameInput {
  return {
    tab: 1,
    now,
    lastSyncAt: '2026-10-23T00:40:51+08:00',
    banner: [],
    panes: [{ lines: lines(5, '左'), cursor: 0, scroll: 0 }],
    focus: 0,
    help: '1-5 分頁 Tabs  q 離開 Quit',
    message: null,
    ...over,
  };
}

describe('renderFrame', () => {
  it('shows tabs, the system date and time, and the last sync on top', () => {
    const out = renderFrame(input(), { cols: 100, rows: 24 }, false);
    expect(out[0]).toContain('1 首頁');
    expect(out[0]).toContain('5 系統設定');
    expect(out[1]).toContain('2026-10-23（五）01:45');
    expect(out[1]).toContain('最近同步 10-23 00:40');
    expect(out).toHaveLength(24);
  });

  it('says 尚未同步 when there is no sync yet', () => {
    expect(renderFrame(input({ lastSyncAt: null }), { cols: 100, rows: 24 }, false)[1]).toContain('尚未同步');
  });

  it('lays out two panes side by side from 80 columns', () => {
    const f = input({ panes: [{ lines: lines(3, '左'), cursor: 0, scroll: 0, width: 56 }, { lines: lines(3, '右'), cursor: null, scroll: 0 }] });
    for (const cols of [100, 80]) {
      const out = renderFrame(f, { cols, rows: 24 }, false);
      for (const l of out) expect(strWidth(l)).toBeLessThanOrEqual(cols);
      const body = out.find((l) => l.includes('左0')) ?? '';
      expect(body).toContain('│');
      expect(body).toContain('右0');
    }
  });

  it('stacks panes in one column below 80 columns', () => {
    const f = input({ panes: [{ lines: lines(3, '左'), cursor: 0, scroll: 0 }, { lines: lines(3, '右'), cursor: null, scroll: 0 }] });
    const out = renderFrame(f, { cols: 79, rows: 24 }, false);
    expect(out.some((l) => l.includes('│'))).toBe(false);
    const left = out.findIndex((l) => l.includes('左2'));
    const right = out.findIndex((l) => l.includes('右0'));
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(left);
    for (const l of out) expect(strWidth(l)).toBeLessThanOrEqual(79);
  });

  it('asks for a bigger window below 40 columns or 10 rows', () => {
    expect(renderFrame(input(), { cols: 39, rows: 24 }, false)).toEqual([TOO_SMALL]);
    expect(renderFrame(input(), { cols: 100, rows: 9 }, false)).toEqual([TOO_SMALL]);
    expect(TOO_SMALL).toBe('視窗太小，請放大 Window too small');
  });

  it('highlights the cursor line in the focused pane', () => {
    const out = renderFrame(input({ panes: [{ lines: lines(5, '左'), cursor: 2, scroll: 0 }] }), { cols: 100, rows: 24 }, true);
    const row = out.find((l) => plain(l).includes('左2')) ?? '';
    expect(row).toContain(`${ESC}[7m`);
    expect(out.find((l) => plain(l).includes('左1'))).not.toContain(`${ESC}[7m`);
  });

  it('scrolls so that the cursor stays visible', () => {
    const size = { cols: 100, rows: 12 };
    const h = bodyRows(size, 0);
    const out = renderFrame(input({ panes: [{ lines: lines(50, 'r'), cursor: 40, scroll: 0 }] }), size, false);
    expect(out.some((l) => l.includes('r40 '))).toBe(true);
    expect(out.some((l) => l.includes('r0 '))).toBe(false);
    expect(out.filter((l) => /r\d+/.test(l))).toHaveLength(h);
  });

  it('puts the help on the last line and the message just above it', () => {
    const out = renderFrame(input({ message: '尚有 2 項未確認' }), { cols: 100, rows: 24 }, false);
    expect(out.at(-1)).toContain('1-5 分頁 Tabs');
    expect(out.at(-2)).toContain('尚有 2 項未確認');
  });

  it('shows banner lines under the header', () => {
    const out = renderFrame(input({ banner: ['首次同步進行中'] }), { cols: 100, rows: 24 }, false);
    expect(out[3]).toContain('首次同步進行中');
    expect(bodyRows({ cols: 100, rows: 24 }, 1)).toBe(bodyRows({ cols: 100, rows: 24 }, 0) - 1);
  });

  it('never exceeds the width with emoji and full-width titles, even at 40 columns', () => {
    const f = input({
      panes: [
        { lines: [{ text: '  10-28 09:00  數位行銷  個人作業二，影片學習(一) 從零學剪輯📌〈一〉（二）' }], cursor: 0, scroll: 0, width: 30 },
        { lines: [{ text: '右邊也很長的一行文字右邊也很長的一行文字📌' }], cursor: null, scroll: 0 },
      ],
    });
    for (const cols of [100, 80, 60, 40]) {
      for (const l of renderFrame(f, { cols, rows: 20 }, true)) expect(strWidth(plain(l))).toBeLessThanOrEqual(cols);
    }
  });
});
