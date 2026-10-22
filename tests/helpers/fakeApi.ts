import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../../src/config/config.js';
import { openDb } from '../../src/db/schema.js';
import { Outbox } from '../../src/events/outbox.js';
import { DEFAULT_RULES } from '../../src/rules/engine.js';
import type { SyncContext } from '../../src/sync/sync.js';
import type { IlearnEvent } from '../../src/types.js';
import type {
  ApiActivity,
  ApiBulletin,
  ApiCourse,
  ApiCourseDetail,
  ApiExam,
  ApiHomework,
  ApiRead,
  ApiSubmission,
  IlearnApi,
} from '../../src/ilearn/api.js';

export interface FakeData {
  semester: string;
  courses: ApiCourse[];
  details: Record<number, ApiCourseDetail>;
  activities: Record<number, ApiActivity[]>;
  homework: Record<number, ApiHomework[]>;
  /** key: activityId */
  submissions: Record<number, ApiSubmission[]>;
  reads: Record<number, ApiRead[]>;
  exams: Record<number, ApiExam[]>;
  examScores: Record<number, { activity_id: number; score: number | null }[]>;
  bulletins: Record<number, ApiBulletin[]>;
  courseScore: Record<number, { total_score: string | null; published: boolean }>;
  /** key: uploadId */
  blobs: Record<number, string>;
  /** 'method' 或 'method:arg' → 下次呼叫拋出此錯誤（持續生效，直到刪除） */
  fail: Record<string, Error>;
  /** 'method' 或 'method:arg' → 呼叫時執行的 hook（可拋 AbortError） */
  hooks: Record<string, () => void>;
}

export interface FakeApi {
  api: IlearnApi;
  data: FakeData;
  calls: string[];
  count(prefix: string): number;
}

export function emptyData(): FakeData {
  return {
    semester: '115-1',
    courses: [],
    details: {},
    activities: {},
    homework: {},
    submissions: {},
    reads: {},
    exams: {},
    examScores: {},
    bulletins: {},
    courseScore: {},
    blobs: {},
    fail: {},
    hooks: {},
  };
}

/** 兩門本學期課程 + 一門舊學期課程；課程 1 有作業、教材、影片、考試、公告。 */
export function standardData(): FakeData {
  const d = emptyData();
  d.courses = [
    { id: 1, name: '資料結構', course_code: '1151_CS101', semester: { code: '115-1' } },
    { id: 2, name: '管理學', course_code: '1151_BA201', semester: { code: '115-1' } },
    { id: 9, name: '舊課程', course_code: '1142_OLD001', semester: { code: '114-2' } },
  ];
  d.details[1] = {
    ...(d.courses[0] as ApiCourse),
    course_outline: { common_fields: [{ key: 'grading', title: '評分方式', description: '期中 40% 期末 60%' }] },
  };
  d.details[2] = {
    ...(d.courses[1] as ApiCourse),
    course_outline: { common_fields: [] },
  };
  d.activities[1] = [
    { id: 101, type: 'homework', title: '作業一', end_time: '2026-10-30T15:59:00Z', submit_by_group: false, published: true,
      uploads: [{ id: 5001, name: '作業一說明.pdf', size: 12, allow_download: true, link: null }] },
    { id: 102, type: 'material', title: '第一週講義', published: true,
      uploads: [{ id: 5002, name: '講義1.pdf', size: 10, allow_download: true, link: null }] },
    { id: 103, type: 'online_video', title: '第一週影片', end_time: '2026-11-30T15:59:00Z', published: true },
    { id: 104, type: 'page', title: '一般頁面', published: true },
  ];
  d.homework[1] = [
    { id: 101, title: '作業一', end_time: '2026-10-30T15:59:00Z', submit_by_group: false, submitted: false,
      submitted_status: null, is_closed: false, score: null, score_published: false },
  ];
  d.reads[1] = [];
  d.exams[1] = [
    { id: 301, title: '期中考', start_time: '2026-11-05T01:00:00Z', end_time: '2026-11-05T03:00:00Z' },
  ];
  d.examScores[1] = [];
  d.bulletins[1] = [
    { id: 88000, title: '歡迎修課', content: '<p>歡迎大家</p>', created_at: '2026-09-10T02:00:00Z', uploads: [
      { id: 5003, name: '課程簡介.pdf', size: 9, allow_download: true, link: null },
    ] },
  ];
  d.courseScore[1] = { total_score: null, published: false };
  d.activities[2] = [];
  d.homework[2] = [];
  d.reads[2] = [];
  d.exams[2] = [];
  d.examScores[2] = [];
  d.bulletins[2] = [];
  d.courseScore[2] = { total_score: null, published: false };
  d.blobs[5001] = 'hw-description';
  d.blobs[5002] = 'lecture-1';
  d.blobs[5003] = 'intro';
  return d;
}

