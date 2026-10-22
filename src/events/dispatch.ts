import { spawn } from 'node:child_process';
import type { Config } from '../config/config.js';
import type { IlearnEvent } from '../types.js';
import type { Channel, Outbox } from './outbox.js';

const HOOK_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

const duration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`);

/** 只接受本機位址：localhost、*.localhost、127.0.0.0/8、::1；協定限 http／https。 */
export function webhookUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '網址格式不正確';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只接受 http 或 https';
  if (u.username !== '' || u.password !== '') return '網址不可包含帳號密碼';
  const h = u.hostname.toLowerCase();
  const local =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  return local ? null : '只接受本機位址（localhost、127.0.0.1 或 ::1）';
}

/** 執行使用者設定的指令，事件 JSON 經 stdin 傳入；exit code 0 才算成功。 */
export function runHook(command: string, e: IlearnEvent, timeoutMs = HOOK_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, ILEARN_EVENT_ID: e.event_id, ILEARN_EVENT_TYPE: e.type },
    });
    let stderr = '';
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error(`逾時（${duration(timeoutMs)}）`));
    }, timeoutMs);
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 500) stderr += b.toString('utf8');
    });
    child.on('error', (err) => done(err));
    child.on('close', (code) => {
      if (code === 0) done();
      else done(new Error(`exit code ${code ?? 'null'}${stderr.trim() ? `：${stderr.trim()}` : ''}`));
    });
    // 指令不讀 stdin 就結束時寫入會 EPIPE，不影響結果
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${JSON.stringify(e)}\n`);
  });
}

/** POST 事件 JSON 到本機 webhook；不跟隨轉址，2xx 才算成功。 */
export async function postWebhook(
  url: string,
  e: IlearnEvent,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
): Promise<void> {
  const bad = webhookUrlError(url);
  if (bad !== null) throw new Error(`webhook 網址被拒絕：${bad}`);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'thu-ilearn' },
      body: JSON.stringify(e),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(connectionError(err, new URL(url).host, timeoutMs), { cause: err });
  }
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status}（不跟隨轉址）`);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
}

/** fetch 只會回報「fetch failed」，改用底層原因說明連線為何失敗。 */
function connectionError(err: unknown, host: string, timeoutMs: number): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `逾時：${host} 在 ${duration(timeoutMs)}內沒有回應`;
  }
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  switch (cause?.code) {
    case 'ECONNREFUSED':
      return `連線被拒：${host} 沒有程式在接收`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `找不到主機：${host}`;
    case 'ECONNRESET':
      return `連線中斷：${host} 在回應前關閉了連線`;
    default:
      return `無法連線到 ${host}：${cause?.code ?? cause?.message ?? message(err)}`;
  }
}

export interface DispatchDeps {
  runHook?: (command: string, e: IlearnEvent) => Promise<void>;
  postWebhook?: (url: string, e: IlearnEvent) => Promise<void>;
}

export interface DispatchResult {
  sent: number;
  failed: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 把到期的推送事件交給已啟用的 hook／webhook；失敗只記錄，下一輪按 backoff 重試。 */
export async function dispatchPending(
  outbox: Outbox,
  delivery: Config['delivery'],
  now: Date,
  deps: DispatchDeps = {},
): Promise<Record<Channel, DispatchResult>> {
  const result: Record<Channel, DispatchResult> = { hook: { sent: 0, failed: 0 }, webhook: { sent: 0, failed: 0 } };
  const senders: [Channel, ((e: IlearnEvent) => Promise<void>) | null][] = [
    [
      'hook',
      delivery.hook.enabled && delivery.hook.command.trim() !== ''
        ? (e) => (deps.runHook ?? runHook)(delivery.hook.command, e)
        : null,
    ],
    [
      'webhook',
      delivery.webhook.enabled && delivery.webhook.url.trim() !== ''
        ? (e) => (deps.postWebhook ?? postWebhook)(delivery.webhook.url, e)
        : null,
    ],
  ];
  for (const [channel, send] of senders) {
    if (send === null) continue;
    for (const e of outbox.pendingHooks(channel, now)) {
      try {
        await send(e);
        outbox.markHook(channel, e.event_id, true, now);
        result[channel].sent++;
      } catch (err) {
        outbox.markHook(channel, e.event_id, false, now, message(err));
        result[channel].failed++;
      }
    }
  }
  return result;
}
