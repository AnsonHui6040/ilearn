import { getSyncState } from '../../db/repo.js';
import { dispatchPending, type DispatchResult } from '../../events/dispatch.js';
import type { Channel } from '../../events/outbox.js';
import { isSyncDue, randomJitterMs } from '../../events/schedule.js';
import type { IlearnApi } from '../../ilearn/api.js';
import {
  commitReload,
  planReload,
  runReminderTick,
  runSync,
  type SyncProgress,
  type SyncReport,
} from '../../sync/sync.js';
import { withAuth } from '../auth.js';
import { CliExit, createSetUpContext, NOT_SET_UP, reloadSettings, type CliContext, type ContextOverrides } from '../context.js';
import { clearLastError, writeLastError, writeProgress } from './state.js';

const RECENT_MS = 120_000;
const PROGRESS_WRITE_MS = 1000;

/** API 包裝：中止後下一次呼叫即拋 AbortError，讓同步在安全點停下。 */
export function abortableApi(api: IlearnApi, signal: AbortSignal): IlearnApi {
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      signal.throwIfAborted();
      return fn(...a);
    };
  return {
    activeSemesterCode: wrap(api.activeSemesterCode.bind(api)),
    myCourses: wrap(api.myCourses.bind(api)),
    course: wrap(api.course.bind(api)),
    activities: wrap(api.activities.bind(api)),
    homework: wrap(api.homework.bind(api)),
    submissions: wrap(api.submissions.bind(api)),
    reads: wrap(api.reads.bind(api)),
    exams: wrap(api.exams.bind(api)),
    examScores: wrap(api.examScores.bind(api)),
    bulletins: wrap(api.bulletins.bind(api)),
    courseScore: wrap(api.courseScore.bind(api)),
    downloadUpload: wrap(api.downloadUpload.bind(api)),
  };
}

