import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configGet, configSet } from '../src/agent/settings.js';
import { deliveryTestCommand, deliveryTestStatusCommand } from '../src/cli/commands/delivery.js';
import { ackCommand, eventsCommand, reportCommand, statusCommand } from '../src/cli/commands/query.js';
import { CliExit, createContext, writeAccount, type CliContext } from '../src/cli/context.js';
import { statusText, testStatusText } from '../src/cli/format.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config/config.js';
import { dispatchPending, postWebhook, runHook } from '../src/events/dispatch.js';
import { makeEvent, Outbox } from '../src/events/outbox.js';
import { renderFolderView } from '../src/folder/folder.js';
import { loadTuiData } from '../src/tui/data.js';
import { createMcpServer, INSTRUCTIONS, MCP_TOOLS } from '../src/mcp/server.js';
import type { IlearnEvent } from '../src/types.js';

const quiet = { start: '00:00', end: '07:00' };
const NOON = new Date('2026-10-22T04:00:00Z'); // 12:00 Taipei
const SECRET = 'SECRET_VALUE_xyz_123';

function ev(n: number, over: Partial<Parameters<typeof makeEvent>[0]> = {}): IlearnEvent {
  return makeEvent({
    type: 'announcement.new',
    delivery: 'push',
    categories: [],
    matched_rules: [],
    course: { id: '1', name: '資料結構', semester: '115-1' },
    item: { id: `a${n}`, kind: 'announcement', title: `公告 ${n}`, due_at: null, url: null },
    summary: null,
    dedupe_key: `announcement.new:${n}`,
    detectedAt: new Date(NOON.getTime() - 60_000 + n * 1000),
    quiet,
    ...over,
  });
}

let root: string;
let now = NOON;
let ctx: CliContext;
let server: Server | null = null;
const dbs: CliContext[] = [];

function open(): CliContext {
  const c = createContext({ root, now: () => now, userId: 1 });
  dbs.push(c);
  return c;
}

beforeEach(() => {
  now = NOON;
  root = mkdtempSync(join(tmpdir(), 'ilearn-adapters-'));
  ctx = open();
  writeAccount(root, { username: 's11234567', user_id: 1 });
});
afterEach(() => {
  server?.close();
  server = null;
  for (const c of dbs.splice(0)) c.db.close();
});

interface Captured {
  headers: IncomingHttpHeaders;
  body: string;
}

async function listen(captured: Captured[], status = 204): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      captured.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

const hmac = (secret: string, ts: string, body: string): string => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

describe('CLI Adapter rename and compatibility', () => {
  it('loads a legacy delivery.hook as delivery.cli and saves it back as cli', () => {
    writeFileSync(join(root, 'config.yaml'), 'delivery:\n  hook:\n    enabled: true\n    command: my-agent notify\n  webhook:\n    enabled: false\n    url: ""\n');
    const cfg = loadConfig(root);
    expect(cfg.delivery.cli).toEqual({ enabled: true, command: 'my-agent notify' });
    expect(cfg.delivery.webhook.secret).toBe('');
    expect('hook' in cfg.delivery).toBe(false);
    saveConfig(cfg, root);
    const text = readFileSync(join(root, 'config.yaml'), 'utf8');
    expect(text).toContain('cli:');
    expect(text).not.toMatch(/^\s+hook:/m);
    expect(loadConfig(root).delivery.cli.command).toBe('my-agent notify');
  });

  it('prefers delivery.cli when both exist', () => {
    writeFileSync(join(root, 'config.yaml'), 'delivery:\n  hook:\n    enabled: true\n    command: old\n  cli:\n    enabled: true\n    command: new\n');
    expect(loadConfig(root).delivery.cli.command).toBe('new');
  });

  it('migrates hook: state keys to cli: and keeps retry state', () => {
    const e = ev(1);
    ctx.outbox.append(e);
    const statePath = join(root, 'outbox', 'state.json');
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as { hooks: Record<string, unknown> };
    st.hooks[`hook:${e.event_id}`] = { ok: false, attempts: 1, last_attempt: '2026-10-22T12:00:00+08:00', last_error: 'exit code 1' };
    writeFileSync(statePath, JSON.stringify(st));
    const box = new Outbox(root);
    expect(box.hookStats('cli', NOON)).toEqual({ retrying: 1, gave_up: 0, last_error: 'exit code 1' });
    expect(box.pendingHooks('cli', new Date(NOON.getTime() + 60_000))).toHaveLength(0); // backoff 未到
    box.markHook('cli', e.event_id, true, NOON);
    expect(readFileSync(statePath, 'utf8')).not.toContain('"hook:');
  });

  it('status returns cli and the same object under the legacy hook name, never the secret', () => {
    ctx.config.delivery.cli = { enabled: true, command: 'my-agent notify' };
    ctx.config.delivery.webhook = { enabled: true, url: 'http://127.0.0.1:9/x', secret: SECRET };
    const s = statusCommand(ctx);
    expect(s.delivery.cli.enabled).toBe(true);
    expect(s.delivery.hook).toEqual(s.delivery.cli);
    const all = JSON.stringify(s) + statusText(s);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('my-agent notify');
    expect(all).not.toContain('127.0.0.1:9');
    expect(s.processing_failures).toEqual([]);
  });

  it('exposes ILEARN_DELIVERY to the CLI Adapter', async () => {
    const out = join(root, 'env.txt');
    const e = ev(1);
    await runHook(`printf '%s' "$ILEARN_DELIVERY" > "${out}"`, e);
    expect(readFileSync(out, 'utf8')).toBe('event');
    await runHook(`printf '%s' "$ILEARN_DELIVERY" > "${out}"`, e, 5000, 'test');
    expect(readFileSync(out, 'utf8')).toBe('test');
  });
});

