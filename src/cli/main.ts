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
  reportCommand,
  statusCommand,
  tasksCommand,
} from './commands/query.js';
import {
  formatValidation,
  rulesEditCommand,
  rulesListCommand,
  rulesTestCommand,
} from './commands/rules.js';
import { deliveryTestCommand, deliveryTestStatusCommand } from './commands/delivery.js';
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
  testStatusText,
} from './format.js';
import { formatProgress, formatSummary, runLogin, runSetup, summaryExtras } from './setup.js';
import { pendingSummaries, writeSummary } from '../summaries/summaries.js';
import { renderFolderView } from '../folder/folder.js';
import { configGet, configSet, rulesAdd } from '../agent/settings.js';
import { formatChangeValue } from '../agent/changes.js';

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
  .option('--test', '只列出該 agent 尚未 ACK 的 delivery test 測試事件（需要 --agent）')
  .option('--limit <n>', '最多回傳 n 則（1 到 100 的整數，篩選之後取最舊的 n 則）')
  .option('--compact', '精簡輸出：event_id、類型、課程、標題（最多 120 字）、時間、連結與該 agent 的失敗次數')
  .option('--json', '以 JSON 輸出')
  .action((o: { deliverable?: boolean; agent?: string; type?: string; since?: string; test?: boolean; limit?: string; compact?: boolean; json?: boolean }) => {
    // agent 讀取時資料夾必須已設定：避免把「讀錯資料夾」誤當成「沒有新事件」
    const r = eventsCommand(o.agent !== undefined ? createSetUpContext() : createReadContext(), o);
    out(o.json, r, () => eventsText(r));
  });
events
  .command('ack <agent> <event_id>')
  .description('標記該 agent 已處理到此事件')
  .option('--test', '這是 delivery test 的測試事件')
  .option('--json', '以 JSON 輸出')
  .action((agent: string, eventId: string, _o: unknown, cmd: Command) => {
    // 上層 events 也有 --test、--json，commander 會把它們算給上層，所以合併上層的選項
    const o = cmd.optsWithGlobals<{ test?: boolean; json?: boolean }>();
    const r = ackCommand(createSetUpContext(), agent, eventId, o.test ? { test: true } : {});
    out(o.json, r, () => `${agent} 已處理到 ${eventId}`);
  });
events
  .command('report <agent> <event_id>')
  .description('回報事件處理結果；failed、skipped 會顯示在 ilearn status 與 ilearn ui，不會移動 ACK 進度')
  .requiredOption('--status <狀態>', 'processed、failed 或 skipped（skipped 是隔離：記錄後 agent 可以 ACK 越過）')
  .option('--note <說明>', '失敗原因等說明（最多 300 字）')
  .option('--test', '這是 delivery test 的測試事件')
  .option('--json', '以 JSON 輸出')
  .action((agent: string, eventId: string, _o: unknown, cmd: Command) => {
    const o = cmd.optsWithGlobals<{ status: string; note?: string; test?: boolean; json?: boolean }>();
    const r = reportCommand(createSetUpContext(), {
      agent,
      eventId,
      status: o.status,
      ...(o.note !== undefined ? { note: o.note } : {}),
      ...(o.test ? { test: true } : {}),
    });
    out(o.json, r, () => `已記錄 ${agent} 對 ${eventId} 的處理結果：${r.status}`);
  });

