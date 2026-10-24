import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext, type CliContext } from '../src/cli/context.js';
import { loadConfig } from '../src/config/config.js';
import {
  ackTest,
  createDeliveryTest,
  getTestResult,
  readTestEvents,
  reportTest,
} from '../src/events/delivery-test.js';
import {
  buildCronPrompt,
  connectPromptCommand,
  connectPromptText,
  connectRequestCommand,
  detectActiveProfile,
  displayArgs,
  requestFile,
  runConnectApprove,
  runConnectHermes,
  type HermesDeps,
  type RunResult,
} from '../src/connect/hermes.js';
import { createFakeApi } from './helpers/fakeApi.js';

const SECRET = 'a'.repeat(64);
const NOW = new Date('2026-10-24T04:00:00Z');
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', code = 1): RunResult => ({ code, stdout: '', stderr });

interface Setup {
  ctx: CliContext;
  deps: HermesDeps;
  calls: string[][];
  said: string[];
  asked: string[];
  /** 每次 sleep 時執行的動作（模擬 agent 逐步完成測試） */
  onSleep: Array<(ctx: CliContext, testId: string) => void>;
  sleeps: number[];
}

interface Opts {
  answers?: Record<string, string>;
  confirms?: Record<string, boolean>;
  replies?: (argv: string[]) => RunResult | undefined;
  healthy?: boolean | boolean[];
  cronJobFlag?: boolean;
  cronRunning?: boolean;
  timeoutMs?: number;
  /** cron list 是否列出 thu-ilearn-inbox */
  cronListed?: boolean;
}

function setup(o: Opts = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-connect-'));
  const ctx = createContext({
    root,
    api: createFakeApi().api,
    fetchText: () => Promise.resolve('<html></html>'),
    now: () => NOW,
    userId: 1,
  });
  const calls: string[][] = [];
  const said: string[] = [];
  const asked: string[] = [];
  const sleeps: number[] = [];
  const onSleep: Setup['onSleep'] = [];
  const healths = Array.isArray(o.healthy) ? [...o.healthy] : null;
  let lastTest = '';
  const deps: HermesDeps = {
    run: (cmd, args) => {
      expect(cmd).toBe('hermes');
      calls.push(args);
      const custom = o.replies?.(args);
      if (custom) return custom;
      const sub = args[0] === '-p' ? args.slice(2) : args;
      const j = sub.join(' ');
      if (j === '--version') return ok('hermes 1.2.3');
      if (j === 'cron status') return o.cronRunning === false ? ok('scheduler not running') : ok('scheduler running');
      if (j === 'gateway status') return ok('gateway running');
      if (j === 'webhook --help') return ok('usage: hermes webhook');
      if (j === 'webhook subscribe --help') return ok(o.cronJobFlag === false ? '--prompt --secret' : '--prompt --secret --cron-job');
      if (j === 'cron list' || j === 'webhook list') return ok(o.cronListed ? 'thu-ilearn-inbox  every 5m' : '');
      return ok('done');
    },
    health: () => Promise.resolve(healths ? (healths.shift() ?? true) : o.healthy === undefined ? true : (o.healthy as boolean)),
    prompts: {
      input: ((q: { message: string; default?: string }) => {
        asked.push(q.message);
        const hit = Object.entries(o.answers ?? {}).find(([k]) => q.message.includes(k));
        return Promise.resolve(hit ? hit[1] : (q.default ?? ''));
      }) as never,
      confirm: ((q: { message: string; default?: boolean }) => {
        asked.push(q.message);
        const hit = Object.entries(o.confirms ?? {}).find(([k]) => q.message.includes(k));
        return Promise.resolve(hit ? hit[1] : (q.default ?? false));
      }) as never,
    },
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);
      for (const f of onSleep.splice(0, 1)) f(ctx, lastTest);
      return Promise.resolve();
    },
    say: (s = '') => void said.push(s),
    node: '/opt/node/bin/node',
    script: '/opt/ilearn/dist/cli/index.js',
    randomSecret: () => SECRET,
    randomCode: () => 'AB23CD',
    pollIntervalMs: 10_000,
    pollTimeoutMs: o.timeoutMs ?? 60_000,
    restartWaitMs: 1,
    deliveryTest: async (c, agent) => {
      const r = await createDeliveryTest(c.outbox.outboxDir, agent, c.config.delivery, NOW, {
        runHook: () => Promise.resolve(),
        postWebhook: () => Promise.resolve(200),
      });
      lastTest = r.test_id;
      return { test_id: r.test_id };
    },
  };
  return { ctx, deps, calls, said, asked, onSleep, sleeps };
}

