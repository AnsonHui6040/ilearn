import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { THU_PERIOD_TIMES } from '../domain/schedule.js';
import type { Delivery } from '../types.js';
import { dataRoot, writeSecureFile } from './paths.js';

export interface Config {
  environment: 'desktop' | 'vps';
  interfaces: { terminal: boolean; folder: boolean; web: boolean; desktop: boolean };
  delivery: { hook: { enabled: boolean; command: string }; webhook: { enabled: boolean; url: string } };
  quiet_hours: { start: string; end: string };
  reminders: { offsets: string[] };
  force_push_offsets: string[];
  files: { download_disallowed: 'skip' | 'download' };
  summaries: { daily_limit: number; courses: Record<string, { materials: boolean; announcements: boolean }> };
  course_overrides: Record<
    string,
    { reminders?: string[]; rules?: Record<string, { enabled?: boolean; action?: Delivery }> }
  >;
  period_times: Record<string, { start: string; end: string }>;
  password_saved: boolean;
}

export const DEFAULT_CONFIG: Config = {
  environment: 'desktop',
  interfaces: { terminal: true, folder: true, web: false, desktop: false },
  delivery: {
    hook: { enabled: false, command: '' },
    webhook: { enabled: false, url: '' },
  },
  quiet_hours: { start: '00:00', end: '07:00' },
  reminders: { offsets: ['P1D', 'PT3H'] },
  force_push_offsets: ['PT3H'],
  files: { download_disallowed: 'skip' },
  summaries: { daily_limit: 20, courses: {} },
  course_overrides: {},
  period_times: structuredClone(THU_PERIOD_TIMES),
  password_saved: false,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 以預設為底，遞迴合併使用者值；陣列及未知形狀整個取代。 */
function merge<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return structuredClone(base);
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
      const b = (base as Record<string, unknown>)[k];
      out[k] = k in base ? merge(b, over[k]) : structuredClone(over[k]);
    }
    return out as T;
  }
  return structuredClone(over) as T;
}

export function loadConfig(root: string = dataRoot()): Config {
  const file = join(root, 'config.yaml');
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const parsed: unknown = parse(readFileSync(file, 'utf8'));
  return merge(DEFAULT_CONFIG, parsed);
}

export function saveConfig(cfg: Config, root: string = dataRoot()): void {
  writeSecureFile(join(root, 'config.yaml'), stringify(cfg));
}
