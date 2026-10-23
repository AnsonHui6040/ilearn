import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announcementsCommand, courseCommand } from '../src/cli/commands/query.js';
import { CliExit, createContext, writeAccount, type CliContext } from '../src/cli/context.js';
import { askSummaries, formatConfirmation, setupDefaults, setupTracker } from '../src/cli/setup.js';
import { pendingSummariesText } from '../src/cli/format.js';
import { saveConfig } from '../src/config/config.js';
import { upsertCourse, upsertFile, upsertItem, type StoredItem } from '../src/db/repo.js';
import { createMcpServer } from '../src/mcp/server.js';
import { cleanSummaryText, pendingSummaries, summaryTargets, writeSummary } from '../src/summaries/summaries.js';
import { applyChanges, previewChanges } from '../src/tui/actions.js';
import { courseDetail, loadTuiData } from '../src/tui/data.js';
import { buildPage, SYSTEM_ITEMS, type PageSources } from '../src/tui/pages.js';
import { initialState, type Row, type TuiState } from '../src/tui/state.js';

const NOW = new Date('2026-10-22T04:00:00Z'); // 12:00 台北

function mk(root: string = mkdtempSync(join(tmpdir(), 'ilearn-sum-')), now: () => Date = () => NOW): CliContext {
  return createContext({ root, now, userId: 1 });
}

function ann(ctx: CliContext, id: number, courseId: string, title: string, body: string | null = '內文'): void {
  const t = NOW.toISOString();
  const it: StoredItem = {
    id: `announcement:${id}`, kind: 'announcement', course_id: courseId, title, body, due_at: null, start_at: null,
    url: null, completion: 'pending', teammate_hint: false, group: false, score: null, score_published: false,
    feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: t, updated_at: t,
  };
  upsertItem(ctx.db, it);
}

function file(ctx: CliContext, id: string, courseId: string, o: { hash?: string | null; status?: 'done' | 'skipped'; path?: string | null } = {}): void {
  upsertFile(ctx.db, {
    upload_id: id, item_id: 'material:1', course_id: courseId, name: `${id}.pdf`, size: 10,
    hash: o.hash === undefined ? 'h-' + id : o.hash, local_path: o.path === undefined ? `courses/${courseId}/${id}.pdf` : o.path,
    status: o.status ?? 'done', link: null, allow_download: true,
  });
}

function enable(ctx: CliContext, courseId: string, v: { materials?: boolean; announcements?: boolean }, allow = true): void {
  ctx.config.summaries.courses[courseId] = { materials: v.materials ?? false, announcements: v.announcements ?? false };
  ctx.config.summaries.agent_write = allow;
  saveConfig(ctx.config, ctx.root);
}

