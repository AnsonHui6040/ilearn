import { describe, expect, it } from 'vitest';
import { deliverAfter, isQuiet } from '../src/events/delivery.js';
import { taipeiDate } from '../src/time.js';

const quiet = { start: '00:00', end: '07:00' };
const t = (y: number, m: number, d: number, hh: number, mm: number) => taipeiDate(y, m, d, hh, mm);

describe('deliverAfter', () => {
  it('23:59 push is not quiet', () => {
    const at = t(2026, 10, 22, 23, 59);
    expect(deliverAfter(at, 'push', quiet).getTime()).toBe(at.getTime());
  });
  it('00:30 push waits until 07:00 same day', () => {
    expect(deliverAfter(t(2026, 10, 23, 0, 30), 'push', quiet).getTime()).toBe(t(2026, 10, 23, 7, 0).getTime());
  });
  it('06:59 force_push is immediate', () => {
    const at = t(2026, 10, 23, 6, 59);
    expect(deliverAfter(at, 'force_push', quiet).getTime()).toBe(at.getTime());
  });
  it('12:00 push is immediate', () => {
    const at = t(2026, 10, 23, 12, 0);
    expect(deliverAfter(at, 'push', quiet).getTime()).toBe(at.getTime());
  });
  it('03:00 record is unchanged', () => {
    const at = t(2026, 10, 23, 3, 0);
    expect(deliverAfter(at, 'record', quiet).getTime()).toBe(at.getTime());
  });
  it('crossing-midnight window 22:00-06:00', () => {
    const q = { start: '22:00', end: '06:00' };
    expect(deliverAfter(t(2026, 10, 22, 23, 0), 'push', q).getTime()).toBe(t(2026, 10, 23, 6, 0).getTime());
    expect(deliverAfter(t(2026, 10, 23, 2, 0), 'push', q).getTime()).toBe(t(2026, 10, 23, 6, 0).getTime());
    const noon = t(2026, 10, 23, 12, 0);
    expect(deliverAfter(noon, 'push', q).getTime()).toBe(noon.getTime());
  });
});

describe('isQuiet', () => {
  it('07:00 is not quiet, 06:59 is', () => {
    expect(isQuiet(t(2026, 10, 23, 7, 0), quiet)).toBe(false);
    expect(isQuiet(t(2026, 10, 23, 6, 59), quiet)).toBe(true);
  });
  it('00:00 is quiet', () => {
    expect(isQuiet(t(2026, 10, 23, 0, 0), quiet)).toBe(true);
  });
});
