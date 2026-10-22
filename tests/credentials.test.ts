import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private service: string,
      private user: string,
    ) {}
    setPassword(p: string): void {
      store.set(`${this.service}/${this.user}`, p);
    }
    getPassword(): string | null {
      return store.get(`${this.service}/${this.user}`) ?? null;
    }
    deletePassword(): boolean {
      return store.delete(`${this.service}/${this.user}`);
    }
  },
}));

import {
  chooseBackend,
  deleteCredentials,
  loadPassword,
  loadSession,
  saveSession,
  savePassword,
  VPS_RISK_WARNING,
} from '../src/auth/credentials.js';

const PW = 'S3cret-pässword-XYZ';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cred-'));
  store.clear();
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('credentials', () => {
  it('chooses backend', () => {
    expect(chooseBackend('desktop')).toBe('keychain');
    expect(chooseBackend('vps')).toBe('encrypted_file');
    expect(VPS_RISK_WARNING).toContain('加密金鑰亦在同一機器');
  });

  it('none backend persists nothing', async () => {
    await savePassword(root, 'none', 'u', PW);
    saveSession(root, 'cookie=1');
    for (const f of walk(root)) expect(readFileSync(f, 'utf8')).not.toContain(PW);
    expect(await loadPassword(root, 'none', 'u')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('encrypted_file round trip, no plaintext, 0600', async () => {
    await savePassword(root, 'encrypted_file', 'u', PW);
    expect(await loadPassword(root, 'encrypted_file', 'u')).toBe(PW);
    expect(await loadPassword(root, 'encrypted_file', 'other')).toBeNull();
    const enc = join(root, 'data', 'credential.enc');
    const key = join(root, 'data', 'key');
    for (const f of [enc, key]) expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(enc, 'utf8')).not.toContain(PW);
    expect(Object.keys(JSON.parse(readFileSync(enc, 'utf8')) as object).sort()).toEqual(['data', 'iv', 'tag']);
    expect(readFileSync(key, 'utf8').trim()).toHaveLength(64);
  });

  it('tampered ciphertext errors without leaking password', async () => {
    await savePassword(root, 'encrypted_file', 'u', PW);
    const enc = join(root, 'data', 'credential.enc');
    const c = JSON.parse(readFileSync(enc, 'utf8')) as { data: string; iv: string; tag: string };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(enc, JSON.stringify({ ...c, tag: Buffer.alloc(16).toString('base64') }));
    const err = await loadPassword(root, 'encrypted_file', 'u').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(PW);
  });

  it('keychain uses service thu-ilearn', async () => {
    await savePassword(root, 'keychain', 'u', PW);
    expect(store.get('thu-ilearn/u')).toBe(PW);
    expect(await loadPassword(root, 'keychain', 'u')).toBe(PW);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('keychain failure message omits password', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => ({
      Entry: class {
        setPassword(p: string): void {
          throw new Error(`boom ${p}`);
        }
      },
    }));
    const m = await import('../src/auth/credentials.js');
    const err = await m.savePassword(root, 'keychain', 'u', PW).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(PW);
    vi.doUnmock('@napi-rs/keyring');
  });

  it('session round trip 0600 and deleteCredentials clears all', async () => {
    saveSession(root, 'MoodleSession=abc');
    expect(loadSession(root)).toBe('MoodleSession=abc');
    expect(statSync(join(root, 'data', 'session.json')).mode & 0o777).toBe(0o600);
    await savePassword(root, 'encrypted_file', 'u', PW);
    await savePassword(root, 'keychain', 'u', PW);
    await deleteCredentials(root, 'u');
    expect(await loadPassword(root, 'encrypted_file', 'u')).toBeNull();
    expect(await loadPassword(root, 'keychain', 'u')).toBeNull();
    expect(loadSession(root)).toBeNull();
  });
});