export function createFakeApi(data: FakeData = standardData()): FakeApi {
  const calls: string[] = [];

  async function hit<T>(method: string, arg: number | undefined, value: () => T): Promise<T> {
    const key = arg === undefined ? method : `${method}:${arg}`;
    calls.push(key);
    data.hooks[key]?.();
    data.hooks[method]?.();
    const err = data.fail[key] ?? data.fail[method];
    if (err) throw err;
    return structuredClone(value());
  }

  const api: IlearnApi = {
    activeSemesterCode: () => hit('activeSemesterCode', undefined, () => data.semester),
    myCourses: () => hit('myCourses', undefined, () => data.courses),
    course: (id) => hit('course', id, () => data.details[id] ?? (data.courses.find((c) => c.id === id) as ApiCourseDetail)),
    activities: (id) => hit('activities', id, () => data.activities[id] ?? []),
    homework: (id) => hit('homework', id, () => data.homework[id] ?? []),
    submissions: (activityId) => hit('submissions', activityId, () => data.submissions[activityId] ?? []),
    reads: (id) => hit('reads', id, () => data.reads[id] ?? []),
    exams: (id) => hit('exams', id, () => data.exams[id] ?? []),
    examScores: (id) => hit('examScores', id, () => data.examScores[id] ?? []),
    bulletins: (id) => hit('bulletins', id, () => data.bulletins[id] ?? []),
    courseScore: (id) => hit('courseScore', id, () => data.courseScore[id] ?? { total_score: null, published: false }),
    downloadUpload: (id) =>
      hit('downloadUpload', id, () => {
        const b = data.blobs[id];
        return b === undefined ? null : b;
      }).then((b) => (b === null ? new Response('missing', { status: 404 }) : new Response(b))),
  };

  return { api, data, calls, count: (prefix) => calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length };
}

/** 課程資訊頁 HTML；room 可替換教室。 */
export function courseViewHtml(room = 'M134'): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'course-view.html'), 'utf8').replace('M134', room);
}

export interface TestEnv {
  ctx: SyncContext;
  fake: FakeApi;
  root: string;
  db: DatabaseSync;
  outbox: Outbox;
  clock: { now: Date };
  html: { room: string; fail: boolean };
  events(): IlearnEvent[];
}

export function makeEnv(over: { data?: FakeData; config?: Partial<Config>; start?: string } = {}): TestEnv {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-sync-'));
  const db = openDb(':memory:');
  const outbox = new Outbox(root);
  const fake = createFakeApi(over.data ?? standardData());
  const clock = { now: new Date(over.start ?? '2026-10-22T04:00:00Z') }; // 12:00 Taipei
  const html = { room: 'M134', fail: false };
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), ...over.config };
  const ctx: SyncContext = {
    db,
    api: fake.api,
    fetchText: () => (html.fail ? Promise.reject(new Error('offline')) : Promise.resolve(courseViewHtml(html.room))),
    outbox,
    config,
    rules: DEFAULT_RULES,
    root,
    userId: 777,
    now: () => clock.now,
  };
  return { ctx, fake, root, db, outbox, clock, html, events: () => outbox.read() };
}
