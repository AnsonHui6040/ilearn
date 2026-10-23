#!/usr/bin/env node
import { Command } from 'commander';
import { dataRoot } from '../config/paths.js';
import { currentVersion } from '../update/update.js';
import { logout } from './auth.js';
import {
  ackCommand,
  announcementsCommand,
  courseCommand,
  coursesCommand,
  eventsCommand,
  fileTextCommand,
  filesSearchCommand,
  gradesCommand,
  markTeammateCommand,
  statusCommand,
  tasksCommand,
} from './commands/query.js';
import {
  formatValidation,
  rulesEditCommand,
  rulesListCommand,
  rulesTestCommand,
} from './commands/rules.js';
import { daemonLoop, reloadCommand, runHandler, syncHandler } from './commands/sync.js';
import { CliExit, createContext, createReadContext, createSetUpContext, isSetUp } from './context.js';
import {
  announcementsText,
  courseText,
  coursesText,
  eventsText,
  filesText,
  gradesText,
  pendingSummariesText,
  statusText,
  tasksText,
} from './format.js';
import { formatProgress, formatSummary, runLogin, runSetup, summaryExtras } from './setup.js';
import { pendingSummaries, writeSummary } from '../summaries/summaries.js';

const write = (s: string): void => void process.stdout.write(`${s}\n`);
const warn = (s: string): void => void process.stderr.write(`${s}\n`);

/** --json 時 stdout 只輸出一個 JSON 值。 */
function out(json: boolean | undefined, data: unknown, text: () => string): void {
  write(json ? JSON.stringify(data) : text());
}

function progressPrinter(): ((p: Parameters<typeof formatProgress>[0]) => void) | undefined {
  if (!process.stderr.isTTY) return undefined;
  return (p) => void process.stderr.write(`\r${formatProgress(p)}   `);
}

function needTty(what: string): void {
  if (!process.stdin.isTTY) throw new CliExit(1, `${what}需要在互動終端機執行`);
}

const program = new Command();
program
  .name('ilearn')
  .description('把東海大學 iLearn 同步到本機，供 AI agent 讀取（非官方工具）')
  .version(currentVersion());

program
  .command('setup')
  .description('首次設定精靈')
  .action(async () => {
    needTty('設定精靈');
    await runSetup(createContext());
  });

program
  .command('login')
  .description('重新登入 iLearn')
  .action(async () => {
    needTty('登入');
    await runLogin(createContext());
  });

program
  .command('logout')
  .description('刪除 session 及已保存的密碼')
  .action(async () => {
    const root = dataRoot();
    if (!isSetUp(root)) {
      write('尚未設定，沒有需要登出的資料');
      return;
    }
    await logout(createContext({ root }));
    write('已登出，session 及已保存的密碼都已刪除');
  });

program
  .command('sync')
  .description('立即同步並下載檔案')
  .option('--force', '即使剛同步過也再同步一次')
  .option('--json', '以 JSON 輸出')
  .action(async (o: { force?: boolean; json?: boolean }) => {
    const printer = o.json ? undefined : progressPrinter();
    const { ctx, outcome: r } = await syncHandler({ ...(o.force ? { force: true } : {}), ...(printer ? { onProgress: printer } : {}) });
    if (printer) process.stderr.write('\n');
    out(o.json, r, () => (r.skipped ? (r.reason ?? '略過') : r.report ? formatSummary(r.report, summaryExtras(ctx.db, ctx.now())) : ''));
  });

program
  .command('run')
  .description('背景服務每 5 分鐘執行：到點才同步，檢查提醒，並依設定檢查新版本')
  .action(async () => {
    try {
      await runHandler();
    } finally {
      const root = dataRoot();
      if (isSetUp(root)) {
        const { maybeCheckUpdate } = await import('./commands/update.js');
        const { currentVersion } = await import('../update/update.js');
        const { loadConfig } = await import('../config/config.js');
        await maybeCheckUpdate({ root, freq: loadConfig(root).updates.check, current: currentVersion(), now: new Date(), env: process.env, log: warn });
      }
    }
  });

program
  .command('update')
  .description('更新到 npm 上的最新版本（只能由本人在互動終端操作）')
  .option('--check', '只檢查是否有新版本')
  .option('--json', '與 --check 一起使用，以 JSON 輸出')
  .action(async (o: { check?: boolean; json?: boolean }) => {
    const { checkForUpdate, currentProgramDirKind, currentVersion, npmBinary } = await import('../update/update.js');
    const root = dataRoot();
    if (o.check) {
      const st = await checkForUpdate({ root, current: currentVersion(), now: new Date(), env: process.env });
      out(o.json, st, () => (st.available ? `有新版本 ${st.latest}（目前 ${st.current}），執行 ilearn update 更新` : `已是最新版本 ${st.current}`));
      return;
    }
    const { updateApplyCommand } = await import('./commands/update.js');
    const { defaultServiceDeps } = await import('../service/service.js');
    const { existsSync } = await import('node:fs');
    write(
      await updateApplyCommand({
        isTTY: Boolean(process.stdin.isTTY),
        root,
        current: currentVersion(),
        now: new Date(),
        env: process.env,
        kind: currentProgramDirKind(),
        npm: npmBinary(process.execPath, existsSync),
        run: (cmd, args) => defaultServiceDeps().run(cmd, args),
      }),
    );
  });

