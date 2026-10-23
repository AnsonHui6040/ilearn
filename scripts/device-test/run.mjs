#!/usr/bin/env node
// 裝置測試：在全新的暫存資料夾裡，用真實的 dist/ 程式跑完「真機測試步驟」能自動化的部分。
// 用法：node scripts/device-test/run.mjs [--mock] [--interactive] [--keep]
// 帳密來自環境變數 ILEARN_TEST_USERNAME 與 ILEARN_TEST_PASSWORD，由 macos.sh、linux.sh、windows.ps1 帶入。

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const INTERACTIVE = args.has('--interactive');
const KEEP = args.has('--keep');

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const dist = join(repo, 'dist');
const logsDir = join(here, 'logs');

/* ---------- 時間與檔名 ---------- */

/** 台北時間（+08:00）的 ISO 字串片段，不依賴電腦時區。 */
function taipei(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString();
}
const stampLine = () => `${taipei().slice(0, 19).replace('T', ' ')}+08:00`;
const startedAt = new Date();
const fileStamp = taipei(startedAt).slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const platformName = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;
const reportFile = join(logsDir, `report-${platformName}-${fileStamp}.md`);
const logFile = join(logsDir, `run-${platformName}-${fileStamp}.log`);

/* ---------- 遮蔽：學號、密碼、cookie、token 一律換成 *** ---------- */

const secrets = new Set();
function addSecret(s) {
  if (typeof s === 'string' && s.length >= 3) secrets.add(s);
}
function redact(input) {
  let t = String(input);
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) t = t.split(s).join('***');
  t = t
    .replace(/((?:Set-)?Cookie\s*:)[^\n]*/gi, '$1 ***')
    .replace(/\b([\w-]*(?:session|token|cookie)[\w-]*)\s*([=:])\s*[^\s;,]+/gi, '$1$2***')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
    .replace(/[A-Za-z0-9_-]{48,}/g, '***');
  return t;
}

/* ---------- 輸出：全部經過遮蔽；setup 執行期間改為攔截 ---------- */

let capture = null;
for (const stream of [process.stdout, process.stderr]) {
  const real = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (capture !== null) {
      capture.push(s);
      const cb = rest.find((x) => typeof x === 'function');
      if (cb) cb();
      return true;
    }
    return real(redact(s), ...rest);
  };
}

let logReady = false;
function logLine(text) {
  if (!logReady) return;
  const lines = redact(text).split(/\r?\n/);
  appendFileSync(logFile, lines.map((l) => `[${stampLine()}] ${l}\n`).join(''));
}
function say(text = '') {
  process.stdout.write(`${text}\n`);
  logLine(text);
}
function logError(label, e) {
  const detail = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
  logLine(`ERROR ${label}\n${detail}`);
}

/* ---------- 結果記錄 ---------- */

const results = [];
let currentStep = '0';
function record(name, status, reason = '') {
  results.push({ step: currentStep, name, status, reason });
  process.stdout.write(`  ${status.padEnd(4)}  ${name}${reason ? `：${reason}` : ''}\n`);
  logLine(`CHECK step=${currentStep} ${status} ${name}${reason ? ` | ${reason}` : ''}`);
}
const pass = (name, reason) => record(name, 'PASS', reason);
const fail = (name, reason) => record(name, 'FAIL', reason);
const skip = (name, reason) => record(name, 'SKIP', reason);
const check = (name, ok, reasonFail, reasonPass = '') => (ok ? pass(name, reasonPass) : fail(name, reasonFail));

async function step(n, title, fn) {
  currentStep = String(n);
  const t0 = Date.now();
  say(`\n== 步驟 ${n}：${title} ==`);
  logLine(`STEP ${n} START ${title}`);
  try {
    await fn();
  } catch (e) {
    logError(`步驟 ${n}`, e);
    fail('步驟執行中發生錯誤', e instanceof Error ? e.message : String(e));
  }
  logLine(`STEP ${n} END ${title} (${Date.now() - t0} ms)`);
}

