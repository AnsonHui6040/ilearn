import type { courseCommand } from '../cli/commands/query.js';
import type { Rule } from '../rules/engine.js';
import { displayName, type CourseRow, type TuiData } from './data.js';
import { TWO_PANE_COLS, type Style } from './frame.js';
import { AGENT_CHANGE_DAYS, AGENT_CHANGE_SHOWN, formatAgentChange } from '../agent/changes.js';
import { toTaipeiIso } from '../time.js';
import { changeKey, SUMMARY_LABEL, type Change, type Row, type TuiState, type View } from './state.js';
import { fit, strWidth, wrap } from './text.js';

type Detail = ReturnType<typeof courseCommand>;
type Item = Detail['completed'][number];

export interface Page {
  panes: Row[][];
  /** 兩欄時左欄寬度；單欄為 null。 */
  leftWidth: number | null;
  help: string;
}

export interface PageSources {
  detail: (courseId: string) => Detail;
  /** 確認畫面的說明（含規則試算）。 */
  preview: (changes: Change[]) => string[];
}

export const HELP = {
  tabs: '1-5 分頁 Tabs  ↑↓ 移動 Move  Space 剔選 Select  Enter 確認 OK  q 離開 Quit',
  twoPane: '1-5 分頁 Tabs  ←→ 欄 Pane  ↑↓ 移動 Move  Space 剔選 Select  Enter 確認 OK  q 離開 Quit',
  course: '←→ 欄 Pane  ↑↓ 移動 Move  Space 剔選 Select  Enter 確認或開啟 OK  Esc 返回 Back',
  confirm: 'Enter 確認 OK  Esc 取消 Cancel',
  detail: 'Enter 開啟 Open  Esc 返回 Back',
};

const OFFSET_LABEL: Record<string, string> = {
  P3D: '前 3 日', P2D: '前 2 日', P1D: '前 1 日', PT12H: '前 12 小時', PT6H: '前 6 小時', PT3H: '前 3 小時', PT1H: '前 1 小時',
};
export const offsetLabel = (o: string): string => OFFSET_LABEL[o] ?? o;

/** 依原文換行分段後再依寬度分行。 */
const paragraphs = (s: string, w: number): string[] => s.split(/\r\n|\r|\n/).flatMap((l) => wrap(l, w));
const short = (iso: string | null): string => (iso === null ? '' : iso.slice(5, 16).replace('T', ' '));
const head = (text: string, style: Style = 'bold'): Row => ({ text, style });
const dim = (text: string): Row => ({ text, style: 'dim' });
const box = (on: boolean): string => (on ? '[x]' : '[ ]');

/** 剔選後的結果：目前狀態與待確認變更互斥。 */
const willBe = (s: TuiState, current: boolean, change: Change): boolean => current !== s.ticked.has(changeKey(change));

export function ruleName(rules: Rule[], id: string): string {
  if (id === 'general') return '一般通知';
  return rules.find((r) => r.id === id)?.name ?? id;
}

/* ---------- 1 首頁 ---------- */