program
  .command('daemon')
  .description('常駐執行，每 5 分鐘做一次 run')
  .action(async () => {
    const ctx = createSetUpContext();
    const ac = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ac.abort());
    warn('ilearn daemon 已啟動，按 Ctrl-C 結束');
    await daemonLoop(ctx, { signal: ac.signal });
  });

program
  .command('reload')
  .description('同步後把目前需要處理的事項推送給 agent')
  .option('--yes', '不再詢問，直接推送')
  .option('--json', '以 JSON 輸出')
  .action(async (o: { yes?: boolean; json?: boolean }) => {
    const ctx = createSetUpContext();
    const isTTY = Boolean(process.stdin.isTTY);
    const r = await reloadCommand(ctx, {
      ...(o.yes ? { yes: true } : {}),
      isTTY,
      confirm: async (n) => {
        const { confirm } = await import('@inquirer/prompts');
        return confirm({ message: `將推送 ${n} 則事件，確定嗎？`, default: false, transformer: (v: boolean) => (v ? 'Y' : 'N') });
      },
    });
    out(o.json, r, () => (r.cancelled ? `已取消，沒有推送（原本會推送 ${r.planned} 則）` : `已推送 ${r.pushed} 則事件`));
  });

program
  .command('tasks')
  .description('未完成的作業及影片')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = tasksCommand(createReadContext());
    out(o.json, r, () => tasksText(r));
  });

const events = program
  .command('events')
  .description('查詢 outbox 事件')
  .option('--deliverable', '只列出 deliver_after 已到的事件')
  .option('--agent <名稱>', '排除該 agent 已 ack 的事件')
  .option('--type <類型>', '只列出指定類型')
  .option('--since <時間>', '只列出此時間之後偵測到的事件（ISO 格式）')
  .option('--json', '以 JSON 輸出')
  .action((o: { deliverable?: boolean; agent?: string; type?: string; since?: string; json?: boolean }) => {
    const r = eventsCommand(createReadContext(), o);
    out(o.json, r, () => eventsText(r));
  });
events
  .command('ack <agent> <event_id>')
  .description('標記該 agent 已處理到此事件')
  .option('--json', '以 JSON 輸出')
  .action((agent: string, eventId: string, o: { json?: boolean }) => {
    const r = ackCommand(createSetUpContext(), agent, eventId);
    out(o.json, r, () => `${agent} 已處理到 ${eventId}`);
  });

program
  .command('courses')
  .description('課程列表')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = coursesCommand(createReadContext());
    out(o.json, r, () => coursesText(r));
  });

program
  .command('course <id>')
  .description('單一課程的全部資料')
  .option('--json', '以 JSON 輸出')
  .action((id: string, o: { json?: boolean }) => {
    const r = courseCommand(createReadContext(), id);
    out(o.json, r, () => courseText(r));
  });

program
  .command('announcements')
  .description('公告列表')
  .option('--category <代碼>', '只列出指定分類')
  .option('--course <id>', '只列出指定課程')
  .option('--json', '以 JSON 輸出')
  .action((o: { category?: string; course?: string; json?: boolean }) => {
    const r = announcementsCommand(createReadContext(), o);
    out(o.json, r, () => announcementsText(r));
  });

program
  .command('grades')
  .description('分數及評語')
  .option('--course <id>', '只列出指定課程')
  .option('--json', '以 JSON 輸出')
  .action((o: { course?: string; json?: boolean }) => {
    const r = gradesCommand(createReadContext(), o);
    out(o.json, r, () => gradesText(r));
  });

const files = program.command('files').description('檔案查詢');
files
  .command('search <關鍵字>')
  .description('以檔名搜尋')
  .option('--json', '以 JSON 輸出')
  .action((kw: string, o: { json?: boolean }) => {
    const r = filesSearchCommand(createReadContext(), kw);
    out(o.json, r, () => filesText(r));
  });

const file = program.command('file').description('單一檔案');
file
  .command('text <id>')
  .description('輸出 .txt 或 .md 檔案的文字')
  .option('--json', '以 JSON 輸出')
  .action((id: string, o: { json?: boolean }) => {
    const r = fileTextCommand(createReadContext(), id);
    out(o.json, r, () => r.text);
  });

const summaries = program.command('summaries').description('公告與教材的摘要：由 agent 寫回，本工具不會呼叫任何 AI');
summaries
  .command('pending')
  .description('列出還沒有摘要（或原文已變動）的公告與教材，數量受每日上限限制')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = pendingSummaries(createReadContext());
    out(o.json, r, () => pendingSummariesText(r));
  });
