import { writeSecureFile } from '../config/paths.js';
import { DEFAULT_CONFIG, saveConfig, type Config } from '../config/config.js';
import { CliExit, reloadSettings, rulesPath, type CliContext } from '../cli/context.js';
import { formatValidation, validateRules } from '../cli/commands/rules.js';
import { listItems, setCompletion } from '../db/repo.js';
import { DEFAULT_RULES, type Rule } from '../rules/engine.js';
import { stringifyRules } from '../rules/yaml.js';
import { parseIsoDuration } from '../time.js';
import type { Delivery } from '../types.js';
import { displayName } from './data.js';
import type { Change } from './state.js';

export const OFFSET_CHOICES: string[] = ['P3D', 'P2D', 'P1D', 'PT12H', 'PT6H', 'PT3H', 'PT1H'];

type CourseOverrides = Config['course_overrides'];
type RuleOverride = NonNullable<CourseOverrides[string]['rules']>[string];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function courseName(ctx: CliContext, id: string): string {
  const r = ctx.db.prepare('SELECT name FROM courses WHERE id = ?').get(id) as { name: string } | undefined;
  return r === undefined ? id : displayName(r.name);
}

function ruleName(rules: Rule[], id: string): string {
  return rules.find((r) => r.id === id)?.name ?? id;
}

const onOff = (enabled: boolean): string => (enabled ? '啟用' : '停用');

function withRuleEnabled(rules: Rule[], ruleId: string, enabled: boolean): Rule[] {
  return rules.map((r) => (r.id === ruleId ? { ...r, enabled } : r));
}

/** 確認畫面的說明；有規則變更時附上以資料庫試算的結果。不寫入任何東西。 */
export function previewChanges(ctx: CliContext, changes: Change[]): string[] {
  const lines = [`將變更 ${changes.length} 項`];
  const items = new Map(listItems(ctx.db, { kind: 'assignment' }).map((i) => [i.id, i.title]));
  let rules = ctx.rules;
  let hasRule = false;
  for (const c of changes) {
    switch (c.kind) {
      case 'teammate': {
        const title = items.get(c.itemId) ?? c.itemId;
        lines.push(`${c.mark ? '標記' : '取消'}「隊員已交」：${title}`);
        break;
      }
      case 'rule':
        hasRule = true;
        lines.push(`通知規則「${ruleName(ctx.rules, c.ruleId)}」：${onOff(c.enabled)}`);
        rules = withRuleEnabled(rules, c.ruleId, c.enabled);
        break;
      case 'courseRule':
        lines.push(`${courseName(ctx, c.courseId)}「${ruleName(ctx.rules, c.ruleId)}」：${onOff(c.enabled)}`);
        break;
      case 'reset':
        lines.push('全部設定回復預設，同步資料、檔案、帳號保留');
        break;
    }
  }
  if (hasRule) {
    lines.push('', '試算：', ...formatValidation(validateRules(ctx, stringifyRules(rules))).split('\n'));
  }
  return lines;
}

function writeRules(ctx: CliContext, rules: Rule[]): void {
  writeSecureFile(rulesPath(ctx.root), stringifyRules(rules));
}

/** 刪除空的 rules 與課程物件。 */
function prune(overrides: CourseOverrides, courseId: string): void {
  const course = overrides[courseId];
  if (course === undefined) return;
  if (course.rules !== undefined) {
    for (const [id, o] of Object.entries(course.rules)) {
      if (Object.keys(o).length === 0) delete course.rules[id];
    }
    if (Object.keys(course.rules).length === 0) delete course.rules;
  }
  if (Object.keys(course).length === 0) delete overrides[courseId];
}

function ruleOverride(cfg: Config, courseId: string, ruleId: string): RuleOverride {
  const course = (cfg.course_overrides[courseId] ??= {});
  const rules = (course.rules ??= {});
  return (rules[ruleId] ??= {});
}

