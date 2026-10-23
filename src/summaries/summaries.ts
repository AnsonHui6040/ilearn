import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CliExit, absPath, type CliContext } from '../cli/context.js';
import { checkAgent } from '../events/outbox.js';
import { countSummariesOn, listFiles, listItems, listSummaries, upsertSummary } from '../db/repo.js';
import { toTaipeiIso } from '../time.js';

/** 單則摘要的字數上限 */
export const SUMMARY_MAX_CHARS = 2000;

export type SummaryKind = 'announcement' | 'material';

export interface SummaryTarget {
  target_id: string;
  kind: SummaryKind;
  course: { id: string; name: string };
  title: string;
  body: string | null;
  path: string | null;
  source_hash: string;
}

export interface PendingSummaries {
  agent_write: boolean;
  remaining_today: number;
  pending: SummaryTarget[];
}

export interface SummaryWritten {
  target_id: string;
  kind: SummaryKind;
  written_at: string;
  remaining_today: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function latestSemester(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(semester) AS s FROM courses').get() as { s: string | null }).s;
}

/** 目前學期、且該課程已啟用對應摘要的全部對象（不論有沒有寫過）。 */
export function summaryTargets(ctx: CliContext): SummaryTarget[] {
  const sem = latestSemester(ctx.db);
  if (sem === null) return [];
  const courses = ctx.db.prepare('SELECT id, name FROM courses WHERE semester = ?').all(sem) as unknown as { id: string; name: string }[];
  const names = new Map(courses.map((c) => [c.id, c.name]));
  const enabled = (courseId: string, kind: 'materials' | 'announcements'): boolean =>
    names.has(courseId) && ctx.config.summaries.courses[courseId]?.[kind] === true;
  const course = (id: string): { id: string; name: string } => ({ id, name: names.get(id) ?? id });

  const out: SummaryTarget[] = [];
  const items = listItems(ctx.db, { kind: 'announcement', semester: sem }).filter((i) => enabled(i.course_id, 'announcements'));
  // 新公告排前面，每日上限不夠時先處理最新的
  for (const i of items.reverse()) {
    out.push({
      target_id: i.id,
      kind: 'announcement',
      course: course(i.course_id),
      title: i.title,
      body: i.body,
      path: null,
      source_hash: sha256(`${i.title}\n${i.body ?? ''}`),
    });
  }
  for (const f of listFiles(ctx.db, { status: 'done' })) {
    if (f.local_path === null || !enabled(f.course_id, 'materials')) continue;
    out.push({
      target_id: `file:${f.upload_id}`,
      kind: 'material',
      course: course(f.course_id),
      title: f.name,
      body: null,
      path: absPath(ctx.root, f.local_path),
      source_hash: f.hash ?? sha256(`${f.name}:${f.size}`),
    });
  }
  return out;
}

const taipeiDay = (now: Date): string => toTaipeiIso(now).slice(0, 10);

function remainingToday(ctx: CliContext): number {
  return Math.max(0, ctx.config.summaries.daily_limit - countSummariesOn(ctx.db, taipeiDay(ctx.now())));
}

/** 還沒有摘要、或原文已變動的對象，數量受每日上限限制。 */
export function pendingSummaries(ctx: CliContext): PendingSummaries {
  const remaining = remainingToday(ctx);
  const have = new Map(listSummaries(ctx.db).map((s) => [s.target_id, s.source_hash]));
  const pending = summaryTargets(ctx).filter((t) => have.get(t.target_id) !== t.source_hash);
  return { agent_write: ctx.config.summaries.agent_write, remaining_today: remaining, pending: pending.slice(0, remaining) };
}

/** 去掉控制字元（保留換行）後修剪，再截到字數上限。 */
export function cleanSummaryText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '').trim();
  return Array.from(stripped).slice(0, SUMMARY_MAX_CHARS).join('').trimEnd();
}

/** agent 寫回摘要；任何不符條件的情況都以 CliExit(1, 中文訊息) 拒絕。 */
export function writeSummary(
  ctx: CliContext,
  o: { target_id: string; source_hash: string; text: string; agent?: string | undefined },
): SummaryWritten {
  if (!ctx.config.summaries.agent_write) {
    throw new CliExit(1, '使用者尚未允許 agent 寫入摘要，可在 ilearn setup 第 8 步或 ilearn ui 的「系統設定 > 摘要」開啟');
  }
  if (o.agent !== undefined) {
    try {
      checkAgent(o.agent);
    } catch (e) {
      throw new CliExit(1, e instanceof Error ? e.message : '無效的 agent 名稱');
    }
  }
  const target = summaryTargets(ctx).find((t) => t.target_id === o.target_id);
  if (target === undefined) {
    throw new CliExit(1, `找不到可寫摘要的對象 ${o.target_id}，可能是未知的 id、不在本學期，或該課程沒有啟用這類摘要`);
  }
  if (target.source_hash !== o.source_hash) {
    throw new CliExit(1, '原文已變動，請重新取得待摘要清單（ilearn summaries pending）後再寫');
  }
  if (remainingToday(ctx) <= 0) {
    throw new CliExit(1, `今天寫入的摘要已達每日上限 ${ctx.config.summaries.daily_limit} 則，明天再寫`);
  }
  const text = cleanSummaryText(o.text);
  if (text === '') throw new CliExit(1, '摘要內容是空的');

  const written_at = toTaipeiIso(ctx.now());
  upsertSummary(ctx.db, {
    target_id: target.target_id,
    kind: target.kind,
    course_id: target.course.id,
    source_hash: target.source_hash,
    text,
    agent: o.agent ?? null,
    written_at,
  });
  return { target_id: target.target_id, kind: target.kind, written_at, remaining_today: remainingToday(ctx) };
}

/** target_id → 摘要文字，供課程與公告輸出附上。 */
export function summaryTexts(db: DatabaseSync): Map<string, string> {
  return new Map(listSummaries(db).map((s) => [s.target_id, s.text]));
}

/** 設定頁用：今天已寫入的摘要數。 */
export function summariesWrittenToday(ctx: CliContext): number {
  return countSummariesOn(ctx.db, taipeiDay(ctx.now()));
}
