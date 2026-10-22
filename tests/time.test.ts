import { describe, expect, it } from 'vitest';
import { parseIsoDuration, taipeiDate, taipeiParts, toTaipeiIso } from '../src/time.js';

describe('time', () => {
  it('toTaipeiIso formats with +08:00', () => {
    expect(toTaipeiIso(new Date('2026-10-21T17:12:40Z'))).toBe('2026-10-22T01:12:40+08:00');
  });

  it('parseIsoDuration', () => {
    expect(parseIsoDuration('P1D')).toBe(86400000);
    expect(parseIsoDuration('PT3H')).toBe(10800000);
    expect(parseIsoDuration('PT30M')).toBe(1800000);
    expect(parseIsoDuration('P1DT2H')).toBe(93600000);
    expect(() => parseIsoDuration('abc')).toThrow();
  });

  it('taipeiDate converts wall-clock to Date', () => {
    expect(taipeiDate(2026, 10, 22, 7, 0).toISOString()).toBe('2026-10-21T23:00:00.000Z');
  });

  it('taipeiParts returns wall-clock parts', () => {
    const p = taipeiParts(new Date('2026-10-21T17:12:40Z'));
    expect(p).toEqual({ y: 2026, m: 10, d: 22, hh: 1, mm: 12, weekday: 4 });
  });
});
