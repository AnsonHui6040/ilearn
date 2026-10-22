import { LineCounter, isMap, isSeq, parseDocument, stringify, type Node } from 'yaml';
import type { Delivery } from '../types.js';
import type { Rule, RuleField } from './defaults.js';

const ACTIONS: Delivery[] = ['force_push', 'push', 'record'];
const FIELDS: RuleField[] = ['title', 'body', 'course_info_diff'];
const LIST_KEYS = ['any', 'all', 'none', 'regex'] as const;

type ParseResult = { ok: true; rules: Rule[] } | { ok: false; error: string; line: number | null };

class RuleError extends Error {
  constructor(
    message: string,
    readonly node: unknown,
  ) {
    super(message);
  }
}

export function parseRulesYaml(text: string): ParseResult {
  const lc = new LineCounter();
  const lineOf = (node: unknown): number | null => {
    const range = (node as Node | null | undefined)?.range;
    return range ? lc.linePos(range[0]).line : null;
  };
  const doc = parseDocument(text, { lineCounter: lc });
  const err = doc.errors[0];
  if (err) return { ok: false, error: `YAML 語法錯誤：${err.message}`, line: err.linePos?.[0].line ?? null };

  try {
    const root = doc.contents;
    if (!isSeq(root)) throw new RuleError('規則檔最外層必須是清單', root);
    const seen = new Set<string>();
    const rules = root.items.map((item) => parseRule(item, seen));
    return { ok: true, rules };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, error: e.message, line: lineOf(e.node) };
    throw e;
  }
}

function parseRule(item: unknown, seen: Set<string>): Rule {
  if (!isMap(item)) throw new RuleError('每條規則必須是物件', item);
  const nodeOf = (key: string): unknown => item.get(key, true) ?? item;
  const get = (key: string): unknown => item.toJSON()[key];

  const str = (key: string, required: boolean): string => {
    const v = get(key);
    if (v === undefined || v === null) {
      if (required) throw new RuleError(`缺少必要欄位 ${key}`, item);
      return '';
    }
    if (typeof v !== 'string' || v.trim() === '') throw new RuleError(`${key} 必須是非空字串`, nodeOf(key));
    return v;
  };

  const id = str('id', true);
  if (seen.has(id)) throw new RuleError(`規則 id 重複：${id}`, nodeOf('id'));
  seen.add(id);
  const name = get('name') === undefined ? id : str('name', false);

  const action = get('action');
  if (typeof action !== 'string' || !ACTIONS.includes(action as Delivery)) {
    throw new RuleError(`未知的 action：${String(action)}（可用：${ACTIONS.join('、')}）`, nodeOf('action'));
  }

  const enabled = get('enabled') ?? true;
  if (typeof enabled !== 'boolean') throw new RuleError('enabled 必須是 true 或 false', nodeOf('enabled'));

  const rawScope = get('scope') ?? 'all';
  let scope: Rule['scope'];
  if (rawScope === 'all') scope = 'all';
  else if (
    Array.isArray(rawScope) &&
    rawScope.every((s) => typeof s === 'string' || typeof s === 'number')
  ) {
    scope = rawScope.map(String);
  } else throw new RuleError('scope 必須是 all 或課程 ID 清單', nodeOf('scope'));

  const rawFields = get('fields') ?? ['title', 'body'];
  if (
    !Array.isArray(rawFields) ||
    rawFields.length === 0 ||
    !rawFields.every((f) => FIELDS.includes(f as RuleField))
  ) {
    throw new RuleError(`fields 只可包含：${FIELDS.join('、')}`, nodeOf('fields'));
  }

  const lists = {} as Record<(typeof LIST_KEYS)[number], string[]>;
  for (const key of LIST_KEYS) {
    const v = get(key) ?? [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' || typeof s === 'number')) {
      throw new RuleError(`${key} 必須是字串清單`, nodeOf(key));
    }
    lists[key] = v.map(String);
  }
  for (const pattern of lists.regex) {
    try {
      new RegExp(pattern, 'iu');
    } catch (e) {
      throw new RuleError(`無效的正規表示式 ${pattern}：${(e as Error).message}`, nodeOf('regex'));
    }
  }

  return {
    id,
    name,
    enabled,
    scope,
    fields: rawFields as RuleField[],
    any: lists.any,
    all: lists.all,
    none: lists.none,
    regex: lists.regex,
    action: action as Delivery,
  };
}

export function stringifyRules(rules: Rule[]): string {
  return stringify(rules, { lineWidth: 0 });
}
