import { describe, expect, it } from 'vitest';
import { CliExit } from '../src/cli/context.js';
import { planUninstall, runUninstall, type UninstallDeps } from '../src/service/uninstall.js';

const HOME = '/Users/a';
const base = { dataRoot: `${HOME}/.thu-ilearn`, home: HOME, isPackage: () => true };

describe('planUninstall', () => {
  it('removes the program only and keeps the data folder', () => {
    const p = planUninstall({ ...base, removeData: false, programDir: `${HOME}/thu-ilearn` });
    expect(p.lines).toEqual([
      '移除背景服務',
      '移除 ilearn 指令（npm rm -g thu-ilearn）',
      `刪除程式資料夾 ${HOME}/thu-ilearn`,
      `保留資料夾 ${HOME}/.thu-ilearn（設定、資料庫、已下載的教材與登入資料）`,
    ]);
    expect(p.deleteProgramDir).toBe(true);
  });

  it('also removes login data and the data folder when asked', () => {
    const p = planUninstall({ ...base, removeData: true, programDir: `${HOME}/thu-ilearn` });
    expect(p.lines).toContain('刪除登入資料與 Keychain 中的密碼');
    expect(p.lines).toContain(`刪除資料夾 ${HOME}/.thu-ilearn（包括已下載的教材）`);
  });

  it('never deletes a program folder outside ~/thu-ilearn', () => {
    const p = planUninstall({ ...base, removeData: false, programDir: '/Users/a/Documents/GitHub/ilearn' });
    expect(p.deleteProgramDir).toBe(false);
    expect(p.lines).toContain('程式資料夾 /Users/a/Documents/GitHub/ilearn 不是預設安裝位置，請自行刪除');
    const notPackage = planUninstall({ ...base, isPackage: () => false, removeData: false, programDir: `${HOME}/thu-ilearn` });
    expect(notPackage.deleteProgramDir).toBe(false);
  });

  it('refuses to delete the home folder or the file system root as data', () => {
    expect(() => planUninstall({ ...base, dataRoot: HOME, removeData: true, programDir: `${HOME}/thu-ilearn` })).toThrow(CliExit);
    expect(() => planUninstall({ ...base, dataRoot: '/', removeData: true, programDir: `${HOME}/thu-ilearn` })).toThrow(CliExit);
  });
});

describe('runUninstall', () => {
  function fake() {
    const calls: string[] = [];
    const deps: UninstallDeps = {
      uninstallService: () => (calls.push('service'), '已移除背景服務'),
      logout: async () => void calls.push('logout'),
      removeDir: (p) => void calls.push(`rm ${p}`),
      run: (cmd, args) => (calls.push(`${cmd} ${args.join(' ')}`), { code: 0, stdout: '', stderr: '' }),
    };
    return { calls, deps };
  }

  it('runs the steps in order and reports each one', async () => {
    const { calls, deps } = fake();
    const plan = planUninstall({ ...base, removeData: true, programDir: `${HOME}/thu-ilearn` });
    const out = await runUninstall(plan, deps);
    expect(calls).toEqual(['service', 'logout', `rm ${HOME}/.thu-ilearn`, 'npm rm -g thu-ilearn', `rm ${HOME}/thu-ilearn`]);
    expect(out.at(-1)).toBe('thu-ilearn 已完全移除');
  });

  it('keeps going and reports a failed step', async () => {
    const { calls, deps } = fake();
    deps.run = () => ({ code: 1, stdout: '', stderr: 'EACCES' });
    const plan = planUninstall({ ...base, removeData: false, programDir: `${HOME}/thu-ilearn` });
    const out = await runUninstall(plan, deps);
    expect(out).toContain('移除 ilearn 指令失敗：EACCES，請自行執行 npm rm -g thu-ilearn');
    expect(calls).toContain(`rm ${HOME}/thu-ilearn`);
  });
});
