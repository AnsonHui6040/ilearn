import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeSecureFile } from '../../config/paths.js';
import { listItems } from '../../db/repo.js';
import { DEFAULT_RULES, dryRun, type Rule } from '../../rules/engine.js';
import { parseRulesYaml, stringifyRules } from '../../rules/yaml.js';
import { CliExit, rulesPath, type CliContext } from '../context.js';

export type Preview = { newlyMatched: PreviewEntry[]; noLongerMatched: PreviewEntry[] };
interface PreviewEntry {
  id: string;
  title: string;
  rules: string[];
}

export type Validation =
  | { ok: true; rules: Rule[]; preview: Preview }
  | { ok: false; error: string; line: number | null };

export function currentRulesText(ctx: CliContext): string {
  const p = rulesPath(ctx.root);
  return existsSync(p) ? readFileSync(p, 'utf8') : stringifyRules(DEFAULT_RULES);
}

/** 驗證規則文字並以資料庫中的公告及作業試算與目前生效規則的差異。 */
export function validateRules(ctx: CliContext, text: string): Validation {
  const parsed = parseRulesYaml(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, line: parsed.line };
  const docs = [...listItems(ctx.db, { kind: 'announcement' }), ...listItems(ctx.db, { kind: 'assignment' })].map((i) => ({
    id: i.id,
    title: i.title,
    course_id: i.course_id,
    body: i.body ?? '',
    course_info_diff: '',
  }));
  const preview = dryRun(ctx.rules, parsed.rules, docs, (cid) => ctx.config.course_overrides[cid]?.rules);
  return { ok: true, rules: parsed.rules, preview };
}

export function rulesListCommand(ctx: CliContext) {
  return ctx.rules.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    action: r.action,
    scope: r.scope,
    fields: r.fields,
  }));
}

/** 試算：指定檔案（預設 rules.yaml）與目前生效規則的差異，不寫入任何東西。 */
export function rulesTestCommand(ctx: CliContext, file?: string): Validation {
  const path = file ?? rulesPath(ctx.root);
  if (!existsSync(path)) throw new CliExit(1, `找不到規則檔 ${path}`);
  return validateRules(ctx, readFileSync(path, 'utf8'));
}

export function formatValidation(v: Validation): string {
  if (!v.ok) return `規則無效${v.line !== null ? `（第 ${v.line} 行）` : ''}：${v.error}`;
  const lines = [`規則有效，共 ${v.rules.length} 條`];
  for (const e of v.preview.newlyMatched) lines.push(`新增命中：${e.title}（${e.rules.join('、')}）`);
  for (const e of v.preview.noLongerMatched) lines.push(`不再命中：${e.title}（${e.rules.join('、')}）`);
  if (v.preview.newlyMatched.length + v.preview.noLongerMatched.length === 0) lines.push('與目前規則比較，現有資料的命中結果沒有變化');
  return lines.join('\n');
}

function defaultEditor(path: string): void {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const r = spawnSync(`${editor} ${JSON.stringify(path)}`, { stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new CliExit(1, `編輯器異常結束（${editor}）`);
}

export interface EditDeps {
  editor?: (path: string) => void;
  /** 顯示試算結果後詢問是否儲存。 */
  confirm: (preview: string) => Promise<boolean>;
  /** 規則無效時詢問是否重新編輯。 */
  retry: (message: string) => Promise<boolean>;
}

/** 以編輯器修改規則；無效時拒絕儲存並顯示行數，有效時先顯示試算再確認。 */
export async function rulesEditCommand(ctx: CliContext, deps: EditDeps): Promise<{ saved: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'ilearn-rules-'));
  const tmp = join(dir, 'rules.yaml');
  try {
    writeFileSync(tmp, currentRulesText(ctx), { mode: 0o600 });
    for (;;) {
      (deps.editor ?? defaultEditor)(tmp);
      const text = readFileSync(tmp, 'utf8');
      const v = validateRules(ctx, text);
      if (!v.ok) {
        if (await deps.retry(formatValidation(v))) continue;
        return { saved: false };
      }
      if (!(await deps.confirm(formatValidation(v)))) return { saved: false };
      writeSecureFile(rulesPath(ctx.root), text);
      ctx.rules = v.rules;
      return { saved: true };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
