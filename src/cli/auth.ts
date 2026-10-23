import {
  chooseBackend,
  deleteCredentials,
  loadPassword,
  loadSession,
  saveSession,
  type CredentialBackend,
} from '../auth/credentials.js';
import { saveConfig } from '../config/config.js';
import { makeEvent } from '../events/outbox.js';
import { ApiError, createApi } from '../ilearn/api.js';
import { checkSession, login } from '../ilearn/auth.js';
import { createHttp } from '../ilearn/http.js';
import { toTaipeiIso } from '../time.js';
import { CliExit, removeAccount, writeAccount, type CliContext } from './context.js';

export const LOGIN_HINT = '請執行 ilearn login 重新登入';

export function backendFor(ctx: CliContext): CredentialBackend {
  return ctx.config.password_saved ? chooseBackend(ctx.config.environment) : 'none';
}

/** 登入並保存 session 與學號；成功後 ctx.api 改用新 session。 */
export async function loginWith(ctx: CliContext, username: string, password: string): Promise<void> {
  if (ctx.auth) return ctx.auth.login(ctx, username, password);
  const http = createHttp({});
  const { userId } = await login(http, username, password);
  saveSession(ctx.root, http.exportCookies());
  writeAccount(ctx.root, { username, user_id: userId });
  const api = createApi(http);
  ctx.api = ctx.wrapApi ? ctx.wrapApi(api) : api;
  ctx.userId = userId;
  ctx.username = username;
  ctx.sessionPresent = true;
}

async function defaultRelogin(ctx: CliContext): Promise<boolean> {
  if (ctx.username === null) return false;
  try {
    const pw = await loadPassword(ctx.root, backendFor(ctx), ctx.username);
    if (pw === null) return false;
    await loginWith(ctx, ctx.username, pw);
    return true;
  } catch {
    // 驗證碼、密碼已變更或網路問題都視為無法自動重新登入
    return false;
  }
}

/** 已保存的 session 是否仍可用；沒有 session、網路不通都視為不可用。 */
export async function savedSessionUser(ctx: CliContext): Promise<{ userId: number } | null> {
  if (ctx.auth) return ctx.auth.sessionUser(ctx);
  const cookies = loadSession(ctx.root);
  if (cookies === null || ctx.username === null) return null;
  try {
    return await checkSession(createHttp({ cookies }));
  } catch {
    return null;
  }
}

export async function logout(ctx: CliContext): Promise<void> {
  await deleteCredentials(ctx.root, ctx.username ?? '');
  removeAccount(ctx.root);
  ctx.config.password_saved = false;
  saveConfig(ctx.config, ctx.root);
  ctx.username = null;
  ctx.sessionPresent = false;
}

function is401(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

function expired(ctx: CliContext): CliExit {
  const now = ctx.now();
  const day = toTaipeiIso(now).slice(0, 10);
  const appended = ctx.outbox.append(
    makeEvent({
      type: 'auth.expired',
      delivery: 'push',
      categories: [],
      matched_rules: [],
      course: null,
      item: null,
      summary: `iLearn 登入已過期，${LOGIN_HINT}`,
      dedupe_key: `auth.expired:${day}`,
      detectedAt: now,
      quiet: ctx.config.quiet_hours,
    }),
  );
  if (appended) ctx.outbox.renderMarkdown();
  return new CliExit(2, `iLearn 登入已過期，${LOGIN_HINT}`);
}

/**
 * 執行需要登入的工作。遇到 401（或根本沒有 session）時，若有保存密碼就自動重新登入一次並重試；
 * 否則推送 auth.expired 並以 exit code 2 結束。
 */
export async function withAuth<T>(ctx: CliContext, fn: () => Promise<T>): Promise<T> {
  const relogin = ctx.relogin ?? defaultRelogin;
  if (!ctx.sessionPresent) {
    if (!(await relogin(ctx))) throw expired(ctx);
  }
  try {
    return await fn();
  } catch (e) {
    if (!is401(e)) throw e;
  }
  if (!(await relogin(ctx))) throw expired(ctx);
  try {
    return await fn();
  } catch (e) {
    if (is401(e)) throw expired(ctx);
    throw e;
  }
}