function seeded(): CliContext {
  const ctx = mk();
  upsertCourse(ctx.db, { id: '1', name: '資料結構', code: '1151_1', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  upsertCourse(ctx.db, { id: '2', name: '微積分', code: '1151_2', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  upsertCourse(ctx.db, { id: '9', name: '舊課', code: '1141_9', semester: '114-2', start_date: '', end_date: '', raw: '{}' });
  ann(ctx, 1, '1', '公告一');
  ann(ctx, 2, '2', '公告二');
  ann(ctx, 3, '9', '舊公告');
  file(ctx, 'f1', '1');
  file(ctx, 'f2', '1', { status: 'skipped', path: null });
  file(ctx, 'f3', '2');
  file(ctx, 'f9', '9');
  return ctx;
}

const ids = (ctx: CliContext): string[] => pendingSummaries(ctx).pending.map((p) => p.target_id).sort();
const refuse = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliExit);
    expect((e as CliExit).code).toBe(1);
    return (e as CliExit).message;
  }
  throw new Error('expected refusal');
};
const hashOf = (ctx: CliContext, id: string): string => {
  const p = summaryTargets(ctx).find((x) => x.target_id === id);
  if (!p) throw new Error(`no target: ${id}`);
  return p.source_hash;
};

describe('pending queue', () => {
  it('selects per kind and per course toggle, latest semester only', () => {
    const ctx = seeded();
    expect(ids(ctx)).toEqual([]);
    enable(ctx, '1', { announcements: true });
    expect(ids(ctx)).toEqual(['announcement:1']);
    enable(ctx, '1', { materials: true });
    expect(ids(ctx)).toEqual(['file:f1']);
    enable(ctx, '2', { announcements: true, materials: true });
    ctx.config.summaries.courses['9'] = { materials: true, announcements: true };
    enable(ctx, '1', { announcements: true, materials: true });
    expect(ids(ctx)).toEqual(['announcement:1', 'announcement:2', 'file:f1', 'file:f3']);
  });

  it('describes entries with titles, body, absolute path and hashes', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true, materials: true });
    const r = pendingSummaries(ctx);
    const a = r.pending.find((p) => p.target_id === 'announcement:1');
    const f = r.pending.find((p) => p.target_id === 'file:f1');
    expect(a).toMatchObject({ kind: 'announcement', course: { id: '1', name: '資料結構' }, title: '公告一', body: '內文', path: null });
    expect(f).toMatchObject({ kind: 'material', title: 'f1.pdf', body: null, path: join(ctx.root, 'courses/1/f1.pdf'), source_hash: 'h-f1' });
    expect(a?.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r).toMatchObject({ agent_write: true, remaining_today: 20 });
    expect(pendingSummariesText(r)).toContain('file:f1');
  });

  it('falls back to a hash of name and size when a file has no stored hash', () => {
    const ctx = seeded();
    file(ctx, 'nh', '1', { hash: null });
    enable(ctx, '1', { materials: true });
    const h = hashOf(ctx, 'file:nh');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-queues a target when its content changes', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true });
    writeSummary(ctx, { target_id: 'announcement:1', source_hash: hashOf(ctx, 'announcement:1'), text: '摘要' });
    expect(ids(ctx)).toEqual([]);
    ann(ctx, 1, '1', '公告一', '改過的內文');
    expect(ids(ctx)).toEqual(['announcement:1']);
  });

  it('caps the list at the remaining daily limit and resets on the next Taipei day', () => {
    let now = NOW;
    const root = mkdtempSync(join(tmpdir(), 'ilearn-sum-'));
    const ctx = mk(root, () => now);
    upsertCourse(ctx.db, { id: '1', name: 'A', code: 'a', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
    for (let i = 1; i <= 4; i++) ann(ctx, i, '1', `t${i}`);
    enable(ctx, '1', { announcements: true });
    ctx.config.summaries.daily_limit = 2;
    expect(pendingSummaries(ctx).pending).toHaveLength(2);
    writeSummary(ctx, { target_id: 'announcement:1', source_hash: hashOf(ctx, 'announcement:1'), text: 'a' });
    writeSummary(ctx, { target_id: 'announcement:2', source_hash: hashOf(ctx, 'announcement:2'), text: 'b' });
    expect(pendingSummaries(ctx)).toMatchObject({ remaining_today: 0, pending: [] });
    now = new Date('2026-10-22T15:59:00Z'); // 台北 23:59，仍是同一天
    expect(pendingSummaries(ctx).remaining_today).toBe(0);
    now = new Date('2026-10-22T16:01:00Z'); // 台北隔天 00:01
    expect(pendingSummaries(ctx)).toMatchObject({ remaining_today: 2 });
    expect(pendingSummaries(ctx).pending).toHaveLength(2);
  });
});

