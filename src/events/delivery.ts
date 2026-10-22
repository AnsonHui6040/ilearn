import { taipeiDate, taipeiParts } from '../time.js';
import type { Delivery } from '../types.js';

interface Quiet {
  start: string;
  end: string;
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`無效的時間：${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 台北牆上時間是否落在 [start, end)；start > end 表示跨午夜；start === end 表示沒有夜間時段。 */
export function isQuiet(now: Date, quiet: Quiet): boolean {
  const s = toMinutes(quiet.start);
  const e = toMinutes(quiet.end);
  const p = taipeiParts(now);
  const cur = p.hh * 60 + p.mm;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** force_push 與 record 不延後；push 落在夜間時段則延到該時段結束。 */
export function deliverAfter(detectedAt: Date, delivery: Delivery, quiet: Quiet): Date {
  if (delivery !== 'push' || !isQuiet(detectedAt, quiet)) return detectedAt;
  const s = toMinutes(quiet.start);
  const e = toMinutes(quiet.end);
  const p = taipeiParts(detectedAt);
  const cur = p.hh * 60 + p.mm;
  // 跨午夜且目前在 start 之後（當晚），結束時間是翌日
  const dayOffset = s > e && cur >= s ? 1 : 0;
  return taipeiDate(p.y, p.m, p.d + dayOffset, Math.floor(e / 60), e % 60);
}