function homePage(s: TuiState, d: TuiData): Page {
  const rows: Row[] = [];
  if (d.update?.available) {
    rows.push(head(`有新版本 ${d.update.latest}（目前 ${d.update.current}），可在系統設定 > 系統更新 更新`), { text: '' });
  }
  if (d.agentChanges.length > 0) {
    rows.push(head(`agent 最近 ${AGENT_CHANGE_DAYS} 日修改了 ${d.agentChanges.length} 項設定，詳情見 3 提醒`), { text: '' });
  }
  rows.push(head(`需要處理  未完成 ${d.tasks.tasks.length}`));
  const row = (t: TuiData['home']['overdue'][number], style?: Style): Row => {
    const tick: Change | undefined = t.group && t.kind === 'assignment' ? { kind: 'teammate', itemId: t.id, mark: true } : undefined;
    const flags = [t.group ? '[小組]' : '', t.teammate_hint ? '[隊員可能已交]' : '', t.kind === 'video' ? '[影片]' : ''].join('');
    return {
      text: `  ${tick ? box(willBe(s, false, tick)) : '   '} ${short(t.due_at)}  ${fit(displayName(t.course ?? ''), 14)}${t.title} ${flags}`.trimEnd(),
      key: t.id,
      ...(style ? { style } : {}),
      ...(tick ? { tick } : {}),
      activate: { view: { kind: 'course', courseId: t.course_id, section: 0 } },
    };
  };
  const { overdue, within7d, later, notStarted } = d.home;
  if (d.tasks.tasks.length === 0) {
    rows.push(dim(d.tasks.initial_sync_in_progress ? '  首次同步進行中，清單可能不完整' : '  目前沒有需要處理的作業或影片'));
  }
  if (overdue.length) rows.push(head(`逾期 ${overdue.length}`, 'red'), ...overdue.map((t) => row(t, 'red')));
  if (within7d.length) rows.push(head(`7 日內 ${within7d.length}`), ...within7d.map((t) => row(t)));
  if (later.length) rows.push(head(`之後 ${later.length}`), ...later.map((t) => row(t)));
  if (notStarted.length) rows.push(head(`尚未開放 ${notStarted.length}`), ...notStarted.map((t) => row(t, 'dim')));
  return { panes: [rows], leftWidth: null, help: HELP.tabs };
}

/* ---------- 2 課程 ---------- */

/** 80 欄以下：每科第一行為代號與課程名稱，其後為上課時間、教室與數量。 */
function narrowCourseTable(list: CourseRow[], cols: number): Row[] {
  const CW = Math.max(6, ...list.map((c) => strWidth(c.code))) + 2;
  const rest = Math.max(10, cols - 3 - 2 - CW);
  const pad = ' '.repeat(CW);
  return list.flatMap((c): Row[] => {
    const [first = '', ...more] = wrap(c.name, rest);
    const slots = c.schedule.split('、');
    return [
      { text: `  ${fit(c.code, CW)}${first}`, key: `course:${c.id}`, activate: { view: { kind: 'course', courseId: c.id, section: 0 } } },
      ...more.map((n): Row => ({ text: `  ${pad}${n}` })),
      ...slots.map((s): Row => dim(`  ${pad}${s}`)),
      dim(`  ${pad}${[c.rooms, `待辦 ${c.todo}`, `公告 ${c.announcements}`].filter(Boolean).join('  ')}`),
    ];
  });
}

function courseTable(list: CourseRow[], cols: number): Row[] {
  if (cols < TWO_PANE_COLS) return narrowCourseTable(list, cols);
  const CW = Math.max(6, ...list.map((c) => strWidth(c.code))) + 2;
  const SW = Math.max(10, ...list.flatMap((c) => c.schedule.split('、').map(strWidth))) + 2;
  const RW = Math.max(4, ...list.map((c) => strWidth(c.rooms))) + 2;
  const NW = Math.max(10, Math.min(20, cols - 3 - 2 - CW - SW - RW - 10));
  const rows: Row[] = [dim(`  ${fit('代號', CW)}${fit('課程', NW + 2)}${fit('上課時間', SW)}${fit('教室', RW)}${fit('待辦', 6)}公告`)];
  for (const c of list) {
    const names = wrap(c.name, NW);
    const slots = c.schedule.split('、');
    const n = Math.max(names.length, slots.length);
    for (let i = 0; i < n; i++) {
      const name = fit(names[i] ?? '', NW + 2);
      const slot = fit(slots[i] ?? '', SW);
      rows.push(
        i === 0
          ? {
              text: `  ${fit(c.code, CW)}${name}${slot}${fit(c.rooms, RW)}${fit(c.todo ? String(c.todo) : '', 6)}${c.announcements || ''}`.trimEnd(),
              key: `course:${c.id}`,
              activate: { view: { kind: 'course', courseId: c.id, section: 0 } },
            }
          : { text: `  ${' '.repeat(CW)}${name}${slot}`.trimEnd() },
      );
    }
  }
  return rows;
}

