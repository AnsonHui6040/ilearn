import type { CliContext } from '../cli/context.js';
import { CliExit, reloadSettings, rulesPath } from '../cli/context.js';
import { saveConfig, type Config, type UpdateFrequency } from '../config/config.js';
import { writeSecureFile } from '../config/paths.js';
import { checkAgent } from '../events/outbox.js';
import { renderFolderView } from '../folder/folder.js';
import type { Rule } from '../rules/engine.js';
import { parseRulesYaml, stringifyRules } from '../rules/yaml.js';
import { parseIsoDuration } from '../time.js';
import { nextRuleId, parseKeywords, prune } from '../tui/actions.js';
import type { Delivery } from '../types.js';
import { appendAgentChanges } from './changes.js';

const ACTIONS: Delivery[] = ['record', 'push', 'force_push'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_OFFSET_MS = 60 * 86_400_000;
const MAX_LIST = 10;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_CHARS = 60;
const MAX_NAME_CHARS = 40;

export const PERMISSION_OFF =
  '使用者尚未允許 agent 修改設定，可在 ilearn setup 第 8 步或 ilearn ui 的「系統設定 > agent 權限」開啟';

/** 允許修改的項目，拒絕訊息與文件共用。 */
export const SETTABLE_KEYS = [
  'quiet_hours.start',
  'quiet_hours.end',
  'reminders.offsets',
  'force_push_offsets',
  'rules.<規則代碼>.enabled',
  'rules.<規則代碼>.action',
  'rules.<規則代碼>.keywords',
  'course_overrides.<課程 id>.rules.<規則代碼>.enabled',
  'course_overrides.<課程 id>.rules.<規則代碼>.action',
  'course_overrides.<課程 id>.reminders',
  'summaries.courses.<課程 id>.materials',
  'summaries.courses.<課程 id>.announcements',
  'summaries.daily_limit',
  'interfaces.folder',
  'updates.check',
] as const;

const REFUSALS: [RegExp, string][] = [
  [
    /^(agent_permissions|summaries\.agent_write)(\.|$)/,
    'agent 不能修改自己的權限，請使用者在 ilearn ui 的「系統設定 > agent 權限」或 ilearn setup 調整',
  ],
  [/^(account|username|password|password_saved|login|logout|credentials?|session|cookies?)(\.|$)/, '帳號、密碼與登入只能由使用者本人操作（ilearn login）'],
  [/^environment(\.|$)/, '執行環境只能由使用者本人在 ilearn setup 修改'],
  [/^delivery(\.|$)/, '推送方式（CLI Adapter 指令、webhook 網址與 secret）會讓程式執行指令或送出資料，只能由使用者本人修改'],
  [/^period_times(\.|$)/, '節次時間不開放 agent 修改'],
  [/^(service|setup|sync|reload|uninstall|reset|update)(\.|$)/, '背景服務、同步、更新、解除安裝與重設只能由使用者本人在終端機操作'],
  [/^updates\.(?!check$)/, '更新程式只能由使用者本人執行 ilearn update；agent 只能修改 updates.check（檢查頻率）'],
];

const unsupported = (key: string): CliExit =>
  new CliExit(1, `不支援修改「${key}」。agent 可以修改的項目：\n${SETTABLE_KEYS.map((k) => `- ${k}`).join('\n')}`);

export function refusalFor(key: string): string | null {
  return REFUSALS.find(([re]) => re.test(key))?.[1] ?? null;
}

/** 重新讀取設定後確認使用者已允許 agent 修改設定，並驗證 agent 名稱。 */
function requireSettings(ctx: CliContext, agent: string | undefined): string {
  reloadSettings(ctx);
  if (!ctx.config.agent_permissions.settings) throw new CliExit(1, PERMISSION_OFF);
  if (agent === undefined || agent === '') throw new CliExit(1, '請用 --agent 帶入你的 agent 名稱（英數、. _ -，最長 64 字元）');
  try {
    checkAgent(agent);
  } catch (e) {
    throw new CliExit(1, e instanceof Error ? e.message : '無效的 agent 名稱');
  }
  return agent;
}

function courseName(ctx: CliContext, id: string): string | null {
  const r = ctx.db.prepare('SELECT name FROM courses WHERE id = ?').get(id) as { name: string } | undefined;
  return r?.name ?? null;
}

function needCourse(ctx: CliContext, id: string): void {
  if (courseName(ctx, id) === null) throw new CliExit(1, `找不到課程 ${id}，課程 id 請用 ilearn courses --json 取得`);
}

function needRule(rules: Rule[], id: string): Rule {
  const r = rules.find((x) => x.id === id);
  if (!r) throw new CliExit(1, `找不到通知規則 ${id}，規則代碼請用 ilearn config get 取得`);
  return r;
}

function parseBool(v: string): boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new CliExit(1, `值必須是 true 或 false，收到「${v}」`);
}

