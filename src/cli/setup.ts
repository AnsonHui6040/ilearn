import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { chooseBackend, savePassword, VPS_RISK_WARNING } from '../auth/credentials.js';
import { saveConfig, type Config } from '../config/config.js';
import { writeSecureFile } from '../config/paths.js';
import { getSyncState, listFiles, listItems } from '../db/repo.js';
import { AuthError } from '../ilearn/auth.js';
import { webhookUrlError } from '../events/dispatch.js';
import { stringifyRules } from '../rules/yaml.js';
import type { SyncProgress, SyncReport } from '../sync/sync.js';
import { toTaipeiIso } from '../time.js';
import { backendFor, loginWith, savedSessionUser } from './auth.js';
import { abortableApi, syncCommand, type SyncOutcome } from './commands/sync.js';
import { CliExit, rulesPath, type CliContext } from './context.js';

/* ---------- 純函式 ---------- */

export const KEYS_HELP_CHECKBOX = '↑↓ 移動 Move  Space 剔選 Select  a 全選 All  i 反選 Invert  Enter 確認 Confirm';
export const KEYS_HELP_SELECT = '↑↓ 移動 Move  Enter 確認 Confirm';

const checkboxTheme = { style: { keysHelpTip: (): string => KEYS_HELP_CHECKBOX } };
const selectTheme = { style: { keysHelpTip: (): string => KEYS_HELP_SELECT } };

const RULE = '─'.repeat(30);

export function stepHeader(n: number, total: number, title: string): string {
  return `${RULE}\n步驟 ${n}\uFF0F${total}\u3000${title}\n${RULE}`;
}

export interface SetupDefaults {
  environment: 'desktop' | 'vps';
  folder: boolean;
  passwordSaved: boolean;
  materials: string[];
  announcements: string[];
}

/** 重跑設定精靈時的預設值：有舊設定就沿用，沒有就用偵測結果。 */
export function setupDefaults(config: Config | null, detectedEnv: 'desktop' | 'vps'): SetupDefaults {
  if (config === null) {
    return { environment: detectedEnv, folder: detectedEnv === 'vps', passwordSaved: false, materials: [], announcements: [] };
  }
  const entries = Object.entries(config.summaries.courses);
  return {
    environment: config.environment,
    folder: config.interfaces.folder,
    passwordSaved: config.password_saved,
    materials: entries.filter(([, v]) => v.materials).map(([id]) => id),
    announcements: entries.filter(([, v]) => v.announcements).map(([id]) => id),
  };
}

/**
 * SSH 連線中一律視為 VPS；Linux 沒有圖形介面（DISPLAY、WAYLAND_DISPLAY 皆無）也視為 VPS。
 * macOS 與 Windows 本來就不設 DISPLAY，一律視為桌面。使用者可在精靈中更改。
 */
