import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../config/paths.js';
import { toTaipeiIso } from '../time.js';

export type ReportStatus = 'processed' | 'failed' | 'skipped';

export interface ProcessingReport {
  agent: string;
  event_id: string;
  type: string;
  status: ReportStatus;
  at: string;
  note: string | null;
}

/** 同一個 agent 對同一則事件在最近 7 天內尚未解決的失敗或略過，合併成一筆。 */
export interface ProcessingFailure {
  agent: string;
  event_id: string;
  type: string;
  /** 最新一次回報的狀態；略過（skipped）代表已隔離，agent 可以 ACK 越過 */
  status: 'failed' | 'skipped';
  /** failed 與 skipped 回報的總次數 */
  count: number;
  first_at: string;
  /** 最新一次回報的時間 */
  at: string;
  /** 最新一次回報的說明 */
  note: string | null;
}

const NOTE_MAX = 300;
const KEEP_MS = 30 * 24 * 3_600_000;
const FAILURE_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_ENTRIES = 500;

/** 去掉控制字元（換行以空白取代）並限制長度。 */
export function cleanNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const t = note.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, NOTE_MAX);
  return t === '' ? null : t;
}

const file = (outboxDir: string): string => join(outboxDir, 'reports.json');

function load(outboxDir: string): ProcessingReport[] {
  const p = file(outboxDir);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as ProcessingReport[]) : [];
  } catch {
    return [];
  }
}

/** 記錄 agent 對正式事件的處理結果。不會移動任何 cursor。 */
export function recordReport(outboxDir: string, r: Omit<ProcessingReport, 'at'>, now: Date): ProcessingReport {
  const entry: ProcessingReport = { ...r, at: toTaipeiIso(now) };
  const keep = load(outboxDir).filter((x) => now.getTime() - Date.parse(x.at) <= KEEP_MS);
  keep.push(entry);
  writeSecureFile(file(outboxDir), JSON.stringify(keep.slice(-MAX_ENTRIES)));
  return entry;
}

/** 該 agent 對該事件先前回報 failed 的次數（不論是否已解決）。 */
export function failedCount(outboxDir: string, agent: string, eventId: string): number {
  return load(outboxDir).filter((r) => r.status === 'failed' && r.agent === agent && r.event_id === eventId).length;
}

/** 同一個 agent 對同一事件的失敗次數表，key 為 event_id。 */
export function failedCounts(outboxDir: string, agent: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of load(outboxDir)) {
    if (r.status === 'failed' && r.agent === agent) m.set(r.event_id, (m.get(r.event_id) ?? 0) + 1);
  }
  return m;
}

/**
 * 最近 7 天尚未解決的處理失敗，每個 agent 與事件只有一筆。
 * 之後同一個 agent 對同一事件回報 processed，或已經 ACK 到這則事件之後，就視為已解決；
 * 略過（skipped）的事件仍然列出，讓使用者知道有事件沒有通知。
 */
export function recentFailures(
  outboxDir: string,
  now: Date,
  ackedThrough: (agent: string) => string | null = () => null,
): ProcessingFailure[] {
  const all = load(outboxDir);
  const cursors = new Map<string, string | null>();
  const acked = (agent: string, eventId: string): boolean => {
    if (!cursors.has(agent)) cursors.set(agent, ackedThrough(agent));
    const c = cursors.get(agent) ?? null;
    return c !== null && eventId <= c;
  };
  const groups = new Map<string, ProcessingFailure>();
  all.forEach((r, i) => {
    if (r.status === 'processed' || now.getTime() - Date.parse(r.at) > FAILURE_WINDOW_MS) return;
    const resolved = all.slice(i + 1).some((x) => x.status === 'processed' && x.agent === r.agent && x.event_id === r.event_id);
    if (resolved) return;
    const key = `${r.agent}\u0000${r.event_id}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, { agent: r.agent, event_id: r.event_id, type: r.type, status: r.status, count: 1, first_at: r.at, at: r.at, note: r.note });
    } else {
      g.count += 1;
      g.status = r.status;
      g.at = r.at;
      g.note = r.note;
    }
  });
  return [...groups.values()]
    .filter((g) => g.status === 'skipped' || !acked(g.agent, g.event_id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
