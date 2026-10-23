import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { courseCommand } from '../cli/commands/query.js';
import type { CliContext } from '../cli/context.js';
import { AGENT_CHANGE_DAYS, AGENT_CHANGE_SHOWN, formatChangeValue } from '../agent/changes.js';
import { writeSecureFile } from '../config/paths.js';
import { sanitizeName } from '../sync/files.js';
import { toTaipeiIso } from '../time.js';
import { courseDetail, displayName, loadTuiData, type CourseRow, type TuiData } from '../tui/data.js';
import { ruleName } from '../tui/pages.js';

type Detail = ReturnType<typeof courseCommand>;

const READ_ONLY = '唯讀檢視，由 thu-ilearn 自動產生；修改這個檔案不會影響任何資料。';
const OVERVIEW = '總覽.md';
const CURRENT_DIR = '課程';
const ARCHIVE_DIR = '保留';
const DAY_MS = 86_400_000;

/** 「2026-10-22 18:00」；輸入為 ISO 字串，一律換算成台北時間。 */
const stamp = (iso: string | Date): string => toTaipeiIso(typeof iso === 'string' ? new Date(iso) : iso).slice(0, 16).replace('T', ' ');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const link = (url: string | null): string => (url ? ` [iLearn](${url})` : '');
const paren = (parts: (string | false | null)[]): string => {
  const p = parts.filter((x): x is string => typeof x === 'string' && x !== '');
  return p.length ? `（${p.join('；')}）` : '';
};
const quote = (label: string, text: string): string[] =>
  text.split(/\r\n|\r|\n/).map((l, i) => `  > ${i === 0 ? `${label}：` : ''}${l}`.trimEnd());
const section = (title: string, lines: string[]): string[] => ['', `## ${title}`, '', ...(lines.length ? lines : ['沒有'])];
const page = (title: string, body: string[]): string => [`# ${title}`, '', READ_ONLY, ...body, ''].join('\n');

/* ---------- 檔名 ---------- */

interface Named {
  id: string;
  name: string;
  code: string;
}

/** 同一資料夾內檔名不分大小寫相同時，加上課程代號；仍相同再加課程 id。 */
function fileNames(rows: Named[]): Map<string, string> {
  const base = new Map(rows.map((r) => [r.id, sanitizeName(r.name || r.id)]));
  const count = (m: Map<string, string>): Map<string, number> => {
    const c = new Map<string, number>();
    for (const v of m.values()) c.set(v.toLowerCase(), (c.get(v.toLowerCase()) ?? 0) + 1);
    return c;
  };
  const first = count(base);
  const withCode = new Map(
    rows.map((r) => {
      const b = base.get(r.id) as string;
      return [r.id, (first.get(b.toLowerCase()) ?? 0) > 1 ? sanitizeName(`${b}（${r.code || r.id}）`) : b];
    }),
  );
  const second = count(withCode);
  return new Map(
    rows.map((r) => {
      const n = withCode.get(r.id) as string;
      return [r.id, (second.get(n.toLowerCase()) ?? 0) > 1 ? sanitizeName(`${n}（${r.id}）`) : n];
    }),
  );
}

/* ---------- 總覽 ---------- */