describe('writeSummary', () => {
  it('refuses when the user has not allowed agent writes', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true }, false);
    const msg = refuse(() => writeSummary(ctx, { target_id: 'announcement:1', source_hash: 'x', text: 'a' }));
    expect(msg).toContain('ilearn setup 第 8 步');
    expect(msg).toContain('ilearn ui');
  });

  it('refuses unknown targets, disabled kinds and old semesters', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true });
    const w = (id: string) => writeSummary(ctx, { target_id: id, source_hash: 'x', text: 'a' });
    expect(refuse(() => w('announcement:404'))).toContain('找不到');
    expect(refuse(() => w('file:f1'))).toContain('找不到'); // 教材摘要沒有啟用
    expect(refuse(() => w('announcement:2'))).toContain('找不到'); // 課程沒有啟用
    expect(refuse(() => w('announcement:3'))).toContain('找不到'); // 舊學期
  });

  it('refuses a stale hash, an empty text, an invalid agent and the daily limit', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true });
    const good = hashOf(ctx, 'announcement:1');
    expect(refuse(() => writeSummary(ctx, { target_id: 'announcement:1', source_hash: 'old', text: 'a' }))).toContain('原文已變動');
    expect(refuse(() => writeSummary(ctx, { target_id: 'announcement:1', source_hash: good, text: ' \u0007\n ' }))).toContain('空的');
    expect(refuse(() => writeSummary(ctx, { target_id: 'announcement:1', source_hash: good, text: 'a', agent: 'bad name!' }))).toContain('無效的 agent 名稱');
    ctx.config.summaries.daily_limit = 0;
    expect(refuse(() => writeSummary(ctx, { target_id: 'announcement:1', source_hash: good, text: 'a' }))).toContain('每日上限');
    expect(ids(ctx)).toEqual([]);
  });

  it('strips control characters, keeps newlines, caps at 2000 characters and upserts', () => {
    expect(cleanSummaryText('  a\u0000b\u001b[31mc\r\nd\te\u0085  ')).toBe('ab[31mc\nde');
    const ctx = seeded();
    enable(ctx, '1', { announcements: true });
    const h = hashOf(ctx, 'announcement:1');
    const r = writeSummary(ctx, { target_id: 'announcement:1', source_hash: h, text: '字'.repeat(2500), agent: 'codex' });
    expect(r).toMatchObject({ target_id: 'announcement:1', kind: 'announcement', remaining_today: 19, written_at: '2026-10-22T12:00:00+08:00' });
    const stored = ctx.db.prepare('SELECT text, agent FROM summaries').get() as { text: string; agent: string };
    expect(stored.text).toHaveLength(2000);
    expect(stored.agent).toBe('codex');
    writeSummary(ctx, { target_id: 'announcement:1', source_hash: h, text: '第二版' });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n, text FROM summaries').get()).toMatchObject({ n: 1, text: '第二版' });
  });
});

describe('summary display', () => {
  it('shows summary in course JSON (announcements and files) and in announcements JSON', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true, materials: true });
    writeSummary(ctx, { target_id: 'announcement:1', source_hash: hashOf(ctx, 'announcement:1'), text: '公告摘要' });
    writeSummary(ctx, { target_id: 'file:f1', source_hash: hashOf(ctx, 'file:f1'), text: '教材摘要' });
    const c = courseCommand(ctx, '1');
    expect(c.announcements.map((a) => a.summary)).toEqual(['公告摘要']);
    expect(c.files.find((f) => f.id === 'f1')?.summary).toBe('教材摘要');
    expect(c.files.find((f) => f.id === 'f2')?.summary).toBeNull();
    const all = announcementsCommand(ctx, {});
    expect(all.find((a) => a.id === 'announcement:1')?.summary).toBe('公告摘要');
    expect(all.find((a) => a.id === 'announcement:2')?.summary).toBeNull();
  });
});

