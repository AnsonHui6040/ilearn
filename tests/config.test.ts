import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config/config.js';
import { dataRoot } from '../src/config/paths.js';
import { THU_PERIOD_TIMES } from '../src/domain/schedule.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilearn-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ILEARN_HOME;
});

describe('config', () => {
  it('loadConfig on empty dir returns defaults', () => {
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it('舊設定檔的 period_times 為空時沿用東海節次時間', () => {
    writeFileSync(join(dir, 'config.yaml'), 'period_times: {}\n');
    expect(loadConfig(dir).period_times).toEqual(THU_PERIOD_TIMES);
  });

  it('checks for updates once a day by default, also for an old config file', () => {
    expect(DEFAULT_CONFIG.updates).toEqual({ check: 'daily' });
    writeFileSync(join(dir, 'config.yaml'), 'environment: desktop\n');
    expect(loadConfig(dir).updates.check).toBe('daily');
  });

  it('saveConfig writes 0600 file in 0700 dir and round-trips', () => {
    const root = join(dir, 'home');
    const cfg = { ...DEFAULT_CONFIG, password_saved: true };
    saveConfig(cfg, root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'config.yaml')).mode & 0o777).toBe(0o600);
    expect(loadConfig(root)).toEqual(cfg);
  });

  it('fills missing fields with defaults', () => {
    writeFileSync(join(dir, 'config.yaml'), 'quiet_hours:\n  start: "01:00"\n');
    const cfg = loadConfig(dir);
    expect(cfg.quiet_hours).toEqual({ start: '01:00', end: '07:00' });
    expect(cfg.reminders.offsets).toEqual(['P1D', 'PT3H']);
  });

  it('loads a stale files.download_disallowed key without error', () => {
    writeFileSync(join(dir, 'config.yaml'), 'files:\n  download_disallowed: download\n');
    expect(() => loadConfig(dir)).not.toThrow();
  });

  it('ILEARN_HOME overrides dataRoot', () => {
    process.env.ILEARN_HOME = '/tmp/xyz-ilearn';
    expect(dataRoot()).toBe('/tmp/xyz-ilearn');
  });
});