/* ---------- 小工具 ---------- */

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const under = (p, base) => {
  const r = relative(base, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};
const same = (a, b) => {
  const x = real(a);
  const y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const readText = (p) => readFileSync(p, 'utf8');
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const mod = (rel) => import(pathToFileURL(join(dist, rel)).href);
/** 預期呼叫被拒絕（CliExit 且 exit code 1）；回傳訊息，沒被拒絕回傳 null。 */
function refused(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    if (e && e.name === 'CliExit' && e.code === 1) return e.message;
    throw e;
  }
}
function compactCapture(chunks) {
  const lines = chunks.join('').split(/[\r\n]+/);
  const out = [];
  for (const l of lines) {
    if (l.trim() === '') continue;
    const progress = /^課程 \d+\/\d+，檔案/.test(l);
    if (progress && out.length > 0 && /^課程 \d+\/\d+，檔案/.test(out[out.length - 1])) out[out.length - 1] = l;
    else out.push(l);
  }
  return out;
}

/* ---------- 帳密 ---------- */

/** 讀取帳密時做過的修正（只記錄類型，不含內容），登入失敗時提示用。 */
const credNotes = [];

/** credentials.local 優先（三個平台同一套解析）；沒有檔案才用環境變數。 */
function credentialSource() {
  const file = join(here, 'credentials.local');
  if (!existsSync(file)) {
    return { username: process.env.ILEARN_TEST_USERNAME ?? '', password: process.env.ILEARN_TEST_PASSWORD ?? '' };
  }
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('{\\rtf')) {
    process.stderr.write(
      'credentials.local 被存成 RTF 格式（TextEdit 預設）。請改用 nano scripts/device-test/credentials.local 編輯，或在 TextEdit 選「格式 > 製作純文字」後再存檔。\n',
    );
    process.exit(1);
  }
  const out = { username: '', password: '' };
  for (const line of text.split(/\r?\n|\r/)) {
    const m = /^\s*(ILEARN_TEST_USERNAME|ILEARN_TEST_PASSWORD)\s*=(.*)$/.exec(line);
    if (m === null) continue;
    if (m[1] === 'ILEARN_TEST_USERNAME') out.username = m[2];
    else out.password = m[2];
  }
  return out;
}

const QUOTES = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」']];

/** 去掉換行字元、前後空白與成對的引號；回傳值與做過的修正。 */
function cleanValue(v, isUsername) {
  const notes = [];
  let s = v.replace(/[\r\n]/g, '');
  const trimmed = s.trim();
  if (trimmed !== s) notes.push('前後有空白，已去掉');
  s = trimmed;
  for (const [a, b] of QUOTES) {
    if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) {
      s = s.slice(a.length, s.length - b.length);
      notes.push('有引號，已去掉');
      break;
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(s)) notes.push(isUsername ? '含非英數字元' : '含全形或特殊字元（文字編輯器可能把引號或連字號自動換成全形）');
  return { value: s, notes };
}

async function readCredentials() {
  if (MOCK) {
    const m = await import(pathToFileURL(join(here, 'mock-api.mjs')).href);
    return { username: m.MOCK_USERNAME, password: m.MOCK_PASSWORD };
  }
  const raw = credentialSource();
  const u = cleanValue(raw.username, true);
  const pw = cleanValue(raw.password, false);
  credNotes.push(...u.notes.map((n) => `學號${n}`), ...pw.notes.map((n) => `密碼${n}`));
  const username = u.value;
  let password = pw.value;
  if (username === '') {
    process.stderr.write('尚未填寫學號：請編輯 scripts/device-test/credentials.local，填入 ILEARN_TEST_USERNAME。\n');
    process.exit(1);
  }
  if (password === '') {
    if (!process.stdin.isTTY) {
      process.stderr.write('沒有填寫密碼，而且目前不是互動終端機：請在 credentials.local 填入 ILEARN_TEST_PASSWORD。\n');
      process.exit(1);
    }
    const { password: askPassword } = await import('@inquirer/prompts');
    password = await askPassword({ message: 'iLearn 密碼（輸入時以 * 顯示，不會保存）', mask: '*' });
  }
  return { username, password };
}

/* ---------- 腳本化的提問 ---------- */

