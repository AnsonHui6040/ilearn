import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../config/paths.js';
import { toTaipeiIso } from '../time.js';

export type ReportStatus = 'processed' | 'failed';

export interface ProcessingReport {
  agent: string;
  event_id: string;
  type: string;
  status: ReportStatus;
  at: string;
  note: string | null;
}

export interface ProcessingFailure {
  agent: string;
  event_id: string;
  type: string;
  at: string;
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

/** 最近 7 天尚未解決的處理失敗：之後同一個 agent 對同一事件回報 processed 就視為已解決。 */
export function recentFailures(outboxDir: string, now: Date): ProcessingFailure[] {
  const all = load(outboxDir);
  const out: ProcessingFailure[] = [];
  all.forEach((r, i) => {
    if (r.status !== 'failed' || now.getTime() - Date.parse(r.at) > FAILURE_WINDOW_MS) return;
    const resolved = all.slice(i + 1).some((x) => x.status === 'processed' && x.agent === r.agent && x.event_id === r.event_id);
    if (!resolved) out.push({ agent: r.agent, event_id: r.event_id, type: r.type, at: r.at, note: r.note });
  });
  return out;
}
