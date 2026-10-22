import { load } from 'cheerio';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config/config.js';
import {
  getItem,
  getSyncState,
  listItems,
  markReminderSent,
  recordDueChange,
  reminderSent,
  setCompletion,
  setSyncState,
  upsertCourse,
  upsertItem,
  type StoredItem,
} from '../db/repo.js';
import { judgeHomework, judgeVideo, type HomeworkSubmission } from '../domain/completion.js';
import { isQuiet } from '../events/delivery.js';
import { makeEvent, type Outbox } from '../events/outbox.js';
import { dueReminders, type ReminderTarget } from '../events/reminders.js';
import {
  ApiError,
  type ApiActivity,
  type ApiBulletin,
  type ApiCourse,
  type ApiCourseDetail,
  type ApiExam,
  type ApiHomework,
  type ApiSubmission,
  type IlearnApi,
} from '../ilearn/api.js';
import { courseViewUrl, parseCourseView, type ScheduleSlot } from '../ilearn/courseInfo.js';
import { classify, type Rule } from '../rules/engine.js';
import { toTaipeiIso } from '../time.js';
import type { CompletionState, CourseRef, Delivery, EventType, IlearnEvent } from '../types.js';
import { downloadFiles, downloadPending, registerUploads } from './files.js';
import { toEventItem, toUtcIso, urls } from './shared.js';

export { downloadPending };
export { planReload, commitReload } from './reload.js';

export interface SyncProgress {
  coursesDone: number;
  coursesTotal: number;
  filesDone: number;
  filesTotal: number;
  bytes: number;
}

export interface SyncContext {
  db: DatabaseSync;
  api: IlearnApi;
  fetchText(url: string): Promise<string>;
  outbox: Outbox;
  config: Config;
  rules: Rule[];
  root: string;
  userId: number;
  now: () => Date;
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncReport {
  initial: boolean;
  courses: number;
  pendingAssignments: number;
  upcoming3d: { title: string; due_at: string }[];
  incompleteCourses: string[];
  filesFailed: { name: string; reason: string }[];
  eventsEmitted: number;
}

interface Run {
  ctx: SyncContext;
  /** 首次同步進行中：寫入資料但不 append 事件。 */
  initial: boolean;
  now: Date;
  nowIso: string;
  emitted: number;
}

interface Flag {
  incomplete: boolean;
}

interface EmitOpts {
  delivery: Delivery;
  categories?: string[];
  matched?: string[];
  summary?: string | null;
  dedupe: string;
  offset?: string;
}

/** 使用者中止或登入過期要整個停下來，其餘錯誤只讓該科標為不完整。 */
function isFatal(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || (e instanceof ApiError && e.status === 401));
}

async function attempt<T>(f: Flag, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (isFatal(e)) throw e;
    f.incomplete = true;
    return undefined;
  }
}

function emit(run: Run, e: IlearnEvent): void {
  if (run.initial) return;
  if (run.ctx.outbox.append(e)) run.emitted++;
}

function newEvent(
  run: Run,
  type: EventType,
  course: CourseRef | null,
  item: StoredItem | null,
  o: EmitOpts,
): IlearnEvent {
  return makeEvent({
    type,
    delivery: o.delivery,
    categories: o.categories ?? [],
    matched_rules: o.matched ?? [],
    course,
    item: item ? toEventItem(item) : null,
    summary: o.summary ?? null,
    dedupe_key: o.dedupe,
    ...(o.offset !== undefined ? { offset: o.offset } : {}),
    detectedAt: run.now,
    quiet: run.ctx.config.quiet_hours,
  });
}

function blankItem(run: Run, id: string, kind: StoredItem['kind'], courseId: string, title: string): StoredItem {
  return {
    id, kind, course_id: courseId, title, body: null, due_at: null, start_at: null, url: null,
    completion: 'pending', teammate_hint: false, group: false, score: null, score_published: false,
    feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: run.nowIso, updated_at: run.nowIso,
  };
}

function classifyFor(run: Run, courseId: string, title: string, body: string, diff = '') {
  const overrides = run.ctx.config.course_overrides[courseId]?.rules ?? {};
  return classify(run.ctx.rules, { course_id: courseId, title, body, course_info_diff: diff }, overrides);
}