function overview(ctx: CliContext, d: TuiData, details: Map<string, Detail>): string {
  const name = (c: string | null): string => displayName(c ?? '');
  const task = (t: TuiData['home']['overdue'][number]): string =>
    `- ${name(t.course)}：${oneLine(t.title)}${paren([
      t.due_at ? `截止 ${stamp(t.due_at)}` : '沒有截止時間',
      t.group && '小組',
      t.teammate_hint && '系統顯示隊員可能已交',
      t.kind === 'video' && '影片',
    ])}${link(t.url)}`;

  const limit = d.now.getTime() + 3 * DAY_MS;
  const exams = d.courses
    .flatMap((c) => (details.get(c.id)?.exams ?? []).map((e) => ({ ...e, courseName: c.name })))
    .filter((e) => e.start_at !== null && Date.parse(e.start_at) >= d.now.getTime() && Date.parse(e.start_at) < limit)
    .sort((a, b) => Date.parse(a.start_at ?? '') - Date.parse(b.start_at ?? ''));

  const { overdue, within7d, later, notStarted } = d.home;
  const lines = ['', `產生時間：${stamp(d.now)}`];
  lines.push(...section(`逾期 ${overdue.length}`, overdue.map(task)));
  lines.push(...section(`7 日內截止 ${within7d.length}`, within7d.map(task)));
  lines.push(...section(`之後 ${later.length}`, later.map(task)));
  if (notStarted.length) lines.push(...section(`尚未開放 ${notStarted.length}`, notStarted.map(task)));
  lines.push(
    ...section(
      `3 日內考試 ${exams.length}`,
      exams.map((e) => `- ${e.courseName}：${oneLine(e.title)}${paren([`考試時間 ${stamp(e.start_at ?? '')}`])}${link(e.url)}`),
    ),
  );
  lines.push(
    ...section(
      `今天起發布的公告 ${d.announcements.length}`,
      d.announcements.map((a) => {
        const cats = a.categories.map((c) => ruleName(ctx.rules, c)).join('、');
        return `- ${a.course}：${oneLine(a.title)}${paren([`發布 ${stamp(a.postedAt)}`, cats && `分類 ${cats}`])}${link(a.url)}`;
      }),
    ),
  );
  const changes = d.agentChanges
    .slice(0, AGENT_CHANGE_SHOWN)
    .map((c) => `- ${stamp(c.at)} ${c.agent} 修改 ${c.key}：${oneLine(formatChangeValue(c.old))} → ${oneLine(formatChangeValue(c.new))}`);
  const agentLines = changes.length ? [`- agent 最近 ${AGENT_CHANGE_DAYS} 日修改了 ${d.agentChanges.length} 項設定：`, ...changes.map((l) => `  ${l}`)] : [];
  lines.push(...section('系統提示', [...d.notices.map((n) => `- ${oneLine(n)}`), ...agentLines]));
  return page('iLearn 總覽', lines);
}

/* ---------- 課程頁 ---------- */

function coursePage(ctx: CliContext, row: CourseRow, semester: string, x: Detail): string {
  const head = [
    '',
    `- 學期：${semester}`,
    `- 代號：${row.code}`,
    `- 上課時間：${row.schedule}`,
    `- 教室：${row.rooms || '未提供'}`,
  ];
  const lines = [...head];

  const todo = (t: Detail['todo'][number]): string =>
    `- ${oneLine(t.title)}${paren([
      t.due_at ? `截止 ${stamp(t.due_at)}` : '沒有截止時間',
      t.due_at !== null && Date.parse(t.due_at) < ctx.now().getTime() && !t.not_started && '已逾期',
      t.not_started && '尚未開放',
      t.group && '小組',
      t.teammate_hint && '系統顯示隊員可能已交',
    ])}${link(t.url)}`;
  lines.push(...section(`待辦 ${x.todo.length}`, x.todo.map(todo)));

  lines.push(
    ...section(
      `已完成 ${x.completed.length}`,
      x.completed.map((t) => `- ${oneLine(t.title)}${paren([t.completion === 'teammate_marked' && '隊員已交'])}${link(t.url)}`),
    ),
  );
  lines.push(
    ...section(
      `考試 ${x.exams.length}`,
      x.exams.map((e) => `- ${oneLine(e.title)}${paren([e.start_at && `考試時間 ${stamp(e.start_at)}`])}${link(e.url)}`),
    ),
  );
  lines.push(
    ...section(
      `公告 ${x.announcements.length}`,
      x.announcements.flatMap((a) => {
        const cats = a.categories.map((c) => ruleName(ctx.rules, c)).join('、');
        return [
          `- ${oneLine(a.title)}${paren([a.posted_at && `發布 ${stamp(a.posted_at)}`, cats && `分類 ${cats}`])}${link(a.url)}`,
          ...(a.summary ? quote('摘要', a.summary) : []),
        ];
      }),
    ),
  );

  const fileLines = x.files.flatMap((f) => {
    const downloaded = f.status === 'done' && f.local_path !== null;
    const where = downloaded
      ? `\`${relative(ctx.root, f.local_path as string)}\``
      : `${f.status === 'skipped' ? '老師關閉下載' : f.status === 'failed' ? '下載失敗' : f.status === 'link' ? '外部連結' : '尚未下載'}${link(f.link)}`;
    return [`- ${oneLine(f.name)}：${where}`, ...(f.summary ? quote('摘要', f.summary) : [])];
  });
  // 沒有任何檔案的教材項目仍列出，附上 iLearn 連結
  const withFiles = new Set(x.files.map((f) => f.item_id));
  const bare = x.materials.filter((m) => !withFiles.has(m.id)).map((m) => `- ${oneLine(m.title)}${link(m.url)}`);
  lines.push(...section(`教材 ${x.files.length + bare.length}`, [...fileLines, ...bare]));

  lines.push(...section(`問卷 ${x.surveys.length}`, x.surveys.map((s) => `- ${oneLine(s.title)}${link(s.url)}`)));
  lines.push(
    ...section(
      `影片進度 ${x.videos.length}`,
      x.videos.map((v) => `- ${oneLine(v.title)}${paren([v.completion === 'pending' ? '未看完' : '已看完'])}${link(v.url)}`),
    ),
  );
  lines.push(
    ...section(
      `分數與評語 ${x.grades.length}`,
      x.grades.flatMap((g) => [`- ${oneLine(g.title)}：${g.score ?? ''}`.trimEnd(), ...(g.feedback ? quote('評語', g.feedback) : [])]),
    ),
  );
  return page(displayName(x.course.name) || x.course.id, lines);
}

