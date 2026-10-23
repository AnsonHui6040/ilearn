import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncHandler } from '../src/cli/commands/sync.js';
import { createContext, writeAccount, type CliContext } from '../src/cli/context.js';
import { upsertCourse, upsertFile, upsertItem, upsertSummary, setSyncState, type StoredItem } from '../src/db/repo.js';
import { renderFolderView } from '../src/folder/folder.js';
import { courseViewHtml, createFakeApi, standardData } from './helpers/fakeApi.js';

const NOW = new Date('2026-10-22T04:00:00Z'); // 12:00 台北
const H = 3600_000;
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const READ_ONLY = '唯讀檢視，由 thu-ilearn 自動產生；修改這個檔案不會影響任何資料。';

function mk(): CliContext {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-folder-'));
  return createContext({ root, now: () => NOW, userId: 1 });
}

function course(ctx: CliContext, id: string, name: string, code: string, semester: string): void {
  upsertCourse(ctx.db, { id, name, code, semester, start_date: '', end_date: '', raw: '{}' });
}

function item(ctx: CliContext, p: Partial<StoredItem> & Pick<StoredItem, 'id' | 'kind' | 'course_id'>): void {
  upsertItem(ctx.db, {
    title: p.id, body: null, due_at: null, start_at: null, url: null, completion: 'pending',
    teammate_hint: false, group: false, score: null, score_published: false, feedback: null,
    categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: iso(-24 * H), updated_at: iso(-24 * H),
    ...p,
  });
}

const read = (ctx: CliContext, ...rel: string[]): string => readFileSync(join(ctx.root, ...rel), 'utf8');
const mdFiles = (ctx: CliContext, dir: string): string[] => readdirSync(join(ctx.root, dir), { recursive: true }).map(String).filter((f) => f.endsWith('.md')).sort();