const delivery = program.command('delivery').description('推送測試');
delivery
  .command('test')
  .description('送出測試事件並檢查四級結果（Transport、Agent、處理、ACK）；測試事件不會進入正式事件')
  .option('--agent <名稱>', '要測試的 agent 名稱（英數、. _ -，最長 64 字元）')
  .option('--status <test_id>', '查詢某次測試的四級結果')
  .option('--json', '以 JSON 輸出')
  .action(async (o: { agent?: string; status?: string; json?: boolean }) => {
    const ctx = createSetUpContext();
    if (o.status !== undefined) {
      const s = deliveryTestStatusCommand(ctx, o.status);
      out(o.json, s, () => testStatusText(s));
      return;
    }
    if (o.agent === undefined) throw new CliExit(1, '請用 --agent 帶入 agent 名稱，或用 --status <test_id> 查詢結果');
    const r = await deliveryTestCommand(ctx, { agent: o.agent });
    out(o.json, r, () =>
      [
        `測試 ${r.test_id}`,
        `Transport：${r.transport.status}（CLI Adapter ${r.transport.cli.status}${r.transport.cli.error ? `：${r.transport.cli.error}` : ''}；webhook ${r.transport.webhook.status}${r.transport.webhook.error ? `：${r.transport.webhook.error}` : ''}${r.signed === null ? '' : r.signed ? '，已簽名' : '，未簽名'}）`,
        'Transport PASS 只代表通知送達。agent 接下來依序執行：',
        ...r.next_steps.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n'),
    );
  });

const connect = program.command('connect').description('自動連接 agent（只能由本人在互動終端操作）');
connect
  .command('hermes')
  .description('連接 Hermes。agent 用 --prompt 與 --request（建議）；不帶旗標則由本人在互動終端逐項設定')
  .option('--prompt', 'agent 專用：印出要在 Hermes 對話內建立排程工作的固定內容（需要 --agent）')
  .option('--request', 'agent 專用：偵測後提出連接申請並產生確認代碼，不更改任何設定（需要 --profile、--agent）')
  .option('--remove', '移除排程工作、webhook 路由，並關閉 ilearn 的 webhook（互動終端）')
  .option('--profile <名稱>', 'Hermes profile 名稱；預設 profile 傳空字串')
  .option('--agent <名稱>', 'agent 名稱（英數、. _ -，最長 64 字元）')
  .option('--cron-job <名稱>', '排程工作名稱（預設 thu-ilearn-inbox）')
  .option('--port <埠>', 'Hermes webhook 埠（預設 8644）')
  .option('--json', '以 JSON 輸出（--prompt、--request）')
  .action(
    async (o: { prompt?: boolean; request?: boolean; remove?: boolean; profile?: string; agent?: string; cronJob?: string; port?: string; json?: boolean }) => {
      const mod = await import('../connect/hermes.js');
      if (o.prompt || o.request) {
        if (o.prompt && o.request) throw new CliExit(1, '--prompt 與 --request 不能同時使用');
        if (o.remove) throw new CliExit(1, '--remove 只能由本人在互動終端單獨執行');
        const ctx = createSetUpContext();
        if (o.agent === undefined) throw new CliExit(1, '請用 --agent 帶入你的 agent 名稱');
        const deps = mod.defaultHermesDeps();
        if (o.prompt) {
          const r = mod.connectPromptCommand(ctx, { agent: o.agent }, deps);
          out(o.json, r, () => mod.connectPromptText(r));
          return;
        }
        if (o.profile === undefined) throw new CliExit(1, '請用 --profile 帶入 Hermes profile 名稱（預設 profile 傳空字串）');
        const r = await mod.connectRequestCommand(
          ctx,
          { profile: o.profile, agent: o.agent, ...(o.cronJob !== undefined ? { cronJob: o.cronJob } : {}), ...(o.port !== undefined ? { port: Number(o.port) } : {}) },
          deps,
        );
        out(o.json, r, () => mod.connectRequestText(r));
        return;
      }
      const { assertInteractive } = await import('../tui/app.js');
      assertInteractive(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY));
      const ctx = createSetUpContext();
      const prompts = await import('@inquirer/prompts');
      await mod.runConnectHermes(
        ctx,
        { ...(o.remove ? { remove: true } : {}), ...(o.profile !== undefined ? { profile: o.profile } : {}), ...(o.cronJob !== undefined ? { cronJob: o.cronJob } : {}) },
        mod.defaultHermesDeps(prompts),
      );
    },
  );