const text = (s: Setup): string => s.said.join('\n');
const sub = (calls: string[][], ...head: string[]): string[][] =>
  calls.filter((c) => {
    const a = c[0] === '-p' ? c.slice(2) : c;
    return head.every((h, i) => a[i] === h);
  });

describe('connect hermes: 偵測', () => {
  it('detection table lists each command and the health result without secrets', async () => {
    const s = setup({
      replies: (a) => (a.includes('list') && a.includes('webhook') ? ok(`thu-ilearn  ${'f'.repeat(40)}`) : undefined),
    });
    await runConnectHermes(s.ctx, {}, s.deps);
    const t = text(s);
    for (const k of ['hermes --version', 'cron status', 'gateway status', 'webhook --help', '--cron-job', 'cron list', 'webhook list', '/health']) {
      expect(t).toContain(k);
    }
    expect(t).toContain('hermes 1.2.3');
    expect(t).not.toContain('f'.repeat(24));
    expect(sub(s.calls, 'webhook', 'subscribe', '--help')).toHaveLength(1);
  });

  it('missing hermes stops with a clear message', async () => {
    const s = setup({ replies: (a) => (a.includes('--version') ? fail('ENOENT', 127) : undefined) });
    await expect(runConnectHermes(s.ctx, {}, s.deps)).rejects.toThrow(/找不到 hermes/);
    expect(s.calls).toHaveLength(2);
  });
});

describe('connect hermes: cron 提示詞', () => {
  const p = buildCronPrompt({ node: '/opt/node/bin/node', script: '/opt/ilearn/dist/cli/index.js', root: '/home/a/.thu-ilearn', agent: 'hermes' });
  it('contains absolute paths, root, agent, rules and both flows', () => {
    expect(p).toContain('ILEARN_HOME="/home/a/.thu-ilearn" "/opt/node/bin/node" "/opt/ilearn/dist/cli/index.js" events --deliverable --agent hermes --test --json');
    expect(p).toContain('events --deliverable --agent hermes --json');
    expect(p).toContain('events report hermes <event_id> --status processed --test');
    expect(p).toContain('events ack hermes <event_id> --test');
    expect(p).toContain('--status failed --note');
    expect(p).toContain('[SILENT]');
    expect(p).toContain('不可信');
    expect(p).toContain('推送測試成功');
    expect(p).toContain('讀取失敗');
    expect(p).not.toContain(SECRET);
    expect(p).not.toMatch(/[嘅咗唔喺係冇佢嚟啲]/);
  });
});

