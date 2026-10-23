import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { rulesEditCommand } from '../cli/commands/rules.js';
import { deliverCommand, reloadCommand, syncCommand } from '../cli/commands/sync.js';
import { renderFolderView } from '../folder/folder.js';
import { logout } from '../cli/auth.js';
import { DEFAULT_WEBHOOK_URL, formatProgress, runLogin } from '../cli/setup.js';
import { webhookUrlError } from '../events/dispatch.js';
import type { Rule } from '../rules/engine.js';
import { dataRoot } from '../config/paths.js';
import {
  defaultServiceDeps, defaultServiceSpec, installService, serviceStatus, uninstallService, type ServiceStatus,
} from '../service/service.js';
import {
  currentProgramDir, isThuIlearnPackage, planUninstall, removeDirRecursive, runUninstall, type UninstallPlan,
} from '../service/uninstall.js';
import { homedir } from 'node:os';
import type { UpdateFrequency } from '../config/config.js';
import { checkForUpdate, currentProgramDirKind, currentVersion, npmBinary, readUpdateStatus } from '../update/update.js';
import { updateApplyCommand } from '../cli/commands/update.js';
import { existsSync } from 'node:fs';
import { CliExit, reloadSettings, type CliContext } from '../cli/context.js';
import type { Delivery } from '../types.js';
import {
  applyChanges, applyCourseRuleAction, applyDelivery, applyInterfaces, applyQuietHours, applyReminderOffsets, applyUpdateFrequency,
  nextRuleId, OFFSET_CHOICES, parseKeywords, previewChanges, previewRule, saveRule,
} from './actions.js';
import { courseDetail, loadTuiData, type TuiData } from './data.js';
import { bodyRows, MIN_COLS, MIN_ROWS, renderFrame, visibleStart } from './frame.js';
import { bannerFor, buildPage, offsetLabel, type PageSources } from './pages.js';
import { initialState, normalize, reduce, type Effect, type Key, type OpenTarget, type Prompt, type RunKind, type TuiState } from './state.js';

/** sigterm：程序收到 SIGTERM，即使正在問答也要離開並還原終端。 */
export type UiKey = Key | 'ctrl-c' | 'sigterm';

export interface Term {
  write(s: string): void;
  size(): { cols: number; rows: number };
  onKey(fn: (k: UiKey) => void): () => void;
  onResize(fn: () => void): () => void;
  setRaw(on: boolean): void;
}

