import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../config/paths.js';
import { toTaipeiIso } from '../time.js';

/** agent 修改設定的紀錄保留與顯示的天數 */
export const AGENT_CHANGE_DAYS = 7;
/** 提醒頁與總覽最多列出幾項 */
export const AGENT_CHANGE_SHOWN = 20;

export interface AgentChange {
  /** 台北時間 ISO */
  at: string;
  agent: string;
  key: string;
  old: unknown;
  new: unknown;
}

export const agentChangesPath = (root: string): string => join(root, 'data', 'agent-changes.jsonl');

/** 每個變更的鍵附加一行 JSON。 */
export function appendAgentChanges(root: string, now: Date, agent: string, changes: { key: string; old: unknown; new: unknown }[]): void {
  if (changes.length === 0) return;
  const file = agentChangesPath(root);
  ensureDir(join(root, 'data'));
  const at = toTaipeiIso(now);
  const text = changes.map((c) => `${JSON.stringify({ at, agent, key: c.key, old: c.old ?? null, new: c.new ?? null })}\n`).join('');
  appendFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 最近 AGENT_CHANGE_DAYS 日內的紀錄，新的在前；壞掉的行略過。 */
export function recentAgentChanges(root: string, now: Date): AgentChange[] {
  const file = agentChangesPath(root);
  if (!existsSync(file)) return [];
  const since = now.getTime() - AGENT_CHANGE_DAYS * 86_400_000;
  const out: (AgentChange & { ms: number })[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const c = JSON.parse(line) as Partial<AgentChange>;
      const ms = typeof c.at === 'string' ? Date.parse(c.at) : Number.NaN;
      if (Number.isNaN(ms) || ms < since || typeof c.agent !== 'string' || typeof c.key !== 'string') continue;
      out.push({ at: c.at as string, agent: c.agent, key: c.key, old: c.old ?? null, new: c.new ?? null, ms });
    } catch {
      // 損毀的行略過
    }
  }
  // 同一秒內的多筆維持寫入的相反順序
  return out.map((c, i) => ({ c, i })).sort((a, b) => b.c.ms - a.c.ms || b.i - a.i).map(({ c: { ms: _ms, ...rest } }) => rest);
}

export function formatChangeValue(v: unknown): string {
  if (v === null || v === undefined) return '（無）';
  if (Array.isArray(v)) return v.length === 0 ? '（空）' : v.map(String).join('、');
  if (typeof v === 'boolean') return v ? '開啟' : '關閉';
  if (typeof v === 'object') return formatRuleLike(v as Record<string, unknown>);
  return String(v);
}

function formatRuleLike(o: Record<string, unknown>): string {
  if (typeof o.name === 'string' && Array.isArray(o.keywords)) {
    return `「${o.name}」${String(o.action ?? '')}：${o.keywords.map(String).join('、')}`;
  }
  return JSON.stringify(o);
}

/** 「時間 agent 鍵 舊 → 新」，提醒頁與總覽共用。 */
export function formatAgentChange(c: AgentChange): string {
  return `${c.at.slice(5, 16).replace('T', ' ')}  ${c.agent}  ${c.key}  ${formatChangeValue(c.old)} → ${formatChangeValue(c.new)}`;
}
