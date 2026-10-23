import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maybeCheckUpdate, updateApplyCommand } from '../src/cli/commands/update.js';
import { applyUpdate, checkForUpdate, currentVersion, installKind, isCheckDue, isNewer, npmBinary, readUpdateStatus } from '../src/update/update.js';

describe('isNewer', () => {
  it('compares dotted version numbers', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.3')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });
});

describe('readUpdateStatus', () => {
  const root = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'ilearn-upd-'));
    mkdirSync(join(r, 'data'), { recursive: true });
    return r;
  };

  it('says nothing has been checked yet when there is no record', () => {
    expect(readUpdateStatus(root(), '0.1.0')).toEqual({ current: '0.1.0', latest: null, checkedAt: null, available: false });
  });

  it('reports a newer version found by the last check', () => {
    const r = root();
    writeFileSync(join(r, 'data', 'update.json'), JSON.stringify({ latest: '0.2.0', checked_at: '2026-10-23T08:00:00.000Z' }));
    expect(readUpdateStatus(r, '0.1.0')).toEqual({ current: '0.1.0', latest: '0.2.0', checkedAt: '2026-10-23T08:00:00.000Z', available: true });
    expect(readUpdateStatus(r, '0.2.0').available).toBe(false);
  });

  it('ignores a broken record', () => {
    const r = root();
    writeFileSync(join(r, 'data', 'update.json'), '{oops');
    expect(readUpdateStatus(r, '0.1.0').available).toBe(false);
  });
});

it('reads the running version from package.json', () => {
  expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+$/);
});

