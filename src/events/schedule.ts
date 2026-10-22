import { taipeiDate, taipeiParts } from '../time.js';

/** 台北日曆日的同步時段：03:30、07:00…23:00 每小時、翌日 00:00，共 19 個。 */
export function syncSlots(day: Date): Date[] {
  const { y, m, d } = taipeiParts(day);
  const slots = [taipeiDate(y, m, d, 3, 30)];
  for (let h = 7; h <= 23; h++) slots.push(taipeiDate(y, m, d, h, 0));
  slots.push(taipeiDate(y, m, d + 1, 0, 0));
  return slots;
}

export function isSyncDue(now: Date, lastSyncAt: Date | null, jitterMs: number): boolean {
  const yesterday = new Date(now.getTime() - 86400_000);
  const slot = [...syncSlots(yesterday), ...syncSlots(now)]
    .filter((s) => s.getTime() <= now.getTime())
    .reduce<Date | null>((a, s) => (a === null || s.getTime() > a.getTime() ? s : a), null);
  if (slot === null) return false;
  if (now.getTime() < slot.getTime() + jitterMs) return false;
  return lastSyncAt === null || lastSyncAt.getTime() < slot.getTime();
}

export function randomJitterMs(): number {
  return Math.floor(Math.random() * 300_001);
}