describe('webhook signing', () => {
  it('signs the exact body with HMAC-SHA256 over timestamp.body and sends the id headers', async () => {
    const got: Captured[] = [];
    const url = await listen(got);
    const e = ev(1);
    await postWebhook(url, e, fetch, 5000, { secret: SECRET });
    const { headers, body } = got[0]!;
    const ts = headers['x-webhook-timestamp'] as string;
    expect(ts).toMatch(/^\d{10}$/);
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10);
    expect(headers['x-webhook-signature-v2']).toBe(hmac(SECRET, ts, body));
    expect(headers['x-webhook-signature-v2']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(body)).toEqual(e);
    expect(headers['x-request-id']).toBe(e.event_id);
    expect(headers['x-thu-ilearn-event-id']).toBe(e.event_id);
    expect(headers['x-thu-ilearn-delivery']).toBe('event');
  });

  it('adds no signature headers without a secret but still sends the id headers', async () => {
    const got: Captured[] = [];
    const url = await listen(got);
    const e = ev(1);
    await postWebhook(url, e);
    expect(got[0]!.headers['x-webhook-signature-v2']).toBeUndefined();
    expect(got[0]!.headers['x-webhook-timestamp']).toBeUndefined();
    expect(got[0]!.headers['x-request-id']).toBe(e.event_id);
  });

  it('dispatchPending signs formal events with the configured secret', async () => {
    const got: Captured[] = [];
    const url = await listen(got);
    ctx.outbox.append(ev(1));
    const d = structuredClone(DEFAULT_CONFIG.delivery);
    d.webhook = { enabled: true, url, secret: SECRET };
    await dispatchPending(ctx.outbox, d, NOON);
    const { headers, body } = got[0]!;
    expect(headers['x-webhook-signature-v2']).toBe(hmac(SECRET, headers['x-webhook-timestamp'] as string, body));
  });

  it('a failing webhook error never contains the secret', async () => {
    ctx.outbox.append(ev(1));
    const d = structuredClone(DEFAULT_CONFIG.delivery);
    d.webhook = { enabled: true, url: 'http://127.0.0.1:1/x', secret: SECRET };
    await dispatchPending(ctx.outbox, d, NOON);
    const stats = ctx.outbox.hookStats('webhook', NOON);
    expect(stats.retrying).toBe(1);
    expect(JSON.stringify(stats)).not.toContain(SECRET);
  });

  it('agents cannot read or change delivery settings or the secret', () => {
    ctx.config.agent_permissions.settings = true;
    ctx.config.delivery.webhook.secret = SECRET;
    saveConfig(ctx.config, root);
    const c = open();
    expect(JSON.stringify(configGet(c))).not.toContain(SECRET);
    expect(() => configSet(c, { key: 'delivery.webhook.secret', value: 'x', agent: 'codex' })).toThrow(/推送方式/);
    expect(() => configSet(c, { key: 'delivery.cli.command', value: 'x', agent: 'codex' })).toThrow(/推送方式/);
    expect(loadConfig(root).delivery.webhook.secret).toBe(SECRET);
  });
});