function seeded(): CliContext {
  const ctx = mk();
  setSyncState(ctx.db, { initial_completed: false });
  course(ctx, '1', '(1151_CS101)中文:資料結構', '1151_CS101', '115-1');
  course(ctx, '2', '管理學', '1151_MG200', '115-1');
  course(ctx, '9', '舊課程', '1142_OLD', '114-2');
  item(ctx, {
    id: 'course_info:1', kind: 'course_info', course_id: '1',
    raw: JSON.stringify({ schedule: { raw: 'x', slots: [{ weekday: 3, periods: ['2', '3', '4'], room: 'M134' }] } }),
  });
  // 待辦：逾期、7 日內、之後、影片、尚未開放
  item(ctx, { id: 'assignment:1', kind: 'assignment', course_id: '1', title: '逾期作業', due_at: iso(-2 * H), url: 'https://ilearn.example/a1' });
  item(ctx, { id: 'assignment:2', kind: 'assignment', course_id: '1', title: '期中報告', due_at: iso(3 * 24 * H), group: true, teammate_hint: true, url: 'https://ilearn.example/a2' });
  item(ctx, { id: 'assignment:3', kind: 'assignment', course_id: '2', title: '期末專案', due_at: iso(10 * 24 * H), url: 'https://ilearn.example/a3' });
  item(ctx, { id: 'video:4', kind: 'video', course_id: '2', title: '第三週影片', due_at: null, url: 'https://ilearn.example/v4' });
  item(ctx, { id: 'assignment:5', kind: 'assignment', course_id: '2', title: '尚未開放作業', due_at: iso(2 * 24 * H), start_at: iso(24 * H) });
  item(ctx, { id: 'assignment:6', kind: 'assignment', course_id: '1', title: '已交作業', completion: 'completed', due_at: iso(-5 * 24 * H) });
  item(ctx, { id: 'assignment:7', kind: 'assignment', course_id: '1', title: '隊員代交', completion: 'teammate_marked', due_at: iso(-3 * 24 * H) });
  // 考試：2 日內與 5 日後
  item(ctx, { id: 'exam:1', kind: 'exam', course_id: '1', title: '期中考', start_at: iso(2 * 24 * H), url: 'https://ilearn.example/e1' });
  item(ctx, { id: 'exam:2', kind: 'exam', course_id: '2', title: '期末考', start_at: iso(5 * 24 * H) });
  // 公告：今天與前天
  item(ctx, {
    id: 'announcement:1', kind: 'announcement', course_id: '1', title: '改教室', categories: ['room_change'],
    raw: JSON.stringify({ created_at: '2026-10-22T01:00:00Z' }), url: 'https://ilearn.example/n1',
  });
  item(ctx, { id: 'announcement:2', kind: 'announcement', course_id: '1', title: '舊公告', raw: JSON.stringify({ created_at: '2026-10-20T01:00:00Z' }) });
  upsertSummary(ctx.db, {
    target_id: 'announcement:1', kind: 'announcement', course_id: '1', source_hash: 'h', text: '下週改到 M201\n請留意', agent: 'a', written_at: iso(0),
  });
  // 教材
  item(ctx, { id: 'material:1', kind: 'material', course_id: '1', title: '第一章' });
  upsertFile(ctx.db, {
    upload_id: 'f1', item_id: 'material:1', course_id: '1', name: 'ch1.pdf', size: 10, hash: 'x',
    local_path: join('files', '115-1', '資料結構', '教材', 'ch1.pdf'), status: 'done', link: null, allow_download: true,
  });
  upsertFile(ctx.db, {
    upload_id: 'f2', item_id: 'material:1', course_id: '1', name: 'ch2.pdf', size: 10, hash: null,
    local_path: null, status: 'skipped', link: 'https://ilearn.example/f2', allow_download: false,
  });
  upsertSummary(ctx.db, {
    target_id: 'file:f1', kind: 'material', course_id: '1', source_hash: 'x', text: '第一章重點', agent: 'a', written_at: iso(0),
  });
  item(ctx, { id: 'survey:1', kind: 'survey', course_id: '1', title: '教學意見調查', url: 'https://ilearn.example/s1' });
  item(ctx, { id: 'video:5', kind: 'video', course_id: '1', title: '已看影片', completion: 'completed' });
  // 分數：一筆已公布、一筆未公布
  item(ctx, { id: 'exam:3', kind: 'exam', course_id: '1', title: '小考', start_at: iso(-20 * 24 * H), score: '88', score_published: true, feedback: '很好\n繼續保持' });
  item(ctx, { id: 'exam:4', kind: 'exam', course_id: '1', title: '隱藏成績考', start_at: iso(-30 * 24 * H), score: '10', score_published: false });
  item(ctx, { id: 'assignment:9', kind: 'assignment', course_id: '9', title: '舊作業', completion: 'completed' });
  return ctx;
}

describe('overview', () => {
  it('依序列出各區塊，並帶出課程、標題、截止時間與連結', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    const t = read(ctx, '總覽.md');
    expect(t.startsWith(`# iLearn 總覽\n\n${READ_ONLY}\n`)).toBe(true);
    expect(t).toContain('產生時間：2026-10-22 12:00');
    const order = ['## 逾期 1', '## 7 日內截止 1', '## 之後 2', '## 尚未開放 1', '## 3 日內考試 1', '## 今天起發布的公告 1', '## 系統提示'].map((h) => t.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(t).toContain('- 資料結構：逾期作業（截止 2026-10-22 10:00） [iLearn](https://ilearn.example/a1)');
    expect(t).toContain('- 資料結構：期中報告（截止 2026-10-25 12:00；小組；系統顯示隊員可能已交） [iLearn](https://ilearn.example/a2)');
    expect(t).toContain('- 管理學：第三週影片（沒有截止時間；影片） [iLearn](https://ilearn.example/v4)');
    expect(t).toContain('- 資料結構：期中考（考試時間 2026-10-24 12:00） [iLearn](https://ilearn.example/e1)');
    expect(t).not.toContain('期末考');
    expect(t).toContain('- 資料結構：改教室（發布 2026-10-22 09:00；分類 ');
    expect(t).not.toContain('舊公告');
    expect(t).toContain('- 首次同步進行中');
  });
});