function parseAction(v: string): Delivery {
  if (ACTIONS.includes(v as Delivery)) return v as Delivery;
  throw new CliExit(1, `推送等級只能是 ${ACTIONS.join('、')}，收到「${v}」`);
}

function parseTime(v: string): string {
  if (!TIME_RE.test(v)) throw new CliExit(1, `時間格式為 HH:mm（例如 07:00），收到「${v}」`);
  return v;
}

/** 以逗號分隔的 ISO 8601 時間長度，例如 P1D,PT3H；由大到小排序並去重。 */
function parseOffsets(v: string, allowEmpty: boolean): string[] {
  const items = [...new Set(v.split(/[,，]/).map((x) => x.trim()).filter((x) => x !== ''))];
  if (items.length === 0 && !allowEmpty) throw new CliExit(1, '至少要有一個時間長度，例如 P1D,PT3H');
  if (items.length > MAX_LIST) throw new CliExit(1, `最多 ${MAX_LIST} 個時間長度`);
  const ms = new Map<string, number>();
  for (const it of items) {
    let n: number;
    try {
      n = parseIsoDuration(it);
    } catch {
      throw new CliExit(1, `無效的時間長度「${it}」，格式如 P1D（1 日）、PT3H（3 小時）、PT30M（30 分鐘）`);
    }
    if (n <= 0 || n > MAX_OFFSET_MS) throw new CliExit(1, `時間長度「${it}」必須大於 0 且不超過 60 日`);
    ms.set(it, n);
  }
  return items.sort((a, b) => (ms.get(b) ?? 0) - (ms.get(a) ?? 0));
}

function parseKeywordList(v: string): string[] {
  const words = [...new Set(parseKeywords(v))];
  if (words.length > MAX_KEYWORDS) throw new CliExit(1, `關鍵詞最多 ${MAX_KEYWORDS} 個`);
  const long = words.find((w) => Array.from(w).length > MAX_KEYWORD_CHARS);
  if (long !== undefined) throw new CliExit(1, `關鍵詞太長（上限 ${MAX_KEYWORD_CHARS} 字）：${Array.from(long).slice(0, 20).join('')}`);
  return words;
}

function writeRulesChecked(ctx: CliContext, rules: Rule[]): void {
  const text = stringifyRules(rules);
  const parsed = parseRulesYaml(text);
  if (!parsed.ok) throw new CliExit(1, `規則無效，未儲存：${parsed.error}`);
  writeSecureFile(rulesPath(ctx.root), text);
}

function needValidRulesFile(ctx: CliContext): void {
  if (ctx.rulesWarning !== undefined) throw new CliExit(1, `規則檔無效，未套用任何變更：${ctx.rulesWarning}`);
}

export interface RuleView {
  id: string;
  name: string;
  keywords: string[];
  action: Delivery;
  enabled: boolean;
  courses?: string[];
}

export const ruleView = (r: Rule): RuleView => ({
  id: r.id,
  name: r.name,
  keywords: r.any,
  action: r.action,
  enabled: r.enabled,
  ...(r.scope === 'all' ? {} : { courses: r.scope }),
});

export interface ConfigView {
  agent_permissions: Config['agent_permissions'];
  settings: {
    quiet_hours: Config['quiet_hours'];
    reminders: Config['reminders'];
    force_push_offsets: string[];
    rules: RuleView[];
    course_overrides: Record<string, { name: string | null; reminders?: string[]; rules?: Record<string, { enabled?: boolean; action?: Delivery }> }>;
    summaries: {
      daily_limit: number;
      courses: Record<string, { name: string | null; materials: boolean; announcements: boolean }>;
    };
    interfaces: { folder: boolean };
    updates: { check: UpdateFrequency };
  };
}

/** 唯讀：目前的權限與 agent 可以修改的設定值。 */
export function configGet(ctx: CliContext): ConfigView {
  const c = ctx.config;
  return {
    agent_permissions: { ...c.agent_permissions },
    settings: {
      quiet_hours: { ...c.quiet_hours },
      reminders: { offsets: [...c.reminders.offsets] },
      force_push_offsets: [...c.force_push_offsets],
      rules: ctx.rules.map(ruleView),
      course_overrides: Object.fromEntries(
        Object.entries(c.course_overrides).map(([id, o]) => [id, { name: courseName(ctx, id), ...structuredClone(o) }]),
      ),
      summaries: {
        daily_limit: c.summaries.daily_limit,
        courses: Object.fromEntries(Object.entries(c.summaries.courses).map(([id, v]) => [id, { name: courseName(ctx, id), ...v }])),
      },
      interfaces: { folder: c.interfaces.folder },
      updates: { check: c.updates.check },
    },
  };
}

