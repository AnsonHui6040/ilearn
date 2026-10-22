import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, classify, dryRun } from '../src/rules/engine.js';
import { parseRulesYaml, stringifyRules } from '../src/rules/yaml.js';

const doc = (title: string, body = '', course_id = '1') => ({
  course_id,
  title,
  body,
  course_info_diff: '',
});

describe('DEFAULT_RULES', () => {
  it('has the 13 built-in rules with unique ids', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toEqual([
      'exam', 'deadline', 'deadline_change', 'class_cancel', 'room_change',
      'online_class', 'presentation', 'attendance', 'syllabus_change',
      'grade_release', 'event', 'material', 'survey',
    ]);
    expect(new Set(ids).size).toBe(13);
  });
});

describe('classify', () => {
  it('room change is push', () => {
    const r = classify(DEFAULT_RULES, doc('下週起改至 M201 上課'));
    expect(r.matched_rules).toContain('room_change');
    expect(r.categories).toContain('room_change');
    expect(r.delivery).toBe('push');
  });

  it('exam exclusion words keep grade announcements as record', () => {
    const r = classify(DEFAULT_RULES, doc('上次考試成績已公布'));
    expect(r.matched_rules).toContain('grade_release');
    expect(r.matched_rules).not.toContain('exam');
    expect(r.delivery).toBe('record');
  });

  it('matches exam', () => {
    expect(classify(DEFAULT_RULES, doc('期中考 11/5 舉行')).matched_rules).toContain('exam');
  });

  it('is case insensitive', () => {
    expect(classify(DEFAULT_RULES, doc('Midterm EXAM next week')).matched_rules).toContain('exam');
  });

  it('push wins over record', () => {
    const r = classify(DEFAULT_RULES, doc('期中考講義已上傳'));
    expect(r.matched_rules).toEqual(expect.arrayContaining(['exam', 'material']));
    expect(r.delivery).toBe('push');
  });

  it('force_push wins over push', () => {
    const rules = DEFAULT_RULES.map((r) =>
      r.id === 'exam' ? { ...r, action: 'force_push' as const } : r,
    );
    expect(classify(rules, doc('期中考講義已上傳')).delivery).toBe('force_push');
  });

  it('no match is general/record', () => {
    expect(classify(DEFAULT_RULES, doc('哈囉'))).toEqual({
      categories: ['general'],
      matched_rules: [],
      delivery: 'record',
    });
  });

  it('override can disable a rule', () => {
    const r = classify(DEFAULT_RULES, doc('下週起改至 M201 上課'), {
      room_change: { enabled: false },
    });
    expect(r.matched_rules).not.toContain('room_change');
  });

  it('override can change action', () => {
    const r = classify(DEFAULT_RULES, doc('下週起改至 M201 上課'), {
      room_change: { action: 'force_push' },
    });
    expect(r.delivery).toBe('force_push');
  });

  it('scope restricts to listed courses', () => {
    const rules = DEFAULT_RULES.map((r) =>
      r.id === 'room_change' ? { ...r, scope: ['999'] } : r,
    );
    expect(classify(rules, doc('改至 M201', '', '1')).matched_rules).not.toContain('room_change');
    expect(classify(rules, doc('改至 M201', '', '999')).matched_rules).toContain('room_change');
  });

  it('supports all and regex', () => {
    const base = DEFAULT_RULES[0]!;
    const rules = [
      { ...base, id: 'a', any: [], all: ['甲', '乙'], none: [], regex: [] },
      { ...base, id: 'r', any: [], all: [], none: [], regex: ['第\\d+週'] },
    ];
    expect(classify(rules, doc('甲 乙')).matched_rules).toEqual(['a']);
    expect(classify(rules, doc('甲')).matched_rules).toEqual([]);
    expect(classify(rules, doc('第12週')).matched_rules).toEqual(['r']);
  });

  it('reads course_info_diff only if listed in fields', () => {
    const d = { course_id: '1', title: '', body: '', course_info_diff: '教室異動' };
    expect(classify(DEFAULT_RULES, d).matched_rules).toContain('room_change');
    expect(classify(DEFAULT_RULES, { ...d, course_info_diff: '考試' }).matched_rules).not.toContain('exam');
  });
});

