import type { UpdateFrequency } from '../../config/config.js';
import { applyUpdate, checkForUpdate, isCheckDue, readUpdateStatus, type InstallKind } from '../../update/update.js';
import { CliExit } from '../context.js';

type Run = (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };

/** 先向 npm 查詢最新版本，有新版本才更新；只能由本人在互動終端操作。 */
export async function updateApplyCommand(o: {
  isTTY: boolean;
  root: string;
  current: string;
  now: Date;
  env: NodeJS.ProcessEnv;
  kind: InstallKind;
  npm: string;
  run: Run;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!o.isTTY) throw new CliExit(1, '更新需要在互動終端機執行');
  const st = await checkForUpdate({ root: o.root, current: o.current, now: o.now, env: o.env, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  if (!st.available) return `已是最新版本 ${st.current}`;
  return applyUpdate({ kind: o.kind, latest: st.latest, npm: o.npm, run: o.run });
}

/** 背景執行時依頻率檢查新版本；失敗只記錄，不影響同步與提醒。 */
export async function maybeCheckUpdate(o: {
  root: string;
  freq: UpdateFrequency;
  current: string;
  now: Date;
  env: NodeJS.ProcessEnv;
  log: (s: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!isCheckDue(o.now, readUpdateStatus(o.root, o.current).checkedAt, o.freq)) return false;
  try {
    await checkForUpdate({ root: o.root, current: o.current, now: o.now, env: o.env, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    return true;
  } catch (e) {
    o.log(`檢查更新失敗：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