describe('MCP tools', () => {
  let clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
  });
  async function connect(root: string): Promise<Client> {
    const server = createMcpServer({ root, now: () => NOW });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  }
  type R = { content: { text: string }[]; isError?: boolean };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<R> => (await c.callTool({ name, arguments: args })) as R;

  it('lists both tools, with only summaries_pending read-only', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-mcp-')));
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'summaries_pending')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'summaries_write')?.annotations?.readOnlyHint).toBe(false);
  });

  it('returns pending, refuses writes until allowed, then writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ilearn-mcp-'));
    mkdirSync(root, { recursive: true });
    const ctx = mk(root);
    upsertCourse(ctx.db, { id: '1', name: '資料結構', code: 'a', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
    ann(ctx, 1, '1', '公告一');
    writeAccount(root, { username: 's1', user_id: 1 });
    enable(ctx, '1', { announcements: true }, false);
    ctx.db.close();
    const c = await connect(root);
    const p = JSON.parse((await call(c, 'summaries_pending')).content[0]?.text ?? '') as ReturnType<typeof pendingSummaries>;
    expect(p).toMatchObject({ agent_write: false, remaining_today: 20 });
    const hash = p.pending[0]?.source_hash ?? '';
    const denied = await call(c, 'summaries_write', { target_id: 'announcement:1', source_hash: hash, text: '摘要' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('尚未允許');

    const ctx2 = mk(root);
    ctx2.config.summaries.agent_write = true;
    saveConfig(ctx2.config, root);
    ctx2.db.close();
    const ok = await call(c, 'summaries_write', { target_id: 'announcement:1', source_hash: hash, text: '摘要', agent: 'codex' });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]?.text ?? '')).toMatchObject({ target_id: 'announcement:1', remaining_today: 19 });
    const after = JSON.parse((await call(c, 'summaries_pending')).content[0]?.text ?? '') as ReturnType<typeof pendingSummaries>;
    expect(after.pending).toEqual([]);
  });
});

describe('setup wizard', () => {
  const quiet = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  function prompts(checks: string[][], confirmAnswer: boolean) {
    const confirms: { message: string; default: boolean }[] = [];
    return {
      confirms,
      p: {
        checkbox: (() => Promise.resolve(checks.shift() ?? [])) as never,
        confirm: ((o: { message: string; default: boolean }) => (confirms.push(o), Promise.resolve(confirmAnswer))) as never,
      } as never,
    };
  }
  const run = async (ctx: CliContext, p: never) => {
    const out = quiet();
    await askSummaries(ctx, p, setupDefaults(ctx.config, 'desktop'), setupTracker(ctx.root));
    out.mockRestore();
  };

  it('asks about agent writes when a course is enabled, defaulting to yes the first time', async () => {
    const ctx = seeded();
    const f = prompts([['1'], []], true);
    await run(ctx, f.p);
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]?.message).toBe('允許 agent 寫入摘要嗎？（agent 透過 ilearn summaries write 或 MCP 寫回，本工具不會呼叫任何 AI）');
    expect(f.confirms[0]?.default).toBe(true);
    expect(ctx.config.summaries.agent_write).toBe(true);
    expect(formatConfirmation(ctx)).toContain('8 老師公告摘要：沒有選擇任何課程；agent 寫入摘要：允許');
  });

  it('does not ask and stores false when no course is enabled', async () => {
    const ctx = seeded();
    ctx.config.summaries.agent_write = true;
    const f = prompts([[], []], true);
    await run(ctx, f.p);
    expect(f.confirms).toHaveLength(0);
    expect(ctx.config.summaries.agent_write).toBe(false);
    expect(formatConfirmation(ctx)).toContain('agent 寫入摘要：不允許');
  });

  it('keeps a previously saved answer as the default', async () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true }, false);
    const f = prompts([['1'], ['1']], false);
    await run(ctx, f.p);
    expect(f.confirms[0]?.default).toBe(false);
    expect(ctx.config.summaries.agent_write).toBe(false);
  });
});