describe('connect hermes: 完整流程', () => {
  it('produces the exact hermes argv with a profile and redacts the secret', async () => {
    const s = setup({ answers: { profile: 'daily', 'agent 名稱': 'hermes', 目標: 'telegram:42' } });
    s.onSleep.push(
      (c) => void readTestEvents(c.outbox.outboxDir, 'hermes', NOW),
      (c, id) => void reportTest(c.outbox.outboxDir, 'hermes', id, 'processed', undefined, NOW),
      (c, id) => void ackTest(c.outbox.outboxDir, 'hermes', id, NOW),
    );
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    const prompt = buildCronPrompt({ node: s.deps.node, script: s.deps.script, root: s.ctx.root, agent: 'hermes' });
    expect(s.calls).toEqual([
      ['profile', 'list'],
      ['-p', 'daily', '--version'],
      ['-p', 'daily', 'config', 'get', 'WEBHOOK_PORT'],
      ['-p', 'daily', 'cron', 'status'],
      ['-p', 'daily', 'gateway', 'status'],
      ['-p', 'daily', 'webhook', '--help'],
      ['-p', 'daily', 'webhook', 'subscribe', '--help'],
      ['-p', 'daily', 'cron', 'list'],
      ['-p', 'daily', 'webhook', 'list'],
      ['-p', 'daily', 'cron', 'create', '*/5 * * * *', prompt, '--name', 'thu-ilearn-inbox', '--deliver', 'telegram:42'],
      [
        '-p', 'daily', 'webhook', 'subscribe', 'thu-ilearn',
        '--cron-job', 'thu-ilearn-inbox',
        '--secret', SECRET,
        '--description', 'thu-ilearn 新事件通知',
        '--prompt', 'thu-ilearn 有新事件，請依排程工作的步驟處理。',
      ],
      // webhook 送達後路由已觸發排程工作，不再另外 cron run，避免同一則測試被處理兩次
    ]);
    expect(r.testPassed).toBe(true);
    const out = text(s);
    expect(out).toContain('--secret ***');
    expect(out).not.toContain(SECRET);
    expect(s.asked.join('\n')).not.toContain(SECRET);
    expect(out).toContain('ilearn connect hermes --remove');
    const wh = loadConfig(s.ctx.root).delivery.webhook;
    expect(wh).toEqual({ enabled: true, url: 'http://127.0.0.1:8644/webhooks/thu-ilearn', secret: SECRET });
    expect(out).toMatch(/Transport\s+PASS/);
    expect(out).toMatch(/ACK\s+PASS/);
  });

  it('without a profile there is no -p', async () => {
    const s = setup();
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(s.calls.every((c) => c[0] !== '-p')).toBe(true);
    expect(s.calls[1]).toEqual(['--version']);
  });

  it('replaces existing job and route after confirmation (remove before create)', async () => {
    const s = setup({
      confirms: { 取代: true },
      replies: (a) => {
        if (a.join(' ') === 'cron list') return ok('thu-ilearn-inbox  */5 * * * *');
        if (a.join(' ') === 'webhook list') return ok('thu-ilearn  /webhooks/thu-ilearn');
        return undefined;
      },
    });
    await runConnectHermes(s.ctx, {}, s.deps);
    const j = s.calls.map((c) => c.slice(0, 3).join(' '));
    expect(j.indexOf('cron remove thu-ilearn-inbox')).toBeGreaterThan(-1);
    expect(j.indexOf('cron remove thu-ilearn-inbox')).toBeLessThan(j.findIndex((x) => x.startsWith('cron create')));
    expect(j.indexOf('webhook remove thu-ilearn')).toBeLessThan(j.findIndex((x) => x === 'webhook subscribe thu-ilearn'));
  });

  it('declining the replace default (no) makes no remove/create call', async () => {
    const s = setup({
      replies: (a) => (a.join(' ') === 'cron list' ? ok('thu-ilearn-inbox') : a.join(' ') === 'webhook list' ? ok('thu-ilearn') : undefined),
    });
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(sub(s.calls, 'cron', 'remove')).toHaveLength(0);
    expect(sub(s.calls, 'cron', 'create')).toHaveLength(0);
    expect(sub(s.calls, 'webhook', 'remove')).toHaveLength(0);
    expect(sub(s.calls, 'webhook', 'subscribe').filter((c) => !c.includes('--help'))).toHaveLength(0);
    expect(loadConfig(s.ctx.root).delivery.webhook.enabled).toBe(false);
  });

  it('declining every change makes no mutating call and no config change', async () => {
    const s = setup({ confirms: { 建立: false } });
    await runConnectHermes(s.ctx, {}, s.deps);
    const mutating = s.calls.filter((c) => ['create', 'remove', 'subscribe', 'run', 'start', 'restart', 'set'].some((m) => c.includes(m) && !c.includes('--help')));
    expect(mutating).toEqual([]);
    expect(loadConfig(s.ctx.root).delivery.webhook.enabled).toBe(false);
    expect(text(s)).toContain('沒有更改任何設定');
  });

  it('declining only the ilearn config update keeps the config', async () => {
    const s = setup({ confirms: { 'ilearn 的 webhook': false } });
    s.onSleep.push();
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(loadConfig(s.ctx.root).delivery.webhook.secret).toBe('');
    expect(text(s)).not.toContain(SECRET);
  });
});