describe('isCheckDue', () => {
  const now = new Date('2026-10-23T08:00:00Z');
  it('checks daily, weekly or never', () => {
    expect(isCheckDue(now, null, 'daily')).toBe(true);
    expect(isCheckDue(now, '2026-10-22T09:00:00Z', 'daily')).toBe(false);
    expect(isCheckDue(now, '2026-10-22T07:59:00Z', 'daily')).toBe(true);
    expect(isCheckDue(now, '2026-10-20T08:00:00Z', 'weekly')).toBe(false);
    expect(isCheckDue(now, '2026-10-16T07:59:00Z', 'weekly')).toBe(true);
    expect(isCheckDue(now, null, 'off')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const r = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ilearn-chk-'));
    mkdirSync(join(d, 'data'), { recursive: true });
    return d;
  };
  const fetchWith = (status: number, body: unknown, seen: string[] = []) =>
    (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('asks the npm registry for the latest version and records it', async () => {
    const root = r();
    const seen: string[] = [];
    const st = await checkForUpdate({ root, current: '0.1.0', now: new Date('2026-10-23T08:00:00Z'), env: {}, fetchImpl: fetchWith(200, { version: '0.2.0' }, seen) });
    expect(seen).toEqual(['https://registry.npmjs.org/thu-ilearn/latest']);
    expect(st).toEqual({ current: '0.1.0', latest: '0.2.0', checkedAt: '2026-10-23T08:00:00.000Z', available: true });
    expect(readUpdateStatus(root, '0.1.0')).toEqual(st);
  });

  it('follows the npm registry setting', async () => {
    const seen: string[] = [];
    await checkForUpdate({ root: r(), current: '0.1.0', now: new Date(), env: { npm_config_registry: 'http://127.0.0.1:4873/' }, fetchImpl: fetchWith(200, { version: '0.1.0' }, seen) });
    expect(seen).toEqual(['http://127.0.0.1:4873/thu-ilearn/latest']);
  });

  it('explains when the package is not on npm', async () => {
    await expect(checkForUpdate({ root: r(), current: '0.1.0', now: new Date(), env: {}, fetchImpl: fetchWith(404, {}) })).rejects.toThrow('npm 上找不到 thu-ilearn（HTTP 404）');
  });
});

describe('install kind', () => {
  it('tells an npm global install from a git checkout', () => {
    expect(installKind('/opt/homebrew/lib/node_modules/thu-ilearn', () => false)).toBe('npm');
    expect(installKind('/Users/a/thu-ilearn', (p) => p === '/Users/a/thu-ilearn/.git')).toBe('git');
    expect(installKind('/somewhere/else', () => false)).toBe('unknown');
  });
});

describe('applyUpdate', () => {
  it('installs the latest version with the npm next to node', () => {
    const calls: string[] = [];
    const msg = applyUpdate({
      kind: 'npm', latest: '0.2.0', npm: '/opt/homebrew/bin/npm',
      run: (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), { code: 0, stdout: '', stderr: '' }),
    });
    expect(calls).toEqual(['/opt/homebrew/bin/npm install -g thu-ilearn@0.2.0']);
    expect(msg).toBe('已更新到 0.2.0；背景服務下一輪會使用新版本，介面請離開後重新開啟');
  });

  it('reports a failed install', () => {
    const msg = applyUpdate({ kind: 'npm', latest: '0.2.0', npm: 'npm', run: () => ({ code: 1, stdout: '', stderr: 'EACCES: permission denied' }) });
    expect(msg).toBe('更新失敗：EACCES: permission denied');
  });

  it('asks git installs to update by hand and does nothing without a newer version', () => {
    const run = () => {
      throw new Error('should not run');
    };
    expect(applyUpdate({ kind: 'git', latest: '0.2.0', npm: 'npm', run })).toBe('這份程式以 git 安裝，請在程式資料夾執行 git pull、npm ci、npm run build');
    expect(applyUpdate({ kind: 'npm', latest: null, npm: 'npm', run })).toBe('沒有可用的新版本，請先檢查更新');
  });

  it('finds npm next to the running node', () => {
    expect(npmBinary('/opt/homebrew/bin/node', (p) => p === '/opt/homebrew/bin/npm')).toBe('/opt/homebrew/bin/npm');
    expect(npmBinary('/x/node', () => false)).toBe('npm');
  });
});

describe('ilearn update commands', () => {
  const r = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ilearn-cmd-'));
    mkdirSync(join(d, 'data'), { recursive: true });
    return d;
  };
  const registry = (version: string) =>
    (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;
  const base = { current: '0.1.0', now: new Date('2026-10-23T08:00:00Z'), env: {}, kind: 'npm' as const, npm: 'npm' };

  it('update needs an interactive terminal', async () => {
    await expect(updateApplyCommand({ ...base, root: r(), isTTY: false, fetchImpl: registry('0.2.0'), run: () => ({ code: 0, stdout: '', stderr: '' }) }))
      .rejects.toThrow('更新需要在互動終端機執行');
  });

  it('checks first and installs only when there is a newer version', async () => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => (calls.push(args.join(' ')), { code: 0, stdout: '', stderr: '' });
    expect(await updateApplyCommand({ ...base, root: r(), isTTY: true, fetchImpl: registry('0.1.0'), run })).toBe('已是最新版本 0.1.0');
    expect(calls).toEqual([]);
    expect(await updateApplyCommand({ ...base, root: r(), isTTY: true, fetchImpl: registry('0.2.0'), run })).toContain('已更新到 0.2.0');
    expect(calls).toEqual(['install -g thu-ilearn@0.2.0']);
  });
});

describe('maybeCheckUpdate in the background run', () => {
  it('checks when due, records the result and never throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ilearn-bg-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const logs: string[] = [];
    const ok = (async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })) as unknown as typeof fetch;
    const now = new Date('2026-10-23T08:00:00Z');
    expect(await maybeCheckUpdate({ root, freq: 'daily', current: '0.1.0', now, env: {}, fetchImpl: ok, log: (s) => logs.push(s) })).toBe(true);
    expect(readUpdateStatus(root, '0.1.0').available).toBe(true);
    expect(await maybeCheckUpdate({ root, freq: 'daily', current: '0.1.0', now, env: {}, fetchImpl: ok, log: (s) => logs.push(s) })).toBe(false);
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const later = new Date('2026-10-25T08:00:00Z');
    expect(await maybeCheckUpdate({ root, freq: 'daily', current: '0.1.0', now: later, env: {}, fetchImpl: down, log: (s) => logs.push(s) })).toBe(false);
    expect(logs).toEqual(['檢查更新失敗：getaddrinfo ENOTFOUND']);
    expect(await maybeCheckUpdate({ root, freq: 'off', current: '0.1.0', now: later, env: {}, fetchImpl: ok, log: (s) => logs.push(s) })).toBe(false);
  });
});
