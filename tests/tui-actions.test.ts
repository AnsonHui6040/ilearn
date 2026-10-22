import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CliExit, createContext, rulesPath, type CliContext } from '../src/cli/context.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config/config.js';
import { listItems, upsertCourse, upsertItem, setCompletion, type StoredItem } from '../src/db/repo.js';
import { DEFAULT_RULES } from '../src/rules/engine.js';
import { stringifyRules } from '../src/rules/yaml.js';
import {
  OFFSET_CHOICES,
  applyChanges,
  applyCourseRuleAction,
  applyQuietHours,
  applyReminderOffsets,
  previewChanges,
} from '../src/tui/actions.js';

const NOW = new Date('2026-10-22T04:00:00Z');

function mk(): CliContext {
  const root = mkdtempSync(join(tmpdir(), 'ilearn-tui-act-'));
  return createContext({ root, now: () => NOW, userId: 1 });
}

function course(ctx: CliContext, id: string, name: string): void {
  upsertCourse(ctx.db, { id, name, code: '1151_X', semester: '115-1', start_date: '', end_date: '', raw: '{}' });
}

function assignment(ctx: CliContext, id: string, title: string): void {
  const it: StoredItem = {
    id, kind: 'assignment', course_id: '1', title, body: null, due_at: null, start_at: null, url: null,
    completion: 'pending', teammate_hint: false, group: true, score: null, score_published: false,
    feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  upsertItem(ctx.db, it);
}

const completion = (ctx: CliContext, id: string): string | undefined =>
  listItems(ctx.db, { kind: 'assignment' }).find((i) => i.id === id)?.completion;

const ruleEnabled = (ctx: CliContext, id: string): boolean | undefined => ctx.rules.find((r) => r.id === id)?.enabled;

const readConfig = (ctx: CliContext): Record<string, unknown> =>
  parse(readFileSync(join(ctx.root, 'config.yaml'), 'utf8')) as Record<string, unknown>;

function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => `${join(d.parentPath, d.name)}:${statSync(join(d.parentPath, d.name)).size}`)
    .sort();
}

function exitOf(fn: () => unknown): CliExit {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliExit);
    return e as CliExit;
  }
  throw new Error('expected CliExit');
}

describe('OFFSET_CHOICES', () => {
  it('列出七個提醒時間', () => {
    expect(OFFSET_CHOICES).toEqual(['P3D', 'P2D', 'P1D', 'PT12H', 'PT6H', 'PT3H', 'PT1H']);
  });
});

describe('previewChanges', () => {
  it('第一行為變更項數，之後每項一行', () => {
    const ctx = mk();
    course(ctx, '1', '(1151_1212)會計學');
    assignment(ctx, 'assignment:1', '期中報告');
    assignment(ctx, 'assignment:2', '作業二');
    const r0 = DEFAULT_RULES[0]!;
    const lines = previewChanges(ctx, [
      { kind: 'teammate', itemId: 'assignment:1', mark: true },
      { kind: 'teammate', itemId: 'assignment:2', mark: false },
      { kind: 'courseRule', courseId: '1', ruleId: r0.id, enabled: false },
      { kind: 'courseRule', courseId: '1', ruleId: r0.id, enabled: true },
      { kind: 'reset' },
    ]);
    expect(lines).toEqual([
      '將變更 5 項',
      '標記「隊員已交」：期中報告',
      '取消「隊員已交」：作業二',
      `會計學「${r0.name}」：停用`,
      `會計學「${r0.name}」：啟用`,
      '全部設定回復預設，同步資料、檔案、帳號保留',
    ]);
  });

  it('有規則變更時附上試算', () => {
    const ctx = mk();
    const r0 = DEFAULT_RULES[0]!;
    const r1 = DEFAULT_RULES[1]!;
    const lines = previewChanges(ctx, [
      { kind: 'rule', ruleId: r0.id, enabled: false },
      { kind: 'rule', ruleId: r1.id, enabled: true },
    ]);
    expect(lines.slice(0, 3)).toEqual(['將變更 2 項', `通知規則「${r0.name}」：停用`, `通知規則「${r1.name}」：啟用`]);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('試算：');
    expect(lines[5]).toContain(`規則有效，共 ${DEFAULT_RULES.length} 條`);
    // 預覽不寫入檔案
    expect(existsSync(rulesPath(ctx.root))).toBe(false);
    expect(ruleEnabled(ctx, r0.id)).toBe(true);
  });

  it('沒有規則變更時不附試算', () => {
    const ctx = mk();
    expect(previewChanges(ctx, [{ kind: 'reset' }])).not.toContain('試算：');
  });
});