export interface SetResult {
  key: string;
  old: unknown;
  new: unknown;
}

interface Work {
  cfg: Config;
  rules: Rule[];
  rulesDirty: boolean;
}

function applyRuleKey(ctx: CliContext, w: Work, id: string, field: string, value: string): SetResult {
  needValidRulesFile(ctx);
  const rule = needRule(w.rules, id);
  let next: Rule;
  let old: unknown;
  let now: unknown;
  switch (field) {
    case 'enabled':
      old = rule.enabled;
      now = parseBool(value);
      next = { ...rule, enabled: now as boolean };
      break;
    case 'action':
      old = rule.action;
      now = parseAction(value);
      next = { ...rule, action: now as Delivery };
      break;
    case 'keywords': {
      const words = parseKeywordList(value);
      if (words.length + rule.all.length + rule.regex.length === 0) throw new CliExit(1, '至少要有一個關鍵詞');
      old = rule.any;
      now = words;
      next = { ...rule, any: words };
      break;
    }
    default:
      throw unsupported(`rules.${id}.${field}`);
  }
  w.rules = w.rules.map((r) => (r.id === id ? next : r));
  w.rulesDirty = true;
  return { key: `rules.${id}.${field}`, old, new: now };
}

function applyCourseOverride(ctx: CliContext, w: Work, parts: string[], value: string): SetResult {
  const [, courseId = '', sub = '', ruleId = '', field = ''] = parts;
  needCourse(ctx, courseId);
  const key = parts.join('.');
  const overrides = w.cfg.course_overrides;
  const clear = value === 'default';
  if (sub === 'reminders' && parts.length === 3) {
    const old = overrides[courseId]?.reminders ?? null;
    if (clear) {
      if (overrides[courseId] !== undefined) delete overrides[courseId].reminders;
      prune(overrides, courseId);
      return { key, old, new: null };
    }
    const offsets = parseOffsets(value, false);
    (overrides[courseId] ??= {}).reminders = offsets;
    return { key, old, new: offsets };
  }
  if (sub === 'rules' && parts.length === 5 && (field === 'enabled' || field === 'action')) {
    needValidRulesFile(ctx);
    needRule(w.rules, ruleId);
    const old = overrides[courseId]?.rules?.[ruleId]?.[field] ?? null;
    if (clear) {
      const o = overrides[courseId]?.rules?.[ruleId];
      if (o !== undefined) delete o[field];
      prune(overrides, courseId);
      return { key, old, new: null };
    }
    const o = (((overrides[courseId] ??= {}).rules ??= {})[ruleId] ??= {});
    if (field === 'enabled') {
      const now = parseBool(value);
      o.enabled = now;
      return { key, old, new: now };
    }
    const now = parseAction(value);
    o.action = now;
    return { key, old, new: now };
  }
  throw unsupported(key);
}

function applySummaryKey(ctx: CliContext, w: Work, parts: string[], value: string): SetResult {
  const key = parts.join('.');
  if (parts.length === 2 && parts[1] === 'daily_limit') {
    if (!/^\d{1,3}$/.test(value) || Number(value) > 200) throw new CliExit(1, `每日上限必須是 0 到 200 的整數，收到「${value}」`);
    const old = w.cfg.summaries.daily_limit;
    w.cfg.summaries.daily_limit = Number(value);
    return { key, old, new: Number(value) };
  }
  const [, group, courseId = '', field = ''] = parts;
  if (parts.length === 4 && group === 'courses' && (field === 'materials' || field === 'announcements')) {
    needCourse(ctx, courseId);
    const cur = w.cfg.summaries.courses[courseId] ?? { materials: false, announcements: false };
    const now = parseBool(value);
    const next = { ...cur, [field]: now };
    // 兩種摘要都關閉時不留空項目，與設定精靈、介面一致
    if (next.materials || next.announcements) w.cfg.summaries.courses[courseId] = next;
    else delete w.cfg.summaries.courses[courseId];
    return { key, old: cur[field], new: now };
  }
  throw unsupported(key);
}

