import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, upsertCourse, upsertItem, upsertFile, type StoredFile, type StoredItem } from '../src/db/repo.js';
import type { ItemKind } from '../src/types.js';
import { downloadPending, registerUploads, sanitizeName } from '../src/sync/files.js';
import { makeEnv, type TestEnv } from './helpers/fakeApi.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function seed(env: TestEnv, itemId: string, kind: ItemKind): void {
  upsertCourse(env.db, {
    id: '1', name: '資料結構', code: '1151_CS101', semester: '115-1', start_date: '', end_date: '', raw: '{}',
  });
  const it: StoredItem = {
    id: itemId, kind, course_id: '1', title: 't', body: null, due_at: null, start_at: null, url: null,
    completion: 'pending', teammate_hint: false, group: false, score: null, score_published: false,
    feedback: null, categories: [], matched_rules: [], manual_categories: null, delivery: null, raw: '{}',
    first_seen_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z',
  };
  upsertItem(env.db, it);
}

function fileRow(over: Partial<StoredFile> & { upload_id: string }): StoredFile {
  return {
    item_id: 'material:102', course_id: '1', name: '講義1.pdf', size: 8, hash: null, local_path: null,
    status: 'pending', link: null, allow_download: true, ...over,
  };
}

describe('sanitizeName', () => {
  it('replaces path-hostile characters and leading dots', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j.pdf')).toBe('a_b_c_d_e_f_g_h_i_j.pdf');
    expect(sanitizeName('..hidden')).toBe('hidden');
    expect(sanitizeName('...')).toBe('_');
    expect(sanitizeName('第1週 講義.pdf')).toBe('第1週 講義.pdf');
  });
});