describe('course pages', () => {
  it('本學期課程頁含各區塊、摘要與本機路徑', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    expect(mdFiles(ctx, '課程')).toEqual(['管理學.md', '資料結構.md']);
    const t = read(ctx, '課程', '資料結構.md');
    expect(t.startsWith(`# 資料結構\n\n${READ_ONLY}\n`)).toBe(true);
    expect(t).toContain('- 代號：CS101');
    expect(t).toContain('- 上課時間：三 09:10–12:10（2–4 節）');
    expect(t).toContain('- 教室：M134');
    for (const h of ['## 待辦 2', '## 已完成 2', '## 考試 3', '## 公告 2', '## 教材 2', '## 問卷 1', '## 影片進度 1', '## 分數與評語 1']) {
      expect(t).toContain(h);
    }
    expect(t).toContain('- 逾期作業（截止 2026-10-22 10:00；已逾期） [iLearn](https://ilearn.example/a1)');
    expect(t).toContain('- 隊員代交（隊員已交）');
    expect(t).toContain('- 改教室（發布 2026-10-22 09:00；分類 ');
    expect(t).toContain('  > 摘要：下週改到 M201\n  > 請留意');
    expect(t).toContain(`- ch1.pdf：\`${join('files', '115-1', '資料結構', '教材', 'ch1.pdf')}\`\n  > 摘要：第一章重點`);
    expect(t).toContain('- ch2.pdf：老師關閉下載 [iLearn](https://ilearn.example/f2)');
    expect(t).toContain('- 教學意見調查 [iLearn](https://ilearn.example/s1)');
    expect(t).toContain('- 已看影片（已看完）');
    expect(t).toContain('- 小考：88\n  > 評語：很好\n  > 繼續保持');
    expect(t.slice(t.indexOf('## 分數與評語'))).not.toContain('隱藏成績考');
  });

  it('舊學期放在 保留/<學期>/', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    expect(mdFiles(ctx, '保留')).toEqual([join('114-2', '舊課程.md')]);
    const t = read(ctx, '保留', '114-2', '舊課程.md');
    expect(t).toContain(READ_ONLY);
    expect(t).toContain('- 學期：114-2');
    expect(mdFiles(ctx, '課程')).not.toContain('舊課程.md');
  });

  it('檔名經 sanitizeName，同名時加上課程代號', () => {
    const ctx = mk();
    course(ctx, '1', '微積分/甲', '1151_M1', '115-1');
    course(ctx, '2', '統計學', '1151_S1', '115-1');
    course(ctx, '3', '統計學', '1151_S2', '115-1');
    renderFolderView(ctx);
    expect(mdFiles(ctx, '課程')).toEqual(['微積分_甲.md', '統計學（S1）.md', '統計學（S2）.md']);
  });

  it('代號也相同時再加課程 id', () => {
    const ctx = mk();
    course(ctx, '1', '統計學', '1151_S1', '115-1');
    course(ctx, '2', '統計學', '1151_S1', '115-1');
    renderFolderView(ctx);
    expect(mdFiles(ctx, '課程')).toEqual(['統計學（S1）（1）.md', '統計學（S1）（2）.md']);
  });
});

