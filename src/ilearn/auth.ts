import * as cheerio from 'cheerio';
import type { HttpClient } from './http.js';

const BASE = 'https://ilearn.thu.edu.tw';

export class AuthError extends Error {
  constructor(
    public code: 'bad_credentials' | 'captcha_required' | 'network' | 'unexpected',
    msg: string,
  ) {
    super(msg);
    this.name = 'AuthError';
  }
}

export async function checkSession(http: HttpClient): Promise<{ userId: number } | null> {
  const res = await http.get(`${BASE}/api/profile`);
  if (res.status !== 200) {
    await res.body?.cancel();
    return null;
  }
  try {
    const data = (await res.json()) as { id?: unknown };
    return typeof data.id === 'number' ? { userId: data.id } : null;
  } catch {
    return null;
  }
}

interface LoginForm {
  action: string;
  captcha: boolean;
  errorMessage: string;
}

function parseLoginForm(html: string): LoginForm | null {
  const $ = cheerio.load(html);
  const pw = $('input[name="password"]').first();
  if (pw.length === 0) return null;
  const form = pw.closest('form');
  const action = form.attr('action');
  if (!action) return null;
  const captcha = $('input')
    .toArray()
    .some((el) => /captcha|otp/i.test(`${$(el).attr('name') ?? ''} ${$(el).attr('id') ?? ''}`));
  // 不讀 #request_error_message：學校每個登入頁都有這個固定字串，不是失敗原因
  let errorMessage = '';
  for (const sel of ['#input-error', '.kc-feedback-text', '.alert-error', '.alert-warning', '.info-group']) {
    const text = $(sel).first().text().replace(/\s+/g, ' ').trim();
    if (text) {
      errorMessage = text.slice(0, 200);
      break;
    }
  }
  return { action, captcha, errorMessage };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // 不轉述原始錯誤訊息，避免夾帶請求內容
    throw new AuthError('network', '無法連線到 iLearn 或登入伺服器');
  }
}

export async function login(http: HttpClient, username: string, password: string): Promise<{ userId: number }> {
  return guarded(async () => {
    const first = await http.get(`${BASE}/login`);
    const firstForm = parseLoginForm(await first.text());
    if (!firstForm) {
      const existing = await checkSession(http);
      if (existing) return existing;
      throw new AuthError('unexpected', '找不到登入表單');
    }
    if (firstForm.captcha) throw new AuthError('captcha_required', '登入頁要求驗證碼或雙重驗證，請改用瀏覽器登入');

    const res = await http.postForm(firstForm.action, { username, password });
    const after = parseLoginForm(await res.text());
    if (after) {
      if (after.captcha) throw new AuthError('captcha_required', '登入頁要求驗證碼或雙重驗證，請改用瀏覽器登入');
      throw new AuthError('bad_credentials', after.errorMessage || '帳號或密碼錯誤，或登入伺服器暫時無法處理');
    }
    const session = await checkSession(http);
    if (!session) throw new AuthError('unexpected', '登入流程結束但未取得有效 session');
    return session;
  });
}
