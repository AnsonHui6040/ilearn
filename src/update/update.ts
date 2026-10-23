import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentProgramDir } from '../service/uninstall.js';

/**
 * 系統更新：目前只有介面。實際的版本檢查與更新會在發布到 npm 後提供，
 * 屆時把檢查結果寫入 <資料根>/data/update.json（{ latest, checked_at }）。
 */

export interface UpdateStatus {
  current: string;
  latest: string | null;
  checkedAt: string | null;
  available: boolean;
}

export const UPDATE_NOT_READY = '自動檢查與更新將在發布到 npm 後提供；目前請在程式資料夾執行 git pull、npm ci、npm run build 更新';

/** a 是否比 b 新（以點分隔的數字逐段比較）。 */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function readUpdateStatus(root: string, current: string): UpdateStatus {
  try {
    const r = JSON.parse(readFileSync(join(root, 'data', 'update.json'), 'utf8')) as { latest?: unknown; checked_at?: unknown };
    const latest = typeof r.latest === 'string' ? r.latest : null;
    const checkedAt = typeof r.checked_at === 'string' ? r.checked_at : null;
    return { current, latest, checkedAt, available: latest !== null && isNewer(latest, current) };
  } catch {
    return { current, latest: null, checkedAt: null, available: false };
  }
}

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(currentProgramDir(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
