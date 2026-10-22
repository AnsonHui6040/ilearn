import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { listItems, type StoredItem } from '../db/repo.js';
import { makeEvent, type Outbox } from '../events/outbox.js';
import { toTaipeiIso } from '../time.js';
import type { CourseRef, Delivery, EventType, IlearnEvent } from '../types.js';
import { toEventItem } from './shared.js';

const WEEK_MS = 7 * 86400_000;
// makeEvent 需要夜間設定；Reload 之後會把 deliver_after 改回 now，所以這裡的值不影響結果。
const NO_QUIET = { start: '00:00', end: '00:00' };

function reloadType(it: StoredItem, now: Date): { type: EventType; delivery: Delivery } | null {
  switch (it.kind) {
    case 'assignment':
      return it.completion === 'pending' ? { type: 'assignment.new', delivery: 'push' } : null;
    case 'video':
      return it.completion === 'pending' ? { type: 'video.new', delivery: 'push' } : null;
    case 'exam': {
      if (!it.start_at) return null;
      const start = Date.parse(it.start_at);
      return start > now.getTime() && start <= now.getTime() + WEEK_MS
        ? { type: 'exam.new', delivery: 'push' }
        : null;
    }
    case 'announcement':
      return it.delivery === 'push' || it.delivery === 'force_push'
        ? { type: 'announcement.new', delivery: it.delivery }
        : null;
    case 'course_info':
      return it.delivery === 'push' || it.delivery === 'force_push'
        ? { type: 'course.info_changed', delivery: it.delivery }
        : null;
    default:
      return null;
  }
}

function hasPublishedScore(it: StoredItem): boolean {
  return (
    (it.kind === 'assignment' || it.kind === 'exam' || it.kind === 'grade') &&
    it.score_published &&
    it.score !== null
  );
}

/** 組出 Reload 要送的事件，不寫入 outbox。範圍是資料庫中最新學期的項目。 */
export function planReload(db: DatabaseSync, now: Date): IlearnEvent[] {
  const sem = (db.prepare('SELECT MAX(semester) AS s FROM courses').get() as { s: string | null }).s;
  if (sem === null) return [];

  const courses = new Map<string, CourseRef>();
  for (const r of db.prepare('SELECT id, name, semester FROM courses').all() as unknown as CourseRef[]) {
    courses.set(r.id, { id: r.id, name: r.name, semester: r.semester });
  }

  const reloadId = ulid(now.getTime());
  const seen = new Set<string>();
  const out: IlearnEvent[] = [];

  const push = (it: StoredItem, type: EventType, delivery: Delivery): void => {
    const dedupe_key = `${type}:${it.id}`;
    if (seen.has(dedupe_key)) return;
    seen.add(dedupe_key);
    const e = makeEvent({
      type,
      delivery,
      categories: it.categories,
      matched_rules: it.matched_rules,
      course: courses.get(it.course_id) ?? null,
      item: toEventItem(it),
      summary: null,
      dedupe_key,
      reason: 'reload',
      reload_id: reloadId,
      detectedAt: now,
      quiet: NO_QUIET,
    });
    e.deliver_after = toTaipeiIso(now);
    out.push(e);
  };

  for (const it of listItems(db, { semester: sem })) {
    const t = reloadType(it, now);
    if (t) push(it, t.type, t.delivery);
    if (hasPublishedScore(it)) push(it, 'grade.posted', 'push');
  }
  return out;
}

/** 把 planReload 的事件寫入 outbox，回傳實際寫入數量。 */
export function commitReload(outbox: Outbox, events: IlearnEvent[]): number {
  let n = 0;
  for (const e of events) if (outbox.append(e)) n++;
  if (n > 0) outbox.renderMarkdown();
  return n;
}
