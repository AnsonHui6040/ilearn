import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { ensureDir, writeSecureFile } from '../config/paths.js';
import { toTaipeiIso } from '../time.js';
import type { EventType, IlearnEvent } from '../types.js';
import { deliverAfter } from './delivery.js';

type MakeEventInput = Omit<IlearnEvent, 'schema' | 'event_id' | 'detected_at' | 'deliver_after'> & {
  detectedAt: Date;
  quiet: { start: string; end: string };
};

export function makeEvent(p: MakeEventInput): IlearnEvent {
  const { detectedAt, quiet, ...rest } = p;
  return {
    schema: 'thu-ilearn.event.v1',
    event_id: ulid(detectedAt.getTime()),
    detected_at: toTaipeiIso(detectedAt),
    deliver_after: toTaipeiIso(deliverAfter(detectedAt, rest.delivery, quiet)),
    ...rest,
  };
}

export type Channel = 'hook' | 'webhook';

interface HookStatus {
  ok: boolean;
  attempts: number;
  last_attempt: string;
  last_error?: string;
}

const MINUTE = 60_000;
/** 第 n 次失敗後要等多久才再試；之後一律 60 分鐘。 */
const BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * MINUTE);
/** cron 每 5 分鐘一次，容許少許提早，避免剛好差幾秒而多等一輪。 */
const BACKOFF_SLACK_MS = 30_000;
/** deliver_after 超過這個時間仍未送出就放棄；outbox 仍保留事件。 */
export const GIVE_UP_MS = 24 * 60 * MINUTE;

export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

const hookKey = (channel: Channel, eventId: string): string => `${channel}:${eventId}`;

interface State {
  dedupe: string[];
  hooks: Record<string, HookStatus>;
}

const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function checkAgent(agent: string): void {
  if (!AGENT_RE.test(agent) || agent === '.' || agent === '..') {
    throw new Error(`無效的 agent 名稱：${agent.slice(0, 64)}`);
  }
}

function dedupeToken(e: IlearnEvent): string {
  return e.reason === 'reload' ? `${e.dedupe_key}|reload:${e.reload_id ?? ''}` : e.dedupe_key;
}

function schemaSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['../..', '../../..']) {
    const p = join(here, up, 'schema', 'event.v1.json');
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 schema/event.v1.json');
}

export class Outbox {
  private readonly dir: string;
  private readonly eventsDir: string;
  private readonly cursorsDir: string;
  private readonly statePath: string;
  private readonly dedupe: Set<string>;
  private readonly hooks: Record<string, HookStatus>;

  constructor(root: string) {
    this.dir = join(root, 'outbox');
    this.eventsDir = join(this.dir, 'events');
    this.cursorsDir = join(this.dir, 'cursors');
    const schemaDir = join(this.dir, 'schema');
    ensureDir(this.eventsDir);
    ensureDir(this.cursorsDir);
    ensureDir(schemaDir);
    const dest = join(schemaDir, 'event.v1.json');
    copyFileSync(schemaSource(), dest);
    chmodSync(dest, 0o600);
    this.statePath = join(this.dir, 'state.json');
    const st = this.loadState();
    this.dedupe = new Set(st.dedupe);
    this.hooks = st.hooks;
  }

  private loadState(): State {
    if (!existsSync(this.statePath)) return { dedupe: [], hooks: {} };
    const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<State>;
    return { dedupe: raw.dedupe ?? [], hooks: raw.hooks ?? {} };
  }

  private saveState(): void {
    const st: State = { dedupe: [...this.dedupe], hooks: this.hooks };
    writeSecureFile(this.statePath, JSON.stringify(st));
  }