describe('dryRun', () => {
  it('reports announcements no longer matched', () => {
    const newRules = DEFAULT_RULES.map((r) =>
      r.id === 'room_change' ? { ...r, enabled: false } : r,
    );
    const docs = [{ ...doc('下週起改至 M201 上課'), id: 'a1' }];
    const res = dryRun(DEFAULT_RULES, newRules, docs);
    expect(res.noLongerMatched).toEqual([
      { id: 'a1', title: '下週起改至 M201 上課', rules: ['room_change'] },
    ]);
    expect(res.newlyMatched).toEqual([]);
  });

  it('honours per-course overrides so the result matches classify', () => {
    const oldRules = DEFAULT_RULES.map((r) =>
      r.id === 'room_change' ? { ...r, enabled: false } : r,
    );
    const docs = [
      { ...doc('改至 M201', '', '1'), id: 'c1' },
      { ...doc('改至 M201', '', '2'), id: 'c2' },
    ];
    const overridesFor = (courseId: string) =>
      courseId === '1' ? { room_change: { enabled: false } } : undefined;
    const res = dryRun(oldRules, DEFAULT_RULES, docs, overridesFor);
    expect(res.newlyMatched.map((e) => e.id)).toEqual(['c2']);
    expect(res.noLongerMatched).toEqual([]);
    expect(classify(DEFAULT_RULES, docs[0]!, overridesFor('1')).matched_rules).not.toContain('room_change');
    expect(classify(DEFAULT_RULES, docs[1]!, overridesFor('2')).matched_rules).toContain('room_change');
  });

  it('reports newly matched', () => {
    const res = dryRun(
      DEFAULT_RULES.map((r) => (r.id === 'room_change' ? { ...r, enabled: false } : r)),
      DEFAULT_RULES,
      [{ ...doc('改至 M201'), id: 'a1' }],
    );
    expect(res.newlyMatched[0]?.rules).toEqual(['room_change']);
  });
});

describe('yaml', () => {
  it('round-trips defaults', () => {
    const parsed = parseRulesYaml(stringifyRules(DEFAULT_RULES));
    expect(parsed).toEqual({ ok: true, rules: DEFAULT_RULES });
  });

  it('fills defaults for omitted fields', () => {
    const p = parseRulesYaml('- id: x\n  name: X\n  action: record\n  any: [foo]\n');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.rules[0]).toMatchObject({
        enabled: true, scope: 'all', fields: ['title', 'body'], all: [], none: [], regex: [],
      });
    }
  });

  it('rejects invalid regex with line', () => {
    const p = parseRulesYaml('- id: x\n  name: X\n  action: push\n  regex: ["("]\n');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.line).toBe(4);
  });

  it('rejects unknown action with line', () => {
    const p = parseRulesYaml('- id: x\n  name: X\n  action: shout\n  any: [a]\n');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error).toContain('shout');
      expect(p.line).toBe(3);
    }
  });

  it('rejects duplicate ids, bad fields, bad scope, non-list, syntax errors', () => {
    const dup = '- {id: x, name: X, action: push, any: [a]}\n- {id: x, name: Y, action: push, any: [b]}\n';
    const d = parseRulesYaml(dup);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.line).toBe(2);
    expect(parseRulesYaml('- {id: x, name: X, action: push, fields: [nope]}').ok).toBe(false);
    expect(parseRulesYaml('- {id: x, name: X, action: push, scope: 5}').ok).toBe(false);
    expect(parseRulesYaml('foo: 1').ok).toBe(false);
    const s = parseRulesYaml('- id: [unclosed\n');
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.line).not.toBeNull();
  });

  it('accepts scope as course id list (numbers become strings)', () => {
    const p = parseRulesYaml('- {id: x, name: X, action: push, any: [a], scope: [123, "456"]}');
    expect(p.ok && p.rules[0]?.scope).toEqual(['123', '456']);
  });
});
