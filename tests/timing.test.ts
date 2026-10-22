import { describe, expect, it } from 'vitest';
import { taipeiDate as t } from '../src/time.js';
import { dueReminders, suppressSuperseded, type ReminderTarget } from '../src/events/reminders.js';
import { isSyncDue, randomJitterMs, syncSlots } from '../src/events/schedule.js';

const never = (): boolean => false;
const due = t(2026, 10, 23, 14, 30);
const target = (over: Partial<ReminderTarget> = {}): ReminderTarget => ({
  itemId: 'a',
  kind: 'assignment',
  dueAt: due,
  done: false,
  started: false,
  offsets: ['P1D', 'PT3H'],
  ...over,
});

describe('dueReminders', () => {
  it('sends P1D as push when the 1-day window opens', () => {
    const r = dueReminders(t(2026, 10, 22, 14, 30), [target()], never, ['PT3H'], null);
    expect(r).toEqual([{ itemId: 'a', offset: 'P1D', delivery: 'push' }]);
  });
  it('sends PT3H as force_push', () => {
    const r = dueReminders(t(2026, 10, 23, 11, 30), [target()], (_i, o) => o === 'P1D', ['PT3H'], null);
    expect(r).toEqual([{ itemId: 'a', offset: 'PT3H', delivery: 'force_push' }]);
  });
  it('sends nothing when done', () => {
    expect(dueReminders(t(2026, 10, 23, 11, 30), [target({ done: true })], never, [], null)).toEqual([]);
  });
  it('sends nothing for a started exam', () => {
    const x = target({ kind: 'exam', started: true });
    expect(dueReminders(t(2026, 10, 23, 11, 30), [x], never, [], null)).toEqual([]);
  });
  it('sends nothing after the deadline', () => {
    expect(dueReminders(t(2026, 10, 23, 14, 30), [target()], never, [], null)).toEqual([]);
  });
  it('first run with both windows open emits only PT3H and suppresses P1D', () => {
    const r = dueReminders(t(2026, 10, 23, 12, 0), [target()], never, ['PT3H'], t(2026, 10, 23, 12, 0));
    expect(r.filter((x) => !x.suppressed)).toEqual([{ itemId: 'a', offset: 'PT3H', delivery: 'force_push' }]);
    expect(r.filter((x) => x.suppressed).map((x) => x.offset)).toEqual(['P1D']);
  });
  it('does not repeat reminders already sent', () => {
    const r = dueReminders(t(2026, 10, 23, 12, 0), [target()], () => true, [], null);
    expect(r).toEqual([]);
  });
  it('tolerance: 3h+4min before is not sent, 3h-1min is', () => {
    const only = target({ offsets: ['PT3H'] });
    expect(dueReminders(new Date(due.getTime() - (3 * 60 + 4) * 60000), [only], never, [], null)).toEqual([]);
    expect(dueReminders(new Date(due.getTime() - (3 * 60 - 1) * 60000), [only], never, [], null)).toHaveLength(1);
  });
});

describe('suppressSuperseded', () => {
  it('drops P1D when PT3H already sent', () => {
    const r = suppressSuperseded(t(2026, 10, 23, 7, 0), [{ itemId: 'a', offset: 'P1D' }], (i, o) => i === 'a' && o === 'PT3H');
    expect(r).toEqual([]);
  });
  it('keeps P1D when nothing smaller was sent', () => {
    const p = [{ itemId: 'a', offset: 'P1D' }];
    expect(suppressSuperseded(t(2026, 10, 23, 7, 0), p, never)).toEqual(p);
  });
});

describe('sync schedule', () => {
  it('has 19 slots from 03:30 to next-day 00:00', () => {
    const s = syncSlots(t(2026, 10, 22, 15, 0));
    expect(s).toHaveLength(19);
    expect(s[0]).toEqual(t(2026, 10, 22, 3, 30));
    expect(s[1]).toEqual(t(2026, 10, 22, 7, 0));
    expect(s[17]).toEqual(t(2026, 10, 22, 23, 0));
    expect(s[18]).toEqual(t(2026, 10, 23, 0, 0));
  });
  const jitter = 2 * 60000;
  it('due after slot+jitter when last sync is older', () => {
    expect(isSyncDue(t(2026, 10, 22, 7, 3), t(2026, 10, 22, 6, 10), jitter)).toBe(true);
  });
  it('not due before slot+jitter', () => {
    expect(isSyncDue(t(2026, 10, 22, 7, 1), t(2026, 10, 22, 6, 10), jitter)).toBe(false);
  });
  it('not due when already synced after the slot', () => {
    expect(isSyncDue(t(2026, 10, 22, 7, 3), t(2026, 10, 22, 7, 2), jitter)).toBe(false);
  });
  it('due with no previous sync', () => {
    expect(isSyncDue(t(2026, 10, 22, 7, 3), null, jitter)).toBe(true);
  });
  it('finds yesterday slot across midnight', () => {
    expect(isSyncDue(t(2026, 10, 23, 0, 3), t(2026, 10, 22, 23, 5), jitter)).toBe(true);
  });
  it('jitter is within 0-300000', () => {
    for (let i = 0; i < 50; i++) {
      const j = randomJitterMs();
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(300000);
    }
  });
});
