import { CookieJar } from 'tough-cookie';

export interface HttpClient {
  get(url: string): Promise<Response>;
  postForm(url: string, form: Record<string, string>): Promise<Response>;
  /** 序列化 cookie jar（含 session），僅供存入受保護的本機檔案 */
  exportCookies(): string;
}

const MAX_REDIRECTS = 15;
const TIMEOUT_MS = 30_000;
const UA = 'thu-ilearn/0.1 (+https://github.com/AnsonHui6040/thu-ilearn)';

function restoreJar(cookies: string | undefined): CookieJar {
  if (cookies) {
    try {
      return CookieJar.deserializeSync(cookies);
    } catch {
      // 壞掉的 cookie 檔視同沒有 session
    }
  }
  return new CookieJar();
}

export function createHttp(opts: { cookies?: string; fetchImpl?: typeof fetch }): HttpClient {
  const jar = restoreJar(opts.cookies);
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(startUrl: string, startInit: { method: string; body?: string }): Promise<Response> {
    let url = startUrl;
    let method = startInit.method;
    let body = startInit.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { 'user-agent': UA, accept: '*/*' };
      const cookie = await jar.getCookieString(url);
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
      const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
      if (body !== undefined) init.body = body;
      const res = await doFetch(url, init);
      for (const sc of res.headers.getSetCookie()) {
        try {
          await jar.setCookie(sc, url);
        } catch {
          // 無效 cookie 略過
        }
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  }

  return {
    get: (url) => request(url, { method: 'GET' }),
    postForm: (url, form) => request(url, { method: 'POST', body: new URLSearchParams(form).toString() }),
    exportCookies: () => JSON.stringify(jar.serializeSync()),
  };
}