export interface PromptDeps {
  input(o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  checkbox<T>(o: { message: string; choices: { name: string; value: T; checked?: boolean; disabled?: boolean | string }[] }): Promise<T[]>;
  select<T>(o: { message: string; choices: { name: string; value: T }[]; default?: T }): Promise<T>;
  confirm(o: { message: string; default?: boolean }): Promise<boolean>;
}

export interface UiDeps {
  prompts: PromptDeps;
  service: { status(): ServiceStatus; install(): string; uninstall(): string };
  removal: { plan(removeData: boolean): UninstallPlan; execute(plan: UninstallPlan): Promise<string[]> };
  updater: { check(): Promise<string>; apply(): Promise<string> };
  opener: (t: OpenTarget) => { ok: boolean; message: string };
  clock: { every(ms: number, fn: () => void): () => void };
  color: boolean;
}

const ESC = String.fromCharCode(27);
const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l`;
const LEAVE_SCREEN = `${ESC}[?25h${ESC}[?1049l`;

export function assertInteractive(stdinTTY: boolean, stdoutTTY: boolean): void {
  if (!stdinTTY || !stdoutTTY) throw new CliExit(1, '介面需要在互動終端機執行');
}

/** 終端按鍵轉成介面按鍵；其他鍵回傳 null。 */
export function mapKey(str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): UiKey | null {
  if (key?.ctrl && key.name === 'c') return 'ctrl-c';
  switch (key?.name) {
    case 'up': case 'down': case 'left': case 'right': case 'pageup': case 'pagedown': case 'space':
      return key.name;
    case 'return': case 'enter':
      return 'enter';
    case 'escape':
      return 'esc';
  }
  if (str === 'q' || str === '1' || str === '2' || str === '3' || str === '4' || str === '5') return str;
  return null;
}

/** macOS 用 open，Linux 有桌面時用 xdg-open；其他情況只回傳路徑讓使用者自己開。 */
export function defaultOpener(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): (t: OpenTarget) => { ok: boolean; message: string } {
  const cmd = platform === 'darwin' ? 'open' : platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  return (t) => {
    const what = t.kind === 'url' ? t.url : t.path;
    if (cmd === null) return { ok: false, message: `這個環境無法直接開啟，請手動開啟：${what}` };
    try {
      spawn(cmd, [what], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, message: `已開啟：${what}` };
    } catch {
      return { ok: false, message: `無法開啟，請手動開啟：${what}` };
    }
  };
}

export function nodeTerm(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Term {
  return {
    write: (s) => void output.write(s),
    size: () => ({ cols: output.columns ?? 80, rows: output.rows ?? 24 }),
    onKey: (fn) => {
      emitKeypressEvents(input);
      const h = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
        const k = mapKey(str, key);
        if (k !== null) fn(k);
      };
      const term = (): void => fn('sigterm');
      input.on('keypress', h);
      process.on('SIGTERM', term);
      input.resume();
      return () => {
        input.off('keypress', h);
        process.off('SIGTERM', term);
        input.pause();
      };
    },
    onResize: (fn) => {
      output.on('resize', fn);
      return () => void output.off('resize', fn);
    },
    setRaw: (on) => {
      if (input.isTTY) input.setRawMode(on);
      // @inquirer/prompts 結束時會暫停 stdin，回到介面要重新讀取按鍵
      if (on) input.resume();
    },
  };
}

export async function defaultDeps(ctx: CliContext): Promise<UiDeps> {
  const p = await import('@inquirer/prompts');
  return {
    prompts: p as unknown as PromptDeps,
    service: {
      status: () => serviceStatus(defaultServiceDeps(), defaultServiceSpec(dataRoot()).script),
      install: () => `已安裝背景服務：${installService(defaultServiceDeps(), defaultServiceSpec(dataRoot())).detail}`,
      uninstall: () => uninstallService(defaultServiceDeps()),
    },
    updater: {
      check: async () => {
        const st = await checkForUpdate({ root: ctx.root, current: currentVersion(), now: new Date(), env: process.env });
        return st.available ? `有新版本 ${st.latest}（目前 ${st.current}）` : `已是最新版本 ${st.current}`;
      },
      apply: () =>
        updateApplyCommand({
          isTTY: true, root: ctx.root, current: currentVersion(), now: new Date(), env: process.env,
          kind: currentProgramDirKind(), npm: npmBinary(process.execPath, existsSync),
          run: (cmd, args) => defaultServiceDeps().run(cmd, args),
        }),
    },
    removal: {
      plan: (removeData) =>
        planUninstall({ removeData, dataRoot: ctx.root, programDir: currentProgramDir(), home: homedir(), isPackage: isThuIlearnPackage }),
      execute: (plan) =>
        runUninstall(plan, {
          uninstallService: () => uninstallService(defaultServiceDeps()),
          logout: () => logout(ctx),
          removeDir: removeDirRecursive,
          run: (cmd, args) => defaultServiceDeps().run(cmd, args),
        }),
    },
    opener: defaultOpener(process.platform, process.env),
    clock: { every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    } },
    color: true,
  };
}

const isPromptExit = (e: unknown): boolean => e instanceof Error && e.name === 'ExitPromptError';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function runUi(ctx: CliContext, term: Term, deps: UiDeps): Promise<void> {
  const load = (): TuiData => ({ ...loadTuiData(ctx), service: deps.service.status(), update: readUpdateStatus(ctx.root, currentVersion()) });
  let data: TuiData = load();
  let state: TuiState = initialState();
  let busy = false;
  const src: PageSources = { detail: (id) => courseDetail(ctx, id), preview: (c) => previewChanges(ctx, c) };
  const enter = (): void => {
    term.write(ENTER_SCREEN);
    term.setRaw(true);
  };
  const leave = (): void => {
    term.setRaw(false);
    term.write(LEAVE_SCREEN);
  };

  const page = () => {
    const cols = term.size().cols;
    state = normalize(state, buildPage(state, data, cols, src).panes);
    return buildPage(state, data, cols, src);
  };

  const render = (): void => {
    const size = term.size();
    const p = page();
    const banner = bannerFor(data);
    const h = bodyRows(size, banner.length);
    // 記住捲動位置，游標移動時畫面不跳動
    const scroll: [number, number] = [0, 1].map((i) =>
      visibleStart(state.cursor[i] ?? 0, state.scroll[i] ?? 0, h, p.panes[i]?.length ?? 0),
    ) as [number, number];
    state = { ...state, scroll };
    const lines = renderFrame(
      {
        tab: state.tab, now: data.now, lastSyncAt: data.status.last_sync_at, banner, focus: state.focus, help: p.help, message: state.message,
        panes: p.panes.map((rows, i) => ({
          lines: rows, cursor: state.cursor[i] ?? 0, scroll: scroll[i] ?? 0,
          ...(i === 0 && p.leftWidth !== null ? { width: p.leftWidth } : {}),
        })),
      },
      size,
      deps.color,
    );
    term.write(`${ESC}[H${lines.map((l) => `${l}${ESC}[K`).join('\r\n')}${ESC}[J`);
  };

  const refresh = (message: string | null = state.message): void => {
    // 規則檔與設定檔可能在介面外被修改
    reloadSettings(ctx);
    data = load();
    state = { ...state, message };
    render();
  };

  /** 暫時離開全螢幕執行一般終端互動，完成後回到介面。 */
  const outside = async (fn: () => Promise<string | null>): Promise<void> => {
    busy = true;
    leave();
    let message: string | null;
    try {
      message = await fn();
    } catch (e) {
      if (e instanceof CliExit) message = e.message;
      else if (isPromptExit(e)) message = '已取消';
      else message = `發生錯誤：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      enter();
      busy = false;
    }
    // 完全移除後資料可能已刪除，不再重新讀取
    if (!quitAfter) refresh(message);
  };

  const LEVELS: { name: string; value: Delivery }[] = [
    { name: '即時推送 force_push', value: 'force_push' },
    { name: '推送 push', value: 'push' },
    { name: '只記錄 record', value: 'record' },
  ];

  /** 在終端逐項修改或新增規則；儲存前先顯示試算。 */
  const editRule = async (ruleId: string | null): Promise<string | null> => {
    const { prompts } = deps;
    reloadSettings(ctx);
    const old = ruleId === null ? undefined : ctx.rules.find((r) => r.id === ruleId);
    if (ruleId !== null && !old) return `找不到通知規則 ${ruleId}`;
    const id = old?.id ?? nextRuleId(ctx.rules);
    const name = (await prompts.input({ message: '名稱', ...(old ? { default: old.name } : {}), validate: (v) => v.trim() !== '' || '請輸入名稱' })).trim();
    const oldScope = old?.scope ?? 'all';
    const picked = await prompts.checkbox<string>({
      message: '適用課程（選「全部課程」或剔選個別課程）',
      choices: [
        { name: '全部課程', value: 'all', checked: oldScope === 'all' },
        ...data.courses.map((c) => ({ name: `${c.code} ${c.name}`, value: c.id, checked: oldScope !== 'all' && oldScope.includes(c.id) })),
      ],
    });
    const scope: Rule['scope'] = picked.includes('all') || picked.length === 0 ? 'all' : picked;
    const words = (message: string, now: string[] | undefined) =>
      prompts.input({ message: `${message}（以逗號或「、」分隔，可留空）`, ...(now?.length ? { default: now.join('、') } : {}) });
    const any = parseKeywords(await words('任一關鍵詞', old?.any));
    const all = parseKeywords(await words('全部都要出現的關鍵詞', old?.all));
    const none = parseKeywords(await words('排除詞', old?.none));
    const action = await prompts.select<Delivery>({ message: '推送等級', choices: LEVELS, default: old?.action ?? 'push' });
    const rule: Rule = {
      id, name, enabled: old?.enabled ?? true, scope, fields: old?.fields ?? ['title', 'body'],
      any, all, none, regex: old?.regex ?? [], action,
    };
    if (any.length + all.length + rule.regex.length === 0) throw new CliExit(1, '至少要有一個關鍵詞，沒有儲存');
    term.write(`\r\n${previewRule(ctx, rule).join('\r\n')}\r\n`);
    if (!(await prompts.confirm({ message: '要儲存嗎？', default: true }))) return '沒有儲存';
    saveRule(ctx, rule);
    return `已儲存規則「${name}」`;
  };

  const editDelivery = async (): Promise<string | null> => {
    const { prompts } = deps;
    const dl = data.config.delivery;
    const ways = await prompts.checkbox({
      message: '推送方式',
      choices: [
        { name: 'outbox 檔案（必備）', value: 'outbox', checked: true, disabled: '必備' },
        { name: '本機指令 hook（事件 JSON 經 stdin 傳入）', value: 'hook', checked: dl.hook.enabled },
        { name: '本機 webhook（POST 到 localhost）', value: 'webhook', checked: dl.webhook.enabled },
      ],
    });
    const next = structuredClone(dl);
    next.hook.enabled = ways.includes('hook');
    next.webhook.enabled = ways.includes('webhook');
    if (next.hook.enabled) {
      next.hook.command = await prompts.input({
        message: '每則推送事件要執行的指令',
        ...(dl.hook.command ? { default: dl.hook.command } : {}),
        validate: (v) => v.trim() !== '' || '請輸入指令',
      });
    }
    if (next.webhook.enabled) {
      next.webhook.url = await prompts.input({
        message: 'webhook 網址',
        default: dl.webhook.url || DEFAULT_WEBHOOK_URL,
        validate: (v) => webhookUrlError(v.trim()) ?? true,
      });
    }
    applyDelivery(ctx, next);
    return '已儲存推送方式';
  };

  const ask = async (p: Prompt): Promise<string | null> => {
    const { prompts } = deps;
    if (p.kind === 'quietHours') {
      const validate = (v: string): true | string => (HHMM.test(v) ? true : '時間格式為 HH:MM');
      const start = await prompts.input({ message: '夜間時段開始（HH:MM）', default: data.config.quiet_hours.start, validate });
      const end = await prompts.input({ message: '夜間時段結束（HH:MM）', default: data.config.quiet_hours.end, validate });
      applyQuietHours(ctx, start, end);
      return `夜間時段已改為 ${start}–${end}`;
    }
    if (p.kind === 'reminderOffsets') {
      const current = p.courseId === null ? data.config.reminders.offsets : (data.config.course_overrides[p.courseId]?.reminders ?? null);
      const choices = [
        ...(p.courseId === null ? [] : [{ name: '沿用系統設定', value: 'inherit', checked: current === null }]),
        ...OFFSET_CHOICES.map((o) => ({ name: offsetLabel(o), value: o, checked: current?.includes(o) ?? false })),
      ];
      const picked = await prompts.checkbox({ message: '截止前多久提醒', choices });
      if (p.courseId !== null && picked.includes('inherit')) {
        applyReminderOffsets(ctx, p.courseId, null);
        return '已改為沿用系統設定';
      }
      applyReminderOffsets(ctx, p.courseId, picked);
      return `截止提醒已改為 ${picked.map(offsetLabel).join('、')}`;
    }
    if (p.kind === 'editRule') return editRule(p.ruleId);
    if (p.kind === 'updateFrequency') {
      const freq = await prompts.select<UpdateFrequency>({
        message: '自動檢查新版本的頻率',
        choices: [
          { name: '每天', value: 'daily' },
          { name: '每星期', value: 'weekly' },
          { name: '關閉', value: 'off' },
        ],
        default: data.config.updates.check,
      });
      applyUpdateFrequency(ctx, freq);
      return '已更新自動檢查頻率';
    }
    if (p.kind === 'delivery') return editDelivery();
    if (p.kind === 'interfaces') {
      const picked = await prompts.checkbox({
        message: '要啟用的介面',
        choices: [
          { name: '終端機（必備）', value: 'terminal', checked: true, disabled: '必備' },
          { name: '資料夾（Markdown 檢視）', value: 'folder', checked: data.config.interfaces.folder },
        ],
      });
      applyInterfaces(ctx, picked.includes('folder'));
      return picked.includes('folder') ? '已啟用：終端機、資料夾' : '已啟用：終端機';
    }
    const action = await prompts.select<Delivery | 'inherit'>({
      message: '這條規則在本科的推送等級',
      choices: [
        { name: '沿用系統', value: 'inherit' },
        { name: '即時推送 force_push', value: 'force_push' },
        { name: '推送 push', value: 'push' },
        { name: '只記錄 record', value: 'record' },
      ],
    });
    applyCourseRuleAction(ctx, p.courseId, p.ruleId, action === 'inherit' ? null : action);
    return '已更新推送等級';
  };

  let quitAfter = false;
  let finish: (() => void) | null = null;

  /** 完全移除：選擇範圍、列出清單、輸入確認文字後才執行，完成後關閉介面。 */
  const removeEverything = async (): Promise<string | null> => {
    const cancelled = '已取消，沒有移除任何東西';
    const choice = await deps.prompts.select<'program' | 'all' | 'cancel'>({
      message: '要移除哪些項目？',
      choices: [
        { name: '只移除程式（保留 ~/.thu-ilearn 資料夾）', value: 'program' },
        { name: '移除程式與資料夾（包括已下載的教材與登入資料）', value: 'all' },
        { name: '取消', value: 'cancel' },
      ],
      default: 'cancel',
    });
    if (choice === 'cancel') return cancelled;
    const plan = deps.removal.plan(choice === 'all');
    term.write(`\r\n將會：\r\n${plan.lines.map((l) => `  ${l}`).join('\r\n')}\r\n\r\n`);
    const typed = await deps.prompts.input({ message: '請輸入 confirm 繼續，其他內容即取消' });
    if (typed.trim() !== 'confirm') return cancelled;
    const results = await deps.removal.execute(plan);
    term.write(`${results.join('\r\n')}\r\n`);
    quitAfter = true;
    return results.at(-1) ?? null;
  };

  const runOutside = async (what: RunKind): Promise<string | null> => {
    if (what === 'sync') {
      term.write('同步中，請稍候\r\n');
      const r = await syncCommand(ctx, { force: true, onProgress: (p) => term.write(`\r${formatProgress(p)}   `) });
      await deliverCommand(ctx, (s) => term.write(`\r\n${s}`));
      renderFolderView(ctx, (s) => term.write(`\r\n${s}`));
      return r.skipped ? (r.reason ?? '略過') : '同步完成';
    }
    if (what === 'login') {
      await runLogin(ctx);
      return '已重新登入';
    }
    if (what === 'uninstallAll') return removeEverything();
    if (what === 'updateCheck') return deps.updater.check();
    if (what === 'updateApply') return deps.updater.apply();
    if (what === 'serviceInstall') return deps.service.install();
    if (what === 'serviceUninstall') {
      if (!(await deps.prompts.confirm({ message: '要移除背景服務嗎？之後不會自動同步與提醒', default: false }))) return '沒有移除，背景服務仍在執行';
      return deps.service.uninstall();
    }
    if (!(await deps.prompts.confirm({ message: '要登出嗎？session 與已保存的密碼都會刪除', default: false }))) return '沒有登出';
    await logout(ctx);
    return '已登出，session 與已保存的密碼都已刪除';
  };

  const run = async (effect: Effect): Promise<void> => {
    switch (effect.type) {
      case 'apply': {
        let message: string;
        try {
          const r = applyChanges(ctx, effect.changes);
          message = [`已套用 ${r.applied} 項`, ...r.skipped].join('；');
        } catch (e) {
          if (!(e instanceof CliExit)) throw e;
          message = e.message;
        }
        refresh(message);
        return;
      }
      case 'open':
        refresh(deps.opener(effect.target).message);
        return;
      case 'prompt':
        await outside(() => ask(effect.prompt));
        return;
      case 'reload':
        await outside(async () => {
          term.write('Reload：先同步，再推送目前需要處理的事項\r\n');
          const r = await reloadCommand(ctx, {
            isTTY: true,
            confirm: (n) => deps.prompts.confirm({ message: `將推送 ${n} 則事件，確定嗎？`, default: false }),
          });
          return r.cancelled ? `已取消，沒有推送（原本會推送 ${r.planned} 則）` : `已推送 ${r.pushed} 則事件`;
        });
        return;
      case 'editRules':
        await outside(async () => {
          const r = await rulesEditCommand(ctx, {
            confirm: (preview) => {
              term.write(`${preview.replace(/\n/g, '\r\n')}\r\n`);
              return deps.prompts.confirm({ message: '要儲存嗎？', default: true });
            },
            retry: (msg) => {
              term.write(`${msg}\r\n`);
              return deps.prompts.confirm({ message: '要回去修改嗎？不修改就放棄這次編輯', default: true });
            },
          });
          return r.saved ? '已儲存 rules.yaml' : '沒有儲存';
        });
        return;
      case 'run':
        await outside(() => runOutside(effect.what));
        if (quitAfter) finish?.();
        return;
      case 'quit':
        return;
    }
  };

  enter();
  // 意外結束時仍還原終端
  const onExit = (): void => leave();
  process.once('exit', onExit);
  let stopKeys = (): void => {};
  let stopResize = (): void => {};
  let stopClock = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      /** callback 內的例外一律交給 reject，讓 finally 還原終端。 */
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch (e) {
          reject(e);
        }
      };
      const onKey = (k: UiKey): void => guard(() => {
        if (k === 'sigterm') return resolve();
        if (busy) return;
        if (k === 'ctrl-c') return resolve();
        const size = term.size();
        // 視窗太小時看不到內容，只接受離開
        if ((size.cols < MIN_COLS || size.rows < MIN_ROWS) && k !== 'q') return;
        const p = page();
        const r = reduce(state, k, p.panes, Math.max(1, bodyRows(size, bannerFor(data).length) - 1));
        state = r.state;
        if (r.effect?.type === 'quit') return resolve();
        if (!r.effect) return render();
        run(r.effect).catch(reject);
      });
      stopKeys = term.onKey(onKey);
      stopResize = term.onResize(() => guard(() => !busy && render()));
      stopClock = deps.clock.every(60_000, () => guard(() => !busy && refresh()));
      render();
    });
  } finally {
    stopClock();
    stopResize();
    stopKeys();
    process.off('exit', onExit);
    leave();
  }
}
