import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { ensureDir } from '../config/paths.js';
import { listFiles, upsertFile, type StoredFile } from '../db/repo.js';
import type { ApiUpload } from '../ilearn/api.js';
import type { SyncContext } from './sync.js';

type FileCtx = Pick<SyncContext, 'db'>;

/** 檔名及資料夾名：去掉路徑字元、控制字元及開頭的點。 */
export function sanitizeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned === '' ? '_' : cleaned;
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** 把活動／公告的附件登記到 files 表。已完成的檔案保留 hash 與路徑，大小改變才重新排隊。 */
export function registerUploads(ctx: FileCtx, itemId: string, courseId: string, uploads: ApiUpload[]): void {
  if (uploads.length === 0) return;
  const existing = new Map(listFiles(ctx.db, { course_id: courseId }).map((f) => [f.upload_id, f]));

  for (const u of uploads) {
    const id = String(u.id);
    const link = u.link ? u.link : null;
    const allow = u.allow_download !== false;
    const wanted: StoredFile['status'] = link ? 'link' : !allow ? 'skipped' : 'pending';
    const prev = existing.get(id);

    if (!prev) {
      upsertFile(ctx.db, {
        upload_id: id, item_id: itemId, course_id: courseId, name: u.name, size: u.size ?? 0,
        hash: null, local_path: null, status: wanted, link, allow_download: allow,
      });
      continue;
    }

    let status = prev.status;
    if (wanted === 'link' || wanted === 'skipped') {
      if (prev.status !== 'done') status = wanted;
    } else if (prev.status === 'skipped' || prev.status === 'link') {
      status = 'pending';
    } else if (prev.status === 'done') {
      const sizeChanged = u.size != null && u.size !== prev.size;
      if (sizeChanged || u.name !== prev.name) status = 'pending';
    }
    upsertFile(ctx.db, {
      ...prev, item_id: itemId, name: u.name, size: u.size ?? prev.size, status, link, allow_download: allow,
    });
  }
}

interface FileContext {
  courseName: string;
  semester: string;
  kind: string | null;
}

function category(kind: string | null): string {
  if (kind === 'announcement') return '公告';
  if (kind === 'assignment') return '作業';
  return '教材';
}

function targetRel(ctx: SyncContext, f: StoredFile): string {
  const info = ctx.db
    .prepare(
      `SELECT c.name AS courseName, c.semester AS semester, i.kind AS kind
       FROM files f LEFT JOIN courses c ON c.id = f.course_id LEFT JOIN items i ON i.id = f.item_id
       WHERE f.upload_id = ?`,
    )
    .get(f.upload_id) as unknown as Partial<FileContext> | undefined;
  if (!info?.courseName || !info.semester) throw new Error('找不到檔案所屬的課程');

  const dir = join('files', sanitizeName(info.semester), sanitizeName(info.courseName), category(info.kind ?? null));
  let name = sanitizeName(f.name);
  const clash = ctx.db
    .prepare('SELECT 1 AS x FROM files WHERE local_path = ? AND upload_id != ?')
    .get(join(dir, name), f.upload_id);
  if (clash) {
    const ext = extname(name);
    name = `${basename(name, ext)} (${f.upload_id})${ext}`;
  }
  return join(dir, name);
}

async function fetchToPart(ctx: SyncContext, f: StoredFile, part: string, signal?: AbortSignal): Promise<{ hash: string; bytes: number }> {
  const res = await ctx.api.downloadUpload(Number(f.upload_id));
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`下載失敗：HTTP ${res.status}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const source = res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>) : Readable.from([]);
  const out = createWriteStream(part, { mode: 0o600 });
  await pipeline(source, tap, out, signal ? { signal } : {});
  chmodSync(part, 0o600);
  return { hash: hash.digest('hex'), bytes };
}

/** 下載單一檔案；回傳位元組數。內容相同不重寫；不同則舊檔移入 .versions。 */
async function downloadOne(ctx: SyncContext, f: StoredFile, signal?: AbortSignal): Promise<number> {
  const rel = targetRel(ctx, f);
  const abs = join(ctx.root, rel);
  const dir = dirname(abs);
  ensureDir(dir);
  const part = `${abs}.part`;

  try {
    const { hash, bytes } = await fetchToPart(ctx, f, part, signal);
    if (existsSync(abs)) {
      const oldHash = sha256(readFileSync(abs));
      if (oldHash === hash) {
        rmSync(part, { force: true });
        upsertFile(ctx.db, { ...f, hash, local_path: rel, status: 'done' });
        return bytes;
      }
      const versions = join(dir, '.versions');
      ensureDir(versions);
      renameSync(abs, join(versions, `${basename(abs)}.${oldHash.slice(0, 8)}`));
    }
    renameSync(part, abs);
    upsertFile(ctx.db, { ...f, hash, local_path: rel, status: 'done' });
    return bytes;
  } finally {
    rmSync(part, { force: true });
  }
}

/** 內部用：多一個課程進度參數，供 runSync 回報。 */
export async function downloadFiles(
  ctx: SyncContext,
  signal: AbortSignal | undefined,
  courses: { done: number; total: number },
): Promise<{ done: number; failed: { name: string; reason: string }[] }> {
  const queued = [...listFiles(ctx.db, { status: 'pending' }), ...listFiles(ctx.db, { status: 'failed' })];
  // 老師關閉下載的檔案一律不請求；舊資料若還排在佇列，這裡改記為略過
  for (const f of queued) if (!f.allow_download) upsertFile(ctx.db, { ...f, status: 'skipped' });
  const rows = queued
    .filter((f) => f.allow_download)
    .sort((a, b) => (a.upload_id < b.upload_id ? -1 : a.upload_id > b.upload_id ? 1 : 0));
  const failed: { name: string; reason: string }[] = [];
  let done = 0;
  let bytes = 0;
  const report = (): void =>
    ctx.onProgress?.({
      coursesDone: courses.done, coursesTotal: courses.total, filesDone: done, filesTotal: rows.length, bytes,
    });
  report();

  for (const f of rows) {
    signal?.throwIfAborted();
    try {
      bytes += await downloadOne(ctx, f, signal);
      done++;
    } catch (e) {
      if (isAbort(e)) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      upsertFile(ctx.db, { ...f, status: 'failed' });
      failed.push({ name: f.name, reason });
    }
    report();
  }
  return { done, failed };
}

export function downloadPending(
  ctx: SyncContext,
  signal?: AbortSignal,
): Promise<{ done: number; failed: { name: string; reason: string }[] }> {
  return downloadFiles(ctx, signal, { done: 0, total: 0 });
}
