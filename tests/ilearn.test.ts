import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthError, checkSession, login } from '../src/ilearn/auth.js';
import { ApiError, createApi } from '../src/ilearn/api.js';
import { courseViewUrl, parseCourseView, parseScheduleText } from '../src/ilearn/courseInfo.js';
import { createHttp } from '../src/ilearn/http.js';

const fx = (p: string): string => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const html = (body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...extra } });
const redirect = (location: string, extra: Record<string, string> = {}): Response =>
  new Response(null, { status: 302, headers: { location, ...extra } });
const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const KC_POST =
  'https://tcidentity.thu.edu.tw/auth/realms/thu/login-actions/authenticate?session_code=abc123&execution=exec-1&client_id=tronclass&tab_id=tab-9';
const PASSWORD = 'S3cret!pw';

interface Call { method: string; url: string; body: string | null; cookie: string | null }

function loginFetch(opts: { fail?: boolean; captcha?: boolean } = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let authed = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? String(init.body) : null,
      cookie: headers.get('cookie'),
    });
    if (url === 'https://ilearn.thu.edu.tw/login') {
      return redirect('https://tcidentity.thu.edu.tw/auth/realms/thu/protocol/cas/login?service=x', {
        'set-cookie': 'pre=1; Path=/',
      });
    }
    if (url.startsWith('https://tcidentity.thu.edu.tw/auth/realms/thu/protocol/cas/login')) {
      return html(opts.captcha ? fx('ilearn/keycloak-captcha.html') : fx('ilearn/keycloak-login.html'), {
        'set-cookie': 'KC=kc1; Path=/',
      });
    }
    if (url === KC_POST && init?.method === 'POST') {
      if (opts.fail) return html(fx('ilearn/keycloak-login.html').replace('value=""', 'value="帳號或密碼錯誤"'));
      return redirect('https://ilearn.thu.edu.tw/login?ticket=ST-x');
    }
    if (url === 'https://ilearn.thu.edu.tw/login?ticket=ST-x') {
      authed = true;
      return redirect('https://ilearn.thu.edu.tw/', { 'set-cookie': 'session=sess1; Path=/' });
    }
    if (url === 'https://ilearn.thu.edu.tw/') return html('home');
    if (url === 'https://ilearn.thu.edu.tw/api/profile') {
      return authed ? json({ id: 42 }) : new Response('{}', { status: 401 });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('login', () => {
  it('完成 CAS 流程並回傳 userId', async () => {
    const { fetchImpl, calls } = loginFetch();
    const http = createHttp({ fetchImpl });
    expect(await login(http, 'u123', PASSWORD)).toEqual({ userId: 42 });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(KC_POST);
    const params = new URLSearchParams(post?.body ?? '');
    expect(params.get('username')).toBe('u123');
    expect(params.get('password')).toBe(PASSWORD);
    expect(http.exportCookies()).toContain('sess1');
    // 跨 host 保留 cookie：Keycloak 的 POST 帶上 KC cookie
    expect(post?.cookie).toContain('KC=kc1');
  });

  it('錯誤密碼拋 bad_credentials，且訊息不含密碼', async () => {
    const { fetchImpl } = loginFetch({ fail: true });
    const http = createHttp({ fetchImpl });
    const err = await login(http, 'u123', PASSWORD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('bad_credentials');
    expect((err as AuthError).message).not.toContain(PASSWORD);
    expect(String((err as AuthError).stack)).not.toContain(PASSWORD);
  });

  it('出現 captcha / otp 欄位拋 captcha_required', async () => {
    const { fetchImpl } = loginFetch({ captcha: true });
    const err = await login(createHttp({ fetchImpl }), 'u', PASSWORD).catch((e: unknown) => e);
    expect((err as AuthError).code).toBe('captcha_required');
    expect((err as AuthError).message).not.toContain(PASSWORD);
  });

  it('網路錯誤拋 network 且不含密碼', async () => {
    const fetchImpl = (async () => {
      throw new Error(`boom ${PASSWORD}`);
    }) as typeof fetch;
    const err = await login(createHttp({ fetchImpl }), 'u', PASSWORD).catch((e: unknown) => e);
    expect((err as AuthError).code).toBe('network');
    expect((err as AuthError).message).not.toContain(PASSWORD);
  });

  it('checkSession：401 回 null，有效回 userId', async () => {
    const { fetchImpl } = loginFetch();
    const http = createHttp({ fetchImpl });
    expect(await checkSession(http)).toBeNull();
    await login(http, 'u', PASSWORD);
    expect(await checkSession(http)).toEqual({ userId: 42 });
  });

  it('checkSession：302 回 null', async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith('/api/profile') ? redirect('https://ilearn.thu.edu.tw/login') : html('<form></form>')) as typeof fetch;
    expect(await checkSession(createHttp({ fetchImpl }))).toBeNull();
  });

  it('exportCookies 可還原 session', async () => {
    const { fetchImpl } = loginFetch();
    const http = createHttp({ fetchImpl });
    await login(http, 'u', PASSWORD);
    const http2 = createHttp({ cookies: http.exportCookies(), fetchImpl });
    expect(await checkSession(http2)).toEqual({ userId: 42 });
  });
});

function apiWith(routes: Record<string, () => Response>): ReturnType<typeof createApi> {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    const r = routes[url.replace('https://ilearn.thu.edu.tw', '')];
    return r ? r() : new Response('nf', { status: 404 });
  }) as typeof fetch;
  return createApi(createHttp({ fetchImpl }));
}