function makePrompts(creds, selects) {
  const asked = [];
  const unexpected = (type, message) => Promise.reject(new Error(`未預期的提問（${type}）：${message}`));
  const ctrlC = () => Promise.reject(Object.assign(new Error('User force closed the prompt with SIGINT'), { name: 'ExitPromptError' }));
  const p = {
    select: (o) => {
      asked.push({ type: 'select', message: o.message });
      if (o.message === '設定是否正確') {
        const v = selects.shift();
        return v === 'CTRL_C' ? ctrlC() : Promise.resolve(v ?? 0);
      }
      if (o.message === '目前的執行環境') return Promise.resolve('desktop');
      return unexpected('select', o.message);
    },
    input: (o) => {
      asked.push({ type: 'input', message: o.message });
      return o.message === '學號' ? Promise.resolve(creds.username) : unexpected('input', o.message);
    },
    password: (o) => {
      asked.push({ type: 'password', message: o.message });
      return Promise.resolve(creds.password);
    },
    confirm: (o) => {
      asked.push({ type: 'confirm', message: o.message });
      if (o.message.startsWith('要保存密碼') || o.message.startsWith('要安裝背景服務') || o.message.startsWith('要重新輸入嗎')) {
        return Promise.resolve(false);
      }
      return unexpected('confirm', o.message);
    },
    checkbox: (o) => {
      asked.push({ type: 'checkbox', message: o.message });
      const m = o.message;
      if (m === '要啟用的介面') return Promise.resolve(['terminal', 'folder']);
      if (m === '推送方式') return Promise.resolve(['outbox']);
      if (m.startsWith('通知規則')) return Promise.resolve(o.choices.filter((c) => c.checked).map((c) => c.value));
      if (m.includes('教材檔案摘要') || m.includes('老師公告摘要')) return Promise.resolve(o.choices.length ? [o.choices[0].value] : []);
      if (m === '允許 agent：') return Promise.resolve(['summaries', 'settings']);
      return unexpected('checkbox', m);
    },
  };
  return { p, asked };
}

/* ---------- 主流程 ---------- */