describe('delivery test isolation and four levels', () => {
  const PASS_CLI = 'cat > /dev/null';

  it('keeps test events out of the formal outbox, cursors, dedupe and retry state', async () => {
    const formal = ev(1);
    ctx.outbox.append(formal);
    const before = readFileSync(join(root, 'outbox', 'state.json'), 'utf8');
    ctx.config.delivery.cli = { enabled: true, command: PASS_CLI };
    const r = await deliveryTestCommand(ctx, { agent: 'claude' });

    expect(eventsCommand(ctx, {}).map((e) => e.event_id)).toEqual([formal.event_id]);
    expect(eventsCommand(ctx, { deliverable: true, agent: 'claude' }).map((e) => e.event_id)).toEqual([formal.event_id]);
    expect(ctx.outbox.read()).toHaveLength(1);
    expect(ctx.outbox.pendingHooks('cli', NOON).map((e) => e.event_id)).toEqual([formal.event_id]);
    expect(readFileSync(join(root, 'outbox', 'state.json'), 'utf8')).toBe(before);
    expect(readdirSync(join(root, 'outbox', 'cursors'))).toEqual([]);
    expect(readFileSync(join(root, 'outbox', 'events', '2026-10-22.jsonl'), 'utf8')).not.toContain('delivery.test');
    expect(existsSync(join(root, 'outbox', 'test', `${r.test_id}.json`))).toBe(true);
    expect(() => eventsCommand(ctx, { type: 'delivery.test' })).toThrow(/未知的事件類型/);
    // 正式去重不受影響
    expect(ctx.outbox.append(ev(1))).toBe(false);
    expect(ctx.outbox.append(ev(2))).toBe(true);
  });

  it('the test event has the documented v1 shape', async () => {
    const r = await deliveryTestCommand(ctx, { agent: 'claude' });
    const [e] = eventsCommand(ctx, { agent: 'claude', test: true });
    expect(e).toMatchObject({
      schema: 'thu-ilearn.event.v1',
      event_id: r.test_id,
      type: 'delivery.test',
      delivery: 'push',
      course: null,
      item: null,
      summary: 'thu-ilearn 推送測試',
      dedupe_key: `delivery.test:${r.test_id}`,
    });
    expect(e!.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('walks transport, agent read, processing and ack in order', async () => {
    const got: Captured[] = [];
    const url = await listen(got);
    ctx.config.delivery.cli = { enabled: true, command: PASS_CLI };
    ctx.config.delivery.webhook = { enabled: true, url, secret: SECRET };
    const r = await deliveryTestCommand(ctx, { agent: 'claude' });
    expect(r.transport.status).toBe('PASS');
    expect(r.signed).toBe(true);
    expect(got[0]!.headers['x-thu-ilearn-delivery']).toBe('test');
    expect(got[0]!.headers['x-request-id']).toBe(r.test_id);
    expect(got[0]!.headers['x-webhook-signature-v2']).toBe(hmac(SECRET, got[0]!.headers['x-webhook-timestamp'] as string, got[0]!.body));
    expect(r.next_steps).toHaveLength(4);

    let s = deliveryTestStatusCommand(ctx, r.test_id);
    expect([s.transport.status, s.agent_read.status, s.processing.status, s.ack.status]).toEqual(['PASS', 'PENDING', 'PENDING', 'PENDING']);
    expect(s.transport.webhook).toMatchObject({ status: 'PASS', http_status: 204, signed: true });

    // 別的 agent 讀不到，也不會記成已讀
    expect(eventsCommand(ctx, { agent: 'other', test: true })).toEqual([]);
    expect(deliveryTestStatusCommand(ctx, r.test_id).agent_read.status).toBe('PENDING');

    expect(eventsCommand(ctx, { agent: 'claude', test: true })).toHaveLength(1);
    s = deliveryTestStatusCommand(ctx, r.test_id);
    expect([s.agent_read.status, s.processing.status, s.ack.status]).toEqual(['PASS', 'PENDING', 'PENDING']);

    reportCommand(ctx, { agent: 'claude', eventId: r.test_id, status: 'processed', test: true });
    s = deliveryTestStatusCommand(ctx, r.test_id);
    expect([s.processing.status, s.ack.status]).toEqual(['PASS', 'PENDING']);

    ackCommand(ctx, 'claude', r.test_id, { test: true });
    s = deliveryTestStatusCommand(ctx, r.test_id);
    expect([s.transport.status, s.agent_read.status, s.processing.status, s.ack.status]).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    // ACK 後測試事件檔才刪除，結果保留
    expect(existsSync(join(root, 'outbox', 'test', `${r.test_id}.json`))).toBe(false);
    expect(existsSync(join(root, 'outbox', 'test', 'results.json'))).toBe(true);
    expect(eventsCommand(ctx, { agent: 'claude', test: true })).toEqual([]);
    expect(testStatusText(s)).toContain('4 ACK：PASS');
  });

  it('reports a clear transport failure when nothing listens, and a reported processing failure', async () => {
    const url = await listen([]);
    server!.close();
    server = null;
    ctx.config.delivery.webhook = { enabled: true, url, secret: '' };
    const r = await deliveryTestCommand(ctx, { agent: 'claude' });
    expect(r.transport.status).toBe('FAIL');
    expect(r.transport.cli.status).toBe('未啟用');
    expect(r.transport.webhook.error).toMatch(/連線被拒：127\.0\.0\.1:\d+ 沒有程式在接收/);
    expect(r.signed).toBe(false);
    expect(testStatusText(deliveryTestStatusCommand(ctx, r.test_id))).toContain('未簽名');

    reportCommand(ctx, { agent: 'claude', eventId: r.test_id, status: 'failed', note: '解析失敗', test: true });
    const s = deliveryTestStatusCommand(ctx, r.test_id);
    expect(s.processing).toMatchObject({ status: 'FAIL', note: '解析失敗' });
    // 測試的失敗不會出現在正式 status
    expect(statusCommand(ctx).processing_failures).toEqual([]);
  });

  it('marks nothing enabled as 未啟用 and rejects unknown ids and foreign agents', async () => {
    const r = await deliveryTestCommand(ctx, { agent: 'claude' });
    expect(r.transport.status).toBe('未啟用');
    expect(() => deliveryTestStatusCommand(ctx, 'NOPE')).toThrow(/找不到測試/);
    expect(() => ackCommand(ctx, 'other', r.test_id, { test: true })).toThrow(/不是 other 的測試/);
    expect(() => ackCommand(ctx, 'claude', 'NOPE', { test: true })).toThrow(/找不到測試事件/);
    expect(() => eventsCommand(ctx, { test: true })).toThrow(/--agent/);
    await expect(deliveryTestCommand(ctx, { agent: '../x' })).rejects.toThrow(/無效的 agent/);
  });

  it('times out after 24 hours without ack and cleans up on the next test run', async () => {
    const first = await deliveryTestCommand(ctx, { agent: 'claude' });
    now = new Date(NOON.getTime() + 25 * 3_600_000);
    expect(eventsCommand(ctx, { agent: 'claude', test: true })).toEqual([]);
    expect(deliveryTestStatusCommand(ctx, first.test_id).timed_out).toBe(true);
    expect(testStatusText(deliveryTestStatusCommand(ctx, first.test_id))).toContain('已逾時');
    expect(existsSync(join(root, 'outbox', 'test', `${first.test_id}.json`))).toBe(true);
    const second = await deliveryTestCommand(ctx, { agent: 'claude' });
    expect(existsSync(join(root, 'outbox', 'test', `${first.test_id}.json`))).toBe(false);
    expect(deliveryTestStatusCommand(ctx, first.test_id).timed_out).toBe(true);
    expect(deliveryTestStatusCommand(ctx, second.test_id).timed_out).toBe(false);
  });
});

describe('processing failure report', () => {
  it('records failures, shows them in status, and never moves the cursor', () => {
    const [a, b, c] = [ev(1), ev(2), ev(3)];
    [a, b, c].forEach((e) => ctx.outbox.append(e!));
    ackCommand(ctx, 'claude', a!.event_id);
    const r = reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'failed', note: `行一\n行二\u0007${'x'.repeat(400)}` });
    // eslint-disable-next-line no-control-regex
    expect(r.note).not.toMatch(/[\u0000-\u001f]/);
    expect(r.note!.length).toBeLessThanOrEqual(300);
    expect(eventsCommand(ctx, { deliverable: true, agent: 'claude' }).map((e) => e.event_id)).toEqual([b!.event_id, c!.event_id]);
    const s = statusCommand(ctx);
    expect(s.processing_failures).toEqual([
      { agent: 'claude', event_id: b!.event_id, type: 'announcement.new', status: 'failed', count: 1, first_at: '2026-10-22T12:00:00+08:00', at: '2026-10-22T12:00:00+08:00', note: r.note },
    ]);
    expect(statusText(s)).toContain('處理失敗');
    expect(existsSync(join(root, 'outbox', 'reports.json'))).toBe(true);
  });

  it('a later processed report resolves the failure, and old failures drop out after 7 days', () => {
    const [a, b] = [ev(1), ev(2)];
    [a, b].forEach((e) => ctx.outbox.append(e!));
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed', note: 'x' });
    reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'failed' });
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'processed' });
    expect(statusCommand(ctx).processing_failures.map((f) => f.event_id)).toEqual([b!.event_id]);
    now = new Date(NOON.getTime() + 8 * 24 * 3_600_000);
    expect(statusCommand(ctx).processing_failures).toEqual([]);
  });

  it('a failure is resolved once the agent ACKs past it; skipped events stay listed', () => {
    const [a, b, c] = [ev(1), ev(2), ev(3)];
    [a, b, c].forEach((e) => ctx.outbox.append(e!));
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed', note: '輸出被截斷' });
    reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'skipped', note: '無法處理' });
    reportCommand(ctx, { agent: 'other', eventId: a!.event_id, status: 'failed' });
    ackCommand(ctx, 'claude', b!.event_id);
    // claude 已 ACK 過 a：失敗已解決；b 是略過，仍列出；other 沒有 ACK，仍列出
    expect(statusCommand(ctx).processing_failures.map((f) => `${f.agent}:${f.event_id}:${f.status}`)).toEqual([
      `claude:${b!.event_id}:skipped`,
      `other:${a!.event_id}:failed`,
    ]);
  });

  it('rejects unknown events, bad statuses and bad agent names', () => {
    expect(() => reportCommand(ctx, { agent: 'claude', eventId: 'NOPE', status: 'failed' })).toThrow(/找不到事件/);
    const e = ev(1);
    ctx.outbox.append(e);
    expect(() => reportCommand(ctx, { agent: 'claude', eventId: e.event_id, status: 'done' })).toThrow(/processed、failed 或 skipped/);
    expect(() => reportCommand(ctx, { agent: 'a b', eventId: e.event_id, status: 'failed' })).toThrow(/無效的 agent/);
  });
});