describe('applyChanges teammate', () => {
  it('標記與取消', () => {
    const ctx = mk();
    course(ctx, '1', '會計學');
    assignment(ctx, 'assignment:1', '期中報告');
    expect(applyChanges(ctx, [{ kind: 'teammate', itemId: 'assignment:1', mark: true }])).toEqual({ applied: 1, skipped: [] });
    expect(completion(ctx, 'assignment:1')).toBe('teammate_marked');
    const src = (ctx.db.prepare('SELECT completion_source s FROM items WHERE id = ?').get('assignment:1') as { s: string }).s;
    expect(src).toBe('user');
    expect(applyChanges(ctx, [{ kind: 'teammate', itemId: 'assignment:1', mark: false }]).applied).toBe(1);
    expect(completion(ctx, 'assignment:1')).toBe('pending');
    const src2 = (ctx.db.prepare('SELECT completion_source s FROM items WHERE id = ?').get('assignment:1') as { s: string }).s;
    expect(src2).toBe('ilearn');
  });

  it('套用前已完成就略過，不計入 applied', () => {
    const ctx = mk();
    course(ctx, '1', '會計學');
    assignment(ctx, 'assignment:1', '期中報告');
    assignment(ctx, 'assignment:2', '作業二');
    setCompletion(ctx.db, 'assignment:1', 'completed', 'ilearn');
    const r = applyChanges(ctx, [
      { kind: 'teammate', itemId: 'assignment:1', mark: true },
      { kind: 'teammate', itemId: 'assignment:2', mark: true },
    ]);
    expect(r).toEqual({ applied: 1, skipped: ['期中報告 已完成，略過'] });
    expect(completion(ctx, 'assignment:1')).toBe('completed');
    expect(completion(ctx, 'assignment:2')).toBe('teammate_marked');
  });

  it('找不到作業', () => {
    const ctx = mk();
    expect(applyChanges(ctx, [{ kind: 'teammate', itemId: 'assignment:99', mark: true }])).toEqual({
      applied: 0,
      skipped: ['找不到作業 assignment:99'],
    });
  });
});

