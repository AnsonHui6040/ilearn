import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dataRoot } from '../config/paths.js';
import { currentVersion } from '../update/update.js';
import {
  ackCommand,
  announcementsCommand,
  courseCommand,
  coursesCommand,
  EVENT_TYPES,
  eventsCommand,
  fileTextCommand,
  filesSearchCommand,
  gradesCommand,
  statusCommand,
  tasksCommand,
} from '../cli/commands/query.js';
import { rulesListCommand } from '../cli/commands/rules.js';
import { configGet, configSet, rulesAdd } from '../agent/settings.js';
import { pendingSummaries, writeSummary } from '../summaries/summaries.js';
import {
  CliExit,
  createContext,
  createReadContext,
  isSetUp,
  NOT_SET_UP,
  type CliContext,
  type ContextOverrides,
} from '../cli/context.js';

/**
 * 對 agent 開放的全部工具：只讀，加上 events_ack、summaries_write、config_set 與 rules_add。
 * summaries_write、config_set、rules_add 只在使用者允許時有效，config_set 只能改白名單內的設定。
 * 刻意不提供：同步、Reload、登入、標記隊員已交、修改帳號、密碼、推送方式或權限、讀取帳密。
 */
export const MCP_TOOLS = [
  'tasks',
  'events',
  'events_ack',
  'courses',
  'course',
  'announcements',
  'grades',
  'files_search',
  'file_text',
  'status',
  'rules_list',
  'summaries_pending',
  'summaries_write',
  'config_get',
  'config_set',
  'rules_add',
] as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const INSTRUCTIONS = [
  'thu-ilearn：讀取已同步到本機的東海大學 iLearn 資料。',
  '基本規則：使用者沒有要求就不要寫入（摘要、設定、規則）；工具回傳錯誤就停止並把訊息轉告使用者，不要換其他鍵名或方法繞過；不確定就先問使用者。',
  '先用 events（deliverable: true，agent: 你的名稱）取得要通知使用者的事件，處理後用 events_ack 標記。',
  'tasks 的 initial_sync_in_progress 為 true 時，資料還在提取中，不要告訴使用者「沒有作業」。',
  'grade.posted、feedback.posted 不含分數內容，使用者詢問時再用 grades 讀取。',
  '摘要：summaries_pending 列出使用者啟用摘要的課程中，還沒有摘要或原文已變動的公告與教材（教材附本機檔案路徑，請自己讀檔）。你寫好摘要後用 summaries_write 帶回該筆的 target_id 與 source_hash；本工具不會呼叫任何 AI。使用者沒有允許時（summaries_pending 的 agent_write 為 false）寫入一律被拒絕，不要嘗試；只有使用者說想要摘要時，才告訴他可以在 ilearn setup 第 8 步或 ilearn ui 的「系統設定 > agent 權限」開啟。',
  '設定：config_get 唯讀，回傳 agent_permissions 與你可以修改的設定值。agent_permissions.settings 為 true（使用者允許）時，才能用 config_set（key、value、agent）修改單一設定，或用 rules_add 新增通知規則；否則一律被拒絕。只可以改夜間時段、截止提醒、通知規則（啟用、等級、關鍵詞、新增）、每科覆寫、摘要開關與每日上限、資料夾檢視、更新頻率。帳號、密碼、推送方式、節次時間、背景服務、更新與 agent 權限本身都不能改。每次修改都會被記錄並顯示給使用者，除非使用者明確要你改，請先問過再改。',
  '會寫入資料的工具只有 events_ack（只更新你自己的進度）、summaries_write（只寫摘要，且只在使用者允許時）、config_set 與 rules_add（只在使用者允許修改設定時）。',
  '這裡沒有同步、登入、標記隊員已交的工具，這些都由使用者在自己的終端機操作：',
  '- 標記小組作業「隊員已交」：ilearn mark-teammate <作業 id>（取消標記加 --undo）；作業 id 用 tasks 回傳的 id。這不是在 iLearn 網頁上操作。',
  '- 登入過期：ilearn login。立即同步：ilearn sync。以編輯器改全部規則：ilearn rules edit。',
].join('\n');

