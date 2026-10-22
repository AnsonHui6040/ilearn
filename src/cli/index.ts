#!/usr/bin/env node
import { Command } from 'commander';
import { dataRoot } from '../config/paths.js';
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
  statusText,
  tasksText,
} from './format.js';
import { formatProgress, formatSummary, runLogin, runSetup, summaryExtras } from './setup.js';

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
  .version('0.1.0');

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
  .description('給 cron 使用：到點才同步，並檢查提醒')
  .action(async () => {
    await runHandler();
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

program
  .command('ui')
  .description('開啟全螢幕介面（只能在互動終端使用）')
  .action(async () => {
    const { assertInteractive, defaultDeps, nodeTerm, runUi } = await import('../tui/app.js');
    assertInteractive(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY));
    await runUi(createSetUpContext(), nodeTerm(), await defaultDeps());
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