function applyKey(ctx: CliContext, w: Work, key: string, value: string): SetResult {
  const parts = key.split('.');
  const [a, b] = parts;
  const c = w.cfg;
  if (a === 'quiet_hours' && parts.length === 2 && (b === 'start' || b === 'end')) {
    const old = c.quiet_hours[b];
    c.quiet_hours[b] = parseTime(value);
    return { key, old, new: c.quiet_hours[b] };
  }
  if (a === 'reminders' && parts.length === 2 && b === 'offsets') {
    const old = [...c.reminders.offsets];
    c.reminders.offsets = parseOffsets(value, false);
    return { key, old, new: c.reminders.offsets };
  }
  if (key === 'force_push_offsets') {
    const old = [...c.force_push_offsets];
    c.force_push_offsets = parseOffsets(value, true);
    return { key, old, new: c.force_push_offsets };
  }
  if (a === 'rules' && parts.length === 3) return applyRuleKey(ctx, w, parts[1] ?? '', parts[2] ?? '', value);
  if (a === 'course_overrides') return applyCourseOverride(ctx, w, parts, value);
  if (a === 'summaries') return applySummaryKey(ctx, w, parts, value);
  if (key === 'interfaces.folder') {
    const old = c.interfaces.folder;
    c.interfaces.folder = parseBool(value);
    return { key, old, new: c.interfaces.folder };
  }
  if (key === 'updates.check') {
    if (value !== 'daily' && value !== 'weekly' && value !== 'off') throw new CliExit(1, `檢查頻率只能是 daily、weekly 或 off，收到「${value}」`);
    const old = c.updates.check;
    c.updates.check = value;
    return { key, old, new: value };
  }
  throw unsupported(key);
}

function finish(ctx: CliContext, w: Work, agent: string, results: SetResult[]): void {
  if (w.rulesDirty) writeRulesChecked(ctx, w.rules);
  saveConfig(w.cfg, ctx.root);
  appendAgentChanges(ctx.root, ctx.now(), agent, results);
  reloadSettings(ctx);
  renderFolderView(ctx, () => undefined);
}

/** agent 修改單一設定；未被允許或不在白名單內的一律以 CliExit(1) 拒絕。 */
export function configSet(ctx: CliContext, o: { key: string; value: string; agent?: string | undefined }): SetResult {
  const agent = requireSettings(ctx, o.agent);
  const key = o.key.trim();
  const refused = refusalFor(key);
  if (refused !== null) throw new CliExit(1, refused);
  const w: Work = { cfg: structuredClone(ctx.config), rules: ctx.rules, rulesDirty: false };
  const r = applyKey(ctx, w, key, o.value.trim());
  finish(ctx, w, agent, [r]);
  return r;
}

export interface RuleAddInput {
  name: string;
  keywords: string;
  action: string;
  courses?: string | undefined;
  agent?: string | undefined;
}

/** agent 新增一條通知規則，代碼自動產生（custom_1、custom_2…）。 */
export function rulesAdd(ctx: CliContext, o: RuleAddInput): RuleView & { key: string } {
  const agent = requireSettings(ctx, o.agent);
  needValidRulesFile(ctx);
  const name = o.name.trim();
  // eslint-disable-next-line no-control-regex
  if (name === '' || /[\u0000-\u001F\u007F]/.test(name)) throw new CliExit(1, '規則名稱不可為空，也不可含控制字元');
  if (Array.from(name).length > MAX_NAME_CHARS) throw new CliExit(1, `規則名稱最長 ${MAX_NAME_CHARS} 字`);
  const keywords = parseKeywordList(o.keywords);
  if (keywords.length === 0) throw new CliExit(1, '至少要有一個關鍵詞');
  const action = parseAction(o.action.trim());
  let scope: Rule['scope'] = 'all';
  const ids = (o.courses ?? '').split(/[,，]/).map((x) => x.trim()).filter((x) => x !== '');
  if (ids.length > 0 && !ids.includes('all')) {
    for (const id of ids) needCourse(ctx, id);
    scope = [...new Set(ids)];
  }
  const rule: Rule = {
    id: nextRuleId(ctx.rules),
    name,
    enabled: true,
    scope,
    fields: ['title', 'body'],
    any: keywords,
    all: [],
    none: [],
    regex: [],
    action,
  };
  const w: Work = { cfg: structuredClone(ctx.config), rules: [...ctx.rules, rule], rulesDirty: true };
  const view = ruleView(rule);
  finish(ctx, w, agent, [{ key: `rules.${rule.id}`, old: null, new: view }]);
  return { key: `rules.${rule.id}`, ...view };
}
