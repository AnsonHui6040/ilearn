import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Config } from '../config/config.js';
import { ensureDir, writeSecureFile } from '../config/paths.js';
import { toTaipeiIso } from '../time.js';
import type { WireEvent } from '../types.js';
import { checkAgent } from './outbox.js';
import { cleanNote, type ReportStatus } from './reports.js';

/**
 * delivery test 的測試事件：只存在 outbox/test/，不寫入 outbox/events/，
 * 不進正式去重、cursor 與重試狀態。
 */
const EXPIRE_MS = 24 * 3_600_000;
const RESULT_KEEP_MS = 7 * 24 * 3_600_000;

export interface TestTransport {
  cli?: { ok: boolean; error?: string };
  webhook?: { ok: boolean; status?: number; error?: string; signed: boolean };
}

export interface TestResult {
  test_id: string;
  agent: string;
  created_at: string;
  transport: TestTransport;
  agent_read_at?: string;
  processed?: { status: ReportStatus; at: string; note: string | null };
  acked_at?: string;
  /** 逾時未完成而被清理 */
  timed_out_at?: string;
}

const dirOf = (outboxDir: string): string => join(outboxDir, 'test');
const eventFile = (outboxDir: string, id: string): string => join(dirOf(outboxDir), `${id}.json`);
const resultsFile = (outboxDir: string): string => join(dirOf(outboxDir), 'results.json');

function loadResults(outboxDir: string): Record<string, TestResult> {
  const p = resultsFile(outboxDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, TestResult>;
  } catch {
    return {};
  }
}

function saveResults(outboxDir: string, r: Record<string, TestResult>): void {
  writeSecureFile(resultsFile(outboxDir), JSON.stringify(r));
}

export const isExpired = (r: TestResult, now: Date): boolean =>
  r.acked_at === undefined && (r.timed_out_at !== undefined || now.getTime() - Date.parse(r.created_at) > EXPIRE_MS);

/** 清掉逾時未 ACK 的測試事件（結果標記逾時並保留），並丟棄太舊的結果。 */
export function cleanupTests(outboxDir: string, now: Date): number {
  const results = loadResults(outboxDir);
  let cleaned = 0;
  for (const [id, r] of Object.entries(results)) {
    if (r.acked_at === undefined && r.timed_out_at === undefined && isExpired(r, now)) {
      r.timed_out_at = toTaipeiIso(now);
      rmSync(eventFile(outboxDir, id), { force: true });
      cleaned++;
    }
    if (now.getTime() - Date.parse(r.created_at) > RESULT_KEEP_MS) delete results[id];
  }
  if (existsSync(dirOf(outboxDir))) saveResults(outboxDir, results);
  return cleaned;
}

export function makeTestEvent(now: Date): WireEvent {
  const id = ulid(now.getTime());
  return {
    schema: 'thu-ilearn.event.v1',
    event_id: id,
    type: 'delivery.test',
    detected_at: toTaipeiIso(now),
    deliver_after: toTaipeiIso(now),
    delivery: 'push',
    categories: [],
    matched_rules: [],
    course: null,
    item: null,
    summary: 'thu-ilearn 推送測試',
    dedupe_key: `delivery.test:${id}`,
  };
}