export interface SyncOutcome {
  skipped: boolean;
  reason?: string;
  report?: SyncReport;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 同步一次（含下載）。處理登入過期；進度寫入 data/progress.json 供 status 讀取。 */
export async function syncCommand(
  ctx: CliContext,
  o: { force?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncOutcome> {
  const st = getSyncState(ctx.db);
  if (!o.force && st.initial_completed && st.last_sync_at !== null) {
    const age = ctx.now().getTime() - Date.parse(st.last_sync_at);
    if (age >= 0 && age < RECENT_MS) {
      return { skipped: true, reason: '剛剛才同步過，如要再次同步請加上 --force' };
    }
  }

  let lastWrite = 0;
  ctx.onProgress = (p): void => {
    o.onProgress?.(p);
    const t = Date.now();
    if (t - lastWrite >= PROGRESS_WRITE_MS) {
      lastWrite = t;
      writeProgress(ctx.root, p);
    }
  };
  try {
    const report = await withAuth(ctx, () => runSync(ctx));
    clearLastError(ctx.root);
    return { skipped: false, report };
  } catch (e) {
    if (!(e instanceof Error && e.name === 'AbortError')) writeLastError(ctx.root, errorMessage(e), ctx.now());
    throw e;
  } finally {
    delete ctx.onProgress;
  }
}

/* ---------- run / daemon ---------- */

export interface TickResult {
  synced: boolean;
  reminders: number;
  delivery: Record<Channel, DispatchResult>;
}

const CHANNEL_NAME: Record<Channel, string> = { hook: '本機指令 hook', webhook: '本機 webhook' };

/** 把到期事件交給 hook／webhook；失敗只記錄，下一輪按 backoff 重試，outbox 不受影響。 */
export async function deliverCommand(
  ctx: CliContext,
  log: (s: string) => void = (s): void => void process.stderr.write(`${s}\n`),
): Promise<Record<Channel, DispatchResult>> {
  const r = await dispatchPending(ctx.outbox, ctx.config.delivery, ctx.now());
  for (const ch of ['hook', 'webhook'] as const) {
    if (r[ch].failed > 0) {
      const err = ctx.outbox.hookStats(ch, ctx.now()).last_error;
      log(`${CHANNEL_NAME[ch]}：${r[ch].failed} 則送出失敗，稍後重試${err ? `（${err}）` : ''}`);
    }
  }
  return r;
}

/** cron／daemon 的一次執行：到點才同步，提醒計時每次都跑。 */
export async function runTick(
  ctx: CliContext,
  o: { jitterMs?: number; log?: (s: string) => void } = {},
): Promise<TickResult> {
  const log = o.log ?? ((s: string): void => void process.stderr.write(`${s}\n`));
  if (!ctx.sessionPresent && ctx.username === null) {
    throw new CliExit(2, NOT_SET_UP);
  }
  const now = ctx.now();
  const st = getSyncState(ctx.db);
  const last = st.last_sync_at !== null ? new Date(st.last_sync_at) : null;

  let synced = false;
  let failure: unknown = null;
  if (isSyncDue(now, last, o.jitterMs ?? randomJitterMs())) {
    try {
      await syncCommand(ctx, { force: true });
      synced = true;
    } catch (e) {
      failure = e;
    }
  }

  const reminders = await runReminderTick(ctx);
  const delivery = await deliverCommand(ctx, log);
  if (failure !== null) throw failure;
  return { synced, reminders, delivery };
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export async function daemonLoop(
  ctx: CliContext,
  o: { signal: AbortSignal; intervalMs?: number; log?: (s: string) => void },
): Promise<void> {
  const log = o.log ?? ((s: string): void => void process.stderr.write(`${s}\n`));
  const interval = o.intervalMs ?? 5 * 60_000;
  while (!o.signal.aborted) {
    try {
      reloadSettings(ctx);
      await runTick(ctx, { log });
    } catch (e) {
      log(`本輪執行失敗：${errorMessage(e)}`);
    }
    await sleep(interval, o.signal);
  }
}

/* ---------- reload ---------- */

export interface ReloadResult {
  planned: number;
  pushed: number;
  reload_id: string | null;
  cancelled: boolean;
}

export async function reloadCommand(
  ctx: CliContext,
  o: { yes?: boolean; isTTY?: boolean; confirm?: (planned: number) => Promise<boolean>; onProgress?: (p: SyncProgress) => void },
): Promise<ReloadResult> {
  await syncCommand(ctx, { force: true, ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
  if (!getSyncState(ctx.db).initial_completed) {
    throw new CliExit(1, '首次同步尚未完成，請先執行 ilearn sync 完成後再 Reload');
  }
  const events = planReload(ctx.db, ctx.now());
  const reloadId = events[0]?.reload_id ?? null;
  if (events.length > 0 && !o.yes) {
    if (!o.isTTY || !o.confirm) throw new CliExit(1, '非互動環境請加上 --yes 確認推送');
    if (!(await o.confirm(events.length))) {
      return { planned: events.length, pushed: 0, reload_id: reloadId, cancelled: true };
    }
  }
  const pushed = commitReload(ctx.outbox, events);
  // 使用者主動按 Reload，夜間也即時送出
  await deliverCommand(ctx);
  return { planned: events.length, pushed, reload_id: reloadId, cancelled: false };
}

/* ---------- 進入點：未設定時不建立任何檔案或事件 ---------- */

type Over = Partial<ContextOverrides>;

export async function syncHandler(
  o: { force?: boolean; onProgress?: (p: SyncProgress) => void } = {},
  over: Over = {},
): Promise<{ ctx: CliContext; outcome: SyncOutcome }> {
  const ctx = createSetUpContext(over);
  const outcome = await syncCommand(ctx, o);
  await deliverCommand(ctx);
  return { ctx, outcome };
}

export async function runHandler(over: Over = {}, o: { jitterMs?: number; log?: (s: string) => void } = {}): Promise<TickResult> {
  return runTick(createSetUpContext(over), o);
}
