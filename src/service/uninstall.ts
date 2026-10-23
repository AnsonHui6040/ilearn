import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliExit } from '../cli/context.js';

/** 完全移除 thu-ilearn：背景服務、ilearn 指令、程式資料夾，可選擇一併刪除資料夾。 */

export interface UninstallPlan {
  removeData: boolean;
  dataRoot: string;
  programDir: string;
  /** 只有預設安裝位置 ~/thu-ilearn 且確實是 thu-ilearn 套件時才刪除程式資料夾 */
  deleteProgramDir: boolean;
  lines: string[];
}

export interface UninstallDeps {
  uninstallService(): string;
  logout(): Promise<void>;
  removeDir(path: string): void;
  run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
}

export function planUninstall(o: {
  removeData: boolean;
  dataRoot: string;
  programDir: string;
  home: string;
  isPackage: (dir: string) => boolean;
}): UninstallPlan {
  const dataRoot = resolve(o.dataRoot);
  if (o.removeData && (dataRoot === resolve(o.home) || dataRoot === resolve('/') || resolve(o.home).startsWith(`${dataRoot}/`))) {
    throw new CliExit(1, `資料夾位置 ${dataRoot} 不安全，不會刪除`);
  }
  const deleteProgramDir = resolve(o.programDir) === resolve(o.home, 'thu-ilearn') && o.isPackage(o.programDir);
  const lines = ['移除背景服務'];
  if (o.removeData) lines.push('刪除登入資料與 Keychain 中的密碼', `刪除資料夾 ${dataRoot}（包括已下載的教材）`);
  lines.push('移除 ilearn 指令（npm rm -g thu-ilearn）');
  lines.push(deleteProgramDir ? `刪除程式資料夾 ${o.programDir}` : `程式資料夾 ${o.programDir} 不是預設安裝位置，請自行刪除`);
  if (!o.removeData) lines.push(`保留資料夾 ${dataRoot}（設定、資料庫、已下載的教材與登入資料）`);
  return { removeData: o.removeData, dataRoot, programDir: o.programDir, deleteProgramDir, lines };
}

/** 逐步執行；某一步失敗時記下原因並繼續其他步驟。 */
export async function runUninstall(plan: UninstallPlan, deps: UninstallDeps): Promise<string[]> {
  const out: string[] = [];
  const step = async (ok: string, fail: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
      out.push(ok);
    } catch (e) {
      out.push(`${fail}：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await step('已移除背景服務', '移除背景服務失敗', () => deps.uninstallService());
  if (plan.removeData) {
    await step('已刪除登入資料與 Keychain 中的密碼', '刪除登入資料失敗', () => deps.logout());
    await step(`已刪除資料夾 ${plan.dataRoot}`, '刪除資料夾失敗', () => deps.removeDir(plan.dataRoot));
  }
  const npm = deps.run('npm', ['rm', '-g', 'thu-ilearn']);
  out.push(npm.code === 0 ? '已移除 ilearn 指令' : `移除 ilearn 指令失敗：${npm.stderr.trim() || `exit code ${npm.code}`}，請自行執行 npm rm -g thu-ilearn`);
  if (plan.deleteProgramDir) await step(`已刪除程式資料夾 ${plan.programDir}`, '刪除程式資料夾失敗', () => deps.removeDir(plan.programDir));
  else out.push(`請自行刪除程式資料夾 ${plan.programDir}`);
  out.push('thu-ilearn 已完全移除');
  return out;
}

/** 這份程式所在的套件資料夾（dist/service/uninstall.js 往上兩層）。 */
export function currentProgramDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function isThuIlearnPackage(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'thu-ilearn';
  } catch {
    return false;
  }
}

export const removeDirRecursive = (p: string): void => rmSync(p, { recursive: true, force: true });