describe('api', () => {
  it('activeSemesterCode', async () => {
    const api = apiWith({ '/api/semesters': () => json({ semesters: [{ name: '1150', is_active: false }, { name: '1151', is_active: true }] }) });
    expect(await api.activeSemesterCode()).toBe('115-1');
  });

  it('homework 合併分頁', async () => {
    const api = apiWith({
      '/api/courses/7/homework-activities?page=1&page_size=50': () => json(JSON.parse(fx('ilearn/homework-page1.json'))),
      '/api/courses/7/homework-activities?page=2&page_size=50': () => json(JSON.parse(fx('ilearn/homework-page2.json'))),
    });
    const hw = await api.homework(7);
    expect(hw.map((h) => h.id)).toEqual([1001, 1002]);
    expect(hw[1]?.submitted_status).toBe('makeUp');
  });

  it('非 2xx 拋 ApiError', async () => {
    const api = apiWith({ '/api/courses/9/activities': () => new Response('x', { status: 500 }) });
    const err = await api.activities(9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).path).toBe('/api/courses/9/activities');
  });

  it('其他端點取出包裹欄位', async () => {
    const api = apiWith({
      '/api/my-courses': () => json({ courses: [{ id: 1, name: '(1151_1)測試', course_code: '1151_1', semester: { code: '115-1' } }] }),
      '/api/courses/1/activities': () => json({ activities: [{ id: 5, type: 'material' }] }),
      '/api/activities/5/students/42/submission_list': () => json({ list: [{ id: 1 }] }),
      '/api/course/1/activity-reads-for-user': () => json({ activity_reads: [{ activity_id: 5, completeness: 'full' }] }),
      '/api/courses/1/exams': () => json({ exams: [{ id: 3 }] }),
      '/api/courses/1/exam-scores': () => json({ exam_scores: [{ activity_id: 3, score: 90 }] }),
      '/api/courses/1/bulletins': () => json({ bulletins: [{ id: 8 }] }),
      '/api/course/1/score': () => json({ total_score: null, bonus: 0, published: false }),
    });
    expect((await api.myCourses())[0]?.course_code).toBe('1151_1');
    expect((await api.activities(1))[0]?.id).toBe(5);
    expect(await api.submissions(5, 42)).toHaveLength(1);
    expect((await api.reads(1))[0]?.completeness).toBe('full');
    expect((await api.exams(1))[0]?.id).toBe(3);
    expect((await api.examScores(1))[0]?.score).toBe(90);
    expect((await api.bulletins(1))[0]?.id).toBe(8);
    expect(await api.courseScore(1)).toEqual({ total_score: null, published: false });
  });

  it('downloadUpload 跟隨轉址到 tcmedia', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/uploads/11/blob')) return redirect('https://tcmedia.thu.edu.tw/f/11');
      if (url === 'https://tcmedia.thu.edu.tw/f/11') return new Response('PDFDATA', { status: 200 });
      return new Response('nf', { status: 404 });
    }) as typeof fetch;
    const res = await createApi(createHttp({ fetchImpl })).downloadUpload(11);
    expect(await res.text()).toBe('PDFDATA');
  });
});

describe('courseInfo', () => {
  it('parseScheduleText', () => {
    expect(parseScheduleText('三/2,3,4[M134]')).toEqual([{ weekday: 3, periods: ['2', '3', '4'], room: 'M134' }]);
    expect(parseScheduleText('一/3,4[H101] 四/7[M134]')).toEqual([
      { weekday: 1, periods: ['3', '4'], room: 'H101' },
      { weekday: 4, periods: ['7'], room: 'M134' },
    ]);
    expect(parseScheduleText('日/1')).toEqual([{ weekday: 7, periods: ['1'], room: null }]);
    expect(parseScheduleText('')).toEqual([]);
  });

  it('courseViewUrl', () => {
    expect(courseViewUrl('1151_1236')).toBe('https://course.thu.edu.tw/view/115/1/1236');
    expect(courseViewUrl('labor1151all')).toBeNull();
  });

  it('parseCourseView 真實 DOM：badge 時段、評分表、忽略選課人數表', () => {
    const r = parseCourseView(fx('course-view.html'));
    expect(r.rawScheduleText).toBe('三/2,3,4[M134]');
    expect(r.schedule).toEqual([{ weekday: 3, periods: ['2', '3', '4'], room: 'M134' }]);
    expect(r.grading).toHaveLength(3);
    expect(r.grading.map((g) => g.percent)).toEqual([50, 20, 30]);
    expect(r.grading.reduce((n, g) => n + g.percent, 0)).toBe(100);
    expect(r.grading.map((g) => g.item)).not.toContain('2026-09-01');
  });

  it('parseCourseView 兩個 badge 得兩筆時段', () => {
    const h =
      '<div class="card"><h6>上課時間</h6><span class="badge">一/3,4[H101]</span><span class="badge">四/7[M134]</span></div>';
    const r = parseCourseView(h);
    expect(r.rawScheduleText).toBe('一/3,4[H101] 四/7[M134]');
    expect(r.schedule).toHaveLength(2);
  });

  it('parseCourseView 備援：th/td 相鄰格', () => {
    const r = parseCourseView('<table><tr><th>上課時間</th><td>五/1[A1]</td></tr></table>');
    expect(r.schedule).toEqual([{ weekday: 5, periods: ['1'], room: 'A1' }]);
  });

  it('parseCourseView 無資料時回空', () => {
    expect(parseCourseView('<html><body>x</body></html>')).toEqual({ schedule: [], rawScheduleText: '', grading: [] });
  });
});