connect
  .command('approve')
  .description('核對 agent 提出的連接申請，逐項確認後完成 Hermes 設定（只能由本人在互動終端執行）')
  .action(async () => {
    const { assertInteractive } = await import('../tui/app.js');
    assertInteractive(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY));
    const ctx = createSetUpContext();
    const mod = await import('../connect/hermes.js');
    const prompts = await import('@inquirer/prompts');
    await mod.runConnectApprove(ctx, mod.defaultHermesDeps(prompts));
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
    const ctx = createSetUpContext();
    const r = writeSummary(ctx, { target_id: targetId, source_hash: o.hash, text, agent: o.agent });
    renderFolderView(ctx);
    out(o.json, r, () => `已寫入摘要 ${r.target_id}，今天還可以寫 ${r.remaining_today} 則`);
  });

program
  .command('mark-teammate <item_id>')
  .description('標記小組作業「隊員已交」（只能由本人在互動終端操作）')
  .option('--undo', '取消標記')
  .action((itemId: string, o: { undo?: boolean }) => {
    const ctx = createSetUpContext();
    const r = markTeammateCommand(ctx, {
      itemId,
      ...(o.undo ? { undo: true } : {}),
      isTTY: Boolean(process.stdin.isTTY),
    });
    renderFolderView(ctx);
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

rules
  .command('add')
  .description('新增一條通知規則（需要使用者允許 agent 修改設定，會記錄並顯示給使用者）')
  .requiredOption('--name <名稱>', '規則名稱')
  .requiredOption('--keywords <關鍵詞>', '任一關鍵詞，以逗號分隔')
  .requiredOption('--action <等級>', 'record、push 或 force_push')
  .option('--course <id,...>', '只適用這些課程（預設全部課程）')
  .requiredOption('--agent <名稱>', '你的 agent 名稱（英數、. _ -，最長 64 字元）')
  .option('--json', '以 JSON 輸出')
  .action((o: { name: string; keywords: string; action: string; course?: string; agent: string; json?: boolean }) => {
    const r = rulesAdd(createSetUpContext(), { name: o.name, keywords: o.keywords, action: o.action, courses: o.course, agent: o.agent });
    out(o.json, r, () => `已新增規則 ${r.id}「${r.name}」`);
  });

const config = program.command('config').description('agent 可以讀取與（經使用者允許後）修改的設定');
config
  .command('get')
  .description('目前的 agent 權限與可修改的設定值（唯讀）')
  .option('--json', '以 JSON 輸出')
  .action((o: { json?: boolean }) => {
    const r = configGet(createReadContext());
    out(o.json, r, () =>
      [
        `agent 權限：寫入摘要 ${r.agent_permissions.summaries ? '允許' : '不允許'}，修改設定 ${r.agent_permissions.settings ? '允許' : '不允許'}`,
        `夜間時段：${r.settings.quiet_hours.start}–${r.settings.quiet_hours.end}`,
        `截止提醒：${r.settings.reminders.offsets.join('、')}（強制推送：${r.settings.force_push_offsets.join('、') || '無'}）`,
        ...r.settings.rules.map((x) => `規則 ${x.id}  ${x.enabled ? '啟用' : '停用'}  ${x.action}  ${x.name}：${x.keywords.join('、')}`),
        `資料夾檢視：${r.settings.interfaces.folder ? '啟用' : '停用'}；更新檢查：${r.settings.updates.check}；摘要每日上限：${r.settings.summaries.daily_limit}`,
      ].join('\n'),
    );
  });
config
  .command('set <key> <value>')
  .description('修改一項設定（需要使用者允許 agent 修改設定，會記錄並顯示給使用者）')
  .requiredOption('--agent <名稱>', '你的 agent 名稱（英數、. _ -，最長 64 字元）')
  .option('--json', '以 JSON 輸出')
  .action((key: string, value: string, o: { agent: string; json?: boolean }) => {
    const r = configSet(createSetUpContext(), { key, value, agent: o.agent });
    out(o.json, r, () => `已修改 ${r.key}：${formatChangeValue(r.old)} → ${formatChangeValue(r.new)}`);
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