/** 保留既有項目的分類，新項目才用規則（或指定值）。 */
function withClass(
  item: StoredItem,
  prev: StoredItem | undefined,
  fresh: { categories: string[]; matched_rules: string[]; delivery: Delivery },
): void {
  const src = prev ? { categories: prev.categories, matched_rules: prev.matched_rules, delivery: prev.delivery } : fresh;
  item.categories = src.categories;
  item.matched_rules = src.matched_rules;
  item.delivery = src.delivery;
}

function gradeAppeared(prev: StoredItem | undefined, now: StoredItem): boolean {
  if (!prev) return false;
  return (prev.score === null && now.score !== null) || (!prev.score_published && now.score_published);
}

function clearDueTracking(run: Run, prev: StoredItem | undefined, id: string, oldVal: string | null, newVal: string | null): void {
  if (!prev || oldVal === newVal) return;
  recordDueChange(run.ctx.db, id, oldVal, newVal);
  run.ctx.db.prepare('DELETE FROM reminders_sent WHERE item_id = ?').run(id);
}

function htmlToText(html: string): string {
  const $ = load(html);
  $('br').replaceWith('\n');
  $('p, div, li, tr').append('\n');
  return $.text().replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- 課程資訊 ---------- */

interface Snapshot {
  fields: { key: string; title: string; description: string }[];
  schedule: { raw: string; slots: ScheduleSlot[] };
}

const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日'];

function fmtSlot(s: ScheduleSlot | undefined): string {
  if (!s) return '無';
  return `週${WEEKDAY[s.weekday] ?? s.weekday} 第${s.periods.join(',')}節${s.room ? `[${s.room}]` : ''}`;
}

function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const lines: string[] = [];
  if (a.schedule.raw !== b.schedule.raw) {
    const n = Math.max(a.schedule.slots.length, b.schedule.slots.length);
    if (n === 0) {
      lines.push(`上課時間變更：${a.schedule.raw || '無'} → ${b.schedule.raw || '無'}`);
    }
    for (let i = 0; i < n; i++) {
      const o = a.schedule.slots[i];
      const w = b.schedule.slots[i];
      if (fmtSlot(o) !== fmtSlot(w)) lines.push(`上課時間變更：${fmtSlot(o)} → ${fmtSlot(w)}`);
      if ((o?.room ?? null) !== (w?.room ?? null)) lines.push(`教室異動：${o?.room ?? '無'} → ${w?.room ?? '無'}`);
    }
  }
  const before = new Map(a.fields.map((x) => [x.key, x]));
  const after = new Map(b.fields.map((x) => [x.key, x]));
  for (const [k, v] of after) if (before.get(k)?.description !== v.description) lines.push(`${v.title}變更`);
  for (const [k, v] of before) if (!after.has(k)) lines.push(`${v.title}變更`);
  return lines;
}

function parseSnapshot(raw: string): Snapshot | null {
  try {
    const s = JSON.parse(raw) as Partial<Snapshot>;
    if (Array.isArray(s.fields) && s.schedule && typeof s.schedule.raw === 'string') return s as Snapshot;
  } catch {
    // 舊資料格式不符，當作沒有基準
  }
  return null;
}

async function syncCourseInfo(run: Run, course: CourseRef, detail: ApiCourseDetail): Promise<void> {
  const { ctx } = run;
  const id = `course_info:${course.id}`;
  const prev = getItem(ctx.db, id, 'course_info');
  const prevSnap = prev ? parseSnapshot(prev.raw) : null;

  const fields = (detail.course_outline?.common_fields ?? []).map((x) => ({
    key: x.key, title: x.title, description: x.description ?? '',
  }));
  let schedule = prevSnap?.schedule ?? { raw: '', slots: [] };
  const viewUrl = courseViewUrl(detail.course_code);
  if (viewUrl) {
    try {
      const p = parseCourseView(await ctx.fetchText(viewUrl));
      // 公開頁抓不到或解析不出上課時間，沿用上次的值，避免誤報變更。
      if (p.rawScheduleText !== '' || schedule.raw === '') {
        schedule = { raw: p.rawScheduleText, slots: p.schedule };
      }
    } catch (e) {
      if (isFatal(e)) throw e;
    }
  }
  const snap: Snapshot = { fields, schedule };

  const item = blankItem(run, id, 'course_info', course.id, '課程資訊');
  item.url = urls.outline(course.id);
  item.raw = JSON.stringify(snap);
  item.body = [
    ...fields.map((x) => `${x.title}：${x.description}`),
    ...(schedule.raw ? [`上課時間：${schedule.raw}`] : []),
  ].join('\n');

  const lines = prevSnap ? diffSnapshots(prevSnap, snap) : [];
  if (prev && lines.length > 0) {
    const diff = lines.join('\n');
    const cls = classifyFor(run, course.id, '課程資訊', '', diff);
    withClass(item, undefined, cls);
    upsertItem(ctx.db, item);
    emit(run, newEvent(run, 'course.info_changed', course, item, {
      delivery: cls.delivery, categories: cls.categories, matched: cls.matched_rules, summary: diff,
      dedupe: `course.info_changed:${id}:${run.nowIso}`,
    }));
    return;
  }
  withClass(item, prev, { categories: [], matched_rules: [], delivery: 'record' });
  upsertItem(ctx.db, item);
}