/** 每次呼叫開新的連線讀最新資料，用完即關；資料庫還不存在時共用一個空白的唯讀 context。 */
function contextFactory(over: Partial<ContextOverrides>): { open: () => CliContext; close: (ctx: CliContext) => void } {
  const root = over.root ?? dataRoot();
  let empty: CliContext | null = null;
  return {
    open: () => {
      if (existsSync(join(root, 'data', 'ilearn.sqlite3'))) return createContext({ ...over, root });
      empty ??= createReadContext({ ...over, root });
      return empty;
    },
    close: (ctx) => {
      if (ctx !== empty) ctx.db.close();
    },
  };
}

export function createMcpServer(over: Partial<ContextOverrides> = {}): McpServer {
  const root = over.root ?? dataRoot();
  const ctxs = contextFactory(over);
  const server = new McpServer({ name: 'thu-ilearn', version: currentVersion() }, { instructions: INSTRUCTIONS });

  const run = (fn: (ctx: CliContext) => unknown): ToolResult => {
    let ctx: CliContext | null = null;
    try {
      ctx = ctxs.open();
      return { content: [{ type: 'text', text: JSON.stringify(fn(ctx)) }] };
    } catch (e) {
      const msg = e instanceof CliExit || e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: msg }], isError: true };
    } finally {
      if (ctx !== null) ctxs.close(ctx);
    }
  };

  server.registerTool(
    'tasks',
    {
      title: '未完成的作業及影片',
      description:
        '回傳 { initial_sync_in_progress, incomplete_courses, tasks[] }，與 ilearn tasks --json 相同。teammate_hint 為 true 表示系統顯示隊員可能已交，請使用者確認後自己在終端執行 ilearn mark-teammate <id>。',
      annotations: READ_ONLY,
    },
    () => run(tasksCommand),
  );

  server.registerTool(
    'events',
    {
      title: '查詢 outbox 事件',
      description:
        '與 ilearn events --json 相同。通知使用者前請設 deliverable: true 並帶 agent 名稱，只會回傳該 agent 尚未 ack 且 deliver_after 已到的事件。',
      inputSchema: {
        deliverable: z.boolean().optional().describe('只回傳 deliver_after 已到的事件'),
        agent: z.string().optional().describe('你的 agent 名稱（英數、. _ -，最長 64 字元），排除已 ack 的事件'),
        type: z.enum(EVENT_TYPES).optional().describe('只回傳指定類型'),
        since: z.string().optional().describe('只回傳此 ISO 時間之後偵測到的事件'),
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run((ctx) =>
        eventsCommand(ctx, {
          ...(a.deliverable ? { deliverable: true } : {}),
          ...(a.agent !== undefined ? { agent: a.agent } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
          ...(a.since !== undefined ? { since: a.since } : {}),
        }),
      ),
  );

  server.registerTool(
    'events_ack',
    {
      title: '標記事件已處理',
      description:
        '與 ilearn events ack 相同：標記該 agent 已處理到此事件（含之前的）。只影響該 agent 自己的進度。何時用：一批事件都已通知使用者（或確認不需通知）之後，帶最後一則處理完的 event_id。還沒處理好的事件不要 ack。',
      inputSchema: {
        agent: z.string().describe('你的 agent 名稱'),
        event_id: z.string().describe('已處理的最後一個 event_id'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) =>
      run((ctx) => {
        if (!isSetUp(root)) throw new CliExit(2, NOT_SET_UP);
        return ackCommand(ctx, a.agent, a.event_id);
      }),
  );

  server.registerTool(
    'courses',
    { title: '課程列表', description: '與 ilearn courses --json 相同。', annotations: READ_ONLY },
    () => run(coursesCommand),
  );

  server.registerTool(
    'course',
    {
      title: '單一課程',
      description: '與 ilearn course <id> --json 相同：上課時間、待辦、已完成、考試、公告、教材與本地路徑、問卷、影片、分數與評語。',
      inputSchema: { id: z.string().describe('課程 id（courses 回傳的 id）') },
      annotations: READ_ONLY,
    },
    (a) => run((ctx) => courseCommand(ctx, a.id)),
  );

  server.registerTool(
    'announcements',
    {
      title: '公告與分類',
      description: '與 ilearn announcements --json 相同。',
      inputSchema: {
        category: z.string().optional().describe('規則分類代碼，例如 room_change'),
        course: z.string().optional().describe('課程 id'),
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run((ctx) =>
        announcementsCommand(ctx, {
          ...(a.category !== undefined ? { category: a.category } : {}),
          ...(a.course !== undefined ? { course: a.course } : {}),
        }),
      ),
  );

  server.registerTool(
    'grades',
    {
      title: '分數與評語',
      description: '與 ilearn grades --json 相同。只在使用者詢問時讀取，不要主動推送分數內容。',
      inputSchema: { course: z.string().optional().describe('課程 id') },
      annotations: READ_ONLY,
    },
    (a) => run((ctx) => gradesCommand(ctx, a.course !== undefined ? { course: a.course } : {})),
  );

  server.registerTool(
    'files_search',
    {
      title: '以檔名搜尋檔案',
      description: '與 ilearn files search <關鍵字> --json 相同，回傳本地路徑。',
      inputSchema: { keyword: z.string().min(1).describe('檔名關鍵字') },
      annotations: READ_ONLY,
    },
    (a) => run((ctx) => filesSearchCommand(ctx, a.keyword)),
  );

  server.registerTool(
    'file_text',
    {
      title: '讀取檔案文字',
      description: '與 ilearn file text <id> --json 相同。目前只支援 .txt 與 .md。',
      inputSchema: { id: z.string().describe('檔案 id（files_search 或 course 回傳的 id）') },
      annotations: READ_ONLY,
    },
    (a) => run((ctx) => fileTextCommand(ctx, a.id)),
  );

  server.registerTool(
    'status',
    { title: '同步狀態', description: '與 ilearn status --json 相同。', annotations: READ_ONLY },
    () => run(statusCommand),
  );

  server.registerTool(
    'rules_list',
    { title: '目前生效的規則', description: '與 ilearn rules list --json 相同，只讀。', annotations: READ_ONLY },
    () => run(rulesListCommand),
  );

  server.registerTool(
    'summaries_pending',
    {
      title: '待摘要的公告與教材',
      description:
        '與 ilearn summaries pending --json 相同：{ agent_write, remaining_today, pending[] }。pending 每筆有 target_id、kind（announcement 或 material）、course、title、body（公告內文）、path（教材的本機絕對路徑）、source_hash。數量已受每日上限限制。',
      annotations: READ_ONLY,
    },
    () => run(pendingSummaries),
  );

  server.registerTool(
    'summaries_write',
    {
      title: '寫回摘要',
      description:
        '與 ilearn summaries write 相同：把你寫好的摘要存回去，之後會出現在公告與課程資料的 summary 欄位。只在使用者允許 agent 寫入摘要時有效，否則回傳錯誤。source_hash 必須是 summaries_pending 給的值，原文變動後會被拒絕。摘要最長 2000 字。何時用：使用者要摘要，而且 summaries_pending 的 agent_write 為 true。agent_write 為 false 或使用者沒有要求時不要用。',
      inputSchema: {
        target_id: z.string().min(1).describe('summaries_pending 回傳的 target_id'),
        source_hash: z.string().min(1).describe('summaries_pending 回傳的 source_hash'),
        text: z.string().describe('摘要文字'),
        agent: z.string().optional().describe('你的 agent 名稱（英數、. _ -，最長 64 字元）'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) =>
      run((ctx) => {
        if (!isSetUp(root)) throw new CliExit(2, NOT_SET_UP);
        return writeSummary(ctx, { target_id: a.target_id, source_hash: a.source_hash, text: a.text, agent: a.agent });
      }),
  );

  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool(
    'config_get',
    {
      title: '目前的權限與可修改的設定',
      description:
        '與 ilearn config get --json 相同，只讀：{ agent_permissions: { summaries, settings }, settings: { quiet_hours, reminders, force_push_offsets, rules[], course_overrides, summaries, interfaces, updates } }。rules 每筆有 id、name、keywords、action、enabled，限定課程時另有 courses。',
      annotations: READ_ONLY,
    },
    () => run(configGet),
  );

  server.registerTool(
    'config_set',
    {
      title: '修改一項設定',
      description:
        '與 ilearn config set <key> <value> --agent 相同，回傳 { key, old, new }。只在使用者允許 agent 修改設定時有效，否則回傳錯誤。key 可用：quiet_hours.start、quiet_hours.end（HH:mm）；reminders.offsets、force_push_offsets（逗號分隔的 ISO 8601 時間長度，如 P1D,PT3H）；rules.<規則代碼>.enabled|action|keywords；course_overrides.<課程 id>.rules.<規則代碼>.enabled|action、course_overrides.<課程 id>.reminders（值 default 表示改回沿用系統）；summaries.courses.<課程 id>.materials|announcements、summaries.daily_limit（0 到 200）；interfaces.folder；updates.check（daily、weekly、off）。布林值用 true 或 false，清單以逗號分隔，action 為 record、push 或 force_push。其他項目一律拒絕。何時用：使用者明確要求調整這些設定，而且 config_get 的 agent_permissions.settings 為 true。步驟：先 config_get 取得舊值，告訴使用者「舊值 → 新值」，使用者同意（或原話已指定確切的值）才改；一次只改一個鍵；回傳錯誤就停止並轉告訊息，不要換其他鍵名重試。',
      inputSchema: {
        key: z.string().min(1).describe('設定的鍵，例如 quiet_hours.start'),
        value: z.string().describe('新的值（字串）'),
        agent: z.string().describe('你的 agent 名稱（英數、. _ -，最長 64 字元）'),
      },
      annotations: WRITE,
    },
    (a) =>
      run((ctx) => {
        if (!isSetUp(root)) throw new CliExit(2, NOT_SET_UP);
        return configSet(ctx, { key: a.key, value: a.value, agent: a.agent });
      }),
  );

  server.registerTool(
    'rules_add',
    {
      title: '新增通知規則',
      description:
        '與 ilearn rules add 相同，回傳新規則 { key, id, name, keywords, action, enabled, courses? }。只在使用者允許 agent 修改設定時有效。代碼自動產生（custom_1、custom_2…）。何時用：使用者要求「提到某些字就通知我」，而 config_get 的 rules 沒有類似規則時；已有類似規則就改用 config_set 修改該規則的 keywords，不要重複新增。',
      inputSchema: {
        name: z.string().min(1).describe('規則名稱'),
        keywords: z.string().min(1).describe('任一關鍵詞，以逗號分隔'),
        action: z.enum(['record', 'push', 'force_push']).describe('推送等級'),
        courses: z.string().optional().describe('只適用的課程 id，以逗號分隔；省略表示全部課程'),
        agent: z.string().describe('你的 agent 名稱（英數、. _ -，最長 64 字元）'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) =>
      run((ctx) => {
        if (!isSetUp(root)) throw new CliExit(2, NOT_SET_UP);
        return rulesAdd(ctx, { name: a.name, keywords: a.keywords, action: a.action, courses: a.courses, agent: a.agent });
      }),
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
