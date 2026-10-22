import { parseIsoDuration } from '../time.js';
import type { Delivery } from '../types.js';

export interface ReminderTarget {
  itemId: string;
  kind: 'assignment' | 'exam';
  dueAt: Date;
  done: boolean;
  started: boolean;
  offsets: string[];
}

export interface ReminderDue {
  itemId: string;
  offset: string;
  delivery: Delivery;
  /** true：被較小 offset 取代，呼叫端只需標記為已送，不可發出。 */
  suppressed?: boolean;
}

type SentFn = (itemId: string, offset: string) => boolean;

export function dueReminders(
  now: Date,
  targets: ReminderTarget[],
  sent: SentFn,
  forcePushOffsets: string[],
  _firstRunAt: Date | null,
): ReminderDue[] {
  const out: ReminderDue[] = [];
  for (const t of targets) {
    if (t.done || (t.kind === 'exam' && t.started)) continue;
    if (now.getTime() >= t.dueAt.getTime()) continue;
    const open = t.offsets
      .map((offset) => ({ offset, ms: parseIsoDuration(offset) }))
      .filter((o) => t.dueAt.getTime() - o.ms <= now.getTime())
      .sort((a, b) => a.ms - b.ms);
    open.forEach((o, i) => {
      if (sent(t.itemId, o.offset)) return;
      const delivery: Delivery = forcePushOffsets.includes(o.offset) ? 'force_push' : 'push';
      const entry: ReminderDue = { itemId: t.itemId, offset: o.offset, delivery };
      if (i > 0) entry.suppressed = true;
      out.push(entry);
    });
  }
  return out;
}

const DEFAULT_OFFSETS = ['P1D', 'PT3H'];

/** 釋放夜間暫存時，刪去已有較小 offset 送出的較大 offset。 */
export function suppressSuperseded(
  _releaseAt: Date,
  pending: { itemId: string; offset: string }[],
  sent: SentFn,
): { itemId: string; offset: string }[] {
  const candidates = [...new Set([...DEFAULT_OFFSETS, ...pending.map((p) => p.offset)])];
  return pending.filter((p) => {
    const ms = parseIsoDuration(p.offset);
    return !candidates.some((c) => parseIsoDuration(c) < ms && sent(p.itemId, c));
  });
}