function coursesPage(d: TuiData, cols: number): Page {
  const sem = d.courses.length ? '本學期' : '本學期還沒有課程資料';
  const rows: Row[] = [head(`${sem}  ${d.courses.length} 科`), ...(d.courses.length ? courseTable(d.courses, cols) : [])];
  rows.push({ text: '' }, head('保留學期'));
  if (d.archived.length === 0) rows.push(dim('  沒有（學期結束後移入，例如 114-2）'));
  for (const a of d.archived) rows.push(head(`  ${a.semester}`), ...courseTable(a.courses, cols));
  return { panes: [rows], leftWidth: null, help: HELP.tabs };
}

/* ---------- 課程版面 ---------- */

export const SECTIONS = ['待辦', '已完成', '考試', '公告', '教材檔案', '影片', '問卷', '分數與評語', '課程資訊'] as const;

function sectionCounts(x: Detail): number[] {
  return [x.todo.length, x.completed.length, x.exams.length, x.announcements.length, x.files.length, x.videos.length, x.surveys.length, x.grades.length, x.info_fields.length];
}

function itemDetail(it: Item, course: string, extra: string[] = []): View {
  return {
    kind: 'detail',
    title: it.title,
    lines: [course, ...(it.due_at ? [`截止：${short(it.due_at)}`] : []), ...(it.start_at ? [`開始：${short(it.start_at)}`] : []), ...extra, ...(it.body ? ['', it.body] : [])],
    target: it.url ? { kind: 'url', url: it.url } : null,
  };
}

/** 已有摘要時，在項目下方以淡色換行顯示。 */
function summaryRows(summary: string | null | undefined, width: number): Row[] {
  if (!summary) return [];
  return paragraphs(summary, Math.max(10, width - 8)).map((l) => dim(`      ${l}`));
}

function sectionRows(s: TuiState, d: TuiData, x: Detail, section: number, width: number): Row[] {
  const course = displayName(x.course.name);
  const rows: Row[] = [];
  const empty = (): Row[] => [dim('  沒有')];
  const todoRow = (t: Item & { not_started?: boolean }, overdue: boolean): Row[] => {
    const tick: Change | undefined = t.group ? { kind: 'teammate', itemId: t.id, mark: true } : undefined;
    const notes = [`截止 ${short(t.due_at)}`, t.group ? '小組' : '', t.teammate_hint ? '系統顯示隊員已交，如屬實可標記' : '', t.not_started ? '尚未開放' : ''];
    return [
      {
        text: `  ${tick ? box(willBe(s, false, tick)) : '   '} ${t.title}`,
        key: t.id,
        ...(overdue ? { style: 'red' as const } : {}),
        ...(tick ? { tick } : {}),
        activate: { view: itemDetail(t, course) },
      },
      dim(`      ${notes.filter(Boolean).join('  ')}`),
    ];
  };
  const now = d.now.getTime();
  switch (section) {
    case 0: {
      if (!x.todo.length) return empty();
      const late = x.todo.filter((t) => t.due_at !== null && Date.parse(t.due_at) < now);
      const rest = x.todo.filter((t) => !late.includes(t));
      if (late.length) rows.push(head(`逾期 ${late.length}`, 'red'), ...late.flatMap((t) => todoRow(t, true)));
      if (rest.length) rows.push(head('未逾期'), ...rest.flatMap((t) => todoRow(t, false)));
      return rows;
    }
    case 1:
      if (!x.completed.length) return empty();
      return x.completed.map((t): Row => {
        if (t.completion === 'teammate_marked') {
          const tick: Change = { kind: 'teammate', itemId: t.id, mark: false };
          return { text: `  ${box(willBe(s, true, tick))} ${t.title}  隊員已交`, key: t.id, tick, activate: { view: itemDetail(t, course) } };
        }
        return { text: `      ${t.title}`, key: t.id, activate: { view: itemDetail(t, course) } };
      });
    case 2:
      if (!x.exams.length) return empty();
      return x.exams.map((t): Row => ({ text: `  ${short(t.start_at)}  ${t.title}`, key: t.id, activate: { view: itemDetail(t, course) } }));
    case 3:
      if (!x.announcements.length) return empty();
      return x.announcements.flatMap((a): Row[] => [
        { text: `  ${a.title}`, key: a.id, activate: { view: itemDetail(a, course, [`發布：${short(a.posted_at)}`]) } },
        dim(`      ${short(a.posted_at)}  ${a.categories.map((c) => ruleName(d.rules, c)).join('、')}`),
        ...summaryRows(a.summary, width),
      ]);
    case 4:
      if (!x.files.length) return empty();
      return x.files.flatMap((f): Row[] => {
        if (f.status === 'done' && f.local_path) {
          return [{ text: `  ${f.name}`, key: `file:${f.id}`, activate: { open: { kind: 'file', path: f.local_path } } }, ...summaryRows(f.summary, width)];
        }
        const note = f.status === 'skipped' ? '老師關閉下載' : f.status === 'failed' ? '下載失敗' : f.status === 'link' ? '外部連結' : '尚未下載';
        return [
          { text: `  ${f.name}  ${note}`, key: `file:${f.id}`, style: 'dim', ...(f.link ? { activate: { open: { kind: 'url' as const, url: f.link } } } : {}) },
          ...summaryRows(f.summary, width),
        ];
      });
    case 5:
      if (!x.videos.length) return empty();
      return x.videos.map((v): Row => ({ text: `  ${v.title}  ${v.completion === 'pending' ? '未看完' : '已看完'}`, key: v.id, activate: { view: itemDetail(v, course) } }));
    case 6:
      if (!x.surveys.length) return empty();
      return x.surveys.map((v): Row => ({ text: `  ${v.title}`, key: v.id, activate: { view: itemDetail(v, course) } }));
    case 7:
      if (!x.grades.length) return [dim('  尚未公布')];
      return x.grades.flatMap((g): Row[] => [
        { text: `  ${g.title}  ${g.score ?? ''}`, key: g.id },
        ...(g.feedback ? paragraphs(g.feedback, Math.max(10, width - 8)).map((l) => dim(`      ${l}`)) : []),
      ]);
    default:
      if (!x.info_fields.length) return empty();
      return x.info_fields.map((f): Row => ({
        text: `  ${f.title}`,
        key: `info:${f.key}`,
        activate: { view: { kind: 'detail', title: f.title, lines: [course, '', f.description], target: null } },
      }));
  }
}

