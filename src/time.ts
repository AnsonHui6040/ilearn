export const TZ = 'Asia/Taipei';

// Asia/Taipei has no DST; fixed UTC+8 since 1979.
const OFFSET_MS = 8 * 3600_000;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function taipeiParts(d: Date): { y: number; m: number; d: number; hh: number; mm: number; weekday: number } {
  const s = new Date(d.getTime() + OFFSET_MS);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth() + 1,
    d: s.getUTCDate(),
    hh: s.getUTCHours(),
    mm: s.getUTCMinutes(),
    weekday: s.getUTCDay(),
  };
}

/** "2026-10-22T01:12:40+08:00" */
export function toTaipeiIso(d: Date): string {
  const s = new Date(d.getTime() + OFFSET_MS);
  return (
    `${pad(s.getUTCFullYear(), 4)}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}` +
    `T${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}+08:00`
  );
}

/** 台北牆上時間 → Date */
export function taipeiDate(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFFSET_MS);
}

/** "P1D" → 86400000，"PT3H" → 10800000。支援 D、H、M、S（不含年月週）。 */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
  if (!m || s === 'P' || s.endsWith('T')) throw new Error(`無效的時間長度：${s}`);
  const [, d, h, mi, se] = m;
  return (
    (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(se ?? 0)) * 1000
  );
}