async function main() {
  const creds = await readCredentials();
  addSecret(creds.username);
  addSecret(creds.password);

  mkdirSync(logsDir, { recursive: true });
  writeFileSync(logFile, '');
  logReady = true;
  logLine(`裝置測試開始 平台=${process.platform} ${release()} Node=${process.version} 模式=${MOCK ? 'mock' : '實際連線'} interactive=${INTERACTIVE} keep=${KEEP}`);

  const state = { aborted: false, root: '', ctxs: [], mods: {} };
  const manual = [];
  let svcBefore = null;
  const simpleService = (s) => ({ installed: s.installed, method: s.method, detail: s.detail });

  /* 0 安全檢查 */
  await step(0, '安全檢查', async () => {
    const realRoot = join(homedir(), '.thu-ilearn');
    const tmpBase = real(tmpdir());
    const preset = process.env.ILEARN_HOME;
    if (preset !== undefined && preset !== '' && (!under(real(preset), tmpBase) || same(preset, realRoot))) {
      fail('ILEARN_HOME 已指向非暫存路徑', '為避免動到正式資料，拒絕執行；請清除 ILEARN_HOME 後重跑');
      state.aborted = true;
      return;
    }
    const root = mkdtempSync(join(tmpBase, `thu-ilearn-device-test-${fileStamp.replace('-', '')}-`));
    state.root = root;
    if (same(root, realRoot) || !under(real(root), tmpBase)) {
      fail('測試資料夾不在暫存目錄', '拒絕執行');
      state.aborted = true;
      return;
    }
    const sample = redact(`u=${creds.username} p=${creds.password} Cookie: a=b; sessionid=xyz token=abc`);
    check('學號、密碼、cookie 與 token 會被遮蔽', !sample.includes(creds.username) && !sample.includes(creds.password) &&
      !sample.includes('xyz') && !sample.includes('abc') && sample.includes('***'), '遮蔽功能異常');
    check('測試資料夾是全新的空暫存資料夾', readdirSync(root).length === 0, '資料夾不是空的');
    process.env.ILEARN_HOME = root;
    if (!existsSync(join(dist, 'cli', 'context.js'))) {
      fail('找不到 dist/', '請先執行 npm run build');
      state.aborted = true;
      return;
    }
    const m = state.mods;
    m.context = await mod('cli/context.js');
    m.setup = await mod('cli/setup.js');
    m.query = await mod('cli/commands/query.js');
    m.config = await mod('config/config.js');
    m.settings = await mod('agent/settings.js');
    m.summaries = await mod('summaries/summaries.js');
    m.folder = await mod('folder/folder.js');
    m.tuiData = await mod('tui/data.js');
    m.pages = await mod('tui/pages.js');
    m.tuiState = await mod('tui/state.js');
    m.repo = await mod('db/repo.js');
    m.files = await mod('sync/files.js');
    m.service = await mod('service/service.js');
    check('dataRoot 指向暫存資料夾', same((await mod('config/paths.js')).dataRoot(), root), 'dataRoot 沒有指向暫存資料夾');
    try {
      svcBefore = JSON.stringify(simpleService(m.service.serviceStatus(m.service.defaultServiceDeps())));
      pass('已記錄背景服務狀態（唯讀）', JSON.parse(svcBefore).detail);
    } catch (e) {
      logError('讀取背景服務狀態', e);
      skip('已記錄背景服務狀態', '無法讀取，結尾不比對');
    }
    pass('不安裝、不移除背景服務，不保存密碼', '腳本沒有呼叫這類功能');
  });

  /* 先登入一次確認帳密；失敗就停止，不讓後面的步驟連帶失敗，也避免重複嘗試登入 */
  if (!MOCK && !state.aborted) {
    await step('0.5', '登入檢查', async () => {
      const { createHttp } = await mod('ilearn/http.js');
      const { login } = await mod('ilearn/auth.js');
      try {
        await login(createHttp({}), creds.username, creds.password);
        pass('iLearn 登入成功');
      } catch (e) {
        logError('登入檢查', e);
        const hints = credNotes.length ? `；讀取帳密時：${credNotes.join('、')}` : '';
        fail('iLearn 登入', `${e instanceof Error ? e.message : String(e)}${hints}`);
        say('  請確認 credentials.local：一行一個，等號後直接寫值，不加引號或空白；建議用 nano 編輯。');
        say('  也可以把 ILEARN_TEST_PASSWORD 留空，執行時再輸入密碼。先用同一組帳密在瀏覽器登入 iLearn 確認可以登入。');
        state.aborted = true;
        state.abortReason = '登入失敗';
      }
    });
  }

  const notReady = (why) => (state.aborted ? (state.abortReason ?? '安全檢查未通過') : why);
  let ctx = null;
  const mockAuthFor = async () => {
    const { writeAccount, readAccount } = state.mods.context;
    const mockApi = await import(pathToFileURL(join(here, 'mock-api.mjs')).href);
    return {
      login: (c, username, password) => {
        if (username !== mockApi.MOCK_USERNAME || password !== mockApi.MOCK_PASSWORD) return Promise.reject(new Error('模擬登入：帳密不符'));
        writeAccount(c.root, { username, user_id: mockApi.MOCK_USER_ID });
        c.username = username;
        c.userId = mockApi.MOCK_USER_ID;
        c.sessionPresent = true;
        return Promise.resolve();
      },
      sessionUser: (c) => Promise.resolve(c.username !== null && readAccount(c.root) ? { userId: mockApi.MOCK_USER_ID } : null),
    };
  };
  const makeCtx = async () => {
    const over = { root: state.root };
    if (MOCK) {
      const mockApi = await import(pathToFileURL(join(here, 'mock-api.mjs')).href);
      Object.assign(over, {
        api: mockApi.createMockApi(),
        fetchText: () => Promise.resolve('<html></html>'),
        now: () => mockApi.MOCK_NOW,
        userId: mockApi.MOCK_USER_ID,
        auth: await mockAuthFor(),
      });
    }
    const c = state.mods.context.createContext(over);
    state.ctxs.push(c);
    return c;
  };
  const progressOf = () => JSON.parse(readText(join(state.root, 'data', 'setup-progress.json')));

  /* 1 設定精靈與確認畫面 */
  await step(1, '設定精靈與確認畫面', async () => {
    if (state.aborted) return skip('設定精靈', notReady(''));
    const { runSetup } = state.mods.setup;

    // 第一次：到確認畫面，修改第 5 步，再按 Ctrl-C
    const ctx1 = await makeCtx();
    const run1 = makePrompts(creds, [5, 'CTRL_C']);
    capture = [];
    let err1 = null;
    try {
      await runSetup(ctx1, run1.p);
    } catch (e) {
      err1 = e;
    }
    const out1 = capture;
    capture = null;
    for (const l of compactCapture(out1)) logLine(`[setup 第一次] ${l}`);
    const text1 = out1.join('');
    if (err1 !== null && !(err1.name === 'CliExit' && err1.code === 130)) logError('第一次 runSetup', err1);
    check('Ctrl-C 以「設定已中斷」結束（exit 130）', err1 !== null && err1.name === 'CliExit' && err1.code === 130,
      err1 === null ? '沒有被中斷' : `非預期的錯誤：${err1.message}`);
    check('出現「確認設定」畫面', text1.includes('確認設定'), '輸出裡沒有「確認設定」');
    check('選「修改第 5 步」後回到確認畫面', (text1.match(/確認設定/g) ?? []).length >= 2 &&
      run1.asked.filter((a) => a.message === '推送方式').length >= 2, '沒有重新詢問第 5 步並回到確認畫面');
    check('確認畫面第 2 行是「已登入」', text1.includes('2 登入 iLearn：已登入'), '找不到「2 登入 iLearn：已登入」');
    check('輸出不含學號與密碼', !text1.includes(creds.username) && !text1.includes(creds.password), '輸出出現了學號或密碼');
    const prog1 = existsSync(join(state.root, 'data', 'setup-progress.json')) ? progressOf() : null;
    check('進度檔尚未標記完成', prog1 !== null && prog1.finished === false, prog1 === null ? '沒有進度檔' : '進度檔已標記完成');
    check('沒有保存密碼', ctx1.config.password_saved === false, 'password_saved 不是 false');
    ctx1.db.close();
    if (err1 !== null && !(err1.name === 'CliExit' && err1.code === 130)) {
      skip('重跑設定精靈', '第一次設定沒有走到確認畫面，不再重跑');
      return;
    }

    // 第二次：只應該出現確認畫面
    ctx = await makeCtx();
    const run2 = makePrompts(creds, [0]);
    capture = [];
    let err2 = null;
    try {
      await runSetup(ctx, run2.p);
    } catch (e) {
      err2 = e;
    }
    const out2 = capture;
    capture = null;
    for (const l of compactCapture(out2)) logLine(`[setup 第二次] ${l}`);
    if (err2 !== null) logError('第二次 runSetup', err2);
    const text2 = out2.join('');
    check('重跑設定精靈順利完成', err2 === null, err2 === null ? '' : err2.message);
    const stepPrompts = run2.asked.filter((a) => a.message !== '設定是否正確' && !a.message.startsWith('要安裝背景服務'));
    check('重跑時沒有詢問任何步驟（只剩確認畫面）', stepPrompts.length === 0,
      `多問了：${stepPrompts.map((a) => a.message).join('、')}`);
    check('步驟 1 至 8 顯示略過', (text2.match(/已完成，略過/g) ?? []).length >= 8, '略過的步驟不足 8 個');
    check('輸出不含學號與密碼（重跑）', !text2.includes(creds.username) && !text2.includes(creds.password), '輸出出現了學號或密碼');
    const prog2 = existsSync(join(state.root, 'data', 'setup-progress.json')) ? progressOf() : null;
    check('選「確認完成」後進度檔標記完成', prog2 !== null && prog2.finished === true, '進度檔沒有標記完成');
    if (err2 !== null) {
      // 設定沒有完成，後面的步驟沒有資料可測，改為略過而不是連帶失敗
      ctx.db.close();
      ctx = null;
    }
  });

  /* 2 資料夾檢視 */
  await step(2, '資料夾檢視', async () => {
    if (ctx === null) return skip('資料夾檢視', notReady('設定精靈未完成'));
    const { coursesCommand } = state.mods.query;
    const { displayName } = state.mods.tuiData;
    const overview = join(state.root, '總覽.md');
    check('總覽.md 存在', existsSync(overview), '找不到 總覽.md');
    if (existsSync(overview)) check('總覽.md 有「唯讀檢視」說明', readText(overview).includes('唯讀檢視'), '缺少唯讀說明');
    const dir = join(state.root, '課程');
    const mds = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    check('課程/ 底下有 .md 檔', mds.length > 0, '課程/ 是空的或不存在', `${mds.length} 個`);
    const missingHeader = mds.filter((f) => !readText(join(dir, f)).includes('唯讀檢視'));
    check('每個課程檔都有「唯讀檢視」說明', missingHeader.length === 0, `${missingHeader.length} 個檔案缺少說明`);
    const titles = new Set(mds.map((f) => readText(join(dir, f)).split('\n')[0].replace(/^#\s*/, '').trim()));
    const current = coursesCommand(ctx).filter((c) => c.current);
    const missing = current.filter((c) => !titles.has(displayName(c.name) || c.id));
    check('本學期每一科都有檔案', current.length > 0 && missing.length === 0,
      current.length === 0 ? '資料庫沒有本學期課程' : `${missing.length} 科沒有檔案`, `${current.length} 科`);
    const old = coursesCommand(ctx).filter((c) => !c.current);
    if (old.length > 0) check('有舊學期資料時另有 保留/', existsSync(join(state.root, '保留')), '找不到 保留/');
    else skip('保留/ 資料夾', '沒有舊學期資料');
  });

  /* 3 老師關閉下載的教材 */
  await step(3, '老師關閉下載的教材', async () => {
    if (ctx === null) return skip('老師關閉下載的教材', notReady('設定精靈未完成'));
    const { listFiles } = state.mods.repo;
    const { sanitizeName } = state.mods.files;
    const skipped = listFiles(ctx.db, { status: 'skipped' });
    if (skipped.length === 0) return skip('老師關閉下載的教材', '這個帳號沒有被老師關閉下載的檔案（無資料）');
    const onDisk = walk(join(state.root, 'files')).map((p) => basename(p));
    const bad = skipped.filter((f) => f.local_path !== null || onDisk.includes(f.name) || onDisk.includes(sanitizeName(f.name)));
    check('關閉下載的檔案沒有出現在 files/', bad.length === 0, `${bad.length} 個檔案不應存在卻存在`, `${skipped.length} 個`);
  });

  /* 4 摘要 */
  await step(4, '摘要', async () => {
    if (ctx === null) return skip('摘要', notReady('設定精靈未完成'));
    const { coursesCommand, courseCommand } = state.mods.query;
    const { saveConfig } = state.mods.config;
    const { reloadSettings } = state.mods.context;
    const { pendingSummaries, writeSummary } = state.mods.summaries;
    const { renderFolderView } = state.mods.folder;
    const course = coursesCommand(ctx).filter((c) => c.current).find((c) => courseCommand(ctx, c.id).announcements.length > 0);
    if (!course) return skip('摘要', '本學期沒有任何課程有公告');
    const cfg = structuredClone(ctx.config);
    cfg.summaries.courses[course.id] = { materials: cfg.summaries.courses[course.id]?.materials ?? false, announcements: true };
    saveConfig(cfg, state.root);
    reloadSettings(ctx);
    const pending = pendingSummaries(ctx);
    check('agent_write 為 true', pending.agent_write === true, 'agent_write 不是 true');
    const target = pending.pending.find((t) => t.kind === 'announcement' && t.course.id === String(course.id));
    check('待摘要清單有該科公告，並附 target_id 與 source_hash', Boolean(target && target.target_id && target.source_hash), '清單裡找不到該科公告');
    if (!target) return;
    const TEXT = '裝置測試摘要';
    const w = writeSummary(ctx, { target_id: target.target_id, source_hash: target.source_hash, text: TEXT, agent: 'device-test' });
    check('寫入正確 hash 的摘要，回傳 written_at', Boolean(w.written_at), '沒有 written_at');
    const ann = courseCommand(ctx, course.id).announcements.find((a) => a.id === target.target_id);
    check('課程 JSON 的公告帶有該摘要', ann?.summary === TEXT, '課程 JSON 沒有摘要');
    renderFolderView(ctx, () => undefined);
    const dir = join(state.root, '課程');
    const inMd = readdirSync(dir).some((f) => f.endsWith('.md') && readText(join(dir, f)).includes(TEXT));
    check('課程/<科名>.md 出現該摘要', inMd, '課程檔裡找不到摘要');
    const msg = refused(() => writeSummary(ctx, { target_id: target.target_id, source_hash: 'abc', text: TEXT, agent: 'device-test' }));
    check('錯誤的 hash 被拒絕並說明原文已變動', msg !== null && msg.includes('原文已變動'), msg === null ? '沒有被拒絕' : `訊息不符：${msg}`);
  });

  /* 5 agent 修改設定 */
  await step(5, 'agent 修改設定', async () => {
    if (ctx === null) return skip('agent 修改設定', notReady('設定精靈未完成'));
    const { configSet } = state.mods.settings;
    const { saveConfig } = state.mods.config;
    const { reloadSettings } = state.mods.context;
    const { loadTuiData, courseDetail } = state.mods.tuiData;
    const { buildPage } = state.mods.pages;
    const { initialState } = state.mods.tuiState;
    check('agent 權限（修改設定）已允許', ctx.config.agent_permissions.settings === true, '設定精靈沒有允許修改設定');
    const r = configSet(ctx, { key: 'quiet_hours.start', value: '23:30', agent: 'device-test' });
    check('config set 回傳舊值與新值', r.new === '23:30' && r.old !== undefined && r.old !== r.new, `回傳不符：${JSON.stringify(r)}`, `${r.old} → ${r.new}`);

    const d = loadTuiData(ctx);
    const src = { detail: (id) => courseDetail(ctx, id), preview: () => [] };
    const pageText = (tab) => buildPage({ ...initialState(), tab }, d, 100, src).panes.flat().map((row) => row.text).join('\n');
    check('ui 首頁出現「agent 最近 7 日修改了」', pageText(1).includes('agent 最近 7 日修改了'), '首頁沒有提示');
    const rem = pageText(3);
    check('3 提醒頁列出這次修改', rem.includes('quiet_hours.start') && rem.includes('device-test') && rem.includes('23:30'), '提醒頁沒有列出修改');
    const overview = readText(join(state.root, '總覽.md'));
    check('總覽.md 的系統提示列出這次修改', overview.includes('quiet_hours.start'), '總覽.md 沒有列出');

    const m1 = refused(() => configSet(ctx, { key: 'delivery.hook.command', value: 'echo hi', agent: 'device-test' }));
    check('修改 delivery.hook.command 被拒絕', m1 !== null, '沒有被拒絕');
    const m2 = refused(() => configSet(ctx, { key: 'agent_permissions.settings', value: 'false', agent: 'device-test' }));
    check('修改 agent_permissions.settings 被拒絕', m2 !== null, '沒有被拒絕');
    reloadSettings(ctx);
    check('被拒絕後權限與推送設定沒有變動', ctx.config.agent_permissions.settings === true && ctx.config.delivery.hook.command === '',
      '設定被改動了');

    // 比照 ui 的「系統設定 > agent 權限」關閉修改設定
    const cfg = structuredClone(ctx.config);
    cfg.agent_permissions.settings = false;
    saveConfig(cfg, state.root);
    reloadSettings(ctx);
    const m3 = refused(() => configSet(ctx, { key: 'quiet_hours.start', value: '23:30', agent: 'device-test' }));
    check('關閉「修改設定」後 config set 被拒絕，訊息說尚未允許', m3 !== null && m3.includes('尚未允許'),
      m3 === null ? '沒有被拒絕' : `訊息不符：${m3}`);
  });

  /* 6 人工目視（選用） */
  await step(6, '人工目視（選用）', async () => {
    if (ctx === null) return skip('人工目視', notReady('設定精靈未完成'));
    if (!INTERACTIVE) {
      skip('ui 首頁提示可見', '未使用 --interactive');
      skip('資料夾內容正確', '未使用 --interactive');
      return;
    }
    if (!process.stdin.isTTY) {
      skip('ui 首頁提示可見', '目前不是互動終端機');
      skip('資料夾內容正確', '目前不是互動終端機');
      return;
    }
    const { confirm } = await import('@inquirer/prompts');
    const changes = state.mods.tuiData.loadTuiData(ctx).agentChanges.length;
    const expected = `agent 最近 7 日修改了 ${changes} 項設定，詳情見 3 提醒`;
    logLine(`目視前：測試資料夾有 ${changes} 項 agent 修改紀錄`);
    say(`  開啟後請看「1 首頁」最上方、「需要處理」那一行的上面，應該有一行粗體字：`);
    say(`  ${expected}`);
    if (await confirm({ message: '要開啟 ilearn ui（測試資料夾）檢查首頁提示嗎？按 q 離開 ui 後會回到這裡', default: false })) {
      const r = spawnSync(process.execPath, [join(dist, 'cli', 'index.js'), 'ui'], { stdio: 'inherit', env: { ...process.env, ILEARN_HOME: state.root } });
      logLine(`ilearn ui 結束：exit=${r.status ?? 'null'} signal=${r.signal ?? 'null'}${r.error ? ` error=${r.error.message}` : ''}`);
      const ok = await confirm({ message: '首頁最上方有看到「agent 最近 7 日修改了…」的提示嗎？', default: false });
      manual.push(`ui 首頁提示可見：${ok ? 'PASS' : 'FAIL'}（使用者自己回答）`);
      check('ui 首頁提示可見（使用者回答）', ok, '使用者回答沒有看到');
    } else skip('ui 首頁提示可見', '使用者選擇不開啟');
    if (await confirm({ message: '要用檔案管理員開啟測試資料夾嗎？', default: false })) {
      const opener = { darwin: 'open', linux: 'xdg-open', win32: 'explorer' }[process.platform];
      if (opener) spawnSync(opener, [state.root], { stdio: 'ignore' });
      const ok = await confirm({ message: '資料夾裡有「總覽.md」與「課程」，內容看起來正確嗎？', default: false });
      manual.push(`資料夾內容正確：${ok ? 'PASS' : 'FAIL'}（使用者自己回答）`);
      check('資料夾內容正確（使用者回答）', ok, '使用者回答內容不正確');
    } else skip('資料夾內容正確', '使用者選擇不開啟');
  });

  /* 結尾：背景服務未被改動 */
  currentStep = '0';
  say('\n== 結尾檢查 ==');
  if (state.mods.service && svcBefore !== null) {
    try {
      const after = JSON.stringify(simpleService(state.mods.service.serviceStatus(state.mods.service.defaultServiceDeps())));
      check('背景服務狀態與開始時相同', after === svcBefore, `開始：${svcBefore}；結束：${after}`);
    } catch (e) {
      logError('結尾讀取背景服務狀態', e);
      skip('背景服務狀態與開始時相同', '結尾無法讀取');
    }
  }

  return { state, manual };
}

/* ---------- 報告與收尾 ---------- */

function gitCommit() {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '（無法取得）';
  } catch {
    return '（無法取得）';
  }
}

function buildReport(manual, removedNote) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = results.map((r) => `| ${r.step} | ${esc(r.name)} | ${r.status} | ${esc(r.reason)} |`);
  return redact([
    '# ilearn 裝置測試報告',
    '',
    `- 日期（台北時間）：${stampLine()}`,
    `- 平台：${process.platform} ${release()}`,
    `- Node：${process.version}`,
    `- git commit：${gitCommit()}`,
    `- 模式：${MOCK ? '--mock（假 API，未連線）' : '實際連線 iLearn'}`,
    `- 結果：PASS ${count('PASS')}、FAIL ${count('FAIL')}、SKIP ${count('SKIP')}`,
    `- 暫存資料夾：${removedNote}`,
    '',
    '| 步驟 | 項目 | 結果 | 說明 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## 使用者目視回答',
    '',
    ...(manual.length ? manual.map((m) => `- ${m}`) : ['- 未進行（沒有使用 --interactive）']),
    '',
    '## 未涵蓋',
    '',
    '- 新學期切換、與 agent 的真實對話、密碼 * 的畫面、背景服務睡眠喚醒、完全移除，需另外人工測試。',
    '',
  ].join('\n'));
}

let exitCode = 0;
let outcome = { state: null, manual: [] };
try {
  outcome = await main();
} catch (e) {
  exitCode = 1;
  logError('執行中斷', e);
  results.push({ step: '-', name: '執行中斷', status: 'FAIL', reason: e instanceof Error ? e.message : String(e) });
  process.stdout.write(`執行中斷：${e instanceof Error ? e.message : String(e)}\n`);
}

const state = outcome.state;
let removedNote = '未建立';
if (state && state.root) {
  for (const c of state.ctxs) {
    try {
      c.db.close();
    } catch {
      // 已關閉
    }
  }
  const tmpBase = real(tmpdir());
  if (KEEP) {
    removedNote = `已保留於 ${state.root}`;
  } else if (basename(state.root).startsWith('thu-ilearn-device-test-') && under(real(state.root), tmpBase)) {
    rmSync(state.root, { recursive: true, force: true });
    removedNote = existsSync(state.root) ? '移除失敗，請手動刪除' : '已移除';
  } else {
    removedNote = '路徑不符合預期，未移除';
  }
  logLine(`暫存資料夾：${removedNote}`);
}

if (logReady) {
  writeFileSync(reportFile, buildReport(outcome.manual, state?.root && KEEP ? '已保留（路徑見終端機輸出）' : removedNote));
  const n = (s) => results.filter((r) => r.status === s).length;
  if (n('FAIL') > 0) exitCode = 1;
  say('');
  say(`結果：PASS ${n('PASS')}、FAIL ${n('FAIL')}、SKIP ${n('SKIP')}`);
  if (KEEP && state?.root) say(`暫存資料夾（已保留）：${state.root}`);
  else say(`暫存資料夾：${removedNote}`);
  say(`報告：${reportFile}`);
  say(`日誌：${logFile}`);
  logLine(`結束 exit=${exitCode}`);
}
process.exit(exitCode);
