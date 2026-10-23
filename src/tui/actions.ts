import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../config/paths.js';
import { DEFAULT_CONFIG, saveConfig, type Config, type UpdateFrequency } from '../config/config.js';
import { CliExit, reloadSettings, rulesPath, type CliContext } from '../cli/context.js';
import { formatValidation, validateRules } from '../cli/commands/rules.js';
import { listItems, setCompletion } from '../db/repo.js';
import { renderFolderView } from '../folder/folder.js';
import { DEFAULT_RULES, type Rule } from '../rules/engine.js';
import { parseRulesYaml, stringifyRules } from '../rules/yaml.js';
import { webhookUrlError } from '../events/dispatch.js';
import { parseIsoDuration } from '../time.js';
import type { Delivery } from '../types.js';
import { displayName } from './data.js';
import { SUMMARY_LABEL, type Change } from './state.js';

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
      case 'courseSummary':
        lines.push(`${courseName(ctx, c.courseId)}「${SUMMARY_LABEL[c.summary]}」：${onOff(c.enabled)}`);
        break;
      case 'agentWrite':
        lines.push(`允許 agent 寫入摘要：${c.enabled ? '允許' : '不允許'}`);
        break;
      case 'reset':
        lines.push('全部設定回復預設（先備份為 config.yaml.bak、rules.yaml.bak），同步資料、檔案、帳號保留');
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

/** Reset 前把目前的設定檔與規則檔複製為 .bak。 */
function backupSettings(root: string): void {
  for (const name of ['config.yaml', 'rules.yaml']) {
    const from = join(root, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, `${from}.bak`);
    chmodSync(`${from}.bak`, 0o600);
  }
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
      case 'courseSummary': {
        const cur = cfg.summaries.courses[c.courseId] ?? { materials: false, announcements: false };
        const next = { ...cur, [c.summary]: c.enabled };
        // 兩種摘要都關閉時不留空項目，與設定精靈一致
        if (next.materials || next.announcements) cfg.summaries.courses[c.courseId] = next;
        else delete cfg.summaries.courses[c.courseId];
        cfgDirty = true;
        applied++;
        break;
      }
      case 'agentWrite':
        cfg.summaries.agent_write = c.enabled;
        cfgDirty = true;
        applied++;
        break;
      case 'reset':
        cfg = { ...structuredClone(DEFAULT_CONFIG), environment: cfg.environment, password_saved: cfg.password_saved };
        rules = structuredClone(DEFAULT_RULES);
        cfgDirty = true;
        rulesDirty = true;
        applied++;
        break;
    }
  }

  if (changes.some((c) => c.kind === 'reset')) backupSettings(ctx.root);
  if (cfgDirty) saveConfig(cfg, ctx.root);
  if (rulesDirty) writeRules(ctx, rules);
  reloadSettings(ctx);
  // 介面內不輸出到終端，失敗時靜默略過
  renderFolderView(ctx, () => undefined);
  return { applied, skipped };
}

function updateConfig(ctx: CliContext, fn: (cfg: Config) => void): void {
  reloadSettings(ctx);
  const cfg = structuredClone(ctx.config);
  fn(cfg);
  saveConfig(cfg, ctx.root);
  reloadSettings(ctx);
}

export function applyUpdateFrequency(ctx: CliContext, freq: UpdateFrequency): void {
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'off') throw new CliExit(1, '檢查頻率只能是每天、每星期或關閉');
  updateConfig(ctx, (cfg) => {
    cfg.updates = { check: freq };
  });
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

/* ---------- 規則編輯 ---------- */

/** 以半形、全形逗號或「、」分隔的關鍵詞。 */
export function parseKeywords(s: string): string[] {
  return s.split(/[,，、]/).map((k) => k.trim()).filter((k) => k !== '');
}

/** 新規則的代碼：custom_1、custom_2…中第一個未使用的。 */
export function nextRuleId(rules: Rule[]): string {
  const used = new Set(rules.map((r) => r.id));
  let n = 1;
  while (used.has(`custom_${n}`)) n++;
  return `custom_${n}`;
}

export function ruleIdError(rules: Rule[], id: string): string | null {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) return '代碼只能用小寫英文字母、數字與底線，並以字母開頭';
  return rules.some((r) => r.id === id) ? '代碼已存在' : null;
}

/** 依代碼取代規則，找不到時加在最後。 */
export function withRule(rules: Rule[], rule: Rule): Rule[] {
  return rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
}

/** 儲存前試算：與目前規則比較，現有公告與作業的命中變化。不寫入任何東西。 */
export function previewRule(ctx: CliContext, rule: Rule): string[] {
  return formatValidation(validateRules(ctx, stringifyRules(withRule(ctx.rules, rule)))).split('\n');
}

export function saveRule(ctx: CliContext, rule: Rule): void {
  reloadSettings(ctx);
  if (ctx.rulesWarning !== undefined) throw new CliExit(1, `規則檔無效，未儲存：${ctx.rulesWarning}`);
  if (rule.any.length + rule.all.length + rule.regex.length === 0) throw new CliExit(1, '至少要有一個關鍵詞');
  const text = stringifyRules(withRule(ctx.rules, rule));
  const parsed = parseRulesYaml(text);
  if (!parsed.ok) throw new CliExit(1, `規則無效：${parsed.error}`);
  writeSecureFile(rulesPath(ctx.root), text);
  reloadSettings(ctx);
}

/* ---------- 推送方式、介面 ---------- */

export function applyDelivery(ctx: CliContext, d: Config['delivery']): void {
  const command = d.hook.command.trim();
  const url = d.webhook.url.trim();
  if (d.hook.enabled && command === '') throw new CliExit(1, '請輸入指令');
  if (d.webhook.enabled) {
    const err = webhookUrlError(url);
    if (err !== null) throw new CliExit(1, err);
  }
  updateConfig(ctx, (cfg) => {
    cfg.delivery = { hook: { enabled: d.hook.enabled, command }, webhook: { enabled: d.webhook.enabled, url } };
  });
}

/** 終端機必備；網頁與桌面 app 尚未提供。 */
export function applyInterfaces(ctx: CliContext, folder: boolean): void {
  updateConfig(ctx, (cfg) => {
    cfg.interfaces = { terminal: true, folder, web: false, desktop: false };
  });
  renderFolderView(ctx, () => undefined);
}