export function detectEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): 'desktop' | 'vps' {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'vps';
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'vps';
  return 'desktop';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatProgress(p: SyncProgress): string {
  return `課程 ${p.coursesDone}/${p.coursesTotal}，檔案 ${p.filesDone}/${p.filesTotal}，已下載 ${formatBytes(p.bytes)}`;
}

export function formatFetchDone(initial: boolean, p: SyncProgress): string {
  const head = initial ? '首次提取完成' : '背景同步完成';
  return `✔ ${head}：課程 ${p.coursesDone}/${p.coursesTotal}、檔案 ${p.filesDone}/${p.filesTotal}（${formatBytes(p.bytes)}）`;
}

const yn = (v: boolean): string => (v ? 'Y' : 'N');

export const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:8787/ilearn';

export function deliverySummary(d: Config['delivery']): string {
  const parts = ['outbox 檔案'];
  if (d.hook.enabled) parts.push(`本機指令 hook（${d.hook.command}）`);
  if (d.webhook.enabled) parts.push(`本機 webhook（${d.webhook.url}）`);
  return parts.join('、');
}

const shortTime = (iso: string): string => iso.slice(5, 16).replace('T', ' ');

export interface SummaryExtras {
  assignments?: { open: number; notYetOpen: number; overdue: number; overdueTeammate: number };
  files?: { done: number; doneBytes: number; skipped: number; links: number };
  exams?: { title: string; start_at: string }[];
}

function formatSize(n: number): string {
  const mb = n / 1024 / 1024;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** 從資料庫算出完成摘要需要的分項數字。 */
export function summaryExtras(db: DatabaseSync, now: Date): SummaryExtras {
  const t0 = now.getTime();
  const assignments = { open: 0, notYetOpen: 0, overdue: 0, overdueTeammate: 0 };
  for (const it of listItems(db, { kind: 'assignment' })) {
    if (it.completion !== 'pending') continue;
    if (it.start_at !== null && Date.parse(it.start_at) > t0) assignments.notYetOpen++;
    else if (it.due_at !== null && Date.parse(it.due_at) < t0) {
      assignments.overdue++;
      if (it.teammate_hint) assignments.overdueTeammate++;
    } else assignments.open++;
  }
  const doneFiles = listFiles(db, { status: 'done' });
  const files = {
    done: doneFiles.length,
    doneBytes: doneFiles.reduce((a, f) => a + f.size, 0),
    skipped: listFiles(db, { status: 'skipped' }).length,
    links: listFiles(db, { status: 'link' }).length,
  };
  const exams = listItems(db, { kind: 'exam' })
    .filter((e) => e.start_at !== null && Date.parse(e.start_at) > t0 && Date.parse(e.start_at) <= t0 + 3 * 86400_000)
    .map((e) => ({ title: e.title, start_at: toTaipeiIso(new Date(e.start_at as string)) }));
  return { assignments, files, exams };
}

export function formatSummary(report: SyncReport, extras: SummaryExtras = {}): string {
  const lines: string[] = [];
  lines.push(report.initial ? '首次同步完成' : '同步完成');
  lines.push(`課程數：${report.courses}`);
  const a = extras.assignments;
  if (a) {
    const team = a.overdueTeammate > 0 ? `（其中 ${a.overdueTeammate} 份系統顯示隊員已交）` : '';
    lines.push(`未完成作業：進行中 ${a.open}、尚未開放 ${a.notYetOpen}、逾期 ${a.overdue}${team}`);
  } else {
    lines.push(`未完成作業：${report.pendingAssignments}`);
  }
  if (report.upcoming3d.length === 0 && (extras.exams ?? []).length === 0) {
    lines.push('3 日內截止或考試：沒有');
  } else {
    lines.push('3 日內截止或考試：');
    for (const a of report.upcoming3d) lines.push(`  作業 ${a.title}，截止 ${shortTime(a.due_at)}`);
    for (const e of extras.exams ?? []) lines.push(`  考試 ${e.title}，${shortTime(e.start_at)}`);
  }
  const f = extras.files;
  if (f) {
    const parts = [`已下載 ${f.done} 個（${formatSize(f.doneBytes)}）`];
    if (f.skipped > 0) parts.push(`略過 ${f.skipped} 個（老師關閉下載）`);
    if (f.links > 0) parts.push(`外部連結 ${f.links} 個`);
    lines.push(`檔案：${parts.join('、')}`);
  }
  if (report.filesFailed.length === 0) {
    lines.push('下載失敗：沒有');
  } else {
    lines.push(`下載失敗：${report.filesFailed.length} 個`);
    for (const f of report.filesFailed) lines.push(`  ${f.name}（${f.reason}）`);
  }
  if (report.incompleteCourses.length > 0) {
    lines.push(`資料可能不完整的課程：${report.incompleteCourses.join('、')}，下次同步會再試`);
  }
  return lines.join('\n');
}

function loginFailureText(e: unknown): string {
  if (e instanceof AuthError) {
    switch (e.code) {
      case 'bad_credentials':
        return `登入失敗：${e.message}`;
      case 'captcha_required':
        return `登入失敗，${e.message}`;
      case 'network':
        return `登入失敗，網路不通：${e.message}`;
      default:
        return `登入失敗：${e.message}`;
    }
  }
  return `登入失敗：${e instanceof Error ? e.message : String(e)}`;
}

const say = (s = ''): void => void process.stdout.write(`${s}\n`);

/* ---------- 互動流程 ---------- */

type Prompts = typeof import('@inquirer/prompts');

const TOTAL_STEPS = 8;
const header = (n: number, title: string): void => say(stepHeader(n, TOTAL_STEPS, title));
const ok = (text: string): void => {
  say(`✔ ${text}`);
  say();
};
/** 只在確實寫入磁碟之後呼叫。 */
const saved = (text: string): void => ok(`已儲存：${text}`);

async function promptCredentials(
  ctx: CliContext,
  p: Prompts,
): Promise<{ username: string; password: string }> {
  for (;;) {
    const username = (await p.input({ message: '學號', ...(ctx.username ? { default: ctx.username } : {}) })).trim();
    const password = await p.password({ message: 'iLearn 密碼（輸入時不會顯示）' });
    try {
      await loginWith(ctx, username, password);
      return { username, password };
    } catch (e) {
      say(loginFailureText(e));
      if (!(await p.confirm({ message: '要重新輸入嗎？', default: true, transformer: yn }))) throw new CliExit(1, '已取消設定');
    }
  }
}

async function askSavePassword(
  ctx: CliContext,
  p: Prompts,
  username: string,
  password: string,
  defaultSave: boolean,
): Promise<void> {
  if (ctx.config.environment === 'vps') {
    say(`提醒：${VPS_RISK_WARNING}`);
  }
  const save = await p.confirm({ message: '要保存密碼，讓 session 過期時自動重新登入嗎？', default: defaultSave, transformer: yn });
  ctx.config.password_saved = false;
  let note = '不保存密碼，只保存 session';
  if (save) {
    const backend = chooseBackend(ctx.config.environment);
    try {
      await savePassword(ctx.root, backend, username, password);
      ctx.config.password_saved = true;
      note = backend === 'keychain' ? '密碼存入系統憑證庫' : '密碼存入加密檔';
    } catch (e) {
      say(`${e instanceof Error ? e.message : '無法保存密碼'}，改為只保存 session`);
      note = '沒有保存密碼，只保存 session';
    }
  }
  saveConfig(ctx.config, ctx.root);
  saved(note);
}

/** ilearn login：重新登入；若已保存密碼則一併更新。 */
export async function runLogin(ctx: CliContext): Promise<void> {
  const p = await import('@inquirer/prompts');
  const { username, password } = await promptCredentials(ctx, p);
  if (ctx.config.password_saved) {
    try {
      await savePassword(ctx.root, backendFor(ctx), username, password);
    } catch (e) {
      say(`${e instanceof Error ? e.message : '無法更新已保存的密碼'}`);
    }
  }
  say('登入成功，session 已更新');
}

function isPromptExit(e: unknown): boolean {
  return e instanceof Error && e.name === 'ExitPromptError';
}

export async function runSetup(ctx: CliContext): Promise<void> {
  const p = await import('@inquirer/prompts');
  const hadConfig = existsSync(join(ctx.root, 'config.yaml'));
  const d = setupDefaults(hadConfig ? ctx.config : null, detectEnvironment(process.env));
  say('thu-ilearn 設定精靈');
  say('本工具為非官方工具，資料只存在這台電腦，使用前請自行查閱學校資訊使用規範。');
  say();

  // 步驟 1：環境
  header(1, '執行環境');
  ctx.config.environment = await p.select({
    message: '目前的執行環境',
    choices: [
      { name: '本機桌面（有圖形介面）', value: 'desktop' as const },
      { name: 'VPS 或雲端主機（無圖形介面）', value: 'vps' as const },
    ],
    default: d.environment,
    theme: selectTheme,
  });
  saveConfig(ctx.config, ctx.root);
  saved(ctx.config.environment === 'vps' ? 'VPS 或雲端主機' : '本機桌面');

  // 步驟 2、3：登入與密碼
  header(2, '登入 iLearn');
  let reuse = false;
  const existing = await savedSessionUser(ctx);
  if (existing !== null && ctx.username !== null) {
    reuse = await p.confirm({ message: `目前已登入（學號 ${ctx.username}），要沿用這次登入嗎？`, default: true, transformer: yn });
    if (reuse) ctx.userId = existing.userId;
  }
  if (reuse) {
    ok('沿用目前登入');
    header(3, '保存密碼');
    ok('沿用目前設定');
  } else {
    await promptCredentials(ctx, p).then(async ({ username, password }) => {
      ok('已登入');
      header(3, '保存密碼');
      await askSavePassword(ctx, p, username, password, d.passwordSaved);
    });
  }

  // 首次提取在背景進行
  const ac = new AbortController();
  ctx.api = abortableApi(ctx.api, ac.signal);
  ctx.wrapApi = (api) => abortableApi(api, ac.signal);
  const wasCompleted = getSyncState(ctx.db).initial_completed;
  let printing = false;
  let lastProgress: SyncProgress = { coursesDone: 0, coursesTotal: 0, filesDone: 0, filesTotal: 0, bytes: 0 };
  const settled: Promise<{ ok: true; outcome: SyncOutcome } | { ok: false; error: unknown }> = syncCommand(ctx, {
    force: true,
    onProgress: (pr) => {
      lastProgress = pr;
      if (printing) process.stderr.write(`\r${formatProgress(pr)}   `);
    },
  }).then(
    (outcome) => ({ ok: true as const, outcome }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const onSigint = (): void => {
    if (ac.signal.aborted) process.exit(130);
    ac.abort();
    say('\n已中斷，下次執行 ilearn sync 會從中斷處繼續');
  };
  process.on('SIGINT', onSigint);
  say(wasCompleted ? '背景同步已開始，請繼續完成其餘設定。' : '首次提取已在背景開始，請繼續完成其餘設定。');
  say();

  try {
    await askRemaining(ctx, p, d);

    printing = true;
    const result = await settled;
    printing = false;
    process.stderr.write(`\r${' '.repeat(80)}\r`);
    if (!result.ok) {
      const e = result.error;
      if (e instanceof Error && e.name === 'AbortError') throw new CliExit(130, '設定已中斷，下次執行 ilearn sync 會從中斷處繼續');
      if (e instanceof CliExit) throw e;
      throw new CliExit(1, `首次提取沒有完成：${e instanceof Error ? e.message : String(e)}，之後執行 ilearn sync 會繼續`);
    }
    const report = result.outcome.report;
    say(formatFetchDone(!wasCompleted, lastProgress));
    say();

    await askSummaries(ctx, p, d);

    // 完成摘要
    if (report) say(formatSummary(report, summaryExtras(ctx.db, ctx.now())));
    say();
    say('背景服務註冊：Phase 5 提供。目前可用 cron 定時執行：*/5 * * * * ilearn run');
    say('要把現有事項推送給 agent，請執行 ilearn reload。');
  } catch (e) {
    ac.abort();
    await settled;
    if (isPromptExit(e)) throw new CliExit(130, '設定已中斷，下次執行 ilearn setup 或 ilearn sync 會從中斷處繼續');
    throw e;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function askRemaining(ctx: CliContext, p: Prompts, d: SetupDefaults): Promise<void> {
  header(4, '要啟用的介面');
  const ifaces = await p.checkbox({
    message: '要啟用的介面',
    choices: [
      { name: '終端機', value: 'terminal', checked: true },
      { name: '資料夾（Markdown 檢視）', value: 'folder', checked: d.folder },
      { name: '網頁（後續階段提供）', value: 'web', disabled: true },
      { name: '桌面 app（後續階段提供）', value: 'desktop', disabled: true },
    ],
    theme: checkboxTheme,
  });
  ctx.config.interfaces = {
    terminal: true,
    folder: ifaces.includes('folder'),
    web: false,
    desktop: false,
  };
  saveConfig(ctx.config, ctx.root);
  saved(ctx.config.interfaces.folder ? '終端機、資料夾（Markdown 檢視）' : '終端機');

  header(5, '推送方式');
  const dl = ctx.config.delivery;
  const ways = await p.checkbox({
    message: '推送方式',
    choices: [
      { name: 'outbox 檔案（必備）', value: 'outbox', checked: true },
      { name: '本機指令 hook（事件 JSON 經 stdin 傳入）', value: 'hook', checked: dl.hook.enabled },
      { name: '本機 webhook（POST 到 localhost）', value: 'webhook', checked: dl.webhook.enabled },
    ],
    theme: checkboxTheme,
  });
  const next: Config['delivery'] = structuredClone(dl);
  next.hook.enabled = ways.includes('hook');
  next.webhook.enabled = ways.includes('webhook');
  if (next.hook.enabled) {
    next.hook.command = (
      await p.input({
        message: '每則推送事件要執行的指令',
        ...(dl.hook.command ? { default: dl.hook.command } : {}),
        validate: (v: string) => v.trim() !== '' || '請輸入指令',
      })
    ).trim();
  }
  if (next.webhook.enabled) {
    next.webhook.url = (
      await p.input({
        message: 'webhook 網址',
        default: dl.webhook.url || DEFAULT_WEBHOOK_URL,
        validate: (v: string) => webhookUrlError(v.trim()) ?? true,
      })
    ).trim();
  }
  ctx.config.delivery = next;
  saveConfig(ctx.config, ctx.root);
  saved(deliverySummary(next));

  await askRules(ctx, p);
}

/** 第 6 步：全部取消勾選時先確認，避免誤把規則全部停用。 */
export async function askRules(ctx: CliContext, p: Pick<Prompts, 'checkbox' | 'confirm'>): Promise<void> {
  header(6, '通知規則');
  let enabled: string[];
  for (;;) {
    enabled = await p.checkbox({
      message: '通知規則（預設已勾選，直接 Enter 即採用預設）',
      choices: ctx.rules.map((r) => ({ name: `${r.name}（${r.action}）`, value: r.id, checked: r.enabled })),
      theme: checkboxTheme,
    });
    if (enabled.length > 0 || ctx.rules.length === 0) break;
    const sure = await p.confirm({ message: '全部規則都會停用，新公告不會推送給 agent，確定嗎？', default: false, transformer: yn });
    if (sure) break;
  }
  const set = new Set(enabled);
  if (ctx.rules.some((r) => r.enabled !== set.has(r.id))) {
    const next = ctx.rules.map((r) => ({ ...r, enabled: set.has(r.id) }));
    writeSecureFile(rulesPath(ctx.root), stringifyRules(next));
    ctx.rules = next;
    saved(`通知規則啟用 ${set.size} 條，停用 ${next.length - set.size} 條`);
  } else {
    ok('沿用目前的通知規則');
  }
}

function applySummaries(
  ctx: CliContext,
  courses: { id: string }[],
  materials: Set<string>,
  announcements: Set<string>,
): void {
  const ids = new Set(courses.map((c) => c.id));
  const next: Config['summaries']['courses'] = {};
  for (const [id, v] of Object.entries(ctx.config.summaries.courses)) if (!ids.has(id)) next[id] = v;
  for (const c of courses) {
    if (materials.has(c.id) || announcements.has(c.id)) {
      next[c.id] = { materials: materials.has(c.id), announcements: announcements.has(c.id) };
    }
  }
  ctx.config.summaries.courses = next;
  saveConfig(ctx.config, ctx.root);
}

const countText = (n: number): string => (n === 0 ? '沒有選擇任何課程' : `${n} 門課程`);

async function askSummaries(ctx: CliContext, p: Prompts, d: SetupDefaults): Promise<void> {
  const courses = ctx.db
    .prepare('SELECT id, name FROM courses WHERE semester = (SELECT MAX(semester) FROM courses) ORDER BY name')
    .all() as unknown as { id: string; name: string }[];
  if (courses.length === 0) {
    header(7, '教材檔案摘要');
    ok('目前沒有課程資料，略過');
    header(8, '老師公告摘要');
    ok('目前沒有課程資料，略過');
    return;
  }
  const pick = async (message: string, prior: string[]): Promise<Set<string>> => {
    const was = new Set(prior);
    return new Set(
      await p.checkbox({
        message,
        choices: courses.map((c) => ({ name: c.name, value: c.id, checked: was.has(c.id) })),
        theme: checkboxTheme,
      }),
    );
  };
  header(7, '教材檔案摘要');
  const materials = await pick('啟用「教材檔案摘要」的課程（沒有剔選的課程只顯示標題）', d.materials);
  applySummaries(ctx, courses, materials, new Set(d.announcements));
  saved(`教材檔案摘要：${countText(materials.size)}`);

  header(8, '老師公告摘要');
  const announcements = await pick('啟用「老師公告摘要」的課程（沒有剔選的課程只顯示標題）', d.announcements);
  applySummaries(ctx, courses, materials, announcements);
  saved(`老師公告摘要：${countText(announcements.size)}`);
}