describe('connect hermes: 降級', () => {
  it('no --cron-job: polling only, no subscribe, ilearn webhook unchanged', async () => {
    const s = setup({ cronJobFlag: false });
    s.ctx.config.delivery.webhook = { enabled: true, url: 'http://127.0.0.1:9/x', secret: 's' };
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(s.calls.filter((c) => c.includes('subscribe') && !c.includes('--help'))).toHaveLength(0);
    expect(s.ctx.config.delivery.webhook).toEqual({ enabled: true, url: 'http://127.0.0.1:9/x', secret: 's' });
    expect(text(s)).toContain('只用排程輪詢');
    // 沒有 webhook 觸發時，由 cron run 啟動排程工作來處理測試事件
    expect(s.calls.some((c) => c.join(' ').endsWith('cron run thu-ilearn-inbox'))).toBe(true);
  });

  it('health fails: enables the webhook with hermes config set, restarts with -y, then continues', async () => {
    const s = setup({ healthy: [false, true], answers: { profile: 'daily', 埠: '9000' } });
    await runConnectHermes(s.ctx, {}, s.deps);
    const mut = s.calls.filter((c) => ['set', 'restart'].some((m) => c.includes(m)));
    expect(mut).toEqual([
      ['-p', 'daily', 'config', 'set', 'WEBHOOK_ENABLED', 'true'],
      ['-p', 'daily', 'config', 'set', 'WEBHOOK_PORT', '9000'],
      ['-p', 'daily', 'gateway', 'restart', '-y'],
    ]);
    expect(sub(s.calls, 'webhook', 'subscribe').filter((c) => !c.includes('--help'))).toHaveLength(1);
    expect(s.ctx.config.delivery.webhook.enabled).toBe(true);
  });

  it('health fails and user declines: polling only, no env write, webhook untouched', async () => {
    const s = setup({ healthy: false, confirms: { WEBHOOK_ENABLED: false } });
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(sub(s.calls, 'config', 'set')).toHaveLength(0);
    expect(sub(s.calls, 'gateway', 'restart')).toHaveLength(0);
    expect(s.calls.filter((c) => c.includes('subscribe') && !c.includes('--help'))).toHaveLength(0);
    expect(s.ctx.config.delivery.webhook.enabled).toBe(false);
    expect(text(s)).toContain('只用排程輪詢');
  });

  it('health still failing after restart: polling only', async () => {
    const s = setup({ healthy: false });
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(s.calls.filter((c) => c.includes('subscribe') && !c.includes('--help'))).toHaveLength(0);
    expect(s.ctx.config.delivery.webhook.enabled).toBe(false);
  });
});