summaries
  .command('write <target_id>')
  .description('從標準輸入讀取摘要文字並寫入（需要使用者允許 agent 寫入摘要）')
  .requiredOption('--hash <source_hash>', 'pending 回傳的 source_hash')
  .option('--agent <名稱>', '你的 agent 名稱（英數、. _ -，最長 64 字元）')
  .option('--json', '以 JSON 輸出')
  .action(async (targetId: string, o: { hash: string; agent?: string; json?: boolean }) => {
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
    const r = writeSummary(createSetUpContext(), { target_id: targetId, source_hash: o.hash, text, agent: o.agent });
    out(o.json, r, () => `已寫入摘要 ${r.target_id}，今天還可以寫 ${r.remaining_today} 則`);
  });

program
  .command('mark-teammate <item_id>')
  .description('標記小組作業「隊員已交」（只能由本人在互動終端操作）')
  .option('--undo', '取消標記')
  .action((itemId: string, o: { undo?: boolean }) => {
    const r = markTeammateCommand(createSetUpContext(), {
      itemId,
      ...(o.undo ? { undo: true } : {}),
      isTTY: Boolean(process.stdin.isTTY),
    });
    write(r.completion === 'pending' ? `已取消標記 ${r.id}` : `已標記 ${r.id} 為隊員已交`);
  });

const rules = program.command('rules').description('關鍵詞規則');
rules
  .command('list')
  .description('列出目前生效的規則')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = rulesListCommand(createReadContext());
    out(o.json, r, () => r.map((x) => `${x.enabled ? '啟用' : '停用'}  ${x.id}  ${x.name}  ${x.action}`).join('\n'));
  });
rules
  .command('test [檔案]')
  .description('試算規則檔（預設 rules.yaml）與目前規則的差異，不會儲存')
  .option('--json', '以 JSON 輸出')
  .action((file: string | undefined, o: { json?: boolean }) => {
    const v = rulesTestCommand(createReadContext(), file);
    out(o.json, v, () => formatValidation(v));
    if (!v.ok) process.exitCode = 1;
  });
rules
  .command('edit')
  .description('用 $EDITOR 編輯 rules.yaml，儲存前驗證並試算')
  .action(async () => {
    needTty('編輯規則');
    const { confirm } = await import('@inquirer/prompts');
    const r = await rulesEditCommand(createSetUpContext(), {
      confirm: (preview) => {
        write(preview);
        return confirm({ message: '要儲存嗎？', default: true, transformer: (v: boolean) => (v ? 'Y' : 'N') });
      },
      retry: (msg) => {
        warn(msg);
        return confirm({ message: '要回去修改嗎？不修改就放棄這次編輯', default: true, transformer: (v: boolean) => (v ? 'Y' : 'N') });
      },
    });
    write(r.saved ? '已儲存 rules.yaml' : '沒有儲存');
  });

const service = program.command('service').description('背景服務：由系統排程每 5 分鐘執行 ilearn run');
service
  .command('install')
  .description('安裝背景服務（只能由本人在互動終端操作）')
  .action(async () => {
    const { defaultServiceDeps, defaultServiceSpec } = await import('../service/service.js');
    const { serviceInstallCommand } = await import('./commands/service.js');
    const root = dataRoot();
    const r = serviceInstallCommand({ isTTY: Boolean(process.stdin.isTTY), root, deps: defaultServiceDeps(), spec: defaultServiceSpec(root) });
    write(`已安裝背景服務：${r.detail}`);
  });
service
  .command('uninstall')
  .description('移除背景服務（只能由本人在互動終端操作）')
  .action(async () => {
    const { defaultServiceDeps } = await import('../service/service.js');
    const { serviceUninstallCommand } = await import('./commands/service.js');
    write(serviceUninstallCommand({ isTTY: Boolean(process.stdin.isTTY), deps: defaultServiceDeps() }));
  });
service
  .command('status')
  .description('背景服務是否已安裝')
  .option('--json', '以 JSON 輸出')
  .action(async (o: { json?: boolean }) => {
    const { defaultServiceDeps, defaultServiceSpec, serviceStatus } = await import('../service/service.js');
    const r = serviceStatus(defaultServiceDeps(), defaultServiceSpec(dataRoot()).script);
    out(o.json, r, () => `背景服務：${r.detail}`);
  });

program
  .command('ui')
  .description('開啟全螢幕介面（只能在互動終端使用）')
  .action(async () => {
    const { assertInteractive, defaultDeps, nodeTerm, runUi } = await import('../tui/app.js');
    assertInteractive(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY));
    const ctx = createSetUpContext();
    await runUi(ctx, nodeTerm(), await defaultDeps(ctx));
    // 收到 SIGTERM 時同步或登入可能仍在進行，介面關閉後直接結束程序
    process.exit();
  });

program
  .command('mcp')
  .description('以 stdio 啟動 MCP server，供支援 MCP 的 agent 讀取資料')
  .action(async () => {
    const { serveStdio } = await import('../mcp/server.js');
    await serveStdio();
  });

program
  .command('status')
  .description('同步狀態、最近錯誤、首次同步進度')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = statusCommand(createReadContext());
    out(o.json, r, () => statusText(r));
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliExit) {
      warn(e.message);
      process.exitCode = e.code;
    } else if (e instanceof Error && e.name === 'ExitPromptError') {
      warn('已取消');
      process.exitCode = 130;
    } else {
      warn(`錯誤：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
}

void main();