describe('events --compact and --limit', () => {
  const OLD = new Date('2020-01-01T04:00:00Z');
  const append = (n: number, over: Partial<Parameters<typeof makeEvent>[0]> = {}): IlearnEvent => {
    const e = ev(n, { detectedAt: new Date(OLD.getTime() + n * 1000), ...over });
    ctx.outbox.append(e);
    return e;
  };

  it('compact items have the documented shape and truncate long titles to 120 characters', () => {
    const long = '很長的標題'.repeat(60);
    const e = append(1, {
      item: { id: 'a1', kind: 'assignment', title: long, due_at: '2026-10-30T15:59:00+08:00', url: 'https://x/a1' },
      reload_id: 'R1',
      offset: 'P1D',
    });
    const sys = append(2, { type: 'sync.incomplete', course: null, item: null, summary: '部分課程不完整' });
    const [a, b] = eventsCommand(ctx, { compact: true });
    expect(Object.keys(a!).sort()).toEqual(
      ['course', 'deliver_after', 'delivery', 'due_at', 'event_id', 'failures', 'offset', 'reload_id', 'title', 'type', 'url'].sort(),
    );
    expect(a).toMatchObject({ event_id: e.event_id, type: 'announcement.new', delivery: 'push', course: '資料結構', due_at: '2026-10-30T15:59:00+08:00', url: 'https://x/a1', reload_id: 'R1', offset: 'P1D', failures: 0 });
    expect([...a!.title]).toHaveLength(120);
    expect(a!.title.endsWith('…')).toBe(true);
    expect(b).toMatchObject({ event_id: sys.event_id, course: null, title: '部分課程不完整', due_at: null, url: null, failures: 0 });
    expect(Object.keys(b!)).not.toContain('reload_id');
    expect(JSON.stringify(a)).not.toContain('dedupe_key');
  });

  it('limit applies after the filters, oldest first, and rejects 0 and 101', () => {
    const all = [1, 2, 3, 4, 5].map((n) => append(n, { type: n % 2 === 1 ? 'announcement.new' : 'material.new' }));
    ackCommand(ctx, 'claude', all[0]!.event_id);
    const ids = (o: Parameters<typeof eventsCommand>[1]): string[] => eventsCommand(ctx, o).map((e) => e.event_id);
    expect(ids({ limit: 2 })).toEqual([all[0]!.event_id, all[1]!.event_id]);
    expect(ids({ deliverable: true, agent: 'claude', limit: 2 })).toEqual([all[1]!.event_id, all[2]!.event_id]);
    expect(ids({ type: 'announcement.new', limit: 2 })).toEqual([all[0]!.event_id, all[2]!.event_id]);
    expect(ids({ limit: 100 })).toHaveLength(5);
    expect(ids({ limit: '3', compact: true })).toHaveLength(3);
    for (const bad of [0, 101, -1, 1.5, 'x', '']) {
      expect(() => eventsCommand(ctx, { limit: bad })).toThrow(CliExit);
    }
    expect(() => eventsCommand(ctx, { limit: 0 })).toThrow(/1 到 100/);
  });

  it('failures counts only earlier failed reports by this agent', () => {
    const [a, b] = [append(1), append(2)];
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed' });
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed' });
    reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'processed' });
    reportCommand(ctx, { agent: 'other', eventId: b!.event_id, status: 'failed' });
    const f = (agent?: string): number[] => eventsCommand(ctx, { compact: true, deliverable: true, ...(agent ? { agent } : {}) }).map((e) => e.failures);
    expect(f('claude')).toEqual([2, 0]);
    expect(f('other')).toEqual([0, 1]);
    expect(f('nobody')).toEqual([0, 0]);
    expect(f()).toEqual([0, 0]);
  });

  it('compact works with --test and counts no failures for test events', async () => {
    const t = await deliveryTestCommand(ctx, { agent: 'claude' });
    const r = eventsCommand(ctx, { agent: 'claude', test: true, compact: true, limit: 5 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ event_id: t.test_id, type: 'delivery.test', title: 'thu-ilearn 推送測試', course: null, failures: 0 });
  });
});

