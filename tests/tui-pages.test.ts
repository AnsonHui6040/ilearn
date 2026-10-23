import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext, type CliContext } from '../src/cli/context.js';
import { setSyncState, upsertCourse, upsertItem, type StoredItem } from '../src/db/repo.js';
import { courseDetail, loadTuiData } from '../src/tui/data.js';
import { renderFrame, type TabId } from '../src/tui/frame.js';
import { bannerFor, buildPage, type PageSources } from '../src/tui/pages.js';
import { initialState, normalize, type Row, type TuiState, type View } from '../src/tui/state.js';
import { strWidth } from '../src/tui/text.js';

const NOW = new Date('2026-10-22T04:00:00Z'); // 12:00 台北
const H = 3600_000;
const iso = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

function mk(): CliContext {
  return createContext({ root: mkdtempSync(join(tmpdir(), 'ilearn-pages-')), now: () => NOW, userId: 1 });
}

function item(ctx: CliContext, p: Partial<StoredItem> & Pick<StoredItem, 'id' | 'kind' | 'course_id'>): void {
  upsertItem(ctx.db, {
    title: p.id, body: null, due_at: null, start_at: null, url: null, completion: 'pending',
    teammate_hint: false, group: false, score: null, score_published: false, feedback: null,
    categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: iso(-48 * H), updated_at: iso(-48 * H), ...p,
  });
}

function schedule(ctx: CliContext, courseId: string, slots: { weekday: number; periods: string[]; room: string | null }[]): void {
  item(ctx, { id: `course_info:${courseId}`, kind: 'course_info', course_id: courseId, raw: JSON.stringify({ schedule: { raw: 'x', slots } }) });
}