export function applyChanges(ctx: CliContext, changes: Change[]): { applied: number; skipped: string[] } {
  reloadSettings(ctx);
  if (changes.some((c) => c.kind === 'rule') && ctx.rulesWarning !== undefined) {
    throw new CliExit(1, `規則檔無效，未套用任何變更：${ctx.rulesWarning}`);
  }
  let cfg = structuredClone(ctx.config);
  let rules = ctx.rules;
  let cfgDirty = false;
  let rulesDirty = false;
  let applied = 0;
  const skipped: string[] = [];

  for (const c of changes) {
    switch (c.kind) {
      case 'teammate': {
        const it = listItems(ctx.db, { kind: 'assignment' }).find((i) => i.id === c.itemId);
        if (it === undefined) {
          skipped.push(`找不到作業 ${c.itemId}`);
        } else if (it.completion === 'completed') {
          skipped.push(`${it.title} 已完成，略過`);
        } else {
          if (c.mark) setCompletion(ctx.db, it.id, 'teammate_marked', 'user');
          else setCompletion(ctx.db, it.id, 'pending', 'ilearn');
          applied++;
        }
        break;
      }
      case 'rule':
        if (!rules.some((r) => r.id === c.ruleId)) {
          skipped.push(`找不到通知規則 ${c.ruleId}`);
        } else {
          rules = withRuleEnabled(rules, c.ruleId, c.enabled);
          rulesDirty = true;
          applied++;
        }
        break;
      case 'courseRule': {
        const sys = rules.find((r) => r.id === c.ruleId)?.enabled;
        const o = ruleOverride(cfg, c.courseId, c.ruleId);
        if (sys !== undefined && c.enabled === sys) delete o.enabled;
        else o.enabled = c.enabled;
        prune(cfg.course_overrides, c.courseId);
        cfgDirty = true;
        applied++;
        break;
      }
      case 'reset':
        cfg = { ...structuredClone(DEFAULT_CONFIG), environment: cfg.environment, password_saved: cfg.password_saved };
        rules = structuredClone(DEFAULT_RULES);
        cfgDirty = true;
        rulesDirty = true;
        applied++;
        break;
    }
  }

  if (cfgDirty) saveConfig(cfg, ctx.root);
  if (rulesDirty) writeRules(ctx, rules);
  reloadSettings(ctx);
  return { applied, skipped };
}

function updateConfig(ctx: CliContext, fn: (cfg: Config) => void): void {
  reloadSettings(ctx);
  const cfg = structuredClone(ctx.config);
  fn(cfg);
  saveConfig(cfg, ctx.root);
  reloadSettings(ctx);
}

export function applyQuietHours(ctx: CliContext, start: string, end: string): void {
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new CliExit(1, '時間格式為 HH:MM');
  updateConfig(ctx, (cfg) => {
    cfg.quiet_hours = { start, end };
  });
}

function sortedOffsets(offsets: string[] | null): string[] {
  if (offsets === null || offsets.length === 0) throw new CliExit(1, '至少選一個提醒時間');
  for (const v of offsets) {
    if (!OFFSET_CHOICES.includes(v)) throw new CliExit(1, `不支援的提醒時間：${v}`);
  }
  return [...new Set(offsets)].sort((a, b) => parseIsoDuration(b) - parseIsoDuration(a));
}

/** courseId 為 null 時改全域；課程層級的 offsets 為 null 表示改回沿用系統。 */
export function applyReminderOffsets(ctx: CliContext, courseId: string | null, offsets: string[] | null): void {
  if (courseId !== null && offsets === null) {
    updateConfig(ctx, (cfg) => {
      const course = cfg.course_overrides[courseId];
      if (course === undefined) return;
      delete course.reminders;
      prune(cfg.course_overrides, courseId);
    });
    return;
  }
  const sorted = sortedOffsets(offsets);
  updateConfig(ctx, (cfg) => {
    if (courseId === null) cfg.reminders.offsets = sorted;
    else (cfg.course_overrides[courseId] ??= {}).reminders = sorted;
  });
}

export function applyCourseRuleAction(ctx: CliContext, courseId: string, ruleId: string, action: Delivery | null): void {
  updateConfig(ctx, (cfg) => {
    if (action === null) {
      const o = cfg.course_overrides[courseId]?.rules?.[ruleId];
      if (o === undefined) return;
      delete o.action;
    } else {
      ruleOverride(cfg, courseId, ruleId).action = action;
    }
    prune(cfg.course_overrides, courseId);
  });
}