describe('skipped reports and aggregation', () => {
  const ids = (): string[] => eventsCommand(ctx, { deliverable: true, agent: 'claude' }).map((e) => e.event_id);

  it('records a skipped event without moving the cursor, then lets the agent ack past it', () => {
    const [a, b, c] = [ev(1), ev(2), ev(3)];
    [a, b, c].forEach((e) => ctx.outbox.append(e!));
    const r = reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'skipped', note: `x${'y'.repeat(400)}` });
    expect(r.status).toBe('skipped');
    expect(r.note!.length).toBeLessThanOrEqual(300);
    expect(ids()).toEqual([a!.event_id, b!.event_id, c!.event_id]);
    ackCommand(ctx, 'claude', b!.event_id);
    expect(ids()).toEqual([c!.event_id]);
    expect(statusCommand(ctx).processing_failures).toMatchObject([{ event_id: b!.event_id, status: 'skipped', count: 1 }]);
  });

  it('skipped works for test events too', async () => {
    const t = await deliveryTestCommand(ctx, { agent: 'claude' });
    expect(reportCommand(ctx, { agent: 'claude', eventId: t.test_id, status: 'skipped', note: 'n', test: true })).toMatchObject({ status: 'skipped', test: true });
  });

  it('aggregates reports per agent and event with count, first_at, latest at and status', () => {
    const [a, b] = [ev(1), ev(2)];
    [a, b].forEach((e) => ctx.outbox.append(e!));
    const at = (min: number): void => void (now = new Date(NOON.getTime() + min * 60_000));
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed', note: 'first' });
    at(5);
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed', note: 'second' });
    reportCommand(ctx, { agent: 'other', eventId: a!.event_id, status: 'failed', note: 'o' });
    at(10);
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'failed', note: 'third' });
    at(15);
    reportCommand(ctx, { agent: 'claude', eventId: a!.event_id, status: 'skipped', note: 'quarantine' });
    reportCommand(ctx, { agent: 'claude', eventId: b!.event_id, status: 'failed', note: 'b1' });
    const f = statusCommand(ctx).processing_failures;
    expect(f).toHaveLength(3);
    expect(f.find((x) => x.agent === 'claude' && x.event_id === a!.event_id)).toEqual({
      agent: 'claude', event_id: a!.event_id, type: 'announcement.new', status: 'skipped', count: 4,
      first_at: '2026-10-22T12:00:00+08:00', at: '2026-10-22T12:15:00+08:00', note: 'quarantine',
    });
    expect(f.find((x) => x.agent === 'other')).toMatchObject({ status: 'failed', count: 1, note: 'o' });
    expect(f.find((x) => x.event_id === b!.event_id)).toMatchObject({ status: 'failed', count: 1 });
    // 7 天之後整筆消失
    now = new Date(NOON.getTime() + 8 * 24 * 3_600_000);
    expect(statusCommand(ctx).processing_failures).toEqual([]);
  });

  it('shows one line per event with the count and 已略過 in status, the TUI notices and 總覽.md', () => {
    const [a, b] = [ev(1), ev(2)];
    [a, b].forEach((e) => ctx.outbox.append(e!));
    for (let i = 0; i < 3; i++) reportCommand(ctx, { agent: 'hermes', eventId: a!.event_id, status: 'failed', note: '工具輸出被截斷' });
    reportCommand(ctx, { agent: 'hermes', eventId: b!.event_id, status: 'skipped', note: '無法解析' });
    const s = statusCommand(ctx);
    expect(s.processing_failures).toHaveLength(2);
    const lines = statusText(s).split('\n').filter((l) => /處理失敗|已略過/.test(l));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.includes(a!.event_id))).toMatch(/處理失敗.*共 3 次/);
    expect(lines.find((l) => l.includes(b!.event_id))).toMatch(/已略過.*共 1 次/);
    const notices = loadTuiData(ctx).notices.filter((n) => n.startsWith('hermes'));
    expect(notices).toHaveLength(2);
    expect(notices.some((n) => n.includes('處理失敗') && n.includes('共 3 次'))).toBe(true);
    expect(notices.some((n) => n.includes('已略過') && n.includes('共 1 次'))).toBe(true);
    ctx.config.interfaces.folder = true;
    renderFolderView(ctx);
    const md = readFileSync(join(root, '總覽.md'), 'utf8');
    expect(md.match(/hermes .*共 3 次/g)).toHaveLength(1);
    expect(md).toMatch(/hermes 已略過.*共 1 次/);
  });
});