describe('TUI', () => {
  const sources = (ctx: CliContext): PageSources => ({ detail: (id) => courseDetail(ctx, id), preview: (c) => previewChanges(ctx, c) });
  const state = (over: Partial<TuiState>): TuiState => ({ ...initialState(), ...over });

  it('shows two tickable summary rows per course', () => {
    const ctx = seeded();
    const right = buildPage(state({ tab: 4, cursor: [1, 0] }), loadTuiData(ctx), 100, sources(ctx)).panes[1] ?? [];
    const rows = right.filter((r) => r.key?.startsWith('csum:'));
    expect(rows.map((r) => r.text.trim())).toEqual(['[ ] 教材檔案摘要', '[ ] 老師公告摘要']);
    expect(rows[0]?.tick).toEqual({ kind: 'courseSummary', courseId: '1', summary: 'materials', enabled: true });
    expect(rows[1]?.tick).toEqual({ kind: 'courseSummary', courseId: '1', summary: 'announcements', enabled: true });
  });

  it('applies course summary ticks and removes empty entries', () => {
    const ctx = seeded();
    const changes = [
      { kind: 'courseSummary', courseId: '1', summary: 'materials', enabled: true },
      { kind: 'courseSummary', courseId: '1', summary: 'announcements', enabled: true },
    ] as const;
    expect(previewChanges(ctx, [...changes]).slice(1)).toEqual(['資料結構「教材檔案摘要」：啟用', '資料結構「老師公告摘要」：啟用']);
    expect(applyChanges(ctx, [...changes]).applied).toBe(2);
    expect(ctx.config.summaries.courses['1']).toEqual({ materials: true, announcements: true });
    applyChanges(ctx, [{ kind: 'courseSummary', courseId: '1', summary: 'materials', enabled: false }]);
    expect(ctx.config.summaries.courses['1']).toEqual({ materials: false, announcements: true });
    applyChanges(ctx, [{ kind: 'courseSummary', courseId: '1', summary: 'announcements', enabled: false }]);
    expect(ctx.config.summaries.courses['1']).toBeUndefined();
  });

  it('puts the summary item after the notification rules and toggles agent_write', () => {
    const ctx = seeded();
    const idx = SYSTEM_ITEMS.indexOf('摘要');
    expect(idx).toBe(SYSTEM_ITEMS.indexOf('通知規則') + 1);
    const right: Row[] = buildPage(state({ tab: 5, cursor: [idx + 1, 0] }), loadTuiData(ctx), 100, sources(ctx)).panes[1] ?? [];
    const text = right.map((r) => r.text).join('\n');
    expect(text).toContain('[ ] 允許 agent 寫入摘要');
    expect(text).toContain('每日上限：20 則');
    expect(text).toContain('今天已寫入：0 則');
    const tick = right.find((r) => r.key === 'agent-write')?.tick;
    expect(tick).toEqual({ kind: 'agentWrite', enabled: true });
    expect(previewChanges(ctx, [tick!]).at(1)).toBe('允許 agent 寫入摘要：允許');
    applyChanges(ctx, [tick!]);
    expect(ctx.config.summaries.agent_write).toBe(true);
  });

  it('shows a summary under announcements and material files in the course page', () => {
    const ctx = seeded();
    enable(ctx, '1', { announcements: true, materials: true });
    writeSummary(ctx, { target_id: 'announcement:1', source_hash: hashOf(ctx, 'announcement:1'), text: '這則公告的摘要' });
    writeSummary(ctx, { target_id: 'file:f1', source_hash: hashOf(ctx, 'file:f1'), text: '這份教材的摘要' });
    const view = { kind: 'course' as const, courseId: '1', section: 3 };
    const at = (section: number): Row[] =>
      buildPage(state({ tab: 2, stack: [view], saved: [{ focus: 0, cursor: [0, 0], scroll: [0, 0] }], cursor: [section, 0] }), loadTuiData(ctx), 100, sources(ctx)).panes[1] ?? [];
    const a = at(3);
    const i = a.findIndex((r) => r.text.includes('公告一'));
    expect(a.slice(i).some((r) => r.text.includes('這則公告的摘要') && r.style === 'dim')).toBe(true);
    expect(at(4).some((r) => r.text.includes('這份教材的摘要') && r.style === 'dim')).toBe(true);
  });
});
