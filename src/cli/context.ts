import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { loadSession } from '../auth/credentials.js';
import { loadConfig } from '../config/config.js';
import { dataRoot, ensureDir, writeSecureFile } from '../config/paths.js';
import { openDb } from '../db/schema.js';
import { Outbox } from '../events/outbox.js';
import { createApi, type IlearnApi } from '../ilearn/api.js';
import { createHttp } from '../ilearn/http.js';
import { DEFAULT_RULES, type Rule } from '../rules/engine.js';
import { parseRulesYaml } from '../rules/yaml.js';
import type { SyncContext } from '../sync/sync.js';

/** 中止指令並指定 exit code；訊息會印到 stderr。 */
export class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CliExit';
  }
}

/** 測試或裝置測試腳本用：取代真實的登入與 session 檢查（不連線）。 */
export interface AuthHooks {
  login: (ctx: CliContext, username: string, password: string) => Promise<void>;
  sessionUser: (ctx: CliContext) => Promise<{ userId: number } | null>;
}

export interface CliContext extends SyncContext {
  username: string | null;
  /** 是否已有可用的 session（測試以假 API 注入時視為有）。 */
  sessionPresent: boolean;
  /** 重新登入時替換 api 的包裝（設定精靈用來支援 Ctrl-C 中止）。 */
  wrapApi?: (api: IlearnApi) => IlearnApi;
  /** 以已保存密碼重新登入；測試可覆寫。 */
  relogin?: (ctx: CliContext) => Promise<boolean>;
  /** 有設定時，loginWith 與 savedSessionUser 改走這裡，不連線。 */
  auth?: AuthHooks;
  rulesWarning?: string;
}

export interface ContextOverrides {
  api: IlearnApi;
  fetchText: (url: string) => Promise<string>;
  now: () => Date;
  root: string;
  userId: number;
  relogin: (ctx: CliContext) => Promise<boolean>;
  auth: AuthHooks;
}

interface Account {
  username: string;
  user_id?: number;
}

const accountPath = (root: string): string => join(root, 'data', 'account.json');
export const rulesPath = (root: string): string => join(root, 'rules.yaml');
const lastGoodRulesPath = (root: string): string => join(root, 'data', 'rules.lastgood.yaml');

export function readAccount(root: string): Account | null {
  const p = accountPath(root);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, 'utf8')) as Partial<Account>;
    return typeof a.username === 'string' && a.username !== ''
      ? { username: a.username, ...(typeof a.user_id === 'number' ? { user_id: a.user_id } : {}) }
      : null;
  } catch {
    return null;
  }
}

export function writeAccount(root: string, a: Account): void {
  writeSecureFile(accountPath(root), JSON.stringify(a));
}

export function removeAccount(root: string): void {
  rmSync(accountPath(root), { force: true });
}

/** 讀 rules.yaml；寫錯時沿用上一份有效規則，沒有就用內建預設。 */
export function loadRules(root: string): { rules: Rule[]; warning?: string } {
  const p = rulesPath(root);
  if (!existsSync(p)) return { rules: DEFAULT_RULES };
  const parsed = parseRulesYaml(readFileSync(p, 'utf8'));
  if (parsed.ok) {
    try {
      copyFileSync(p, lastGoodRulesPath(root));
      chmodSync(lastGoodRulesPath(root), 0o600);
    } catch {
      // 備份失敗不影響使用
    }
    return { rules: parsed.rules };
  }
  const where = parsed.line !== null ? `第 ${parsed.line} 行：` : '';
  const warning = `rules.yaml 無效（${where}${parsed.error}），改用上一份有效規則`;
  if (existsSync(lastGoodRulesPath(root))) {
    const last = parseRulesYaml(readFileSync(lastGoodRulesPath(root), 'utf8'));
    if (last.ok) return { rules: last.rules, warning };
  }
  return { rules: DEFAULT_RULES, warning };
}

/** 重新讀取 config.yaml 與規則（daemon 每輪使用）。 */
export function reloadSettings(ctx: CliContext): void {
  ctx.config = loadConfig(ctx.root);
  const r = loadRules(ctx.root);
  ctx.rules = r.rules;
  if (r.warning !== undefined) ctx.rulesWarning = r.warning;
  else delete ctx.rulesWarning;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const NOT_SET_UP = '尚未設定，請先執行 ilearn setup';

/** 已設定 = data/account.json 存在。 */
export function isSetUp(root: string): boolean {
  return existsSync(accountPath(root));
}

function build(root: string, db: DatabaseSync, outbox: Outbox, o: Partial<ContextOverrides>): CliContext {
  const config = loadConfig(root);
  const rules = loadRules(root);
  const account = readAccount(root);
  const cookies = loadSession(root);
  const api = o.api ?? createApi(createHttp(cookies !== null ? { cookies } : {}));

  const ctx: CliContext = {
    db,
    api,
    fetchText: o.fetchText ?? defaultFetchText,
    outbox,
    config,
    rules: rules.rules,
    root,
    userId: o.userId ?? account?.user_id ?? 0,
    now: o.now ?? ((): Date => new Date()),
    username: account?.username ?? null,
    sessionPresent: o.api !== undefined || cookies !== null,
  };
  if (rules.warning !== undefined) ctx.rulesWarning = rules.warning;
  if (o.relogin !== undefined) ctx.relogin = o.relogin;
  if (o.auth !== undefined) ctx.auth = o.auth;
  return ctx;
}

export function createContext(o: Partial<ContextOverrides> = {}): CliContext {
  const root = o.root ?? dataRoot();
  ensureDir(root);
  ensureDir(join(root, 'data'));
  const dbFile = join(root, 'data', 'ilearn.sqlite3');
  const db = openDb(dbFile);
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    if (existsSync(f)) chmodSync(f, 0o600);
  }
  return build(root, db, new Outbox(root), o);
}

/** 需要已設定帳號的指令使用：未設定時直接 exit code 2，不建立任何檔案或事件。 */
export function createSetUpContext(o: Partial<ContextOverrides> = {}): CliContext {
  const root = o.root ?? dataRoot();
  if (!isSetUp(root)) throw new CliExit(2, NOT_SET_UP);
  return createContext({ ...o, root });
}

/**
 * 查詢指令使用：資料庫還不存在時改用記憶體資料庫與暫時的 outbox，
 * 結果為空，且不會在資料目錄建立任何東西。
 */
export function createReadContext(o: Partial<ContextOverrides> = {}): CliContext {
  const root = o.root ?? dataRoot();
  if (existsSync(join(root, 'data', 'ilearn.sqlite3'))) return createContext({ ...o, root });
  const tmp = mkdtempSync(join(tmpdir(), 'ilearn-empty-'));
  process.once('exit', () => rmSync(tmp, { recursive: true, force: true }));
  return build(root, openDb(':memory:'), new Outbox(tmp), { ...o, root });
}

export function absPath(root: string, rel: string | null): string | null {
  return rel === null ? null : join(root, rel);
}
