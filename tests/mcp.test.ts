import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { eventsCommand, statusCommand, tasksCommand } from '../src/cli/commands/query.js';
import { reloadCommand } from '../src/cli/commands/sync.js';
import { createContext, writeAccount, type CliContext } from '../src/cli/context.js';
import { createMcpServer, MCP_TOOLS } from '../src/mcp/server.js';
import { runSync } from '../src/sync/sync.js';
import { courseViewHtml, createFakeApi, standardData } from './helpers/fakeApi.js';

const NOW = new Date('2026-10-22T05:00:00Z'); // 13:00 台北

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

async function seededRoot(): Promise<{ root: string; ctx: CliContext }> {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-mcp-'));
  const fake = createFakeApi(standardData());
  const ctx = createContext({
    root,
    api: fake.api,
    fetchText: () => Promise.resolve(courseViewHtml()),
    now: () => NOW,
    userId: 777,
  });
  await runSync(ctx);
  writeAccount(root, { username: 's11234567', user_id: 777 });
  await reloadCommand(ctx, { yes: true });
  return { root, ctx };
}

type CallResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await c.callTool({ name, arguments: args })) as CallResult;
}

const parse = (r: CallResult): unknown => JSON.parse(r.content[0]?.text ?? 'null');

describe('MCP server', () => {
  it('exposes exactly the read tools plus the permission-gated writers', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-mcp-')));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(!['events_ack', 'summaries_write', 'config_set', 'rules_add'].includes(t.name));
      expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
    }
  });

  it('offers nothing that syncs, logs in, marks teammates, edits rules or reads credentials', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-mcp-')));
    const { tools } = await c.listTools();
    const text = JSON.stringify(tools.map((t) => [t.name, t.inputSchema]));
    for (const banned of ['sync', 'reload', 'login', 'logout', 'setup', 'mark', 'teammate', 'rules_edit', 'password', 'cookie', 'session', 'credential']) {
      expect(tools.map((t) => t.name).filter((n) => n.includes(banned)), banned).toEqual([]);
    }
    expect(text).not.toMatch(/password|cookie|credential/i);
    for (const name of ['mark_teammate', 'rules_edit', 'login', 'sync']) {
      const r = await call(c, name);
      expect(r.isError, name).toBe(true);
    }
  });

  it('tells agents the user marks teammate submissions with ilearn mark-teammate, not on the iLearn website', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-mcp-')));
    const text = c.getInstructions() ?? '';
    expect(text).toContain('ilearn mark-teammate <作業 id>');
    expect(text).toContain('不是在 iLearn 網頁上操作');
    expect(text).toContain('ilearn login');
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'tasks')?.description).toContain('ilearn mark-teammate');
  });

  it('returns the same data as the CLI JSON commands', async () => {
    const { root, ctx } = await seededRoot();
    const c = await connect(root);
    expect(parse(await call(c, 'tasks'))).toEqual(JSON.parse(JSON.stringify(tasksCommand(ctx))));
    const deliverable = parse(await call(c, 'events', { deliverable: true, agent: 'claude' })) as { event_id: string }[];
    expect(deliverable.map((e) => e.event_id)).toEqual(eventsCommand(ctx, { deliverable: true, agent: 'claude' }).map((e) => e.event_id));
    expect(deliverable.length).toBeGreaterThan(0);
    const status = parse(await call(c, 'status')) as ReturnType<typeof statusCommand>;
    expect(status.initial_sync_in_progress).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/password|cookie/i);
    const courses = parse(await call(c, 'courses')) as { id: string }[];
    expect(courses.length).toBeGreaterThan(0);
    const course = parse(await call(c, 'course', { id: courses[0]!.id })) as { course: { id: string } };
    expect(course.course.id).toBe(courses[0]!.id);
    expect(parse(await call(c, 'files_search', { keyword: '講義' }))).toHaveLength(1);
    expect(Array.isArray(parse(await call(c, 'rules_list')))).toBe(true);
  });

  it('events_ack only moves that agent cursor', async () => {
    const { root } = await seededRoot();
    const c = await connect(root);
    const list = parse(await call(c, 'events', { deliverable: true, agent: 'claude' })) as { event_id: string }[];
    const last = list[list.length - 1]!.event_id;
    expect(parse(await call(c, 'events_ack', { agent: 'claude', event_id: last }))).toEqual({ agent: 'claude', last_event_id: last });
    expect(parse(await call(c, 'events', { deliverable: true, agent: 'claude' }))).toEqual([]);
    expect(parse(await call(c, 'events', { deliverable: true, agent: 'hermes' }))).toHaveLength(list.length);
    expect((await call(c, 'events_ack', { agent: '../x', event_id: last })).isError).toBe(true);
    expect((await call(c, 'events_ack', { agent: 'claude', event_id: 'nope' })).isError).toBe(true);
  });

  it('reports errors as tool errors instead of crashing', async () => {
    const { root } = await seededRoot();
    const c = await connect(root);
    const r = await call(c, 'course', { id: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('找不到課程');
    expect((await call(c, 'events', { type: 'not.a.type' })).isError).toBe(true);
    expect(parse(await call(c, 'tasks'))).toMatchObject({ initial_sync_in_progress: false });
  });

  it('before setup: reads return empty, ack is refused, nothing is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ilearn-mcp-'));
    const c = await connect(root);
    expect(parse(await call(c, 'tasks'))).toMatchObject({ tasks: [] });
    expect(parse(await call(c, 'tasks'))).toMatchObject({ tasks: [] });
    const ack = await call(c, 'events_ack', { agent: 'claude', event_id: 'x' });
    expect(ack.isError).toBe(true);
    expect(ack.content[0]?.text).toContain('ilearn setup');
    expect(existsSync(join(root, 'data'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
