import {
  announcementsCommand,
  courseCommand,
  coursesCommand,
  statusCommand,
  tasksCommand,
  type TaskRow,
} from '../cli/commands/query.js';
import type { CliContext } from '../cli/context.js';
import type { Config } from '../config/config.js';
import { reminderSent } from '../db/repo.js';
import { courseCode, slotLabel } from '../domain/schedule.js';
import type { ScheduleSlot } from '../ilearn/courseInfo.js';
import type { Rule } from '../rules/engine.js';
import { parseIsoDuration, taipeiDate, taipeiParts, toTaipeiIso } from '../time.js';
import type { ServiceStatus } from '../service/service.js';
import type { Delivery } from '../types.js';

const DAY_MS = 86_400_000;

export interface HomeSections {
  overdue: TaskRow[];
  within7d: TaskRow[];
  later: TaskRow[];
  notStarted: TaskRow[];
}

export interface CourseRow {
  id: string;
  code: string;
  name: string;
  schedule: string;
  rooms: string;
  todo: number;
  announcements: number;
}

export interface UpcomingReminder {
  itemId: string;
  title: string;
  course: string;
  at: string;
  offset: string;
  sent: boolean;
}

export interface AnnouncementRow {
  id: string;
  title: string;
  course: string;
  postedAt: string;
  categories: string[];
  delivery: Delivery | null;
  url: string | null;
  body: string | null;
}

export interface TuiData {
  now: Date;
  status: ReturnType<typeof statusCommand>;
  tasks: ReturnType<typeof tasksCommand>;
  home: HomeSections;
  courses: CourseRow[];
  archived: { semester: string; courses: CourseRow[] }[];
  reminders: UpcomingReminder[];
  announcements: AnnouncementRow[];
  notices: string[];
  rules: Rule[];
  config: Config;
  /** 背景服務狀態，由介面另外取得 */
  service?: ServiceStatus;
}

/** 去掉開頭的「(…)」，再去掉最後一個冒號（含）之前的部分。 */
export function displayName(name: string): string {
  const noPrefix = name.replace(/^\([^)]*\)/, '');
  const i = Math.max(noPrefix.lastIndexOf(':'), noPrefix.lastIndexOf('：'));
  return (i === -1 ? noPrefix : noPrefix.slice(i + 1)).trim();
}

function homeSections(tasks: TaskRow[], now: Date): HomeSections {
  const limit = now.getTime() + 7 * DAY_MS;
  const out: HomeSections = { overdue: [], within7d: [], later: [], notStarted: [] };
  for (const t of tasks) {
    if (t.not_started) out.notStarted.push(t);
    else if (t.overdue) out.overdue.push(t);
    else if (t.due_at !== null && Date.parse(t.due_at) < limit) out.within7d.push(t);
    else out.later.push(t);
  }
  return out;
}

function courseRow(ctx: CliContext, c: { id: string; name: string; code: string }): CourseRow {
  const d = courseCommand(ctx, c.id);
  const slots = d.schedule.slots as ScheduleSlot[];
  const rooms = [...new Set(slots.map((s) => s.room).filter((r): r is string => r !== null && r !== ''))];
  return {
    id: c.id,
    code: courseCode(c.code),
    name: displayName(c.name),
    schedule: slots.length === 0 ? '未提供' : slots.map((s) => slotLabel(s, ctx.config.period_times)).join('、'),
    rooms: rooms.join('、'),
    todo: d.todo.length,
    announcements: d.announcements.length,
  };
}

const byCode = (a: CourseRow, b: CourseRow): number => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

function todayStart(now: Date): Date {
  const p = taipeiParts(now);
  return taipeiDate(p.y, p.m, p.d, 0, 0);
}

function reminders(ctx: CliContext, now: Date, from: Date): UpcomingReminder[] {
  const names = new Map(
    (ctx.db.prepare('SELECT id, name FROM courses').all() as unknown as { id: string; name: string }[]).map((r) => [
      r.id,
      displayName(r.name),
    ]),
  );
  const rows = ctx.db
    .prepare(
      // 只算本學期；學期結束後停止提醒
      `SELECT id, kind, course_id, title, due_at, start_at FROM items
       WHERE course_id IN (SELECT id FROM courses WHERE semester = (SELECT MAX(semester) FROM courses))
         AND ((kind = 'assignment' AND completion = 'pending' AND due_at IS NOT NULL)
          OR (kind = 'exam' AND start_at IS NOT NULL))`,
    )
    .all() as unknown as {
    id: string;
    kind: 'assignment' | 'exam';
    course_id: string;
    title: string;
    due_at: string | null;
    start_at: string | null;
  }[];
  const out: (UpcomingReminder & { ms: number })[] = [];
  for (const r of rows) {
    const target = Date.parse((r.kind === 'exam' ? r.start_at : r.due_at) ?? '');
    if (Number.isNaN(target) || target <= now.getTime()) continue;
    const offsets = ctx.config.course_overrides[r.course_id]?.reminders ?? ctx.config.reminders.offsets;
    for (const offset of offsets) {
      const ms = target - parseIsoDuration(offset);
      if (ms < from.getTime()) continue;
      out.push({
        itemId: r.id,
        title: r.title,
        course: names.get(r.course_id) ?? '',
        at: toTaipeiIso(new Date(ms)),
        offset,
        sent: reminderSent(ctx.db, r.id, offset),
        ms,
      });
    }
  }
  return out.sort((a, b) => a.ms - b.ms).map(({ ms: _ms, ...rest }) => rest);
}