function coursePage(s: TuiState, d: TuiData, view: Extract<View, { kind: 'course' }>, cols: number, src: PageSources): Page {
  const x = src.detail(view.courseId);
  const counts = sectionCounts(x);
  const left: Row[] = SECTIONS.map((name, i) => {
    const n = counts[i] ?? 0;
    return { text: n ? `  ${name} ${n}` : `  ${name} 沒有`, key: `sec:${i}`, activate: { focusRight: true }, ...(n ? {} : { style: 'dim' as const }) };
  });
  const section = Math.max(0, Math.min(SECTIONS.length - 1, s.cursor[0]));
  const row = d.courses.find((c) => c.id === view.courseId) ?? d.archived.flatMap((a) => a.courses).find((c) => c.id === view.courseId);
  const lw = 18;
  const right: Row[] = [
    head(displayName(x.course.name)),
    dim(`${row?.code ?? ''}  ${row?.schedule ?? ''}  ${row?.rooms ?? ''}`.trim()),
    { text: '' },
    head(`${SECTIONS[section]} ${counts[section] ?? 0}`),
    ...sectionRows(s, d, x, section, cols - lw - 3),
  ];
  return { panes: [left, right], leftWidth: lw, help: HELP.course };
}

/* ---------- 3 提醒 ---------- */

