import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../../config/paths.js';
import { toTaipeiIso } from '../../time.js';
import type { SyncProgress } from '../../sync/sync.js';

const progressPath = (root: string): string => join(root, 'data', 'progress.json');
const errorPath = (root: string): string => join(root, 'data', 'last_error.json');

export function writeProgress(root: string, p: SyncProgress): void {
  writeSecureFile(progressPath(root), JSON.stringify(p));
}

export function readProgress(root: string): SyncProgress | null {
  const f = progressPath(root);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as SyncProgress;
  } catch {
    return null;
  }
}

/** 只記錄訊息文字，不含密碼或 cookie（錯誤訊息本身不帶這些）。 */
export function writeLastError(root: string, message: string, now: Date): void {
  writeSecureFile(errorPath(root), JSON.stringify({ at: toTaipeiIso(now), message }));
}

export function clearLastError(root: string): void {
  rmSync(errorPath(root), { force: true });
}

export function readLastError(root: string): { at: string; message: string } | null {
  const f = errorPath(root);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as { at: string; message: string };
  } catch {
    return null;
  }
}