/* ---------- 作業 ---------- */

function toSubmission(s: ApiSubmission): HomeworkSubmission {
  return {
    is_draft: s.is_draft === true,
    is_redo: s.is_redo === true,
    created_by_id: s.created_by?.id ?? null,
    upload_creator_ids: (s.uploads ?? []).flatMap((u) => (typeof u.created_by_id === 'number' ? [u.created_by_id] : [])),
  };
}

function latestComment(subs: ApiSubmission[]): string | null {
  for (const s of [...subs].reverse()) {
    const c = (s.instructor_comment ?? s.submission_correct?.comment ?? '').trim();
    if (c !== '') return c;
  }
  return null;
}

async function syncHomework(
  run: Run,
  f: Flag,
  course: CourseRef,
  a: ApiActivity,
  hw: ApiHomework | undefined,
): Promise<void> {
  const { ctx } = run;
  const id = `assignment:${a.id}`;
  const prev = getItem(ctx.db, id, 'assignment');
  const prevState: CompletionState | null = prev?.completion ?? null;
  const group = hw?.submit_by_group ?? a.submit_by_group ?? false;
  const listSubmitted = hw?.submitted ?? false;
  const needSub = listSubmitted || prevState === 'completed' || prevState === 'teammate_marked';

  let apiSubs: ApiSubmission[] = [];
  let subs: HomeworkSubmission[] | null = [];
  if (needSub) {
    try {
      apiSubs = await ctx.api.submissions(a.id, ctx.userId);
      subs = apiSubs.map(toSubmission);
    } catch (e) {
      if (isFatal(e)) throw e;
      subs = null;
      f.incomplete = true;
    }
  }

  const res = judgeHomework({
    group, listSubmitted, submissions: subs, userId: ctx.userId, previous: prevState,
    userMarkedTeammate: prevState === 'teammate_marked',
  });

  const item = blankItem(run, id, 'assignment', course.id, hw?.title ?? a.title);
  item.due_at = toUtcIso(hw?.end_time ?? a.end_time ?? a.deadline);
  item.start_at = toUtcIso(a.start_time);
  item.url = urls.activity(course.id, a.id);
  item.completion = res.state;
  item.group = group;
  item.teammate_hint = res.unverified ? (prev?.teammate_hint ?? false) : res.teammateHint;
  item.score = hw ? (hw.score === null ? null : String(hw.score)) : (prev?.score ?? null);
  item.score_published = hw ? hw.score_published : (prev?.score_published ?? false);
  const comment = subs !== null && needSub ? latestComment(apiSubs) : null;
  item.feedback = comment ?? prev?.feedback ?? null;
  const cls = classifyFor(run, course.id, item.title, '');
  withClass(item, prev, { categories: cls.categories, matched_rules: cls.matched_rules, delivery: 'push' });

  upsertItem(ctx.db, item);
  if (res.state === 'completed') setCompletion(ctx.db, id, 'completed', 'ilearn');
  clearDueTracking(run, prev, id, prev?.due_at ?? null, item.due_at);
  registerUploads(ctx, id, course.id, a.uploads ?? []);

  if (!prev && res.state !== 'completed') {
    emit(run, newEvent(run, 'assignment.new', course, item, {
      delivery: 'push', categories: item.categories, matched: item.matched_rules, dedupe: `assignment.new:${id}`,
    }));
  }
  if (res.returned && !res.unverified) {
    emit(run, newEvent(run, 'assignment.returned', course, item, {
      delivery: 'push', categories: item.categories, matched: item.matched_rules,
      dedupe: `assignment.returned:${id}:${run.nowIso}`,
    }));
  }
  if (gradeAppeared(prev, item)) emitGrade(run, course, item);
  if (prev && !prev.feedback && item.feedback) {
    emit(run, newEvent(run, 'feedback.posted', course, item, { delivery: 'push', dedupe: `feedback.posted:${id}` }));
  }
}

