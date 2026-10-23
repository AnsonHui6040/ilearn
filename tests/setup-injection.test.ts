import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createContext, readAccount, writeAccount, type AuthHooks } from '../src/cli/context.js';
import { runSetup, type Prompts } from '../src/cli/setup.js';
import { createFakeApi } from './helpers/fakeApi.js';

describe('runSetup with injected prompts and auth hooks', () => {
  it('runs the whole wizard without the network or the terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ilearn-inject-'));
    const logins: string[] = [];
    const auth: AuthHooks = {
      login: (ctx, username) => {
        logins.push(username);
        writeAccount(ctx.root, { username, user_id: 777 });
        ctx.username = username;
        ctx.userId = 777;
        ctx.sessionPresent = true;
        return Promise.resolve();
      },
      sessionUser: (ctx) => Promise.resolve(readAccount(ctx.root) ? { userId: 777 } : null),
    };
    const ctx = createContext({
      root,
      api: createFakeApi().api,
      fetchText: () => Promise.resolve('<html></html>'),
      now: () => new Date('2026-10-22T04:00:00Z'),
      userId: 777,
      auth,
    });
    const asked: string[] = [];
    const p = {
      select: ((o: { message: string; choices: { value: unknown }[] }) => {
        asked.push(o.message);
        return Promise.resolve(o.message === '設定是否正確' ? 0 : o.choices[0]?.value);
      }) as never,
      input: ((o: { message: string }) => (asked.push(o.message), Promise.resolve('S0000001'))) as never,
      password: ((o: { message: string }) => (asked.push(o.message), Promise.resolve('pw'))) as never,
      confirm: ((o: { message: string }) => (asked.push(o.message), Promise.resolve(false))) as never,
      checkbox: ((o: { message: string; choices: { value: unknown; checked?: boolean }[] }) => {
        asked.push(o.message);
        return Promise.resolve(o.choices.filter((c) => c.checked).map((c) => c.value));
      }) as never,
    } as unknown as Prompts;
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runSetup(ctx, p);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(logins).toEqual(['S0000001']);
    expect(asked).toContain('設定是否正確');
    const progress = JSON.parse(readFileSync(join(root, 'data', 'setup-progress.json'), 'utf8')) as { finished: boolean };
    expect(progress.finished).toBe(true);
  });
});
