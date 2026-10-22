import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** ILEARN_HOME ?? ~/.thu-ilearn */
export function dataRoot(): string {
  const env = process.env.ILEARN_HOME;
  return env && env.length > 0 ? env : join(homedir(), '.thu-ilearn');
}

/** mkdir -p，目錄 chmod 0700 */
export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  chmodSync(p, 0o700);
}

/** 原子寫入（暫存檔 + rename），檔案 chmod 0600 */
export function writeSecureFile(p: string, data: string | Buffer): void {
  ensureDir(dirname(p));
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}
