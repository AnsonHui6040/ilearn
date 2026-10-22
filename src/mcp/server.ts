import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dataRoot } from '../config/paths.js';
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
 * 對 agent 開放的全部工具：只讀，加上 events_ack。
 * 刻意不提供：同步、Reload、登入、標記隊員已交、修改規則或設定、讀取帳密。
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
] as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const INSTRUCTIONS = [
  'thu-ilearn：讀取已同步到本機的東海大學 iLearn 資料。',
  '先用 events（deliverable: true，agent: 你的名稱）取得要通知使用者的事件，處理後用 events_ack 標記。',
  'tasks 的 initial_sync_in_progress 為 true 時，資料還在提取中，不要告訴使用者「沒有作業」。',
  'grade.posted、feedback.posted 不含分數內容，使用者詢問時再用 grades 讀取。',
  '這裡沒有同步、登入、標記隊員已交或修改規則的工具，這些都由使用者在自己的終端機操作：',
  '- 標記小組作業「隊員已交」：ilearn mark-teammate <作業 id>（取消標記加 --undo）；作業 id 用 tasks 回傳的 id。這不是在 iLearn 網頁上操作。',
  '- 登入過期：ilearn login。立即同步：ilearn sync。修改規則：ilearn rules edit。',
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
  const server = new McpServer({ name: 'thu-ilearn', version: '0.1.0' }, { instructions: INSTRUCTIONS });

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
      description: '與 ilearn events ack 相同：標記該 agent 已處理到此事件（含之前的）。只影響該 agent 自己的進度。',
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

  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