describe('connect hermes: 排程器沒有執行', () => {
  it('offers gateway start; declining stops without changes', async () => {
    const s = setup({ cronRunning: false, confirms: { 'gateway start': false } });
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    expect(r.changes).toEqual([]);
    expect(sub(s.calls, 'gateway', 'start')).toHaveLength(0);
    expect(sub(s.calls, 'cron', 'create')).toHaveLength(0);
    expect(text(s)).toContain('排程工作只有在 gateway 執行時才會跑');
  });

  it('starting the gateway proceeds once the scheduler reports running', async () => {
    let started = false;
    const s = setup({
      replies: (a) => {
        const j = a.join(' ');
        if (j === 'gateway start') return (started = true), ok('started');
        if (j === 'cron status') return ok(started ? 'scheduler running' : 'stopped');
        return undefined;
      },
    });
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    expect(r.changes[0]).toContain('啟動 Hermes gateway');
    expect(sub(s.calls, 'cron', 'create')).toHaveLength(1);
  });

  it('non-zero cron status counts as not running', async () => {
    const s = setup({ replies: (a) => (a.join(' ') === 'cron status' ? fail('no daemon') : undefined), confirms: { 'gateway start': false } });
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(sub(s.calls, 'cron', 'create')).toHaveLength(0);
  });
});

describe('connect hermes: 輪詢', () => {
  it('stops early on ACK PASS', async () => {
    const s = setup({ timeoutMs: 600_000 });
    s.onSleep.push(
      (c) => void readTestEvents(c.outbox.outboxDir, 'hermes', NOW),
      (c, id) => (reportTest(c.outbox.outboxDir, 'hermes', id, 'processed', undefined, NOW), ackTest(c.outbox.outboxDir, 'hermes', id, NOW)),
    );
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    expect(r.testPassed).toBe(true);
    expect(s.sleeps).toHaveLength(2);
  });

  it('stops early on a FAIL level', async () => {
    const s = setup({ timeoutMs: 600_000 });
    s.onSleep.push((c, id) => void reportTest(c.outbox.outboxDir, 'hermes', id, 'failed', 'oops', NOW));
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    expect(r.testPassed).toBe(false);
    expect(s.sleeps).toHaveLength(1);
    expect(text(s)).toMatch(/Processing\s+FAIL/);
  });

  it('times out after the limit and explains the pending agent', async () => {
    const s = setup({ timeoutMs: 30_000 });
    const r = await runConnectHermes(s.ctx, {}, s.deps);
    expect(r.testPassed).toBe(false);
    expect(s.sleeps).toHaveLength(3);
    expect(text(s)).toContain('hermes tools');
    expect(getTestResult(s.ctx.outbox.outboxDir, text(s).match(/測試 (\S+)，/)?.[1] ?? '')).not.toBeNull();
  });
});

describe('connect hermes --remove', () => {
  it('removes the job and route and disables the ilearn webhook after confirmations', async () => {
    const s = setup({
      answers: { profile: 'daily' },
      confirms: { 刪除: true, 關閉: true },
      replies: (a) => (a.join(' ').endsWith('cron list') ? ok('thu-ilearn-inbox') : a.join(' ').endsWith('webhook list') ? ok('thu-ilearn') : undefined),
    });
    s.ctx.config.delivery.webhook = { enabled: true, url: 'http://127.0.0.1:8644/webhooks/thu-ilearn', secret: SECRET };
    const r = await runConnectHermes(s.ctx, { remove: true }, s.deps);
    expect(s.calls).toContainEqual(['-p', 'daily', 'cron', 'remove', 'thu-ilearn-inbox']);
    expect(s.calls).toContainEqual(['-p', 'daily', 'webhook', 'remove', 'thu-ilearn']);
    expect(loadConfig(s.ctx.root).delivery.webhook).toEqual({ enabled: false, url: 'http://127.0.0.1:8644/webhooks/thu-ilearn', secret: '' });
    expect(r.changes).toHaveLength(3);
    expect(text(s)).not.toContain(SECRET);
  });

  it('declined removals make no calls and keep the config', async () => {
    const s = setup({
      replies: (a) => (a.join(' ') === 'cron list' ? ok('thu-ilearn-inbox') : a.join(' ') === 'webhook list' ? ok('thu-ilearn') : undefined),
    });
    s.ctx.config.delivery.webhook = { enabled: true, url: 'http://127.0.0.1:8644/webhooks/thu-ilearn', secret: SECRET };
    const r = await runConnectHermes(s.ctx, { remove: true }, s.deps);
    expect(sub(s.calls, 'cron', 'remove')).toHaveLength(0);
    expect(sub(s.calls, 'webhook', 'remove')).toHaveLength(0);
    expect(s.ctx.config.delivery.webhook.secret).toBe(SECRET);
    expect(r.changes).toEqual([]);
  });
});