function emitGrade(run: Run, course: CourseRef, item: StoredItem): void {
  emit(run, newEvent(run, 'grade.posted', course, item, { delivery: 'push', dedupe: `grade.posted:${item.id}` }));
}

/* ---------- 其他活動 ---------- */

type Simple = { type: 'video' | 'material' | 'survey'; event: EventType; prefix: string };
const SIMPLE: Record<string, Simple> = {
  online_video: { type: 'video', event: 'video.new', prefix: 'video' },
  material: { type: 'material', event: 'material.new', prefix: 'material' },
  questionnaire: { type: 'survey', event: 'survey.new', prefix: 'survey' },
};

function syncSimpleActivity(
  run: Run,
  course: CourseRef,
  a: ApiActivity,
  spec: Simple,
  reads: { activity_id: number; completeness: string }[] | undefined,
): void {
  const { ctx } = run;
  const id = `${spec.prefix}:${a.id}`;
  const prev = getItem(ctx.db, id, spec.type);
  const item = blankItem(run, id, spec.type, course.id, a.title);
  item.due_at = toUtcIso(a.end_time ?? a.deadline);
  item.url = urls.activity(course.id, a.id);
  if (spec.type === 'video') {
    if (reads) {
      const r = reads.find((x) => x.activity_id === a.id);
      item.completion = judgeVideo(r ? { completeness: r.completeness === 'full' ? 'full' : 'part' } : undefined);
    } else {
      item.completion = prev?.completion ?? 'pending';
    }
  }
  const cls = classifyFor(run, course.id, item.title, '');
  const fresh = {
    categories: cls.categories,
    matched_rules: cls.matched_rules,
    delivery: spec.type === 'material' ? cls.delivery : ('push' as Delivery),
  };
  withClass(item, prev, fresh);
  upsertItem(ctx.db, item);
  clearDueTracking(run, prev, id, prev?.due_at ?? null, item.due_at);
  registerUploads(ctx, id, course.id, a.uploads ?? []);

  const skip = spec.type === 'video' && item.completion === 'completed';
  if (!prev && !skip) {
    emit(run, newEvent(run, spec.event, course, item, {
      delivery: item.delivery ?? 'record', categories: item.categories, matched: item.matched_rules,
      dedupe: `${spec.event}:${id}`,
    }));
  }
}

async function syncActivities(run: Run, f: Flag, course: CourseRef): Promise<void> {
  const { api } = run.ctx;
  const cid = Number(course.id);
  const all = await attempt(f, () => api.activities(cid));
  if (!all) return;
  const acts = all.filter((a) => a.published !== false);
  const hwList = await attempt(f, () => api.homework(cid));
  const reads = await attempt(f, () => api.reads(cid));

  for (const a of acts) {
    if (a.type === 'homework') {
      if (hwList) await syncHomework(run, f, course, a, hwList.find((h) => h.id === a.id));
      continue;
    }
    const spec = SIMPLE[a.type];
    if (spec) syncSimpleActivity(run, course, a, spec, reads);
  }
}

/* ---------- 考試、公告、總成績 ---------- */

function syncExam(run: Run, course: CourseRef, e: ApiExam, scores: { activity_id: number; score: number | null }[] | undefined): void {
  const { ctx } = run;
  const id = `exam:${e.id}`;
  const prev = getItem(ctx.db, id, 'exam');
  const item = blankItem(run, id, 'exam', course.id, e.title);
  item.start_at = toUtcIso(e.start_time);
  item.url = urls.exam(course.id);
  if (scores) {
    const s = scores.find((x) => x.activity_id === e.id)?.score ?? null;
    item.score = s === null ? null : String(s);
    item.score_published = s !== null;
  } else {
    item.score = prev?.score ?? null;
    item.score_published = prev?.score_published ?? false;
  }
  const cls = classifyFor(run, course.id, item.title, '');
  withClass(item, prev, { categories: cls.categories, matched_rules: cls.matched_rules, delivery: 'push' });
  upsertItem(ctx.db, item);
  clearDueTracking(run, prev, id, prev?.start_at ?? null, item.start_at);

  if (!prev) {
    emit(run, newEvent(run, 'exam.new', course, item, {
      delivery: 'push', categories: item.categories, matched: item.matched_rules, dedupe: `exam.new:${id}`,
    }));
  }
  if (gradeAppeared(prev, item)) emitGrade(run, course, item);
}

