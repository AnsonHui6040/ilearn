import type { HttpClient } from './http.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
  ) {
    super(`iLearn API ${status}: ${path}`);
    this.name = 'ApiError';
  }
}

export interface ApiUpload {
  id: number;
  reference_id?: number | null;
  name: string;
  type?: string;
  size?: number | null;
  allow_download?: boolean;
  link?: string | null;
}

export interface ApiCourse {
  id: number;
  name: string;
  course_code: string;
  semester: { code: string; id?: number };
  instructors?: { name?: string }[];
  department?: { name?: string } | null;
}

export interface ApiCourseDetail extends ApiCourse {
  course_outline?: {
    status?: string;
    external_url?: string | null;
    common_fields?: { key: string; title: string; description: string | null }[];
  } | null;
}

export interface ApiActivity {
  id: number;
  type: string;
  title: string;
  start_time?: string | null;
  end_time?: string | null;
  deadline?: string | null;
  published?: boolean;
  submit_by_group?: boolean;
  uploads?: ApiUpload[];
  data?: Record<string, unknown>;
}

export interface ApiHomework {
  id: number;
  title: string;
  end_time: string | null;
  submit_by_group: boolean;
  submitted: boolean;
  submitted_status: string | null;
  user_submit_count?: number;
  need_make_up?: boolean;
  is_closed: boolean;
  score: number | null;
  score_published: boolean;
}

export interface ApiSubmission {
  id: number;
  submitted_at?: string | null;
  is_draft?: boolean;
  is_redo?: boolean;
  created_by?: { id: number } | null;
  uploads?: (ApiUpload & { created_by_id?: number | null })[];
  score?: number | null;
  final_score?: number | null;
  instructor_comment?: string | null;
  submission_correct?: { comment?: string | null; score?: number | null } | null;
}

export interface ApiRead {
  activity_id: number;
  activity_type?: string;
  completeness: 'full' | 'part' | string;
  last_visited_at?: string | null;
}

export interface ApiExam {
  id: number;
  title: string;
  start_time: string | null;
  end_time: string | null;
  is_started?: boolean;
  is_closed?: boolean;
  submit_times?: number;
}

export interface ApiBulletin {
  id: number;
  title: string;
  content: string;
  created_at: string;
  updated_at?: string | null;
  uploads?: ApiUpload[];
}

export interface IlearnApi {
  activeSemesterCode(): Promise<string>;
  myCourses(): Promise<ApiCourse[]>;
  course(id: number): Promise<ApiCourseDetail>;
  activities(courseId: number): Promise<ApiActivity[]>;
  homework(courseId: number): Promise<ApiHomework[]>;
  submissions(activityId: number, userId: number): Promise<ApiSubmission[]>;
  reads(courseId: number): Promise<ApiRead[]>;
  exams(courseId: number): Promise<ApiExam[]>;
  examScores(courseId: number): Promise<{ activity_id: number; score: number | null }[]>;
  bulletins(courseId: number): Promise<ApiBulletin[]>;
  courseScore(courseId: number): Promise<{ total_score: string | null; published: boolean }>;
  downloadUpload(uploadId: number): Promise<Response>;
}

/** 學校 CAS（tcidentity）的登入頁網址。 */
function isLoginPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'tcidentity.thu.edu.tw' || u.pathname.includes('/protocol/cas/login');
  } catch {
    return false;
  }
}

const PAGE_SIZE = 50;
const MAX_PAGES = 100;

export function createApi(http: HttpClient, base = 'https://ilearn.thu.edu.tw'): IlearnApi {
  async function raw(path: string): Promise<Response> {
    const res = await http.get(base + path);
    // session 過期時 iLearn 不回 401，而是轉址到學校 CAS 登入頁
    if (isLoginPage(res.url)) {
      await res.body?.cancel();
      throw new ApiError(401, path);
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel();
      throw new ApiError(res.status, path);
    }
    return res;
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await (await raw(path)).json()) as T;
  }

  return {
    async activeSemesterCode() {
      const { semesters } = await getJson<{ semesters: { name: string; is_active: boolean }[] }>('/api/semesters');
      const active = semesters.find((s) => s.is_active);
      const m = active && /^(\d{3})(\d)$/.exec(active.name);
      if (!m) throw new ApiError(200, '/api/semesters');
      return `${m[1]}-${m[2]}`;
    },
    async myCourses() {
      return (await getJson<{ courses: ApiCourse[] }>('/api/my-courses')).courses;
    },
    course: (id) => getJson<ApiCourseDetail>(`/api/courses/${id}`),
    async activities(courseId) {
      return (await getJson<{ activities: ApiActivity[] }>(`/api/courses/${courseId}/activities`)).activities;
    },
    async homework(courseId) {
      const all: ApiHomework[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await getJson<{ homework_activities: ApiHomework[]; page?: number; pages?: number }>(
          `/api/courses/${courseId}/homework-activities?page=${page}&page_size=${PAGE_SIZE}`,
        );
        all.push(...r.homework_activities);
        if (!r.pages || page >= r.pages) break;
      }
      return all;
    },
    async submissions(activityId, userId) {
      return (await getJson<{ list: ApiSubmission[] }>(`/api/activities/${activityId}/students/${userId}/submission_list`)).list;
    },
    async reads(courseId) {
      return (await getJson<{ activity_reads: ApiRead[] }>(`/api/course/${courseId}/activity-reads-for-user`)).activity_reads;
    },
    async exams(courseId) {
      return (await getJson<{ exams: ApiExam[] }>(`/api/courses/${courseId}/exams`)).exams;
    },
    async examScores(courseId) {
      return (await getJson<{ exam_scores: { activity_id: number; score: number | null }[] }>(`/api/courses/${courseId}/exam-scores`))
        .exam_scores;
    },
    async bulletins(courseId) {
      return (await getJson<{ bulletins: ApiBulletin[] }>(`/api/courses/${courseId}/bulletins`)).bulletins;
    },
    async courseScore(courseId) {
      const r = await getJson<{ total_score: string | null; published: boolean }>(`/api/course/${courseId}/score`);
      return { total_score: r.total_score, published: r.published };
    },
    downloadUpload: (uploadId) => raw(`/api/uploads/${uploadId}/blob`),
  };
}
