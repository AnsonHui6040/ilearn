import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentVersion, isNewer, readUpdateStatus } from '../src/update/update.js';

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