function remindersPage(d: TuiData): Page {
  const rows: Row[] = [head('系統')];
  if (d.notices.length === 0) rows.push(dim('  沒有系統提醒'));
  rows.push(...d.notices.map((n, i): Row => ({ text: `  ${n}`, key: `notice:${i}`, style: 'red' })));
  if (d.agentChanges.length > 0) {
    rows.push(
      { text: '' },
      head(`agent 最近 ${AGENT_CHANGE_DAYS} 日修改的設定 ${d.agentChanges.length}`),
      ...d.agentChanges.slice(0, AGENT_CHANGE_SHOWN).map((c, i): Row => ({ text: `  ${formatAgentChange(c)}`, key: `agentchg:${i}` })),
    );
    if (d.agentChanges.length > AGENT_CHANGE_SHOWN) rows.push(dim(`  只列出最新 ${AGENT_CHANGE_SHOWN} 項，完整紀錄在 data/agent-changes.jsonl`));
  }
  rows.push({ text: '' }, head(`即將發出的截止提醒 ${d.reminders.length}`));
  if (d.reminders.length === 0) rows.push(dim('  今天之後沒有提醒'));
  rows.push(
    ...d.reminders.map((r, i): Row => ({
      text: `  ${short(r.at)}  ${fit(offsetLabel(r.offset), 11)}${r.title}  ${r.course}${r.sent ? '  已發出' : ''}`,
      key: `rem:${i}`,
      ...(r.sent ? { style: 'dim' as const } : {}),
    })),
  );
  rows.push({ text: '' }, head(`公告 ${d.announcements.length}`));
  if (d.announcements.length === 0) rows.push(dim('  今天沒有新公告'));
  for (const a of d.announcements) {
    rows.push(
      {
        text: `  ${a.title}`,
        key: a.id,
        ...(a.delivery === 'record' ? {} : { style: 'bold' as const }),
        activate: {
          view: {
            kind: 'detail', title: a.title,
            lines: [a.course, `發布：${short(a.postedAt)}`, ...(a.body ? ['', a.body] : [])],
            target: a.url ? { kind: 'url', url: a.url } : null,
          },
        },
      },
      dim(`      ${a.course}  ${short(a.postedAt)}  ${a.categories.map((c) => ruleName(d.rules, c)).join('、')}`),
    );
  }
  return { panes: [rows], leftWidth: null, help: HELP.tabs };
}

/* ---------- 4 課程設定 ---------- */

function courseSettingsPage(s: TuiState, d: TuiData): Page {
  const left: Row[] = [head('選擇課程'), ...d.courses.map((c): Row => ({ text: `  ${c.code} ${c.name}`, key: `cs:${c.id}`, activate: { focusRight: true } }))];
  const c = d.courses[s.cursor[0] - 1] ?? d.courses[0];
  if (!c) return { panes: [left, [dim('還沒有課程資料')]], leftWidth: 34, help: HELP.twoPane };
  const ov = d.config.course_overrides[c.id] ?? {};
  const right: Row[] = [head(`${c.name} 的設定`), { text: '' }, head('通知規則（本科覆寫）')];
  for (const r of d.rules) {
    const o = ov.rules?.[r.id];
    const enabled = o?.enabled ?? r.enabled;
    const tick: Change = { kind: 'courseRule', courseId: c.id, ruleId: r.id, enabled: !enabled };
    right.push({
      text: `  ${box(willBe(s, enabled, tick))} ${fit(r.name, 18)}${fit(o?.action ?? r.action, 12)}${o ? '本科設定' : '沿用系統'}`,
      key: `cr:${r.id}`,
      tick,
      activate: { prompt: { kind: 'courseRuleAction', courseId: c.id, ruleId: r.id } },
    });
  }
  const offsets = ov.reminders;
  right.push(
    { text: '' },
    head('截止提醒'),
    {
      text: offsets ? `  本科：${offsets.map(offsetLabel).join('、')}` : `  沿用系統設定（${d.config.reminders.offsets.map(offsetLabel).join('、')}）`,
      key: 'cs:reminders',
      activate: { prompt: { kind: 'reminderOffsets', courseId: c.id } },
    },
    { text: '' },
    head('摘要'),
  );
  for (const kind of ['materials', 'announcements'] as const) {
    const enabled = d.config.summaries.courses[c.id]?.[kind] ?? false;
    const tick: Change = { kind: 'courseSummary', courseId: c.id, summary: kind, enabled: !enabled };
    right.push({
      text: `  ${box(willBe(s, enabled, tick))} ${SUMMARY_LABEL[kind]}`,
      key: `csum:${kind}`,
      tick,
      activate: { confirm: [tick] },
    });
  }
  right.push(
    { text: '' },
    dim('  Space 剔選規則或摘要  Enter 修改等級或提醒時間'),
  );
  return { panes: [left, right], leftWidth: 34, help: HELP.twoPane };
}

