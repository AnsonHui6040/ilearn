import type { StoredItem } from '../db/repo.js';
import { toTaipeiIso } from '../time.js';
import type { EventItem } from '../types.js';

const BASE = 'https://ilearn.thu.edu.tw';

export const urls = {
  activity: (courseId: string | number, activityId: string | number): string =>
    `${BASE}/course/${courseId}/learning-activity#/${activityId}`,
  bulletin: (courseId: string | number): string => `${BASE}/course/${courseId}/bulletin`,
  exam: (courseId: string | number): string => `${BASE}/course/${courseId}/exam`,
  outline: (courseId: string | number): string => `${BASE}/course/${courseId}/outline`,
};

/** iLearn 時間字串（UTC Z）→ ISO UTC；空值或無法解析 → null。 */
export function toUtcIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function taipei(s: string | null): string | null {
  return s === null ? null : toTaipeiIso(new Date(s));
}

/** 事件內的項目：只放標題及時間，不放分數、評語或內文。考試的時間欄位是開考時間。 */
export function toEventItem(it: StoredItem): EventItem {
  return {
    id: it.id,
    kind: it.kind,
    title: it.title,
    due_at: taipei(it.kind === 'exam' ? it.start_at : it.due_at),
    url: it.url,
  };
}
