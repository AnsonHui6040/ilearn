import { describe, expect, it } from 'vitest';
import { fit, strWidth, wrap } from '../src/tui/text.js';

describe('strWidth', () => {
  it('counts CJK and full-width punctuation as two columns', () => {
    expect(strWidth('會計學 M133')).toBe(11);
    expect(strWidth('微積分乙〈一〉')).toBe(14);
    expect(strWidth('統計學（二）')).toBe(12);
    expect(strWidth('Case Discussion 1')).toBe(17);
  });

  it('counts emoji as two and zero-width characters as zero', () => {
    expect(strWidth('📌公告')).toBe(6);
    expect(strWidth('a​b')).toBe(2);
    expect(strWidth('❤️')).toBe(2);
  });
});

describe('fit', () => {
  it('pads short text to the exact width', () => {
    expect(fit('會計學', 8)).toBe('會計學  ');
  });

  it('truncates long text with an ellipsis', () => {
    expect(fit('Case Discussion 1', 8)).toBe('Case Di…');
    expect(strWidth(fit('勞作教育-應屆畢業學生虛擬課程', 9))).toBe(9);
    expect(fit('勞作教育-應屆畢業學生虛擬課程', 9).endsWith('…')).toBe(true);
  });

  it('returns an empty string for zero width', () => {
    expect(fit('abc', 0)).toBe('');
  });
});

describe('wrap', () => {
  it('breaks long text into lines that never exceed the width', () => {
    expect(wrap('勞作教育-應屆畢業學生虛擬課程', 20)).toEqual(['勞作教育-應屆畢業學', '生虛擬課程']);
    for (const l of wrap('創新與創業專題 Innovation and Entrepreneurship 〈一〉📌', 11)) expect(strWidth(l)).toBeLessThanOrEqual(11);
  });

  it('keeps short and empty text as one line', () => {
    expect(wrap('會計學', 20)).toEqual(['會計學']);
    expect(wrap('', 20)).toEqual(['']);
  });
});