describe('displayArgs', () => {
  it('masks the secret value and shortens long prompts', () => {
    const t = displayArgs(['webhook', 'subscribe', 'x', '--secret', SECRET, '--prompt', 'a\n'.repeat(60)]);
    expect(t).toContain('--secret ***');
    expect(t).not.toContain(SECRET);
    expect(t).toContain('固定提示詞');
  });
});

describe('connect hermes --prompt', () => {
  it('gives the fixed cron prompt and instructions for the agent', () => {
    const s = setup();
    const r = connectPromptCommand(s.ctx, { agent: 'hermes' }, s.deps);
    expect(r).toEqual({
      agent: 'hermes',
      cron_job: 'thu-ilearn-inbox',
      schedule: 'every 5m',
      cron_expression: '*/5 * * * *',
      deliver: 'origin',
      prompt: buildCronPrompt({ node: s.deps.node, script: s.deps.script, root: s.ctx.root, agent: 'hermes' }),
    });
    const t = connectPromptText(r);
    expect(t).toContain('thu-ilearn-inbox');
    expect(t).toContain('每 5 分鐘');
    expect(t).toContain('origin');
    expect(t).toContain(r.prompt);
    expect(t).toContain('不要改寫');
    expect(r.prompt).toContain(`ILEARN_HOME="${s.ctx.root}" "/opt/node/bin/node" "/opt/ilearn/dist/cli/index.js"`);
    expect(s.calls).toEqual([]);
    expect(t).not.toMatch(/[嘅咗唔喺係冇佢嚟啲]/);
  });

  it('rejects an invalid agent name', () => {
    const s = setup();
    expect(() => connectPromptCommand(s.ctx, { agent: 'bad name!' }, s.deps)).toThrow(/無效的 agent/);
  });
});

describe('connect hermes --request', () => {
  it('runs only read-only hermes commands and writes a 0600 request file', async () => {
    const s = setup({ cronListed: true });
    const r = await connectRequestCommand(s.ctx, { profile: 'daily', agent: 'hermes' }, s.deps);
    expect(s.calls).toEqual([
      ['-p', 'daily', '--version'],
      ['-p', 'daily', 'cron', 'list'],
      ['-p', 'daily', 'webhook', 'subscribe', '--help'],
      ['-p', 'daily', 'webhook', 'list'],
      ['-p', 'daily', 'config', 'get', 'WEBHOOK_PORT'],
    ]);
    const file = requestFile(s.ctx.root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      code: 'AB23CD',
      profile: 'daily',
      agent: 'hermes',
      cron_job: 'thu-ilearn-inbox',
      port: 8644,
      root: s.ctx.root,
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    });
    expect(r.warnings).toEqual([]);
    expect(r.next_step).toContain('ilearn connect approve');
    expect(r.next_step).toContain('AB23CD');
  });

  it('warns but still writes the request when the cron job is missing', async () => {
    const s = setup();
    const r = await connectRequestCommand(s.ctx, { profile: '', agent: 'hermes', cronJob: 'my-job', port: 9001 }, s.deps);
    expect(r.warnings[0]).toContain('my-job');
    expect(existsSync(requestFile(s.ctx.root))).toBe(true);
    expect(JSON.parse(readFileSync(requestFile(s.ctx.root), 'utf8'))).toMatchObject({ cron_job: 'my-job', port: 9001, profile: '' });
    expect(s.calls.every((c) => c[0] !== '-p')).toBe(true);
  });

  it('rejects bad input and a missing hermes without writing', async () => {
    const s = setup();
    await expect(connectRequestCommand(s.ctx, { profile: 'a b', agent: 'hermes' }, s.deps)).rejects.toThrow(/profile/);
    await expect(connectRequestCommand(s.ctx, { profile: '', agent: 'x y' }, s.deps)).rejects.toThrow(/agent/);
    await expect(connectRequestCommand(s.ctx, { profile: '', agent: 'h', port: 70000 }, s.deps)).rejects.toThrow(/埠/);
    const m = setup({ replies: (a) => (a.includes('--version') ? fail('ENOENT', 127) : undefined) });
    await expect(connectRequestCommand(m.ctx, { profile: '', agent: 'h' }, m.deps)).rejects.toThrow(/找不到 hermes/);
    expect(existsSync(requestFile(m.ctx.root))).toBe(false);
  });
});