describe('MCP events limit and compact', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('accepts limit and compact, and rejects an out-of-range limit', async () => {
    for (let n = 1; n <= 5; n++) ctx.outbox.append(ev(n));
    const s = createMcpServer({ root, now: () => now });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([s.connect(a), client.connect(b)]);
    clients.push(client);
    const call = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = (await client.callTool({ name: 'events', arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]?.text ?? '', isError: r.isError === true };
    };
    const ok = await call({ agent: 'claude', deliverable: true, compact: true, limit: 2 });
    const list = JSON.parse(ok.text) as { event_id: string; failures: number; dedupe_key?: string }[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ failures: 0 });
    expect(list[0]!.dedupe_key).toBeUndefined();
    const full = JSON.parse((await call({ agent: 'claude', deliverable: true })).text) as { event_id: string; dedupe_key: string }[];
    expect(full).toHaveLength(5);
    expect(list.map((e) => e.event_id)).toEqual(full.slice(0, 2).map((e) => e.event_id));
    expect((await call({ limit: 101 })).isError).toBe(true);
    expect((await call({ limit: 0 })).isError).toBe(true);
    const skipped = (await client.callTool({ name: 'events_report', arguments: { agent: 'claude', event_id: list[0]!.event_id, status: 'skipped' } })) as { isError?: boolean };
    expect(skipped.isError).not.toBe(true);
  });
});