export interface TestSenders {
  runHook?: (command: string, e: WireEvent) => Promise<unknown>;
  postWebhook?: (url: string, e: WireEvent, secret: string) => Promise<unknown>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 建立測試事件並同步送進每個已啟用的通道；沒有啟用的通道不會出現在 transport。 */
export async function createDeliveryTest(
  outboxDir: string,
  agent: string,
  delivery: Config['delivery'],
  now: Date,
  send: Required<TestSenders>,
): Promise<TestResult> {
  checkAgent(agent);
  ensureDir(dirOf(outboxDir));
  cleanupTests(outboxDir, now);
  const e = makeTestEvent(now);
  writeSecureFile(eventFile(outboxDir, e.event_id), JSON.stringify(e));
  const result: TestResult = { test_id: e.event_id, agent, created_at: e.detected_at, transport: {} };
  const results = loadResults(outboxDir);
  results[e.event_id] = result;
  saveResults(outboxDir, results);

  if (delivery.cli.enabled && delivery.cli.command.trim() !== '') {
    try {
      await send.runHook(delivery.cli.command, e);
      result.transport.cli = { ok: true };
    } catch (err) {
      result.transport.cli = { ok: false, error: errText(err).slice(0, 200) };
    }
  }
  if (delivery.webhook.enabled && delivery.webhook.url.trim() !== '') {
    const signed = delivery.webhook.secret !== '';
    try {
      const status = await send.postWebhook(delivery.webhook.url, e, delivery.webhook.secret);
      result.transport.webhook = { ok: true, ...(typeof status === 'number' ? { status } : {}), signed };
    } catch (err) {
      const m = errText(err);
      const http = /^HTTP (\d{3})/.exec(m);
      result.transport.webhook = {
        ok: false,
        ...(http ? { status: Number(http[1]) } : {}),
        error: m.slice(0, 200),
        signed,
      };
    }
  }
  const fresh = loadResults(outboxDir);
  fresh[e.event_id] = result;
  saveResults(outboxDir, fresh);
  return result;
}

export function getTestResult(outboxDir: string, testId: string): TestResult | null {
  return loadResults(outboxDir)[testId] ?? null;
}

/** 該 agent 尚未 ACK 且未逾時的測試事件；讀到時記錄 agent_read_at（只記第一次）。 */
export function readTestEvents(outboxDir: string, agent: string, now: Date): WireEvent[] {
  checkAgent(agent);
  if (!existsSync(dirOf(outboxDir))) return [];
  const results = loadResults(outboxDir);
  const out: WireEvent[] = [];
  for (const f of readdirSync(dirOf(outboxDir)).sort()) {
    if (!f.endsWith('.json') || f === 'results.json') continue;
    const id = f.slice(0, -5);
    const r = results[id];
    if (r === undefined || r.agent !== agent || r.acked_at !== undefined || isExpired(r, now)) continue;
    out.push(JSON.parse(readFileSync(join(dirOf(outboxDir), f), 'utf8')) as WireEvent);
    r.agent_read_at ??= toTaipeiIso(now);
  }
  if (out.length > 0) saveResults(outboxDir, results);
  return out;
}

function mustOwn(outboxDir: string, agent: string, testId: string): { results: Record<string, TestResult>; r: TestResult } {
  checkAgent(agent);
  const results = loadResults(outboxDir);
  const r = results[testId];
  if (r === undefined) throw new Error(`找不到測試事件 ${testId}`);
  if (r.agent !== agent) throw new Error(`測試事件 ${testId} 不是 ${agent} 的測試`);
  return { results, r };
}

export function reportTest(outboxDir: string, agent: string, testId: string, status: ReportStatus, note: string | undefined, now: Date): TestResult {
  const { results, r } = mustOwn(outboxDir, agent, testId);
  r.processed = { status, at: toTaipeiIso(now), note: cleanNote(note) };
  saveResults(outboxDir, results);
  return r;
}

/** 測試事件的 ACK：獨立於正式 cursor；ACK 完成後才刪除測試事件檔，結果保留。 */
export function ackTest(outboxDir: string, agent: string, testId: string, now: Date): TestResult {
  const { results, r } = mustOwn(outboxDir, agent, testId);
  r.acked_at ??= toTaipeiIso(now);
  saveResults(outboxDir, results);
  rmSync(eventFile(outboxDir, testId), { force: true });
  return r;
}

export type Level = 'PASS' | 'FAIL' | 'PENDING' | '未啟用';

export interface TestStatus {
  test_id: string;
  agent: string;
  created_at: string;
  timed_out: boolean;
  /** webhook 是否有簽名；webhook 未啟用時為 null */
  signed: boolean | null;
  transport: {
    status: Level;
    cli: { status: Level; error?: string };
    webhook: { status: Level; http_status?: number; error?: string; signed: boolean | null };
  };
  agent_read: { status: Level; at: string | null };
  processing: { status: Level; at: string | null; note: string | null };
  ack: { status: Level; at: string | null };
}

export function testStatus(outboxDir: string, testId: string, now: Date): TestStatus {
  const r = getTestResult(outboxDir, testId);
  if (r === null) throw new Error(`找不到測試 ${testId}`);
  const cli = r.transport.cli;
  const wh = r.transport.webhook;
  const cliLevel: Level = cli === undefined ? '未啟用' : cli.ok ? 'PASS' : 'FAIL';
  const whLevel: Level = wh === undefined ? '未啟用' : wh.ok ? 'PASS' : 'FAIL';
  const enabled = [cliLevel, whLevel].filter((l) => l !== '未啟用');
  const transport: Level = enabled.length === 0 ? '未啟用' : enabled.every((l) => l === 'PASS') ? 'PASS' : 'FAIL';
  return {
    test_id: r.test_id,
    agent: r.agent,
    created_at: r.created_at,
    timed_out: isExpired(r, now),
    signed: wh === undefined ? null : wh.signed,
    transport: {
      status: transport,
      cli: { status: cliLevel, ...(cli?.error !== undefined ? { error: cli.error } : {}) },
      webhook: {
        status: whLevel,
        ...(wh?.status !== undefined ? { http_status: wh.status } : {}),
        ...(wh?.error !== undefined ? { error: wh.error } : {}),
        signed: wh === undefined ? null : wh.signed,
      },
    },
    agent_read: { status: r.agent_read_at !== undefined ? 'PASS' : 'PENDING', at: r.agent_read_at ?? null },
    processing: {
      status: r.processed === undefined ? 'PENDING' : r.processed.status === 'processed' ? 'PASS' : 'FAIL',
      at: r.processed?.at ?? null,
      note: r.processed?.note ?? null,
    },
    ack: { status: r.acked_at !== undefined ? 'PASS' : 'PENDING', at: r.acked_at ?? null },
  };
}