describe('connect approve', () => {
  const patch = (s: Setup, f: (r: Record<string, unknown>) => void): void => {
    const file = requestFile(s.ctx.root);
    const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    f(r);
    writeFileSync(file, JSON.stringify(r));
  };
  const hermesCalls = (s: Setup): number => s.calls.length;

  it('refuses when there is no request', async () => {
    const s = setup();
    await expect(runConnectApprove(s.ctx, s.deps)).rejects.toThrow(/沒有待確認/);
    expect(hermesCalls(s)).toBe(0);
  });

  it('refuses an expired request', async () => {
    const s = setup({ cronListed: true });
    await connectRequestCommand(s.ctx, { profile: '', agent: 'hermes' }, s.deps);
    patch(s, (r) => (r.expires_at = new Date(NOW.getTime() - 1000).toISOString()));
    const before = s.calls.length;
    await expect(runConnectApprove(s.ctx, s.deps)).rejects.toThrow(/過期/);
    expect(s.calls.length).toBe(before);
  });

  it('refuses when the request root differs from ILEARN_HOME', async () => {
    const s = setup({ cronListed: true });
    await connectRequestCommand(s.ctx, { profile: '', agent: 'hermes' }, s.deps);
    patch(s, (r) => (r.root = '/somewhere/else'));
    await expect(runConnectApprove(s.ctx, s.deps)).rejects.toThrow(/ILEARN_HOME/);
  });

  it('refuses when the cron job does not exist in Hermes', async () => {
    const s = setup({ confirms: { 確認代碼: true } });
    await connectRequestCommand(s.ctx, { profile: '', agent: 'hermes' }, s.deps);
    await expect(runConnectApprove(s.ctx, s.deps)).rejects.toThrow(/還沒有排程工作 thu-ilearn-inbox/);
    expect(s.calls.some((c) => c.includes('set') || c.includes('restart') || c.includes('subscribe') && !c.includes('--help'))).toBe(false);
    expect(existsSync(requestFile(s.ctx.root))).toBe(true);
  });

  it('declining the code makes no hermes call and keeps the request', async () => {
    const s = setup({ cronListed: true, confirms: { 確認代碼: false } });
    await connectRequestCommand(s.ctx, { profile: 'daily', agent: 'hermes' }, s.deps);
    const before = s.calls.length;
    const r = await runConnectApprove(s.ctx, s.deps);
    expect(r.changes).toEqual([]);
    expect(s.calls.length).toBe(before);
    expect(s.asked.join('\n')).toContain('AB23CD');
    expect(existsSync(requestFile(s.ctx.root))).toBe(true);
    expect(s.ctx.config.delivery.webhook.enabled).toBe(false);
  });

  it('happy path: config set, restart -y, subscribe with the request cron job, then deletes the request', async () => {
    const s = setup({
      confirms: { 確認代碼: true },
      healthy: [false, false, true],
      replies: (a) => (a.join(' ').endsWith('cron list') ? ok('my-inbox  every 5m') : undefined),
    });
    // --request 內部會檢查一次 health，approve 再檢查一次，重新啟動後第三次
    await connectRequestCommand(s.ctx, { profile: 'daily', agent: 'hermes', cronJob: 'my-inbox' }, s.deps);
    s.calls.length = 0;
    s.onSleep.push(
      (c) => void readTestEvents(c.outbox.outboxDir, 'hermes', NOW),
      (c, id) => void reportTest(c.outbox.outboxDir, 'hermes', id, 'processed', undefined, NOW),
      (c, id) => void ackTest(c.outbox.outboxDir, 'hermes', id, NOW),
    );
    const r = await runConnectApprove(s.ctx, s.deps);
    expect(s.calls).toEqual([
      ['-p', 'daily', '--version'],
      ['-p', 'daily', 'cron', 'list'],
      ['-p', 'daily', 'webhook', 'subscribe', '--help'],
      ['-p', 'daily', 'webhook', 'list'],
      ['-p', 'daily', 'config', 'set', 'WEBHOOK_ENABLED', 'true'],
      ['-p', 'daily', 'config', 'set', 'WEBHOOK_PORT', '8644'],
      ['-p', 'daily', 'gateway', 'restart', '-y'],
      [
        '-p', 'daily', 'webhook', 'subscribe', 'thu-ilearn',
        '--cron-job', 'my-inbox',
        '--secret', SECRET,
        '--description', 'thu-ilearn 新事件通知',
        '--prompt', 'thu-ilearn 有新事件，請依排程工作的步驟處理。',
      ],
    ]);
    expect(r.testPassed).toBe(true);
    expect(existsSync(requestFile(s.ctx.root))).toBe(false);
    expect(loadConfig(s.ctx.root).delivery.webhook).toEqual({ enabled: true, url: 'http://127.0.0.1:8644/webhooks/thu-ilearn', secret: SECRET });
    const out = text(s);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('ilearn connect hermes --remove');
    expect(out).toContain('cron remove my-inbox');
  });
});