describe('files on disk', () => {
  it('每次完整重寫，移除已不存在的課程檔，其餘檔案不動', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    const keep = [join('files', '115-1', 'note.md'), join('outbox', '通知.md'), join('課程', 'notes.txt'), join('保留', '114-2', 'other.txt'), 'README.md'];
    for (const k of keep) {
      mkdirSync(join(ctx.root, k, '..'), { recursive: true });
      writeFileSync(join(ctx.root, k), 'mine');
    }
    writeFileSync(join(ctx.root, '課程', '已退選.md'), 'old');
    mkdirSync(join(ctx.root, '保留', '113-2'), { recursive: true });
    writeFileSync(join(ctx.root, '保留', '113-2', '更舊.md'), 'old');
    ctx.db.prepare("DELETE FROM courses WHERE id = '2'").run();
    renderFolderView(ctx);
    expect(mdFiles(ctx, '課程')).toEqual(['資料結構.md']);
    expect(existsSync(join(ctx.root, '保留', '113-2'))).toBe(false);
    expect(mdFiles(ctx, '保留')).toEqual([join('114-2', '舊課程.md')]);
    for (const k of keep) expect(readFileSync(join(ctx.root, k), 'utf8')).toBe('mine');
  });

  it('課程移到舊學期後，本學期資料夾裡的舊檔會被移除', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    course(ctx, '3', '新課', '1152_N', '116-1');
    renderFolderView(ctx);
    expect(mdFiles(ctx, '課程')).toEqual(['新課.md']);
    expect(mdFiles(ctx, '保留')).toEqual([join('114-2', '舊課程.md'), join('115-1', '管理學.md'), join('115-1', '資料結構.md')]);
  });

  it('interfaces.folder 關閉時不寫入也不刪除', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    const before = read(ctx, '總覽.md');
    ctx.config.interfaces.folder = false;
    ctx.db.prepare("DELETE FROM courses WHERE id = '2'").run();
    renderFolderView(ctx);
    expect(read(ctx, '總覽.md')).toBe(before);
    expect(mdFiles(ctx, '課程')).toEqual(['管理學.md', '資料結構.md']);

    const fresh = mk();
    fresh.config.interfaces.folder = false;
    renderFolderView(fresh);
    expect(readdirSync(fresh.root).filter((f) => f.endsWith('.md') || f === '課程' || f === '保留')).toEqual([]);
  });

  it('檔案 0600、資料夾 0700', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    expect(statSync(join(ctx.root, '總覽.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.root, '課程', '資料結構.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.root, '課程')).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.root, '保留', '114-2')).mode & 0o777).toBe(0o700);
  });

  it('所有檔案第二段都是唯讀說明', () => {
    const ctx = seeded();
    renderFolderView(ctx);
    for (const rel of ['總覽.md', ...mdFiles(ctx, '課程').map((f) => join('課程', f)), ...mdFiles(ctx, '保留').map((f) => join('保留', f))]) {
      expect(read(ctx, rel).split('\n')[2]).toBe(READ_ONLY);
    }
  });
});

describe('failures', () => {
  it('寫入失敗只記錄，不丟出', () => {
    const ctx = seeded();
    writeFileSync(join(ctx.root, '課程'), '擋住資料夾');
    const logs: string[] = [];
    expect(() => renderFolderView(ctx, (s) => logs.push(s))).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('更新資料夾檢視失敗');
    expect(readFileSync(join(ctx.root, '課程'), 'utf8')).toBe('擋住資料夾');
  });

  it('ilearn sync 照常完成並產生檢視；檢視寫入失敗時同步仍成功', async () => {
    const run = async (block: boolean): Promise<string> => {
      const root = mkdtempSync(join(tmpdir(), 'ilearn-folder-sync-'));
      writeAccount(root, { username: 'u' });
      if (block) writeFileSync(join(root, '課程'), 'x');
      const fake = createFakeApi(standardData());
      const { outcome } = await syncHandler(
        { force: true },
        { root, api: fake.api, fetchText: () => Promise.resolve(courseViewHtml()), now: () => NOW, userId: 777 },
      );
      expect(outcome.skipped).toBe(false);
      return root;
    };
    const ok = await run(false);
    expect(readFileSync(join(ok, '總覽.md'), 'utf8')).toContain(READ_ONLY);
    expect(readdirSync(join(ok, '課程')).length).toBeGreaterThan(0);
    const blocked = await run(true);
    expect(existsSync(join(blocked, '總覽.md'))).toBe(true);
  });
});
