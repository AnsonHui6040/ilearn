import { describe, expect, it } from 'vitest';
import { courseCode, slotLabel, THU_PERIOD_TIMES } from '../src/domain/schedule.js';

describe('schedule', () => {
  it('THU_PERIOD_TIMES 與 115-1 課表一致', () => {
    expect(THU_PERIOD_TIMES['0']).toEqual({ start: '07:10', end: '08:00' });
    expect(THU_PERIOD_TIMES['1']).toEqual({ start: '08:10', end: '09:00' });
    expect(THU_PERIOD_TIMES['3']).toEqual({ start: '10:20', end: '11:10' });
    expect(THU_PERIOD_TIMES['4.5']).toEqual({ start: '12:10', end: '13:00' });
    expect(THU_PERIOD_TIMES['6']).toEqual({ start: '14:10', end: '15:00' });
    expect(THU_PERIOD_TIMES['7']).toEqual({ start: '15:20', end: '16:10' });
    expect(THU_PERIOD_TIMES['13']).toEqual({ start: '21:20', end: '22:10' });
    expect(Object.keys(THU_PERIOD_TIMES)).toHaveLength(15);
  });

  it('slotLabel 顯示星期、時間與節次', () => {
    expect(slotLabel({ weekday: 3, periods: ['2', '3', '4'], room: 'M134' }, THU_PERIOD_TIMES)).toBe('三 09:10–12:10（2–4 節）');
    expect(slotLabel({ weekday: 4, periods: ['6'], room: 'M220' }, THU_PERIOD_TIMES)).toBe('四 14:10–15:00（6 節）');
  });

  it('slotLabel 遇到未知節次只顯示節次', () => {
    expect(slotLabel({ weekday: 1, periods: ['A', 'B'], room: null }, THU_PERIOD_TIMES)).toBe('一 A–B 節');
    expect(slotLabel({ weekday: 2, periods: ['3', '4'], room: null }, {})).toBe('二 3–4 節');
  });

  it('courseCode 取 _ 之後，沒有 _ 時完整顯示', () => {
    expect(courseCode('1151_1212')).toBe('1212');
    expect(courseCode('labor1151gra')).toBe('labor1151gra');
  });
});
