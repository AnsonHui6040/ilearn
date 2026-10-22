import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config/config.js';
import { dispatchPending, postWebhook, runHook, webhookUrlError } from '../src/events/dispatch.js';
import { makeEvent, Outbox } from '../src/events/outbox.js';
import type { IlearnEvent } from '../src/types.js';

const quiet = { start: '00:00', end: '07:00' };
const NOON = new Date('2026-10-22T04:00:00Z'); // 12:00 Taipei

function ev(over: Partial<Parameters<typeof makeEvent>[0]> = {}): IlearnEvent {
  return makeEvent({
    type: 'announcement.new',
    delivery: 'push',
    categories: ['room_change'],
    matched_rules: ['room_change'],
    course: { id: '1', name: '資料結構', semester: '115-1' },
    item: { id: '88001', kind: 'announcement', title: '改至 M201 上課', due_at: null, url: null },
    summary: null,
    dedupe_key: 'announcement.new:88001',
    detectedAt: NOON,
    quiet,
    ...over,
  });
}

function delivery(over: Partial<{ hook: string; webhook: string }>): Config['delivery'] {
  const d = structuredClone(DEFAULT_CONFIG.delivery);
  if (over.hook !== undefined) d.hook = { enabled: true, command: over.hook };
  if (over.webhook !== undefined) d.webhook = { enabled: true, url: over.webhook };
  return d;
}

let root: string;
let box: Outbox;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-'));
  box = new Outbox(root);
});

describe('webhookUrlError', () => {
  it.each(['http://localhost:8080/ilearn', 'http://127.0.0.1:3000', 'https://agent.localhost/x', 'http://[::1]:9000/', 'http://127.1.2.3/'])(
    'accepts %s',
    (u) => expect(webhookUrlError(u)).toBeNull(),
  );
  it.each([
    'http://example.com/hook',
    'http://192.168.1.10:8080',
    'http://10.0.0.1',
    'http://localhost.example.com',
    'http://127.0.0.1.nip.io',
    'ftp://localhost/x',
    'file:///etc/passwd',
    'http://user:pw@localhost/',
    'not a url',
  ])('rejects %s', (u) => expect(webhookUrlError(u)).not.toBeNull());
});

describe('runHook', () => {
  it('passes the event JSON on stdin and resolves on exit 0', async () => {
    const out = join(root, 'got.json');
    const e = ev();
    await runHook(`cat > "${out}"`, e);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(e);
  });

  it('exposes event id and type as environment variables', async () => {
    const out = join(root, 'env.txt');
    const e = ev();
    await runHook(`printf '%s %s' "$ILEARN_EVENT_ID" "$ILEARN_EVENT_TYPE" > "${out}"`, e);
    expect(readFileSync(out, 'utf8')).toBe(`${e.event_id} announcement.new`);
  });

  it('rejects with exit code and stderr on failure', async () => {
    await expect(runHook('echo boom >&2; exit 3', ev())).rejects.toThrow(/exit code 3：boom/);
  });

  it('rejects on timeout', async () => {
    await expect(runHook('sleep 5', ev(), 200)).rejects.toThrow('逾時（200 毫秒）');
  });
});