describe('applyChanges rule', () => {
  it('只改指定規則並寫入 rules.yaml 與 ctx.rules', () => {
    const ctx = mk();
    const r0 = DEFAULT_RULES[0]!;
    const r = applyChanges(ctx, [{ kind: 'rule', ruleId: r0.id, enabled: false }]);
    expect(r.applied).toBe(1);
    expect(ruleEnabled(ctx, r0.id)).toBe(false);
    for (const o of DEFAULT_RULES.slice(1)) expect(ruleEnabled(ctx, o.id)).toBe(o.enabled);
    const onDisk = readFileSync(rulesPath(ctx.root), 'utf8');
    expect(onDisk).toBe(stringifyRules(DEFAULT_RULES.map((x) => (x.id === r0.id ? { ...x, enabled: false } : x))));
  });

  it('規則檔已被外部改成無效時拒絕且不改動檔案', () => {
    const ctx = mk();
    const bad = 'not: [valid\n  - yaml: : :\n';
    writeFileSync(rulesPath(ctx.root), bad);
    const e = exitOf(() => applyChanges(ctx, [{ kind: 'rule', ruleId: DEFAULT_RULES[0]!.id, enabled: false }]));
    expect(e.code).toBe(1);
    expect(e.message).toMatch(/第 \d+ 行/);
    expect(readFileSync(rulesPath(ctx.root), 'utf8')).toBe(bad);
  });

  it('找不到規則就略過', () => {
    const ctx = mk();
    const r = applyChanges(ctx, [{ kind: 'rule', ruleId: 'nope', enabled: false }]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toEqual(['找不到通知規則 nope']);
  });
});

describe('applyChanges courseRule', () => {
  it('寫入覆寫；與系統相同時刪除該鍵與空物件', () => {
    const ctx = mk();
    const r0 = DEFAULT_RULES[0]!;
    applyChanges(ctx, [{ kind: 'courseRule', courseId: '1', ruleId: r0.id, enabled: false }]);
    expect(ctx.config.course_overrides['1']?.rules?.[r0.id]?.enabled).toBe(false);
    expect(loadConfig(ctx.root).course_overrides['1']?.rules?.[r0.id]).toEqual({ enabled: false });

    applyChanges(ctx, [{ kind: 'courseRule', courseId: '1', ruleId: r0.id, enabled: r0.enabled }]);
    expect(ctx.config.course_overrides).toEqual({});
    expect(loadConfig(ctx.root).course_overrides).toEqual({});
  });

  it('有 action 覆寫時保留該規則鍵', () => {
    const ctx = mk();
    const r0 = DEFAULT_RULES[0]!;
    applyCourseRuleAction(ctx, '1', r0.id, 'record');
    applyChanges(ctx, [{ kind: 'courseRule', courseId: '1', ruleId: r0.id, enabled: r0.enabled }]);
    expect(ctx.config.course_overrides['1']?.rules?.[r0.id]).toEqual({ action: 'record' });
  });
});

describe('applyChanges reset', () => {
  it('設定與規則回復預設，保留 environment、password_saved 與資料', () => {
    const ctx = mk();
    mkdirSync(join(ctx.root, 'files'), { recursive: true });
    writeFileSync(join(ctx.root, 'files', 'a.txt'), 'hello');
    writeFileSync(join(ctx.root, 'data', 'account.json'), '{"username":"u"}');
    saveConfig(
      {
        ...DEFAULT_CONFIG,
        environment: 'vps',
        password_saved: true,
        quiet_hours: { start: '22:00', end: '08:00' },
        course_overrides: { '1': { reminders: ['P1D'] } },
      },
      ctx.root,
    );
    applyChanges(ctx, [{ kind: 'rule', ruleId: DEFAULT_RULES[0]!.id, enabled: false }]);
    const before = snapshot(ctx.root).filter((f) => /ilearn\.sqlite3|files|account\.json/.test(f));
    expect(before.length).toBeGreaterThan(0);

    expect(applyChanges(ctx, [{ kind: 'reset' }]).applied).toBe(1);

    const expected = { ...structuredClone(DEFAULT_CONFIG), environment: 'vps', password_saved: true };
    expect(readConfig(ctx)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(ctx.config).toEqual(expected);
    expect(readFileSync(rulesPath(ctx.root), 'utf8')).toBe(stringifyRules(DEFAULT_RULES));
    expect(ruleEnabled(ctx, DEFAULT_RULES[0]!.id)).toBe(true);
    expect(snapshot(ctx.root).filter((f) => /ilearn\.sqlite3|files|account\.json/.test(f))).toEqual(before);
    expect(readFileSync(join(ctx.root, 'data', 'account.json'), 'utf8')).toBe('{"username":"u"}');
  });
});

describe('applyChanges applied count', () => {
  it('只計實際套用的項目', () => {
    const ctx = mk();
    course(ctx, '1', '會計學');
    assignment(ctx, 'assignment:1', 'A');
    const r = applyChanges(ctx, [
      { kind: 'teammate', itemId: 'assignment:1', mark: true },
      { kind: 'teammate', itemId: 'assignment:404', mark: true },
      { kind: 'rule', ruleId: DEFAULT_RULES[0]!.id, enabled: false },
      { kind: 'courseRule', courseId: '1', ruleId: DEFAULT_RULES[0]!.id, enabled: false },
    ]);
    expect(r.applied).toBe(3);
    expect(r.skipped).toEqual(['找不到作業 assignment:404']);
  });
});

describe('applyQuietHours', () => {
  it('寫入有效時間', () => {
    const ctx = mk();
    applyQuietHours(ctx, '23:00', '06:30');
    expect(ctx.config.quiet_hours).toEqual({ start: '23:00', end: '06:30' });
    expect(loadConfig(ctx.root).quiet_hours).toEqual({ start: '23:00', end: '06:30' });
  });

  it.each([
    ['24:00', '06:00'],
    ['7:00', '08:00'],
    ['ab:cd', '08:00'],
    ['22:00', '09:60'],
  ])('拒絕 %s %s', (s, e) => {
    const ctx = mk();
    const x = exitOf(() => applyQuietHours(ctx, s, e));
    expect(x.code).toBe(1);
    expect(x.message).toBe('時間格式為 HH:MM');
    expect(existsSync(join(ctx.root, 'config.yaml'))).toBe(false);
  });
});

describe('applyReminderOffsets', () => {
  it('全域：由長到短排序後寫入', () => {
    const ctx = mk();
    applyReminderOffsets(ctx, null, ['PT3H', 'P2D', 'PT12H']);
    expect(ctx.config.reminders.offsets).toEqual(['P2D', 'PT12H', 'PT3H']);
    expect(loadConfig(ctx.root).reminders.offsets).toEqual(['P2D', 'PT12H', 'PT3H']);
  });

  it('全域：空或 null 拒絕', () => {
    const ctx = mk();
    for (const v of [[], null]) {
      const x = exitOf(() => applyReminderOffsets(ctx, null, v));
      expect(x.code).toBe(1);
      expect(x.message).toBe('至少選一個提醒時間');
    }
  });

  it('不支援的值拒絕', () => {
    const ctx = mk();
    const x = exitOf(() => applyReminderOffsets(ctx, null, ['P1D', 'PT5M']));
    expect(x.message).toBe('不支援的提醒時間：PT5M');
    expect(existsSync(join(ctx.root, 'config.yaml'))).toBe(false);
  });

  it('課程：設定、null 刪除並清掉空物件、空陣列拒絕', () => {
    const ctx = mk();
    applyReminderOffsets(ctx, '1', ['PT1H', 'P3D']);
    expect(ctx.config.course_overrides['1']?.reminders).toEqual(['P3D', 'PT1H']);
    applyReminderOffsets(ctx, '1', null);
    expect(ctx.config.course_overrides).toEqual({});
    expect(loadConfig(ctx.root).course_overrides).toEqual({});
    expect(exitOf(() => applyReminderOffsets(ctx, '1', [])).message).toBe('至少選一個提醒時間');
  });

  it('課程：刪除提醒時保留其他覆寫', () => {
    const ctx = mk();
    applyCourseRuleAction(ctx, '1', 'r', 'push');
    applyReminderOffsets(ctx, '1', ['P1D']);
    applyReminderOffsets(ctx, '1', null);
    expect(ctx.config.course_overrides).toEqual({ '1': { rules: { r: { action: 'push' } } } });
  });
});

describe('applyCourseRuleAction', () => {
  it('設定與刪除 action，並清理空物件', () => {
    const ctx = mk();
    applyCourseRuleAction(ctx, '1', 'x', 'force_push');
    expect(loadConfig(ctx.root).course_overrides['1']?.rules?.['x']).toEqual({ action: 'force_push' });
    applyCourseRuleAction(ctx, '1', 'x', null);
    expect(ctx.config.course_overrides).toEqual({});
    expect(loadConfig(ctx.root).course_overrides).toEqual({});
  });

  it('刪除 action 時保留 enabled 覆寫', () => {
    const ctx = mk();
    applyChanges(ctx, [{ kind: 'courseRule', courseId: '1', ruleId: DEFAULT_RULES[0]!.id, enabled: false }]);
    applyCourseRuleAction(ctx, '1', DEFAULT_RULES[0]!.id, 'record');
    applyCourseRuleAction(ctx, '1', DEFAULT_RULES[0]!.id, null);
    expect(ctx.config.course_overrides['1']?.rules?.[DEFAULT_RULES[0]!.id]).toEqual({ enabled: false });
  });
});

describe('reloadSettings', () => {
  it('套用前讀取外部修改，套用後 ctx 與檔案一致', () => {
    const ctx = mk();
    saveConfig({ ...loadConfig(ctx.root), quiet_hours: { start: '01:00', end: '05:00' } }, ctx.root);
    expect(ctx.config.quiet_hours.start).toBe('00:00');
    applyReminderOffsets(ctx, null, ['P1D']);
    expect(ctx.config.quiet_hours).toEqual({ start: '01:00', end: '05:00' });
    expect(ctx.config.reminders.offsets).toEqual(['P1D']);
  });
});