function announcements(ctx: CliContext, from: Date): AnnouncementRow[] {
  return announcementsCommand(ctx, {})
    .filter((a) => a.posted_at !== null && Date.parse(a.posted_at) >= from.getTime())
    .map((a) => ({
      id: a.id,
      title: a.title,
      course: displayName(a.course ?? ''),
      postedAt: a.posted_at ?? '',
      categories: a.categories,
      delivery: a.delivery,
      url: a.url,
      body: a.body,
    }));
}

function channelNotice(status: TuiData['status'], ch: 'hook' | 'webhook'): string | null {
  const s = status.delivery[ch];
  if (s.retrying <= 0 && s.gave_up <= 0) return null;
  const name = ch === 'hook' ? '本機指令 hook' : '本機 webhook';
  const parts = [s.retrying > 0 ? `重試中 ${s.retrying} 則` : null, s.gave_up > 0 ? `放棄 ${s.gave_up} 則` : null];
  return `${name}${s.enabled ? '' : '（已停用）'}：${parts.filter((p) => p !== null).join('，')}`;
}

function notices(ctx: CliContext, status: TuiData['status']): string[] {
  const out: string[] = [];
  const fp = status.first_sync_progress;
  if (status.initial_sync_in_progress && fp !== null) {
    out.push(
      `首次同步進行中，資料可能不完整（課程 ${fp.courses_done}／${fp.courses_total ?? '?'}、檔案 ${fp.files_done}／${fp.files_total}）`,
    );
  }
  if (status.incomplete_courses.length > 0) out.push(`資料可能不完整：${status.incomplete_courses.join('、')}`);

  const expired = ctx.outbox.read({ type: 'auth.expired' }).map((e) => Date.parse(e.detected_at));
  if (expired.length > 0) {
    const newest = Math.max(...expired);
    if (status.last_sync_at === null || newest > Date.parse(status.last_sync_at)) {
      out.push('登入已過期，請在終端執行 ilearn login');
    }
  }
  if (ctx.rules.length > 0 && ctx.rules.every((r) => !r.enabled)) out.push('通知規則全部停用，新公告不會推送');
  for (const ch of ['hook', 'webhook'] as const) {
    const n = channelNotice(status, ch);
    if (n !== null) out.push(n);
  }
  if (ctx.rulesWarning !== undefined && ctx.rulesWarning !== '') out.push(`規則檔有問題：${ctx.rulesWarning}`);
  return out;
}

/** 由 CliContext 組出 TUI 畫面需要的全部資料；只讀，不寫入任何檔案。 */
export function loadTuiData(ctx: CliContext): TuiData {
  const now = ctx.now();
  const from = todayStart(now);
  const status = statusCommand(ctx);
  const tasks = tasksCommand(ctx);

  const all = coursesCommand(ctx);
  const courses = all.filter((c) => c.current).map((c) => courseRow(ctx, c)).sort(byCode);
  const semesters = [...new Set(all.filter((c) => !c.current).map((c) => c.semester))].sort().reverse();
  const archived = semesters.map((semester) => ({
    semester,
    courses: all.filter((c) => !c.current && c.semester === semester).map((c) => courseRow(ctx, c)).sort(byCode),
  }));

  return {
    now,
    status,
    tasks,
    home: homeSections(tasks.tasks, now),
    courses,
    archived,
    reminders: reminders(ctx, now, from),
    announcements: announcements(ctx, from),
    notices: notices(ctx, status),
    rules: ctx.rules,
    config: ctx.config,
  };
}

/** 單一課程內容；分數與評語只留已公布的列。 */
export function courseDetail(ctx: CliContext, courseId: string): ReturnType<typeof courseCommand> {
  const d = courseCommand(ctx, courseId);
  return { ...d, grades: d.grades.filter((g) => g.score_published) };
}