function seeded(): CliContext {
  const ctx = mk();
  setSyncState(ctx.db, { initial_completed: true, last_sync_at: iso(-H) });
  upsertCourse(ctx.db, { id: '1', name: '(1151_1236)數位行銷', code: '1151_1236', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  upsertCourse(ctx.db, { id: '2', name: '(115-1)永續實踐:勞作教育-應屆畢業學生虛擬課程', code: 'labor1151gra', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  upsertCourse(ctx.db, { id: '3', name: '(1151_1222)微積分乙〈一〉', code: '1151_1222', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
  schedule(ctx, '1', [{ weekday: 3, periods: ['2', '3', '4'], room: 'M134' }]);
  schedule(ctx, '3', [{ weekday: 1, periods: ['3', '4'], room: 'M230' }, { weekday: 4, periods: ['6'], room: 'M220' }]);
  item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', title: '個人作業三', due_at: iso(-30 * 24 * H) });
  item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', title: '小組作業二', due_at: iso(-20 * 24 * H), group: true, teammate_hint: true });
  item(ctx, { id: 'assignment:3', kind: 'assignment', course_id: '1', title: '小組作業五', due_at: iso(5 * 24 * H), group: true });
  item(ctx, { id: 'grade:1', kind: 'grade', course_id: '1', title: '學期總分', score: '0.0', score_published: false });
  item(ctx, { id: 'announcement:1', kind: 'announcement', course_id: '1', title: '今天的公告', raw: JSON.stringify({ created_at: iso(-H) }) });
  item(ctx, { id: 'announcement:2', kind: 'announcement', course_id: '1', title: '昨天的公告', raw: JSON.stringify({ created_at: iso(-24 * H) }) });
  return ctx;
}

const sources = (ctx: CliContext): PageSources => ({
  detail: (id) => courseDetail(ctx, id),
  preview: (changes) => [`將變更 ${changes.length} 項`, ...changes.map((c) => c.kind)],
});

function show(ctx: CliContext, s: TuiState, cols: number): string[] {
  const d = loadTuiData(ctx);
  const p0 = buildPage(s, d, cols, sources(ctx));
  const st = normalize(s, p0.panes);
  const p = buildPage(st, d, cols, sources(ctx));
  return renderFrame(
    {
      tab: st.tab, now: d.now, lastSyncAt: d.status.last_sync_at, banner: bannerFor(d), focus: st.focus, help: p.help, message: null,
      panes: p.panes.map((rows, i) => ({ lines: rows, cursor: st.cursor[i] ?? 0, scroll: 0, ...(i === 0 && p.leftWidth ? { width: p.leftWidth } : {}) })),
    },
    { cols, rows: 60 },
    false,
  );
}

const onTab = (tab: TabId, stack: View[] = []): TuiState => ({ ...initialState(), tab, stack, saved: stack.map(() => ({ focus: 0, cursor: [0, 0], scroll: [0, 0] })) });
const text = (lines: string[]): string => lines.join('\n');

describe('pages fit the terminal', () => {
  it('no line is wider than 100 or 80 columns on any page', () => {
    const ctx = seeded();
    const views: TuiState[] = [
      onTab(1), onTab(2), onTab(3), onTab(4), onTab(5),
      onTab(2, [{ kind: 'course', courseId: '1', section: 0 }]),
      onTab(1, [{ kind: 'confirm', changes: [{ kind: 'reset' }], fromTicks: false }]),
    ];
    for (const cols of [100, 80]) for (const s of views) for (const l of show(ctx, s, cols)) expect(strWidth(l)).toBeLessThanOrEqual(cols);
  });
});

describe('1 首頁', () => {
  it('lists work to do by group and shows no class schedule', () => {
    const out = text(show(seeded(), onTab(1), 100));
    expect(out).toContain('逾期 2');
    expect(out).toContain('7 日內 1');
    expect(out).toContain('[小組][隊員可能已交]');
    expect(out).not.toContain('09:10');
    expect(out).not.toContain('節）');
  });

  it('says the first sync is still running instead of claiming there is nothing to do', () => {
    const ctx = mk();
    const out = text(show(ctx, onTab(1), 100));
    expect(out).toContain('首次同步進行中');
    expect(out).not.toContain('目前沒有');
  });
});

describe('2 課程', () => {
  it('shows full codes and rooms, wraps long names and lists each time slot', () => {
    const out = show(seeded(), onTab(2), 100);
    const all = text(out);
    expect(all).toContain('labor1151gra');
    expect(all).toContain('M230、M220');
    expect(all).toContain('三 09:10–12:10（2–4 節）');
    expect(all).toContain('四 14:10–15:00（6 節）');
    const first = out.findIndex((l) => l.includes('labor1151gra'));
    expect(out[first]).toContain('勞作教育-應屆畢業學');
    expect(out[first + 1]).toContain('生虛擬課程');
    expect(out[first + 1]).not.toContain('labor');
    expect(all).toContain('保留學期');
  });

  it('keeps every column readable below 80 columns', () => {
    const out = show(seeded(), onTab(2), 70);
    const all = text(out);
    expect(all).toContain('M230、M220');
    expect(all).toContain('待辦 3');
    expect(all).toContain('公告 2');
    expect(out.some((l) => l.includes('…'))).toBe(false);
  });
});

describe('課程版面', () => {
  it('lists overdue work under 逾期, hides unpublished scores and marks empty sections', () => {
    const ctx = seeded();
    const out = text(show(ctx, onTab(2, [{ kind: 'course', courseId: '1', section: 0 }]), 100));
    expect(out).toMatch(/逾期 2[\s\S]*個人作業三[\s\S]*未逾期[\s\S]*小組作業五/);
    expect(out).toContain('系統顯示隊員已交，如屬實可標記');
    expect(out).toContain('考試 沒有');
    const grades = text(show(ctx, { ...onTab(2, [{ kind: 'course', courseId: '1', section: 7 }]), cursor: [7, 0] }, 100));
    expect(grades).not.toContain('0.0');
    expect(grades).toContain('尚未公布');
  });
});

describe('3 提醒', () => {
  it('keeps only announcements from today, with the course on the next line', () => {
    const out = show(seeded(), onTab(3), 100);
    const all = text(out);
    expect(all).not.toContain('昨天的公告');
    const i = out.findIndex((l) => l.includes('今天的公告'));
    expect(out[i + 1]).toContain('數位行銷');
    expect(all).toContain('前 1 日');
  });

  it('says there is no announcement today', () => {
    const ctx = mk();
    expect(text(show(ctx, onTab(3), 100))).toContain('今天沒有新公告');
  });
});

describe('5 系統設定', () => {
  it('never shows the hook command or the webhook address', () => {
    const ctx = seeded();
    ctx.config.delivery = { hook: { enabled: true, command: 'secret-hook-cmd' }, webhook: { enabled: true, url: 'http://127.0.0.1:9/secret-path' } };
    for (let i = 1; i <= 11; i++) {
      const out = text(show(ctx, { ...onTab(5), cursor: [i, 0] }, 100));
      expect(out).not.toContain('secret-hook-cmd');
      expect(out).not.toContain('secret-path');
    }
  });

  it('shows the rule list with checkboxes and the count of enabled rules', () => {
    const out = text(show(seeded(), { ...onTab(5), cursor: [7, 0] }, 100));
    expect(out).toContain('通知規則  啟用 13／13');
    expect(out).toContain('[x] exam');
    expect(out).toContain('新增規則');
    expect(out).toContain('以編輯器修改全部規則');
  });
});

describe('5 系統設定 actions', () => {
  const rows = (cursor: number): Row[] => {
    const ctx = seeded();
    const d = loadTuiData(ctx);
    return buildPage({ ...onTab(5), cursor: [cursor, 0] }, d, 100, sources(ctx)).panes[1] ?? [];
  };
  const acts = (cursor: number) => rows(cursor).flatMap((r) => (r.activate ? [r.activate] : []));

  it('offers sync, interfaces, delivery, rule editing, login and logout', () => {
    expect(acts(2)).toContainEqual({ run: 'sync' });
    expect(acts(3)).toContainEqual({ prompt: { kind: 'interfaces' } });
    expect(acts(4)).toContainEqual({ prompt: { kind: 'delivery' } });
    expect(acts(7)).toContainEqual({ prompt: { kind: 'editRule', ruleId: 'exam' } });
    expect(acts(7)).toContainEqual({ prompt: { kind: 'editRule', ruleId: null } });
    expect(acts(8)).toContainEqual({ run: 'login' });
    expect(acts(8)).toContainEqual({ run: 'logout' });
  });

  it('enter on a left item without its own action moves into the right pane', () => {
    const ctx = seeded();
    const left = buildPage(onTab(5), loadTuiData(ctx), 100, sources(ctx)).panes[0] ?? [];
    expect(left.find((r) => r.text.includes('同步狀態'))?.activate).toEqual({ focusRight: true });
    expect(left.find((r) => r.text.includes('Reload'))?.activate).toEqual({ reload: true });
  });

  it('installs or removes the background service', () => {
    const ctx = seeded();
    const at = (installed: boolean) => {
      const d = { ...loadTuiData(ctx), service: { installed, method: installed ? ('launchd' as const) : null, detail: installed ? '已安裝（LaunchAgent）' : '未安裝' } };
      return (buildPage({ ...onTab(5), cursor: [9, 0] }, d, 100, sources(ctx)).panes[1] ?? []);
    };
    expect(at(false).map((r) => r.text).join('\n')).toContain('未安裝');
    expect(at(false).flatMap((r) => (r.activate ? [r.activate] : []))).toContainEqual({ run: 'serviceInstall' });
    expect(at(true).flatMap((r) => (r.activate ? [r.activate] : []))).toContainEqual({ run: 'serviceUninstall' });
  });

  it('offers complete removal as the last item', () => {
    expect(acts(11)).toContainEqual({ run: 'uninstallAll' });
  });

  it('shows whether the folder view is on', () => {
    expect(rows(3).map((r) => r.text).join('\n')).toContain('資料夾（Markdown 檢視）：');
  });
});

describe('詳細畫面', () => {
  it('shows each line of a multi-line body on its own row', () => {
    const ctx = seeded();
    const view: View = { kind: 'detail', title: '公告', lines: ['第一行\n第二行'], target: null };
    const out = show(ctx, onTab(3, [view]), 100);
    const a = out.findIndex((l) => l.includes('第一行'));
    expect(a).toBeGreaterThan(0);
    expect(out[a]).not.toContain('第二行');
    expect(out[a + 1]).toContain('第二行');
    expect(out).toHaveLength(60);
  });
});

describe('確認畫面', () => {
  it('shows the preview lines and how to confirm', () => {
    const out = text(show(seeded(), onTab(5, [{ kind: 'confirm', changes: [{ kind: 'rule', ruleId: 'exam', enabled: false }, { kind: 'rule', ruleId: 'deadline', enabled: false }], fromTicks: true }]), 100));
    expect(out).toContain('將變更 2 項');
    expect(out).toContain('Enter 確認，Esc 取消');
  });
});
