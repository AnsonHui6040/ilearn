import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../config/paths.js';

export type CredentialBackend = 'keychain' | 'encrypted_file' | 'none';

const SERVICE = 'thu-ilearn';

export function chooseBackend(env: 'desktop' | 'vps'): CredentialBackend {
  return env === 'desktop' ? 'keychain' : 'encrypted_file';
}

export const VPS_RISK_WARNING =
  '伺服器被入侵或供應商可存取磁碟時，密碼可能外洩；加密金鑰亦在同一機器，只能防止一般誤讀';

const keyPath = (root: string): string => join(root, 'data', 'key');
const credPath = (root: string): string => join(root, 'data', 'credential.enc');
const sessionPath = (root: string): string => join(root, 'data', 'session.json');

async function entry(username: string): Promise<import('@napi-rs/keyring').Entry> {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry(SERVICE, username);
}

function getKey(root: string, create: boolean): Buffer | null {
  const p = keyPath(root);
  if (existsSync(p)) return Buffer.from(readFileSync(p, 'utf8').trim(), 'hex');
  if (!create) return null;
  const k = randomBytes(32);
  writeSecureFile(p, k.toString('hex'));
  return k;
}

export async function savePassword(
  root: string,
  backend: CredentialBackend,
  username: string,
  password: string,
): Promise<void> {
  if (backend === 'none') return;
  if (backend === 'keychain') {
    try {
      (await entry(username)).setPassword(password);
    } catch {
      throw new Error('無法寫入系統憑證庫');
    }
    return;
  }
  const key = getKey(root, true);
  if (!key) throw new Error('無法建立加密金鑰');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ username, password }), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeSecureFile(
    credPath(root),
    JSON.stringify({ iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') }),
  );
}

export async function loadPassword(
  root: string,
  backend: CredentialBackend,
  username: string,
): Promise<string | null> {
  if (backend === 'none') return null;
  if (backend === 'keychain') {
    try {
      return (await entry(username)).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  const key = getKey(root, false);
  if (!key || !existsSync(credPath(root))) return null;
  try {
    const c = JSON.parse(readFileSync(credPath(root), 'utf8')) as { iv: string; tag: string; data: string };
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'base64'));
    d.setAuthTag(Buffer.from(c.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(c.data, 'base64')), d.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as { username: string; password: string };
    return parsed.username === username ? parsed.password : null;
  } catch {
    throw new Error('無法解密已保存的密碼，請重新登入');
  }
}

export async function deleteCredentials(root: string, username: string): Promise<void> {
  try {
    (await entry(username)).deletePassword();
  } catch {
    // 憑證庫沒有該項目或不可用，視為已清除
  }
  for (const p of [keyPath(root), credPath(root), sessionPath(root)]) rmSync(p, { force: true });
}

export function saveSession(root: string, cookies: string): void {
  writeSecureFile(sessionPath(root), JSON.stringify({ cookies }));
}

export function loadSession(root: string): string | null {
  const p = sessionPath(root);
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as { cookies?: string };
    return s.cookies ?? null;
  } catch {
    return null;
  }
}
