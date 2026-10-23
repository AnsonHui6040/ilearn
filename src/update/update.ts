import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { UpdateFrequency } from '../config/config.js';
import { writeSecureFile } from '../config/paths.js';
import { currentProgramDir } from '../service/uninstall.js';

/**
 * 系統更新：向 npm registry 查詢最新版本，結果寫入 <資料根>/data/update.json（{ latest, checked_at }）；
 * 以 npm 全域安裝的版本可直接執行 npm install -g 更新。
 */

export interface UpdateStatus {
  current: string;
  latest: string | null;
  checkedAt: string | null;
  available: boolean;
}

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

const PACKAGE = 'thu-ilearn';
const DAY_MS = 86_400_000;

export function isCheckDue(now: Date, checkedAt: string | null, freq: UpdateFrequency): boolean {
  if (freq === 'off') return false;
  if (checkedAt === null) return true;
  const gap = freq === 'weekly' ? 7 * DAY_MS : DAY_MS;
  return now.getTime() - Date.parse(checkedAt) >= gap;
}

/** 依使用者的 npm 設定（npm_config_registry）決定查詢的 registry。 */
function registry(env: NodeJS.ProcessEnv): string {
  return (env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/+$/, '');
}

export async function checkForUpdate(o: {
  root: string;
  current: string;
  now: Date;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<UpdateStatus> {
  const res = await (o.fetchImpl ?? fetch)(`${registry(o.env)}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm 上找不到 ${PACKAGE}（HTTP ${res.status}）`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== 'string') throw new Error('npm 回傳的版本格式不正確');
  writeSecureFile(join(o.root, 'data', 'update.json'), JSON.stringify({ latest: version, checked_at: o.now.toISOString() }));
  return readUpdateStatus(o.root, o.current);
}

export type InstallKind = 'npm' | 'git' | 'unknown';

/** npm 全域安裝位於 node_modules/thu-ilearn；git 安裝有 .git 資料夾。 */
export function installKind(programDir: string, exists: (p: string) => boolean): InstallKind {
  if (programDir.includes(`${sep}node_modules${sep}${PACKAGE}`) || programDir.endsWith(`node_modules${sep}${PACKAGE}`)) return 'npm';
  return exists(join(programDir, '.git')) ? 'git' : 'unknown';
}

/** 與執行中的 node 同一個資料夾的 npm；找不到時用 PATH 中的 npm。 */
export function npmBinary(execPath: string, exists: (p: string) => boolean): string {
  const candidate = join(dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return exists(candidate) ? candidate : 'npm';
}

export function applyUpdate(o: {
  kind: InstallKind;
  latest: string | null;
  npm: string;
  run: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
}): string {
  if (o.kind === 'git') return '這份程式以 git 安裝，請在程式資料夾執行 git pull、npm ci、npm run build';
  if (o.latest === null) return '沒有可用的新版本，請先檢查更新';
  const r = o.run(o.npm, ['install', '-g', `${PACKAGE}@${o.latest}`]);
  if (r.code !== 0) return `更新失敗：${r.stderr.trim() || `exit code ${r.code}`}`;
  return `已更新到 ${o.latest}；背景服務下一輪會使用新版本，介面請離開後重新開啟`;
}

/** 目前這份程式的安裝方式。 */
export function currentProgramDirKind(): InstallKind {
  return installKind(currentProgramDir(), (p) => existsSync(p));
}