/* ---------- 5 系統設定 ---------- */

export const SYSTEM_ITEMS = ['Reload', '同步狀態', '介面啟用', '推送方式', '夜間時段', '截止提醒', '通知規則', '摘要', 'agent 權限', '帳號', '背景服務', '系統更新', 'Reset', '完全移除'] as const;

function systemRight(s: TuiState, d: TuiData, item: number): Row[] {
  const st = d.status;
  const offsets = d.config.reminders.offsets.map(offsetLabel).join('、');
  switch (SYSTEM_ITEMS[item]) {
    case 'Reload':
      return [head('Reload'), dim('  先同步，再把目前需要處理的事項推送給 agent；推送前會顯示數量並確認'), { text: '  按 Enter 開始', key: 'reload', activate: { reload: true } }];
    case '同步狀態':
      return [
        head('同步狀態'),
        { text: `  最近同步：${st.last_sync_at ? short(st.last_sync_at) : '尚未同步'}` },
        { text: `  檔案：已下載 ${st.files.done}，待下載 ${st.files.pending}，失敗 ${st.files.failed}，略過 ${st.files.skipped}` },
        ...(st.incomplete_courses.length ? [{ text: `  資料可能不完整：${st.incomplete_courses.join('、')}`, style: 'red' as const }] : []),
        ...(st.last_error ? [{ text: `  最近錯誤（${short(st.last_error.at)}）：${st.last_error.message}`, style: 'red' as const }] : []),
        { text: '' },
        { text: '  立即同步', key: 'sync', activate: { run: 'sync' } },
      ];
    case '介面啟用':
      return [
        head('介面啟用'),
        { text: '  終端機：啟用（必備）' },
        { text: `  資料夾（Markdown 檢視）：${d.config.interfaces.folder ? '啟用' : '停用'}` },
        dim('  網頁與桌面 app 尚未提供'),
        { text: '' },
        { text: '  修改', key: 'interfaces', activate: { prompt: { kind: 'interfaces' } } },
      ];
    case '推送方式': {
      const ch = (name: string, x: typeof st.delivery.cli): Row => ({
        text: `  ${name}：${x.enabled ? '啟用' : '停用'}${x.retrying ? `，重試中 ${x.retrying} 則` : ''}${x.gave_up ? `，放棄 ${x.gave_up} 則` : ''}`,
      });
      return [head('推送方式'), { text: '  outbox 檔案：啟用（必備）' }, ch('CLI Adapter（本機指令）', st.delivery.cli), ch('本機 webhook', st.delivery.webhook), { text: `  webhook secret：${d.config.delivery.webhook.secret !== '' ? '已設定' : '未設定'}` }, { text: '' }, { text: '  修改推送方式', key: 'delivery', activate: { prompt: { kind: 'delivery' } } }];
    }
    case '夜間時段':
      return [head('夜間時段'), dim('  這段時間的推送保存到結束時才送出；截止前 3 小時提醒照常即時推送'), { text: `  ${d.config.quiet_hours.start}–${d.config.quiet_hours.end}`, key: 'quiet', activate: { prompt: { kind: 'quietHours' } } }];
    case '截止提醒':
      return [head('截止提醒'), { text: `  ${offsets}`, key: 'offsets', activate: { prompt: { kind: 'reminderOffsets', courseId: null } } }];
    case '通知規則': {
      const on = d.rules.filter((r) => r.enabled).length;
      return [
        head(`通知規則  啟用 ${on}／${d.rules.length}`),
        ...d.rules.map((r): Row => {
          const tick: Change = { kind: 'rule', ruleId: r.id, enabled: !r.enabled };
          return {
            text: `  ${box(willBe(s, r.enabled, tick))} ${fit(r.id, 18)}${fit(r.name, 18)}${r.action}`,
            key: `rule:${r.id}`,
            tick,
            activate: { prompt: { kind: 'editRule', ruleId: r.id } },
          };
        }),
        { text: '' },
        { text: '  新增規則', key: 'new-rule', activate: { prompt: { kind: 'editRule', ruleId: null } } },
        { text: '  以編輯器修改全部規則（rules.yaml）', key: 'edit', activate: { editRules: true } },
        dim('  Space 剔選啟用或停用，再按 Enter 確認；沒有剔選時 Enter 修改該規則的關鍵詞'),
      ];
    }
    case '摘要': {
      const sm = d.config.summaries;
      return [
        head('摘要'),
        dim('  agent 讀取待摘要的公告與教材，寫好後用 ilearn summaries write 或 MCP 寫回；本工具不會呼叫任何 AI'),
        { text: '' },
        { text: `  每日上限：${sm.daily_limit} 則` },
        { text: `  今天已寫入：${d.summariesToday} 則` },
        { text: '' },
        dim('  各科是否啟用，在「課程設定」分頁；是否允許 agent 寫入，在「agent 權限」'),
      ];
    }
    case 'agent 權限': {
      const ap = d.config.agent_permissions;
      const perm = (permission: 'summaries' | 'settings', label: string): Row => {
        const tick: Change = { kind: 'agentPermission', permission, enabled: !ap[permission] };
        return { text: `  ${box(willBe(s, ap[permission], tick))} ${label}`, key: `agent-perm:${permission}`, tick, activate: { confirm: [tick] } };
      };
      return [
        head('agent 權限'),
        dim('  預設都不允許；只有你能在這裡或 ilearn setup 改變，agent 不能自己開啟'),
        { text: '' },
        perm('summaries', '允許 agent 寫入摘要'),
        perm('settings', '允許 agent 修改設定'),
        { text: '' },
        dim('  可修改的設定：夜間時段、截止提醒、通知規則與關鍵詞、每科設定、摘要開關與每日上限、資料夾檢視、更新頻率'),
        dim('  帳號、密碼、推送方式、背景服務、更新與移除一律不開放'),
        dim('  agent 每次修改都會記錄，並顯示在首頁與「提醒」分頁'),
      ];
    }
    case '帳號':
      return [
        head('帳號'),
        { text: `  ${st.username ? '已登入' : '尚未登入'}，${st.credential_saved ? '已保存密碼' : '未保存密碼'}` },
        { text: '' },
        { text: '  重新登入', key: 'login', activate: { run: 'login' } },
        { text: '  登出（刪除 session 與已保存的密碼）', key: 'logout', activate: { run: 'logout' } },
      ];
    case '背景服務': {
      const sv = d.service;
      return [
        head('背景服務'),
        dim('  由系統排程每 5 分鐘執行一次 ilearn run：到時間就同步，並檢查提醒與推送'),
        { text: `  狀態：${sv ? sv.detail : '無法取得'}`, ...(sv?.mismatch ? { style: 'red' as const } : {}) },
        { text: '' },
        ...(sv?.mismatch ? [{ text: '  重新安裝背景服務（改為執行這份程式）', key: 'svc-re', activate: { run: 'serviceInstall' as const } }] : []),
        sv?.installed
          ? { text: '  移除背景服務', key: 'svc', activate: { run: 'serviceUninstall' } }
          : { text: '  安裝背景服務', key: 'svc', activate: { run: 'serviceInstall' } },
      ];
    }
    case '系統更新': {
      const u = d.update;
      const freq = { daily: '每天', weekly: '每星期', off: '關閉' }[d.config.updates.check];
      return [
        head('系統更新'),
        { text: `  目前版本：${u?.current ?? '無法取得'}` },
        { text: `  最新版本：${u?.latest ?? '尚未檢查'}${u?.available ? '（可以更新）' : ''}` },
        { text: `  上次檢查：${u?.checkedAt ? short(toTaipeiIso(new Date(u.checkedAt))) : '尚未檢查'}` },
        { text: '' },
        { text: `  自動檢查：${freq}`, key: 'update-freq', activate: { prompt: { kind: 'updateFrequency' } } },
        { text: '  立即檢查', key: 'update-check', activate: { run: 'updateCheck' } },
        { text: '  更新', key: 'update-apply', activate: { run: 'updateApply' } },
      ];
    }
    case '完全移除':
      return [
        head('完全移除'),
        dim('  移除背景服務、ilearn 指令與程式資料夾；可以選擇保留或一併刪除 ~/.thu-ilearn 資料夾'),
        dim('  執行前會列出清單，並要求輸入 confirm'),
        { text: '' },
        { text: '  完全移除 thu-ilearn', key: 'uninstall-all', style: 'red', activate: { run: 'uninstallAll' } },
      ];
    default:
      return [head('Reset'), dim('  全部設定回復預設（先備份為 config.yaml.bak、rules.yaml.bak），同步資料、檔案、帳號保留'), { text: '  按 Enter 重設', key: 'reset', activate: { confirm: [{ kind: 'reset' }] } }];
  }
}