describe('CLI option parsing', () => {
  const OLD = new Date('2020-01-01T04:00:00Z');
  async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const outs: string[] = [];
    const errs: string[] = [];
    const so = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (outs.push(String(c)), true));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (errs.push(String(c)), true));
    const prevArgv = process.argv;
    const prevHome = process.env.ILEARN_HOME;
    process.argv = ['node', 'ilearn', ...args];
    process.env.ILEARN_HOME = root;
    try {
      vi.resetModules();
      await import('../src/cli/index.js');
      await vi.waitFor(() => expect(outs.length + errs.length).toBeGreaterThan(0), { timeout: 5000 });
    } finally {
      process.argv = prevArgv;
      if (prevHome === undefined) delete process.env.ILEARN_HOME;
      else process.env.ILEARN_HOME = prevHome;
      so.mockRestore();
      se.mockRestore();
      process.exitCode = undefined;
    }
    return { stdout: outs.join(''), stderr: errs.join('') };
  }

  it('merges parent and child options for events report ... --status skipped --test --json', async () => {
    const t = await deliveryTestCommand(ctx, { agent: 'x' });
    const r = await runCli(['events', 'report', 'x', t.test_id, '--status', 'skipped', '--test', '--note', 'n', '--json']);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ agent: 'x', event_id: t.test_id, status: 'skipped', note: 'n', test: true });
  });

  it('parses events --deliverable --agent x --json --compact --limit 3', async () => {
    for (let n = 1; n <= 5; n++) ctx.outbox.append(ev(n, { detectedAt: new Date(OLD.getTime() + n * 1000) }));
    const r = await runCli(['events', '--deliverable', '--agent', 'x', '--json', '--compact', '--limit', '3']);
    expect(r.stderr).toBe('');
    const list = JSON.parse(r.stdout) as { title: string; failures: number }[];
    expect(list.map((e) => e.title)).toEqual(['公告 1', '公告 2', '公告 3']);
    expect(list.every((e) => e.failures === 0)).toBe(true);
  });

  it('rejects --limit 101 with exit code 1', async () => {
    ctx.outbox.append(ev(1, { detectedAt: OLD }));
    const r = await runCli(['events', '--agent', 'x', '--json', '--limit', '101']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('1 到 100');
  });
});