/* ---------- 寫入與清理 ---------- */

/** 只動 課程/ 與 保留/<學期>/ 底下的 .md；其餘一律不碰。 */
function removeStale(root: string, keep: Set<string>): void {
  const dirs = [CURRENT_DIR, ...safeList(join(root, ARCHIVE_DIR), true).map((s) => join(ARCHIVE_DIR, s))];
  for (const dir of dirs) {
    for (const f of safeList(join(root, dir), false)) {
      if (f.endsWith('.md') && !keep.has(join(dir, f))) rmSync(join(root, dir, f), { force: true });
    }
  }
  // 學期資料夾清空後一併移除；rmdir 遇到非空資料夾會失敗，不會刪到別的東西
  for (const sem of safeList(join(root, ARCHIVE_DIR), true)) {
    try {
      rmdirSync(join(root, ARCHIVE_DIR, sem));
    } catch {
      // 還有其他檔案，保留
    }
  }
}

function safeList(dir: string, dirs: boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (dirs ? e.isDirectory() : e.isFile()))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function build(ctx: CliContext): Map<string, string> {
  const d = loadTuiData(ctx);
  const details = new Map<string, Detail>();
  const detail = (id: string): Detail => {
    let x = details.get(id);
    if (x === undefined) {
      x = courseDetail(ctx, id);
      details.set(id, x);
    }
    return x;
  };
  for (const c of d.courses) detail(c.id);

  const out = new Map<string, string>();
  out.set(OVERVIEW, overview(ctx, d, details));
  const add = (dir: string, semester: string, rows: CourseRow[]): void => {
    const names = fileNames(rows);
    for (const r of rows) out.set(join(dir, `${names.get(r.id) as string}.md`), coursePage(ctx, r, semester, detail(r.id)));
  };
  const cur = (ctx.db.prepare('SELECT MAX(semester) AS s FROM courses').get() as { s: string | null }).s;
  add(CURRENT_DIR, cur ?? '', d.courses);
  for (const a of d.archived) add(join(ARCHIVE_DIR, sanitizeName(a.semester)), a.semester, a.courses);
  return out;
}

/**
 * 依 config.interfaces.folder 產生唯讀的 Markdown 檢視：總覽.md、課程/、保留/<學期>/。
 * 關閉時什麼都不做（也不刪除舊檔）。任何錯誤只記錄，不影響呼叫端。
 */
export function renderFolderView(ctx: CliContext, log: (s: string) => void = (s): void => void process.stderr.write(`${s}\n`)): void {
  if (!ctx.config.interfaces.folder) return;
  try {
    const files = build(ctx);
    for (const [rel, text] of files) writeSecureFile(join(ctx.root, rel), text);
    removeStale(ctx.root, new Set(files.keys()));
  } catch (e) {
    log(`更新資料夾檢視失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}