function systemPage(s: TuiState, d: TuiData): Page {
  // 左欄按 Enter：有主要動作的直接執行，其他移到右欄
  const leftAction: Partial<Record<(typeof SYSTEM_ITEMS)[number], Row['activate']>> = {
    Reload: { reload: true },
    夜間時段: { prompt: { kind: 'quietHours' } },
    截止提醒: { prompt: { kind: 'reminderOffsets', courseId: null } },
    Reset: { confirm: [{ kind: 'reset' }] },
  };
  const left: Row[] = [
    head('系統設定'),
    ...SYSTEM_ITEMS.map((t, i): Row => {
      return { text: `  ${t}`, key: `sys:${i}`, activate: leftAction[t] ?? { focusRight: true } };
    }),
  ];
  const item = Math.max(0, Math.min(SYSTEM_ITEMS.length - 1, s.cursor[0] - 1));
  return { panes: [left, systemRight(s, d, item)], leftWidth: 20, help: HELP.twoPane };
}

/* ---------- 詳細、確認 ---------- */

function detailPage(view: Extract<View, { kind: 'detail' }>, cols: number): Page {
  const w = Math.max(10, cols - 4);
  const rows: Row[] = [head(view.title), ...view.lines.flatMap((l) => paragraphs(l, w)).map((x): Row => ({ text: x }))];
  if (view.target) {
    rows.push({ text: '' }, { text: view.target.kind === 'url' ? `在瀏覽器開啟：${view.target.url}` : `開啟檔案：${view.target.path}`, key: 'open', activate: { open: view.target } });
  }
  return { panes: [rows], leftWidth: null, help: HELP.detail };
}