describe('offline catch-up and restart', () => {
  it('an offline agent catches up from its cursor in event_id order', () => {
    const evs = [1, 2, 3, 4].map((n) => ev(n));
    evs.forEach((e) => ctx.outbox.append(e));
    expect(eventsCommand(ctx, { deliverable: true, agent: 'hermes' }).map((e) => e.event_id)).toEqual(evs.map((e) => e.event_id));
    ackCommand(ctx, 'hermes', evs[1]!.event_id);
    const later = ev(5);
    ctx.outbox.append(later);
    // 重新啟動後（新的 Outbox 與 context）仍從 cursor 繼續
    const again = open();
    expect(eventsCommand(again, { deliverable: true, agent: 'hermes' }).map((e) => e.event_id)).toEqual([evs[2]!.event_id, evs[3]!.event_id, later.event_id]);
    expect(eventsCommand(again, { deliverable: true, agent: 'other' })).toHaveLength(5);
  });

  it('keeps retry state across restarts and does not resend succeeded events', async () => {
    const e1 = ev(1);
    const e2 = ev(2);
    ctx.outbox.append(e1);
    ctx.outbox.append(e2);
    const sent: string[] = [];
    const failing = new Set([e2.event_id]);
    const deps = {
      postWebhook: (_u: string, e: IlearnEvent): Promise<void> => {
        sent.push(e.event_id);
        return failing.has(e.event_id) ? Promise.reject(new Error('HTTP 500')) : Promise.resolve();
      },
    };
    const d = structuredClone(DEFAULT_CONFIG.delivery);
    d.webhook = { enabled: true, url: 'http://127.0.0.1:9/x', secret: '' };
    await dispatchPending(ctx.outbox, d, NOON, deps);
    expect(sent).toEqual([e1.event_id, e2.event_id]);

    const restarted = new Outbox(root);
    const at = (min: number): Date => new Date(NOON.getTime() + min * 60_000);
    await dispatchPending(restarted, d, at(2), deps); // backoff 未到，且 e1 已成功
    expect(sent).toHaveLength(2);
    failing.clear();
    await dispatchPending(restarted, d, at(5), deps);
    expect(sent).toEqual([e1.event_id, e2.event_id, e2.event_id]);
    await dispatchPending(new Outbox(root), d, at(70), deps);
    expect(sent).toHaveLength(3);
  });
});

describe('MCP tools for delivery', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  async function connect(r: string = root): Promise<Client> {
    const s = createMcpServer({ root: r, now: () => now });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([s.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
    const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]?.text ?? '', isError: r.isError === true };
  };

  it('lists the new tools with the right write hints and test flags', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    for (const n of ['delivery_test', 'delivery_test_status', 'events_report']) expect(MCP_TOOLS).toContain(n);
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    expect(tools.find((t) => t.name === 'delivery_test_status')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'events_report')?.annotations?.readOnlyHint).toBe(false);
    for (const n of ['events', 'events_ack']) {
      expect(JSON.stringify(tools.find((t) => t.name === n)?.inputSchema)).toContain('"test"');
    }
    for (const phrase of ['不是資料來源', '不可信', '讀取失敗', 'compact: true', 'skipped', '不要用 jq']) expect(INSTRUCTIONS).toContain(phrase);
  });

  it('runs a whole delivery test through MCP without ever returning the secret', async () => {
    ctx.config.delivery.cli = { enabled: true, command: 'cat > /dev/null' };
    ctx.config.delivery.webhook = { enabled: false, url: '', secret: SECRET };
    saveConfig(ctx.config, root);
    const c = await connect();
    const started = await call(c, 'delivery_test', { agent: 'claude' });
    expect(started.isError).toBe(false);
    const { test_id } = JSON.parse(started.text) as { test_id: string };
    const events = JSON.parse((await call(c, 'events', { agent: 'claude', deliverable: true, test: true })).text) as { event_id: string }[];
    expect(events.map((e) => e.event_id)).toEqual([test_id]);
    expect((await call(c, 'events_report', { agent: 'claude', event_id: test_id, status: 'processed', test: true })).isError).toBe(false);
    expect((await call(c, 'events_ack', { agent: 'claude', event_id: test_id, test: true })).isError).toBe(false);
    const status = await call(c, 'delivery_test_status', { test_id });
    expect(JSON.parse(status.text)).toMatchObject({ transport: { status: 'PASS' }, agent_read: { status: 'PASS' }, processing: { status: 'PASS' }, ack: { status: 'PASS' } });
    for (const t of [started, status, await call(c, 'status'), await call(c, 'config_get')]) expect(t.text).not.toContain(SECRET);
    expect((await call(c, 'delivery_test_status', { test_id: 'NOPE' })).isError).toBe(true);
  });

  it('refuses writes before setup', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-adapters-fresh-')));
    expect((await call(c, 'delivery_test', { agent: 'claude' })).isError).toBe(true);
    expect((await call(c, 'events_report', { agent: 'claude', event_id: 'x', status: 'failed' })).isError).toBe(true);
  });

  it('reports a read failure, not an empty list, when an agent reads an unset data folder', async () => {
    const c = await connect(mkdtempSync(join(tmpdir(), 'ilearn-adapters-fresh-')));
    const r = await call(c, 'events', { agent: 'claude', deliverable: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('尚未設定');
  });
});