describe('connect hermes: 預設值偵測', () => {
  it('detectActiveProfile reads the ◆ table format of hermes v0.15.1', () => {
    const table = [
      '',
      ' Profile          Model                        Gateway      Alias        Distribution',
      ' ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────',
      ' ◆default         deepseek/deepseek-v4.1-fla   stopped      —            —',
      '  agentdesigner   qwen3.6:27b-mlx              stopped      agentdesigner —',
    ].join('\n');
    expect(detectActiveProfile(ok(table))).toBe('');
    expect(detectActiveProfile(ok(table.replace(' ◆default', '  default').replace('  agentdesigner', ' ◆agentdesigner')))).toBe('agentdesigner');
  });

  it('detectActiveProfile reads the starred line; default means no profile', () => {
    expect(detectActiveProfile(ok('  default\n  work *\n'))).toBe('work');
    expect(detectActiveProfile(ok('* daily  ready\n'))).toBe('daily');
    expect(detectActiveProfile(ok('default *\nwork\n'))).toBe('');
    expect(detectActiveProfile(ok('default\nwork\n'))).toBe('');
    expect(detectActiveProfile(fail())).toBe('');
  });

  it('interactive flow uses the starred profile and the configured port as defaults', async () => {
    const s = setup({
      replies: (a) => {
        const j = a.join(' ');
        if (j === 'profile list') return ok('default\ndaily *\n');
        if (j.endsWith('config get WEBHOOK_PORT')) return ok('WEBHOOK_PORT: 9100');
        return undefined;
      },
    });
    const seen: Array<{ message: string; default?: string }> = [];
    const orig = s.deps.prompts.input as unknown as (q: { message: string; default?: string }) => Promise<string>;
    s.deps.prompts.input = ((q: { message: string; default?: string }) => (seen.push(q), orig(q))) as never;
    await runConnectHermes(s.ctx, {}, s.deps);
    expect(seen.find((q) => q.message.includes('profile'))?.default).toBe('daily');
    expect(seen.find((q) => q.message.includes('埠'))?.default).toBe('9100');
    expect(s.calls).toContainEqual(['-p', 'daily', 'config', 'get', 'WEBHOOK_PORT']);
  });
});