function confirmPage(view: Extract<View, { kind: 'confirm' }>, src: PageSources): Page {
  const rows: Row[] = src.preview(view.changes).map((l, i): Row => (i === 0 ? head(l) : { text: l }));
  rows.push({ text: '' }, { text: 'Enter 確認，Esc 取消', key: 'ok', style: 'bold' });
  return { panes: [rows], leftWidth: null, help: HELP.confirm };
}

/** 依目前狀態產生畫面內容。 */
export function buildPage(s: TuiState, d: TuiData, cols: number, src: PageSources): Page {
  const view = s.stack.at(-1);
  if (view?.kind === 'confirm') return confirmPage(view, src);
  if (view?.kind === 'detail') return detailPage(view, cols);
  if (view?.kind === 'course') return coursePage(s, d, view, cols, src);
  switch (s.tab) {
    case 1:
      return homePage(s, d);
    case 2:
      return coursesPage(d, cols);
    case 3:
      return remindersPage(d);
    case 4:
      return courseSettingsPage(s, d);
    case 5:
      return systemPage(s, d);
  }
}

/** 每頁頂部固定顯示的提示：首次同步進行中、登入過期。 */
export function bannerFor(d: TuiData): string[] {
  return d.notices.filter((n) => n.startsWith('首次同步進行中') || n.startsWith('登入已過期'));
}