async function syncExams(run: Run, f: Flag, course: CourseRef): Promise<void> {
  const { api } = run.ctx;
  const cid = Number(course.id);
  const exams = await attempt(f, () => api.exams(cid));
  if (!exams) return;
  const scores = await attempt(f, () => api.examScores(cid));
  for (const e of exams) syncExam(run, course, e, scores);
}

function syncBulletin(run: Run, course: CourseRef, b: ApiBulletin): void {
  const { ctx } = run;
  const id = `announcement:${b.id}`;
  const prev = getItem(ctx.db, id, 'announcement');
  const body = htmlToText(b.content ?? '');
  const item = blankItem(run, id, 'announcement', course.id, b.title);
  item.body = body;
  item.url = urls.bulletin(course.id);
  item.first_seen_at = run.nowIso;
  const cls = classifyFor(run, course.id, b.title, body);
  withClass(item, prev, cls);
  upsertItem(ctx.db, item);
  registerUploads(ctx, id, course.id, b.uploads ?? []);
  if (!prev) {
    emit(run, newEvent(run, 'announcement.new', course, item, {
      delivery: cls.delivery, categories: cls.categories, matched: cls.matched_rules,
      dedupe: `announcement.new:${id}`,
    }));
  }
}

async function syncBulletins(run: Run, f: Flag, course: CourseRef): Promise<void> {
  const list = await attempt(f, () => run.ctx.api.bulletins(Number(course.id)));
  if (list) for (const b of list) syncBulletin(run, course, b);
}

async function syncCourseScore(run: Run, f: Flag, course: CourseRef): Promise<void> {
  const r = await attempt(f, () => run.ctx.api.courseScore(Number(course.id)));
  if (!r) return;
  const id = `course_score:${course.id}`;
  const prev = getItem(run.ctx.db, id, 'grade');
  const item = blankItem(run, id, 'grade', course.id, '學期總成績');
  item.score = r.total_score;
  item.score_published = r.published && r.total_score !== null;
  item.delivery = 'push';
  upsertItem(run.ctx.db, item);
  if (gradeAppeared(prev, item)) emitGrade(run, course, item);
}

/* ---------- 同步主流程 ---------- */

async function syncCourse(run: Run, apiCourse: ApiCourse, course: CourseRef): Promise<boolean> {
  const f: Flag = { incomplete: false };
  const detail = await attempt(f, () => run.ctx.api.course(apiCourse.id));
  if (detail) await syncCourseInfo(run, course, detail);
  await syncActivities(run, f, course);
  await syncExams(run, f, course);
  await syncBulletins(run, f, course);
  await syncCourseScore(run, f, course);
  return f.incomplete;
}

function buildReport(run: Run, semester: string, initial: boolean, courses: number, incompleteNames: string[], failed: SyncReport['filesFailed']): SyncReport {
  const pending = listItems(run.ctx.db, { kind: 'assignment', semester }).filter((i) => i.completion === 'pending');
  const t0 = run.now.getTime();
  const upcoming3d = pending
    .filter((i) => i.due_at !== null && Date.parse(i.due_at) > t0 && Date.parse(i.due_at) <= t0 + 3 * 86400_000)
    .sort((a, b) => Date.parse(a.due_at as string) - Date.parse(b.due_at as string))
    .map((i) => ({ title: i.title, due_at: toTaipeiIso(new Date(i.due_at as string)) }));
  return {
    initial, courses, pendingAssignments: pending.length, upcoming3d, incompleteCourses: incompleteNames,
    filesFailed: failed, eventsEmitted: run.emitted,
  };
}

