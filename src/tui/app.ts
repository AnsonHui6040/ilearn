import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { rulesEditCommand } from '../cli/commands/rules.js';
import { reloadCommand } from '../cli/commands/sync.js';
import { CliExit, type CliContext } from '../cli/context.js';
import type { Delivery } from '../types.js';
import { applyChanges, applyCourseRuleAction, applyQuietHours, applyReminderOffsets, OFFSET_CHOICES, previewChanges } from './actions.js';
import { courseDetail, loadTuiData, type TuiData } from './data.js';
import { bodyRows, renderFrame, visibleStart } from './frame.js';
import { bannerFor, buildPage, offsetLabel, type PageSources } from './pages.js';
import { initialState, normalize, reduce, type Effect, type Key, type OpenTarget, type Prompt, type TuiState } from './state.js';

export type UiKey = Key | 'ctrl-c';

export interface Term {
  write(s: string): void;
  size(): { cols: number; rows: number };
  onKey(fn: (k: UiKey) => void): () => void;
  onResize(fn: () => void): () => void;
  setRaw(on: boolean): void;
}

export interface PromptDeps {
  input(o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  checkbox<T>(o: { message: string; choices: { name: string; value: T; checked?: boolean }[] }): Promise<T[]>;
  select<T>(o: { message: string; choices: { name: string; value: T }[] }): Promise<T>;
  confirm(o: { message: string; default?: boolean }): Promise<boolean>;
}

export interface UiDeps {
  prompts: PromptDeps;
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

export function nodeTerm(): Term {
  const input = process.stdin;
  const output = process.stdout;
  return {
    write: (s) => void output.write(s),
    size: () => ({ cols: output.columns ?? 80, rows: output.rows ?? 24 }),
    onKey: (fn) => {
      emitKeypressEvents(input);
      const h = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
        const k = mapKey(str, key);
        if (k !== null) fn(k);
      };
      const term = (): void => fn('ctrl-c');
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
    setRaw: (on) => void (input.isTTY && input.setRawMode(on)),
  };
}

export async function defaultDeps(): Promise<UiDeps> {
  const p = await import('@inquirer/prompts');
  return {
    prompts: p as unknown as PromptDeps,
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
  let data: TuiData = loadTuiData(ctx);
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
    data = loadTuiData(ctx);
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
      else throw e;
    } finally {
      enter();
      busy = false;
    }
    refresh(message);
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
      case 'quit':
        return;
    }
  };

  enter();
  let stopKeys = (): void => {};
  let stopResize = (): void => {};
  let stopClock = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const onKey = (k: UiKey): void => {
        if (busy) return;
        if (k === 'ctrl-c') return resolve();
        const p = page();
        const r = reduce(state, k, p.panes, Math.max(1, bodyRows(term.size(), bannerFor(data).length) - 1));
        state = r.state;
        if (r.effect?.type === 'quit') return resolve();
        if (!r.effect) return render();
        run(r.effect).catch(reject);
      };
      stopKeys = term.onKey(onKey);
      stopResize = term.onResize(() => !busy && render());
      stopClock = deps.clock.every(60_000, () => !busy && refresh());
      render();
    });
  } finally {
    stopClock();
    stopResize();
    stopKeys();
    leave();
  }
}
