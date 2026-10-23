// 假的 iLearn API：只在 --mock 乾跑時使用，不連線。資料形狀與 tests/helpers/fakeApi.ts 相同。

export const MOCK_USERNAME = 'S99887766';
export const MOCK_PASSWORD = 'mock-pass-8812';
export const MOCK_USER_ID = 777;
/** 乾跑時固定的「現在」，讓假資料裡的截止日都在未來。 */
export const MOCK_NOW = new Date('2026-10-22T04:00:00Z');

function mockData() {
  const courses = [
    { id: 1, name: '資料結構', course_code: '1151_CS101', semester: { code: '115-1' } },
    { id: 2, name: '管理學', course_code: '1151_BA201', semester: { code: '115-1' } },
    { id: 9, name: '舊課程', course_code: '1142_OLD001', semester: { code: '114-2' } },
  ];
  const d = {
    semester: '115-1',
    courses,
    details: {},
    activities: {},
    homework: {},
    reads: {},
    exams: {},
    bulletins: {},
    blobs: { 5001: 'hw-description', 5002: 'lecture-1', 5003: 'intro' },
  };
  d.details[1] = { ...courses[0], course_outline: { common_fields: [{ key: 'grading', title: '評分方式', description: '期中 40% 期末 60%' }] } };
  d.details[2] = { ...courses[1], course_outline: { common_fields: [] } };
  d.activities[1] = [
    { id: 101, type: 'homework', title: '作業一', end_time: '2026-10-30T15:59:00Z', submit_by_group: false, published: true,
      uploads: [{ id: 5001, name: '作業一說明.pdf', size: 14, allow_download: true, link: null }] },
    { id: 102, type: 'material', title: '第一週講義', published: true,
      uploads: [{ id: 5002, name: '講義1.pdf', size: 9, allow_download: true, link: null }] },
    { id: 105, type: 'material', title: '老師關閉下載的教材', published: true,
      uploads: [{ id: 5004, name: '關閉下載.pdf', size: 20, allow_download: false, link: null }] },
    { id: 103, type: 'online_video', title: '第一週影片', end_time: '2026-11-30T15:59:00Z', published: true },
  ];
  d.homework[1] = [
    { id: 101, title: '作業一', end_time: '2026-10-30T15:59:00Z', submit_by_group: false, submitted: false,
      submitted_status: null, is_closed: false, score: null, score_published: false },
  ];
  d.exams[1] = [{ id: 301, title: '期中考', start_time: '2026-11-05T01:00:00Z', end_time: '2026-11-05T03:00:00Z' }];
  d.bulletins[1] = [
    { id: 88000, title: '歡迎修課', content: '<p>歡迎大家</p>', created_at: '2026-09-10T02:00:00Z',
      uploads: [{ id: 5003, name: '課程簡介.pdf', size: 5, allow_download: true, link: null }] },
  ];
  return d;
}

export function createMockApi() {
  const d = mockData();
  const ok = (v) => Promise.resolve(structuredClone(v));
  return {
    activeSemesterCode: () => ok(d.semester),
    myCourses: () => ok(d.courses),
    course: (id) => ok(d.details[id] ?? d.courses.find((c) => c.id === id)),
    activities: (id) => ok(d.activities[id] ?? []),
    homework: (id) => ok(d.homework[id] ?? []),
    submissions: () => ok([]),
    reads: (id) => ok(d.reads[id] ?? []),
    exams: (id) => ok(d.exams[id] ?? []),
    examScores: () => ok([]),
    bulletins: (id) => ok(d.bulletins[id] ?? []),
    courseScore: () => ok({ total_score: null, published: false }),
    downloadUpload: (id) => {
      const b = d.blobs[id];
      return Promise.resolve(b === undefined ? new Response('missing', { status: 404 }) : new Response(b));
    },
  };
}