export async function runSync(ctx: SyncContext): Promise<SyncReport> {
  const now = ctx.now();
  const state = getSyncState(ctx.db);
  const initial = !state.initial_completed;
  const run: Run = { ctx, initial, now, nowIso: now.toISOString(), emitted: 0 };

  const semester = await ctx.api.activeSemesterCode();
  const courses = (await ctx.api.myCourses()).filter((c) => c.semester.code === semester);
  const finished = new Set(initial ? state.in_progress_courses : []);
  const incompleteIds: string[] = [];
  const incompleteNames: string[] = [];
  const progress = (done: number): void =>
    ctx.onProgress?.({ coursesDone: done, coursesTotal: courses.length, filesDone: 0, filesTotal: 0, bytes: 0 });

  progress(0);
  let done = 0;
  for (const c of courses) {
    const id = String(c.id);
    if (finished.has(id)) {
      progress(++done);
      continue;
    }
    upsertCourse(ctx.db, {
      id, name: c.name, code: c.course_code, semester: c.semester.code, start_date: '', end_date: '',
      raw: JSON.stringify(c),
    });
    const course: CourseRef = { id, name: c.name, semester: c.semester.code };
    const incomplete = await syncCourse(run, c, course);
    if (incomplete) {
      incompleteIds.push(id);
      incompleteNames.push(c.name);
    } else if (initial) {
      finished.add(id);
      setSyncState(ctx.db, { in_progress_courses: [...finished] });
    }
    progress(++done);
  }

  if (!initial) {
    for (let i = 0; i < incompleteIds.length; i++) {
      const course: CourseRef = { id: incompleteIds[i] as string, name: incompleteNames[i] as string, semester };
      emit(run, newEvent(run, 'sync.incomplete', course, null, {
        delivery: 'push',
        summary: `「${course.name}」部分資料沒有取得，內容可能不完整`,
        dedupe: `sync.incomplete:${course.id}:${toTaipeiIso(now).slice(0, 10)}`,
      }));
    }
  }

  if (initial && incompleteIds.length === 0) {
    run.initial = false;
    emit(run, newEvent(run, 'sync.initial_completed', null, null, {
      delivery: 'record', summary: `首次同步完成，共 ${courses.length} 門課程`, dedupe: 'sync.initial_completed',
    }));
    setSyncState(ctx.db, { initial_completed: true, in_progress_courses: [] });
  }
  setSyncState(ctx.db, { incomplete_courses: incompleteIds, last_sync_at: now.toISOString() });
  if (run.emitted > 0) ctx.outbox.renderMarkdown();

  const dl = await downloadFiles(ctx, undefined, { done, total: courses.length });
  return buildReport(run, semester, initial, courses.length, incompleteNames, dl.failed);
}

/* ---------- 提醒 ---------- */

export async function runReminderTick(ctx: Omit<SyncContext, 'api' | 'fetchText'>): Promise<number> {
  const now = ctx.now();
  if (!getSyncState(ctx.db).initial_completed) return 0;

  const items = [...listItems(ctx.db, { kind: 'assignment' }), ...listItems(ctx.db, { kind: 'exam' })];
  const byId = new Map(items.map((i) => [i.id, i]));
  const targets: ReminderTarget[] = [];
  for (const it of items) {
    const at = it.kind === 'exam' ? it.start_at : it.due_at;
    if (!at) continue;
    const dueAt = new Date(at);
    targets.push({
      itemId: it.id,
      kind: it.kind === 'exam' ? 'exam' : 'assignment',
      dueAt,
      done: it.kind === 'assignment' && it.completion !== 'pending',
      started: it.kind === 'exam' && now.getTime() >= dueAt.getTime(),
      offsets: ctx.config.course_overrides[it.course_id]?.reminders ?? ctx.config.reminders.offsets,
    });
  }

  const courseRow = ctx.db.prepare('SELECT id, name, semester FROM courses WHERE id = ?');
  const quiet = isQuiet(now, ctx.config.quiet_hours);
  const run: Run = { ctx: ctx as SyncContext, initial: false, now, nowIso: now.toISOString(), emitted: 0 };
  let sent = 0;

  const due = dueReminders(now, targets, (id, off) => reminderSent(ctx.db, id, off), ctx.config.force_push_offsets, null);
  for (const d of due) {
    if (d.suppressed) {
      markReminderSent(ctx.db, d.itemId, d.offset, run.nowIso);
      continue;
    }
    if (d.delivery === 'push' && quiet) continue; // 夜間不送也不標記，結束後仍會到期
    const it = byId.get(d.itemId);
    if (!it) continue;
    const type: EventType = it.kind === 'exam' ? 'exam.reminder' : 'assignment.due_reminder';
    const c = courseRow.get(it.course_id) as unknown as CourseRef | undefined;
    const course = c ? { id: c.id, name: c.name, semester: c.semester } : null;
    const appended = ctx.outbox.append(
      newEvent(run, type, course, it, { delivery: d.delivery, dedupe: `${type}:${it.id}:${d.offset}`, offset: d.offset }),
    );
    markReminderSent(ctx.db, d.itemId, d.offset, run.nowIso);
    if (appended) sent++;
  }
  if (sent > 0) ctx.outbox.renderMarkdown();
  return sent;
}
