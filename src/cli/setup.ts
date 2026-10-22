import type { DatabaseSync } from 'node:sqlite';
import { chooseBackend, savePassword, VPS_RISK_WARNING } from '../auth/credentials.js';
import { saveConfig, type Config } from '../config/config.js';
import { writeSecureFile } from '../config/paths.js';
import { listFiles, listItems } from '../db/repo.js';
import { AuthError } from '../ilearn/auth.js';
import { stringifyRules } from '../rules/yaml.js';
import type { SyncProgress, SyncReport } from '../sync/sync.js';
import { toTaipeiIso } from '../time.js';
import { backendFor, loginWith } from './auth.js';
import { abortableApi, syncCommand, type SyncOutcome } from './commands/sync.js';
import { CliExit, rulesPath, type CliContext } from './context.js';

/* ---------- 純函式 ---------- */

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

async function promptCredentials(
  ctx: CliContext,
  p: typeof import('@inquirer/prompts'),
): Promise<{ username: string; password: string }> {
  for (;;) {
    const username = (await p.input({ message: '學號', ...(ctx.username ? { default: ctx.username } : {}) })).trim();
    const password = await p.password({ message: 'iLearn 密碼（輸入時不會顯示）' });
    try {
      await loginWith(ctx, username, password);
      return { username, password };
    } catch (e) {
      say(loginFailureText(e));
      if (!(await p.confirm({ message: '要重新輸入嗎？', default: true }))) throw new CliExit(1, '已取消設定');
    }
  }
}

async function askSavePassword(
  ctx: CliContext,
  p: typeof import('@inquirer/prompts'),
  username: string,
  password: string,
): Promise<void> {
  if (ctx.config.environment === 'vps') {
    say(`提醒：${VPS_RISK_WARNING}`);
  }
  const save = await p.confirm({ message: '要保存密碼，讓 session 過期時自動重新登入嗎？', default: false });
  ctx.config.password_saved = false;
  if (!save) return;
  try {
    await savePassword(ctx.root, chooseBackend(ctx.config.environment), username, password);
    ctx.config.password_saved = true;
  } catch (e) {
    say(`${e instanceof Error ? e.message : '無法保存密碼'}，改為只保存 session`);
  }
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
  say('thu-ilearn 設定精靈');
  say('本工具為非官方工具，資料只存在這台電腦，使用前請自行查閱學校資訊使用規範。');
  say();

  // 1. 環境
  const detected = detectEnvironment(process.env);
  ctx.config.environment = await p.select({
    message: '目前的執行環境',
    choices: [
      { name: '本機桌面（有圖形介面）', value: 'desktop' as const },
      { name: 'VPS 或雲端主機（無圖形介面）', value: 'vps' as const },
    ],
    default: detected,
  });

  // 2、3. 登入與密碼
  const { username, password } = await promptCredentials(ctx, p);
  await askSavePassword(ctx, p, username, password);
  saveConfig(ctx.config, ctx.root);

  // 4. 首次提取在背景進行
  const ac = new AbortController();
  ctx.api = abortableApi(ctx.api, ac.signal);
  ctx.wrapApi = (api) => abortableApi(api, ac.signal);
  let printing = false;
  const settled: Promise<{ ok: true; outcome: SyncOutcome } | { ok: false; error: unknown }> = syncCommand(ctx, {
    force: true,
    onProgress: (pr) => {
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
  say('首次提取已在背景開始，請繼續完成其餘設定。');
  say();

  try {
    // 5. 其餘設定
    await askRemaining(ctx, p);
    saveConfig(ctx.config, ctx.root);

    printing = true;
    const result = await settled;
    printing = false;
    process.stderr.write('\n');
    if (!result.ok) {
      const e = result.error;
      if (e instanceof Error && e.name === 'AbortError') throw new CliExit(130, '設定已中斷，下次執行 ilearn sync 會從中斷處繼續');
      if (e instanceof CliExit) throw e;
      throw new CliExit(1, `首次提取沒有完成：${e instanceof Error ? e.message : String(e)}，之後執行 ilearn sync 會繼續`);
    }
    const report = result.outcome.report;

    await askSummaries(ctx, p);
    saveConfig(ctx.config, ctx.root);

    // 6. 完成摘要
    say();
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

async function askRemaining(ctx: CliContext, p: typeof import('@inquirer/prompts')): Promise<void> {
  const ifaces = await p.checkbox({
    message: '要啟用的介面（空白鍵剔選，Enter 確認）',
    choices: [
      { name: '終端機', value: 'terminal', checked: true },
      { name: '文件夾（Markdown 檢視）', value: 'folder', checked: ctx.config.environment === 'vps' },
      { name: '網頁（後續階段提供）', value: 'web', disabled: true },
      { name: '桌面 app（後續階段提供）', value: 'desktop', disabled: true },
    ],
  });
  ctx.config.interfaces = {
    terminal: true,
    folder: ifaces.includes('folder'),
    web: false,
    desktop: false,
  };

  const delivery = await p.checkbox({
    message: '推送方式',
    choices: [
      { name: 'outbox 檔案（必備）', value: 'outbox', checked: true },
      { name: '本機指令 hook（Phase 3 提供）', value: 'hook', disabled: true },
      { name: '本機 webhook（Phase 3 提供）', value: 'webhook', disabled: true },
    ],
  });
  if (!delivery.includes('outbox')) say('outbox 是必備的推送方式，已保留。');

  const enabled = await p.checkbox({
    message: '通知規則（預設已勾選，直接 Enter 即採用預設）',
    choices: ctx.rules.map((r) => ({ name: `${r.name}（${r.action}）`, value: r.id, checked: r.enabled })),
  });
  const set = new Set(enabled);
  if (ctx.rules.some((r) => r.enabled !== set.has(r.id))) {
    const next = ctx.rules.map((r) => ({ ...r, enabled: set.has(r.id) }));
    writeSecureFile(rulesPath(ctx.root), stringifyRules(next));
    ctx.rules = next;
  }
}

async function askSummaries(ctx: CliContext, p: typeof import('@inquirer/prompts')): Promise<void> {
  const courses = ctx.db
    .prepare('SELECT id, name FROM courses WHERE semester = (SELECT MAX(semester) FROM courses) ORDER BY name')
    .all() as unknown as { id: string; name: string }[];
  if (courses.length === 0) return;
  const pick = async (message: string): Promise<Set<string>> =>
    new Set(await p.checkbox({ message, choices: courses.map((c) => ({ name: c.name, value: c.id })) }));
  const materials = await pick('啟用「教材檔案摘要」的課程（預設全不剔選，只顯示標題）');
  const announcements = await pick('啟用「老師公告摘要」的課程（預設全不剔選，只顯示標題）');
  const next: Config['summaries']['courses'] = {};
  for (const c of courses) {
    if (materials.has(c.id) || announcements.has(c.id)) {
      next[c.id] = { materials: materials.has(c.id), announcements: announcements.has(c.id) };
    }
  }
  ctx.config.summaries.courses = next;
}