describe('postWebhook', () => {
  let server: Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/ilearn`;
  }

  it('POSTs the event JSON to a localhost URL', async () => {
    let body = '';
    let type = '';
    const url = await listen((req, res) => {
      type = req.headers['content-type'] ?? '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => res.writeHead(204).end());
    });
    const e = ev();
    await postWebhook(url, e);
    expect(type).toBe('application/json');
    expect(JSON.parse(body)).toEqual(e);
  });

  it('treats non-2xx and redirects as failure', async () => {
    const url = await listen((req, res) => {
      if (req.url === '/ilearn') res.writeHead(302, { location: 'http://example.com/' }).end();
      else res.writeHead(500).end();
    });
    await expect(postWebhook(url, ev())).rejects.toThrow('HTTP 302（不跟隨轉址）');
    await expect(postWebhook(url.replace('/ilearn', '/x'), ev())).rejects.toThrow('HTTP 500');
  });

  it('explains a refused connection instead of "fetch failed"', async () => {
    const url = await listen((_req, res) => res.end());
    const port = (server!.address() as AddressInfo).port;
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    await expect(postWebhook(url, ev())).rejects.toThrow(`連線被拒：127.0.0.1:${port} 沒有程式在接收`);
  });

  it('explains a timeout', async () => {
    const url = await listen(() => undefined); // 收到請求但永不回應
    await expect(postWebhook(url, ev(), fetch, 200)).rejects.toThrow(/^逾時：127\.0\.0\.1:\d+ 在 200 毫秒內沒有回應$/);
  });

  it('refuses non-localhost URLs without sending anything', async () => {
    let called = false;
    const fake = (() => {
      called = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    await expect(postWebhook('http://example.com/hook', ev(), fake)).rejects.toThrow(/被拒絕/);
    expect(called).toBe(false);
  });
});

describe('dispatchPending', () => {
  it('sends push events once and skips record events and disabled channels', async () => {
    const push = ev();
    const rec = ev({ delivery: 'record', dedupe_key: 'r' });
    [push, rec].forEach((e) => box.append(e));
    const sent: string[] = [];
    const deps = { runHook: (_c: string, e: IlearnEvent) => (sent.push(e.dedupe_key), Promise.resolve()) };
    const r1 = await dispatchPending(box, delivery({ hook: 'agent-cli' }), NOON, deps);
    expect(r1).toEqual({ hook: { sent: 1, failed: 0 }, webhook: { sent: 0, failed: 0 } });
    const r2 = await dispatchPending(box, delivery({ hook: 'agent-cli' }), new Date(NOON.getTime() + 60_000), deps);
    expect(r2.hook.sent).toBe(0);
    expect(sent).toEqual(['announcement.new:88001']);
    expect((await dispatchPending(box, delivery({}), NOON, deps)).hook.sent).toBe(0);
  });

  it('does not send night push events before deliver_after', async () => {
    box.append(ev({ detectedAt: new Date('2026-10-22T17:00:00Z') })); // 01:00 Taipei → 07:00
    const sent: string[] = [];
    const deps = { postWebhook: (_u: string, e: IlearnEvent) => (sent.push(e.event_id), Promise.resolve()) };
    const d = delivery({ webhook: 'http://localhost:9/x' });
    await dispatchPending(box, d, new Date('2026-10-22T22:59:00Z'), deps); // 06:59
    expect(sent).toHaveLength(0);
    await dispatchPending(box, d, new Date('2026-10-22T23:00:00Z'), deps); // 07:00
    expect(sent).toHaveLength(1);
  });

  it('retries a failed hook after backoff and keeps the outbox intact', async () => {
    const push = ev();
    box.append(push);
    let fail = true;
    const calls: number[] = [];
    const deps = {
      runHook: (): Promise<void> => {
        calls.push(1);
        return fail ? Promise.reject(new Error('exit code 1')) : Promise.resolve();
      },
    };
    const d = delivery({ hook: 'agent-cli' });
    const at = (min: number): Date => new Date(NOON.getTime() + min * 60_000);
    expect((await dispatchPending(box, d, at(0), deps)).hook).toEqual({ sent: 0, failed: 1 });
    await dispatchPending(box, d, at(2), deps); // backoff 未到
    expect(calls).toHaveLength(1);
    fail = false;
    expect((await dispatchPending(box, d, at(5), deps)).hook).toEqual({ sent: 1, failed: 0 });
    await dispatchPending(box, d, at(60), deps);
    expect(calls).toHaveLength(2);
    expect(box.read()).toHaveLength(1);
  });

  it('hook and webhook track delivery separately', async () => {
    box.append(ev());
    const d = delivery({ hook: 'agent-cli', webhook: 'http://localhost:9/x' });
    const r = await dispatchPending(box, d, NOON, {
      runHook: () => Promise.resolve(),
      postWebhook: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(r).toEqual({ hook: { sent: 1, failed: 0 }, webhook: { sent: 0, failed: 1 } });
    expect(box.hookStats('webhook', NOON).retrying).toBe(1);
    expect(box.hookStats('hook', NOON).retrying).toBe(0);
  });

  it('a non-localhost webhook in config.yaml fails instead of sending', async () => {
    box.append(ev());
    const r = await dispatchPending(box, delivery({ webhook: 'http://example.com/hook' }), NOON);
    expect(r.webhook).toEqual({ sent: 0, failed: 1 });
    expect(box.hookStats('webhook', NOON).last_error).toMatch(/被拒絕/);
  });
});
