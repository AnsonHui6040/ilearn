import type { ScheduleSlot } from '../ilearn/courseInfo.js';

type PeriodTimes = Record<string, { start: string; end: string }>;

/** 東海大學節次時間，依 115 學年度上學期課表。 */
export const THU_PERIOD_TIMES: PeriodTimes = {
  '0': { start: '07:10', end: '08:00' },
  '1': { start: '08:10', end: '09:00' },
  '2': { start: '09:10', end: '10:00' },
  '3': { start: '10:20', end: '11:10' },
  '4': { start: '11:20', end: '12:10' },
  '4.5': { start: '12:10', end: '13:00' },
  '5': { start: '13:10', end: '14:00' },
  '6': { start: '14:10', end: '15:00' },
  '7': { start: '15:20', end: '16:10' },
  '8': { start: '16:20', end: '17:10' },
  '9': { start: '17:20', end: '18:10' },
  '10': { start: '18:20', end: '19:10' },
  '11': { start: '19:20', end: '20:10' },
  '12': { start: '20:20', end: '21:10' },
  '13': { start: '21:20', end: '22:10' },
};

const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 「三 09:10–12:10（2–4 節）」；首尾節次沒有時間時只顯示「三 2–4 節」。 */
export function slotLabel(slot: ScheduleSlot, times: PeriodTimes): string {
  const first = slot.periods[0] ?? '';
  const last = slot.periods.at(-1) ?? first;
  const periods = first === last ? first : `${first}–${last}`;
  const day = WEEKDAY[slot.weekday] ?? String(slot.weekday);
  const a = times[first];
  const b = times[last];
  return a && b ? `${day} ${a.start}–${b.end}（${periods} 節）` : `${day} ${periods} 節`;
}

/** 課程代碼含 `_` 時取之後的部分，例如 `1151_1212` 為 `1212`。 */
export function courseCode(code: string): string {
  const i = code.indexOf('_');
  return i === -1 ? code : code.slice(i + 1);
}