describe('downloadPending', () => {
  it('downloads to files/<semester>/<course>/<category>/<name> with 0600 and sha256', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    seed(env, 'announcement:88000', 'announcement');
    seed(env, 'assignment:101', 'assignment');
    env.fake.data.blobs[1] = 'lecture-1';
    env.fake.data.blobs[2] = 'notice';
    env.fake.data.blobs[3] = 'hw';
    upsertFile(env.db, fileRow({ upload_id: '1' }));
    upsertFile(env.db, fileRow({ upload_id: '2', item_id: 'announcement:88000', name: '公告.pdf' }));
    upsertFile(env.db, fileRow({ upload_id: '3', item_id: 'assignment:101', name: '作業.pdf' }));
    const r = await downloadPending(env.ctx);
    expect(r).toEqual({ done: 3, failed: [] });
    const rows = listFiles(env.db, {});
    const byId = Object.fromEntries(rows.map((f) => [f.upload_id, f]));
    expect(byId['1']?.local_path).toBe(join('files', '115-1', '資料結構', '教材', '講義1.pdf'));
    expect(byId['2']?.local_path).toBe(join('files', '115-1', '資料結構', '公告', '公告.pdf'));
    expect(byId['3']?.local_path).toBe(join('files', '115-1', '資料結構', '作業', '作業.pdf'));
    expect(byId['1']?.hash).toBe(sha('lecture-1'));
    expect(byId['1']?.status).toBe('done');
    const abs = join(env.root, byId['1']?.local_path ?? '');
    expect(readFileSync(abs, 'utf8')).toBe('lecture-1');
    expect(statSync(abs).mode & 0o777).toBe(0o600);
    expect(statSync(join(abs, '..')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(abs, '..')).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('does not rewrite a file whose hash is unchanged', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[1] = 'lecture-1';
    upsertFile(env.db, fileRow({ upload_id: '1' }));
    await downloadPending(env.ctx);
    const row = listFiles(env.db, {})[0];
    const abs = join(env.root, row?.local_path ?? '');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(abs, old, old);
    const before = statSync(abs).mtimeMs;

    upsertFile(env.db, { ...(row as StoredFile), status: 'pending' });
    const r = await downloadPending(env.ctx);
    expect(r.done).toBe(1);
    expect(statSync(abs).mtimeMs).toBe(before);
    expect(listFiles(env.db, {})[0]?.status).toBe('done');
    expect(existsSync(join(abs, '..', '.versions'))).toBe(false);
  });

  it('moves the old file to .versions when the hash differs', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[1] = 'lecture-1';
    upsertFile(env.db, fileRow({ upload_id: '1' }));
    await downloadPending(env.ctx);
    const row = listFiles(env.db, {})[0] as StoredFile;
    const abs = join(env.root, row.local_path ?? '');

    env.fake.data.blobs[1] = 'lecture-1-v2';
    upsertFile(env.db, { ...row, status: 'pending' });
    await downloadPending(env.ctx);
    expect(readFileSync(abs, 'utf8')).toBe('lecture-1-v2');
    const kept = join(abs, '..', '.versions', `講義1.pdf.${sha('lecture-1').slice(0, 8)}`);
    expect(readFileSync(kept, 'utf8')).toBe('lecture-1');
    expect(listFiles(env.db, {})[0]?.hash).toBe(sha('lecture-1-v2'));
  });

  it('skips allow_download=false by default and makes no request', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    registerUploads(env.ctx, 'material:102', '1', [
      { id: 7, name: '禁止.pdf', size: 5, allow_download: false, link: null },
    ]);
    expect(listFiles(env.db, {})[0]?.status).toBe('skipped');
    const r = await downloadPending(env.ctx);
    expect(r.done).toBe(0);
    expect(env.fake.count('downloadUpload')).toBe(0);
  });

  it('downloads allow_download=false files when config says download', async () => {
    const env = makeEnv({ config: { files: { download_disallowed: 'download' } } });
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[7] = 'secret';
    registerUploads(env.ctx, 'material:102', '1', [
      { id: 7, name: '禁止.pdf', size: 6, allow_download: false, link: null },
    ]);
    expect(listFiles(env.db, {})[0]?.status).toBe('pending');
    await downloadPending(env.ctx);
    expect(listFiles(env.db, {})[0]?.status).toBe('done');
  });

  it('records external links without downloading', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    registerUploads(env.ctx, 'material:102', '1', [
      { id: 8, name: '外部連結', size: null, allow_download: true, link: 'https://example.com/x' },
    ]);
    const f = listFiles(env.db, {})[0];
    expect(f?.status).toBe('link');
    expect(f?.link).toBe('https://example.com/x');
    await downloadPending(env.ctx);
    expect(env.fake.count('downloadUpload')).toBe(0);
  });

  it('registerUploads keeps status/hash of finished files and re-queues changed ones', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[1] = 'lecture-1';
    registerUploads(env.ctx, 'material:102', '1', [{ id: 1, name: '講義1.pdf', size: 9, allow_download: true, link: null }]);
    await downloadPending(env.ctx);
    registerUploads(env.ctx, 'material:102', '1', [{ id: 1, name: '講義1.pdf', size: 9, allow_download: true, link: null }]);
    expect(listFiles(env.db, {})[0]?.status).toBe('done');
    expect(listFiles(env.db, {})[0]?.hash).toBe(sha('lecture-1'));
    registerUploads(env.ctx, 'material:102', '1', [{ id: 1, name: '講義1.pdf', size: 20, allow_download: true, link: null }]);
    expect(listFiles(env.db, {})[0]?.status).toBe('pending');
    expect(listFiles(env.db, {})[0]?.hash).toBe(sha('lecture-1'));
  });

  it('marks a failed download with a reason, continues, and retries next time', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[2] = 'ok';
    upsertFile(env.db, fileRow({ upload_id: '1', name: 'a.pdf' }));
    upsertFile(env.db, fileRow({ upload_id: '2', name: 'b.pdf' }));
    const r = await downloadPending(env.ctx); // blob 1 missing -> 404
    expect(r.done).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.name).toBe('a.pdf');
    expect(r.failed[0]?.reason).toContain('404');
    expect(listFiles(env.db, { status: 'failed' })).toHaveLength(1);
    const dir = join(env.root, 'files', '115-1', '資料結構', '教材');
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);

    env.fake.data.blobs[1] = 'now-here';
    const r2 = await downloadPending(env.ctx);
    expect(r2).toEqual({ done: 1, failed: [] });
    expect(listFiles(env.db, {}).every((f) => f.status === 'done')).toBe(true);
  });

  it('gives same-named files from different uploads separate paths', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[1] = 'one';
    env.fake.data.blobs[2] = 'two';
    upsertFile(env.db, fileRow({ upload_id: '1', name: 'same.pdf' }));
    upsertFile(env.db, fileRow({ upload_id: '2', name: 'same.pdf' }));
    await downloadPending(env.ctx);
    const rows = listFiles(env.db, {});
    expect(new Set(rows.map((r) => r.local_path)).size).toBe(2);
    for (const r of rows) {
      expect(readFileSync(join(env.root, r.local_path ?? ''), 'utf8')).toBe(r.upload_id === '1' ? 'one' : 'two');
    }
  });

  it('reports progress and respects an aborted signal without leaving .part files', async () => {
    const env = makeEnv();
    seed(env, 'material:102', 'material');
    env.fake.data.blobs[1] = 'abc';
    upsertFile(env.db, fileRow({ upload_id: '1' }));
    const seen: { filesDone: number; filesTotal: number; bytes: number }[] = [];
    env.ctx.onProgress = (p) => seen.push({ filesDone: p.filesDone, filesTotal: p.filesTotal, bytes: p.bytes });
    await downloadPending(env.ctx);
    expect(seen.at(-1)).toEqual({ filesDone: 1, filesTotal: 1, bytes: 3 });

    upsertFile(env.db, fileRow({ upload_id: '2', name: 'x.pdf' }));
    env.fake.data.blobs[2] = 'x';
    const ac = new AbortController();
    ac.abort();
    await expect(downloadPending(env.ctx, ac.signal)).rejects.toThrow();
    const dir = join(env.root, 'files', '115-1', '資料結構', '教材');
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(listFiles(env.db, {}).find((f) => f.upload_id === '2')?.status).toBe('pending');
  });
});
