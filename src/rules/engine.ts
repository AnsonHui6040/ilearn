import type { Delivery } from '../types.js';
import { DEFAULT_RULES, type Rule } from './defaults.js';

export { DEFAULT_RULES };
export type { Rule, RuleField } from './defaults.js';

export interface Classifiable {
  course_id: string;
  title: string;
  body: string;
  course_info_diff: string;
}

export type RuleOverrides = Record<string, { enabled?: boolean; action?: Delivery }>;

export interface Classification {
  categories: string[];
  matched_rules: string[];
  delivery: Delivery;
}

const RANK: Record<Delivery, number> = { record: 0, push: 1, force_push: 2 };

function regexHit(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'iu').test(text);
  } catch {
    return false; // invalid regex never matches; parseRulesYaml rejects these on save
  }
}

function ruleMatches(rule: Rule, doc: Classifiable): boolean {
  if (rule.any.length + rule.all.length + rule.regex.length === 0) return false;
  const text = rule.fields.map((f) => doc[f]).join('\n');
  const lower = text.toLowerCase();
  const has = (kw: string): boolean => lower.includes(kw.toLowerCase());

  const anyOk =
    (rule.any.length === 0 && rule.regex.length === 0) ||
    rule.any.some(has) ||
    rule.regex.some((p) => regexHit(p, text));
  return anyOk && rule.all.every(has) && !rule.none.some(has);
}

export function classify(rules: Rule[], doc: Classifiable, overrides: RuleOverrides = {}): Classification {
  const matched: { id: string; action: Delivery }[] = [];
  for (const rule of rules) {
    const o = overrides[rule.id];
    if (!(o?.enabled ?? rule.enabled)) continue;
    if (rule.scope !== 'all' && !rule.scope.includes(doc.course_id)) continue;
    if (!ruleMatches(rule, doc)) continue;
    matched.push({ id: rule.id, action: o?.action ?? rule.action });
  }
  if (matched.length === 0) return { categories: ['general'], matched_rules: [], delivery: 'record' };
  const ids = matched.map((m) => m.id);
  const delivery = matched.reduce<Delivery>((best, m) => (RANK[m.action] > RANK[best] ? m.action : best), 'record');
  return { categories: ids, matched_rules: ids, delivery };
}

type DryRunDoc = Classifiable & { id: string; title: string };
type DryRunEntry = { id: string; title: string; rules: string[] };

export function dryRun(
  oldRules: Rule[],
  newRules: Rule[],
  docs: DryRunDoc[],
  overridesFor?: (courseId: string) => RuleOverrides | undefined,
): { newlyMatched: DryRunEntry[]; noLongerMatched: DryRunEntry[] } {
  const newlyMatched: DryRunEntry[] = [];
  const noLongerMatched: DryRunEntry[] = [];
  for (const d of docs) {
    const overrides = overridesFor?.(d.course_id);
    const before = new Set(classify(oldRules, d, overrides).matched_rules);
    const after = new Set(classify(newRules, d, overrides).matched_rules);
    const gained = [...after].filter((r) => !before.has(r));
    const lost = [...before].filter((r) => !after.has(r));
    if (gained.length) newlyMatched.push({ id: d.id, title: d.title, rules: gained });
    if (lost.length) noLongerMatched.push({ id: d.id, title: d.title, rules: lost });
  }
  return { newlyMatched, noLongerMatched };
}