  append(e: IlearnEvent): boolean {
    const token = dedupeToken(e);
    if (this.dedupe.has(token)) return false;
    const file = join(this.eventsDir, `${e.detected_at.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    this.dedupe.add(token);
    this.saveState();
    return true;
  }

  private readAll(): IlearnEvent[] {
    const out: IlearnEvent[] = [];
    const files = readdirSync(this.eventsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const f of files) {
      const text = readFileSync(join(this.eventsDir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        out.push(JSON.parse(line) as IlearnEvent);
      }
    }
    return out.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  }

  private cursorPath(agent: string): string {
    checkAgent(agent);
    return join(this.cursorsDir, `${agent}.json`);
  }

  private getCursor(agent: string): string | null {
    const p = this.cursorPath(agent);
    if (!existsSync(p)) return null;
    const c = JSON.parse(readFileSync(p, 'utf8')) as { last_event_id?: string };
    return c.last_event_id ?? null;
  }

  /** since：ISO 時間字串，回傳 detected_at 不早於該時間的事件。 */
  read(f: { since?: string; deliverableAt?: Date; agent?: string; type?: EventType } = {}): IlearnEvent[] {
    const cursor = f.agent !== undefined ? this.getCursor(f.agent) : null;
    const sinceMs = f.since !== undefined ? Date.parse(f.since) : null;
    if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`無效的 since：${f.since}`);
    return this.readAll().filter((e) => {
      if (cursor !== null && e.event_id <= cursor) return false;
      if (sinceMs !== null && Date.parse(e.detected_at) < sinceMs) return false;
      if (f.deliverableAt && Date.parse(e.deliver_after) > f.deliverableAt.getTime()) return false;
      if (f.type && e.type !== f.type) return false;
      return true;
    });
  }

  ack(agent: string, eventId: string): void {
    const cur = this.getCursor(agent);
    if (cur !== null && eventId <= cur) return;
    writeSecureFile(this.cursorPath(agent), JSON.stringify({ last_event_id: eventId }));
  }

  /**
   * 該通道現在要送的事件：非 record、deliver_after 已到且未超過 24 小時、
   * 未成功過，失敗過的要等 backoff 時間過後才再試。
   */
  pendingHooks(channel: Channel, now: Date = new Date()): IlearnEvent[] {
    const t = now.getTime();
    return this.readAll().filter((e) => {
      if (e.delivery === 'record') return false;
      const due = Date.parse(e.deliver_after);
      if (due > t || t - due > GIVE_UP_MS) return false;
      const st = this.hooks[hookKey(channel, e.event_id)];
      if (st === undefined) return true;
      if (st.ok) return false;
      return t >= Date.parse(st.last_attempt) + backoffMs(st.attempts) - BACKOFF_SLACK_MS;
    });
  }

  markHook(channel: Channel, eventId: string, ok: boolean, now: Date = new Date(), error?: string): void {
    const key = hookKey(channel, eventId);
    const prev = this.hooks[key];
    this.hooks[key] = {
      ok,
      attempts: (prev?.attempts ?? 0) + 1,
      last_attempt: toTaipeiIso(now),
      ...(ok || error === undefined ? {} : { last_error: error.slice(0, 200) }),
    };
    this.saveState();
  }

  /** 供 status 顯示：重試中與已放棄的數量，以及最近一次錯誤。 */
  hookStats(channel: Channel, now: Date = new Date()): { retrying: number; gave_up: number; last_error: string | null } {
    const t = now.getTime();
    const byId = new Map(this.readAll().map((e) => [e.event_id, e]));
    let retrying = 0;
    let gaveUp = 0;
    let last: HookStatus | null = null;
    for (const [key, st] of Object.entries(this.hooks)) {
      if (st.ok || !key.startsWith(`${channel}:`)) continue;
      const e = byId.get(key.slice(channel.length + 1));
      if (e === undefined) continue;
      if (t - Date.parse(e.deliver_after) > GIVE_UP_MS) gaveUp++;
      else retrying++;
      if (last === null || st.last_attempt > last.last_attempt) last = st;
    }
    return { retrying, gave_up: gaveUp, last_error: last?.last_error ?? null };
  }

  renderMarkdown(): void {
    const events = this.readAll().slice(-100).reverse();
    const lines: string[] = ['# iLearn 通知', '', `最近 ${events.length} 則（新到舊）。`, ''];
    for (const e of events) {
      const course = e.course ? `${e.course.name}（${e.course.semester}）` : '系統';
      lines.push(`## ${e.item?.title ?? e.type}`, '');
      lines.push(`- 類型：${e.type}${e.offset ? `（${e.offset}）` : ''}`);
      lines.push(`- 課程：${course}`);
      lines.push(`- 偵測時間：${e.detected_at}`);
      if (e.deliver_after !== e.detected_at) lines.push(`- 送出時間：${e.deliver_after}`);
      lines.push(`- 等級：${e.delivery}`);
      if (e.item?.due_at) lines.push(`- 截止：${e.item.due_at}`);
      if (e.item?.url) lines.push(`- 連結：${e.item.url}`);
      if (e.summary) lines.push(`- 摘要：${e.summary}`);
      if (e.note) lines.push(`- 備註：${e.note}`);
      lines.push('');
    }
    writeSecureFile(join(this.dir, '通知.md'), lines.join('\n'));
  }
}
