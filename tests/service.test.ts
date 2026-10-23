import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceInstallCommand, serviceUninstallCommand } from '../src/cli/commands/service.js';
import { CliExit, writeAccount } from '../src/cli/context.js';
import {
  CRON_MARK,
  installService,
  launchdPlist,
  serviceStatus,
  stableNodePath,
  systemdUnits,
  uninstallService,
  type ServiceDeps,
  type ServiceSpec,
} from '../src/service/service.js';

const spec: ServiceSpec = {
  node: '/opt/homebrew/bin/node',
  script: '/Users/a b/thu-ilearn/dist/cli/index.js',
  root: '/Users/a b/.thu-ilearn',
  customRoot: false,
};

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

function fakeDeps(platform: NodeJS.Platform, results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
  const files = new Map<string, string>();
  const calls: Call[] = [];
  const deps: ServiceDeps = {
    platform,
    home: '/Users/a b',
    uid: 501,
    run: (cmd, args, input) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      const key = `${cmd} ${args.join(' ')}`;
      const hit = Object.entries(results).find(([k]) => key.startsWith(k));
      const r = hit?.[1] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    writeFile: (p, data) => void files.set(p, data),
    removeFile: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    mkdir: () => {},
  };
  return { deps, files, calls };
}

const PLIST = '/Users/a b/Library/LaunchAgents/thu-ilearn.run.plist';
const UNIT_DIR = '/Users/a b/.config/systemd/user';

describe('launchdPlist', () => {
  it('runs ilearn run every 5 minutes with absolute paths and a log file', () => {
    const xml = launchdPlist(spec);
    expect(xml).toContain('<string>thu-ilearn.run</string>');
    expect(xml).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(xml).toContain('<string>/Users/a b/thu-ilearn/dist/cli/index.js</string>');
    expect(xml).toContain('<string>run</string>');
    expect(xml).toContain('<key>StartInterval</key>\n  <integer>300</integer>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<string>/Users/a b/.thu-ilearn/logs/run.log</string>');
    expect(xml).not.toContain('ILEARN_HOME');
  });

  it('passes a custom data root and escapes XML characters', () => {
    const xml = launchdPlist({ ...spec, root: '/tmp/a&b<c', customRoot: true });
    expect(xml).toContain('<key>ILEARN_HOME</key>');
    expect(xml).toContain('<string>/tmp/a&amp;b&lt;c</string>');
  });
});

describe('systemdUnits', () => {
  it('builds a oneshot service and a persistent 5-minute timer', () => {
    const u = systemdUnits(spec);
    expect(u.service).toContain('Type=oneshot');
    expect(u.service).toContain('ExecStart="/opt/homebrew/bin/node" "/Users/a b/thu-ilearn/dist/cli/index.js" run');
    expect(u.timer).toContain('OnUnitActiveSec=5min');
    expect(u.timer).toContain('Persistent=true');
    expect(u.timer).toContain('WantedBy=timers.target');
  });
});

describe('macOS', () => {
  it('installs a LaunchAgent and loads it', () => {
    const { deps, files, calls } = fakeDeps('darwin', { 'launchctl bootout': { code: 3 } });
    const r = installService(deps, spec);
    expect(r.method).toBe('launchd');
    expect(files.get(PLIST)).toContain('thu-ilearn.run');
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      'launchctl bootout gui/501/thu-ilearn.run',
      `launchctl bootstrap gui/501 ${PLIST}`,
    ]);
  });

  it('reports a failed load with the system message', () => {
    const { deps } = fakeDeps('darwin', { 'launchctl bootstrap': { code: 5, stderr: 'Input/output error' } });
    expect(() => installService(deps, spec)).toThrow(CliExit);
    expect(() => installService(deps, spec)).toThrow(/Input\/output error/);
  });

  it('shows status and uninstalls', () => {
    const { deps, files, calls } = fakeDeps('darwin');
    expect(serviceStatus(deps)).toMatchObject({ installed: false, method: null });
    installService(deps, spec);
    expect(serviceStatus(deps)).toMatchObject({ installed: true, method: 'launchd' });
    calls.length = 0;
    uninstallService(deps);
    expect(files.has(PLIST)).toBe(false);
    expect(calls[0]).toEqual({ cmd: 'launchctl', args: ['bootout', 'gui/501/thu-ilearn.run'] });
  });
});

describe('Linux', () => {
  it('uses a systemd user timer when available', () => {
    const { deps, files, calls } = fakeDeps('linux');
    const r = installService(deps, spec);
    expect(r.method).toBe('systemd');
    expect(files.get(`${UNIT_DIR}/thu-ilearn.service`)).toContain('Type=oneshot');
    expect(files.get(`${UNIT_DIR}/thu-ilearn.timer`)).toContain('OnUnitActiveSec=5min');
    expect(calls.map((c) => c.args.join(' '))).toContain('--user enable --now thu-ilearn.timer');
    expect(r.detail).toContain('loginctl enable-linger');
  });

  it('falls back to crontab without touching other lines, and reinstalls without duplicates', () => {
    const existing = '0 9 * * * backup.sh\n';
    const { deps, calls } = fakeDeps('linux', {
      'systemctl --user show-environment': { code: 1 },
      'crontab -l': { code: 0, stdout: existing },
    });
    const r = installService(deps, spec);
    expect(r.method).toBe('cron');
    const written = calls.find((c) => c.cmd === 'crontab' && c.args[0] === '-')?.input ?? '';
    expect(written.startsWith('0 9 * * * backup.sh\n')).toBe(true);
    expect(written).toContain(`*/5 * * * * "/opt/homebrew/bin/node" "/Users/a b/thu-ilearn/dist/cli/index.js" run >> "/Users/a b/.thu-ilearn/logs/run.log" 2>&1 ${CRON_MARK}`);

    const again = fakeDeps('linux', { 'systemctl --user show-environment': { code: 1 }, 'crontab -l': { code: 0, stdout: written } });
    installService(again.deps, spec);
    const rewritten = again.calls.find((c) => c.cmd === 'crontab' && c.args[0] === '-')?.input ?? '';
    expect(rewritten.split(CRON_MARK)).toHaveLength(2);
  });

  it('removes only its own crontab line', () => {
    const tab = `0 9 * * * backup.sh\n*/5 * * * * node x run ${CRON_MARK}\n`;
    const { deps, calls } = fakeDeps('linux', { 'systemctl --user show-environment': { code: 1 }, 'crontab -l': { code: 0, stdout: tab } });
    expect(serviceStatus(deps)).toMatchObject({ installed: true, method: 'cron' });
    uninstallService(deps);
    expect(calls.find((c) => c.cmd === 'crontab' && c.args[0] === '-')?.input).toBe('0 9 * * * backup.sh\n');
  });
});

describe('Windows', () => {
  it('creates a scheduled task that runs every 5 minutes', () => {
    const { deps, calls } = fakeDeps('win32');
    const r = installService(deps, { ...spec, node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\thu-ilearn\\dist\\cli\\index.js' });
    expect(r.method).toBe('schtasks');
    expect(calls[0]).toEqual({
      cmd: 'schtasks',
      args: ['/Create', '/TN', 'thu-ilearn', '/SC', 'MINUTE', '/MO', '5', '/TR', '"C:\\Program Files\\nodejs\\node.exe" "C:\\thu-ilearn\\dist\\cli\\index.js" run', '/F'],
    });
  });
});

it('refuses an unsupported platform', () => {
  const { deps } = fakeDeps('aix');
  expect(() => installService(deps, spec)).toThrow('這個作業系統尚未支援背景服務');
});

describe('ilearn service commands', () => {
  const setUpRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'ilearn-svc-'));
    writeAccount(root, { username: 'test-user' }); // 測試用的假帳號，視為已設定
    return root;
  };

  it('install and uninstall only run in an interactive terminal', () => {
    const { deps } = fakeDeps('darwin');
    const root = setUpRoot();
    expect(() => serviceInstallCommand({ isTTY: false, root, deps, spec })).toThrow('安裝背景服務需要在互動終端機執行');
    expect(() => serviceUninstallCommand({ isTTY: false, deps })).toThrow('移除背景服務需要在互動終端機執行');
  });

  it('install needs ilearn setup first', () => {
    const { deps } = fakeDeps('darwin');
    const missing = join(mkdtempSync(join(tmpdir(), 'ilearn-svc-none-')), 'root');
    expect(() => serviceInstallCommand({ isTTY: true, root: missing, deps, spec })).toThrow(expect.objectContaining({ code: 2 }));
  });

  it('installs, reports status and uninstalls', () => {
    const { deps } = fakeDeps('darwin');
    const root = setUpRoot();
    expect(serviceInstallCommand({ isTTY: true, root, deps, spec }).method).toBe('launchd');
    expect(serviceStatus(deps).installed).toBe(true);
    expect(serviceUninstallCommand({ isTTY: true, deps })).toBe('已移除背景服務');
  });
});

describe('stableNodePath', () => {
  const real: Record<string, string> = {
    '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/26.7.0/bin/node',
    '/opt/homebrew/Cellar/node/26.7.0/bin/node': '/opt/homebrew/Cellar/node/26.7.0/bin/node',
    '/usr/local/bin/node': '/usr/local/bin/node',
  };
  const realpath = (p: string): string | null => real[p] ?? null;

  it('prefers the PATH link that survives a Homebrew upgrade', () => {
    expect(stableNodePath('/opt/homebrew/Cellar/node/26.7.0/bin/node', '/usr/bin:/opt/homebrew/bin', realpath)).toBe('/opt/homebrew/bin/node');
  });

  it('keeps the running Node when PATH points to a different one', () => {
    expect(stableNodePath('/opt/homebrew/Cellar/node/26.7.0/bin/node', '/usr/local/bin', realpath)).toBe('/opt/homebrew/Cellar/node/26.7.0/bin/node');
    expect(stableNodePath('/x/node', undefined, realpath)).toBe('/x/node');
  });
});

describe('which program the service runs', () => {
  it('reports the script in the LaunchAgent and warns when it is another copy', () => {
    const { deps } = fakeDeps('darwin');
    installService(deps, spec);
    expect(serviceStatus(deps, spec.script)).toMatchObject({ installed: true, target: spec.script, mismatch: false });
    expect(serviceStatus(deps, '/opt/homebrew/lib/node_modules/thu-ilearn/dist/cli/index.js')).toMatchObject({ target: spec.script, mismatch: true });
  });

  it('reads the script from a systemd unit and from crontab', () => {
    const sd = fakeDeps('linux');
    installService(sd.deps, spec);
    expect(serviceStatus(sd.deps, '/other/index.js')).toMatchObject({ method: 'systemd', target: spec.script, mismatch: true });
    const line = `*/5 * * * * "/n" "${spec.script}" run >> "/l" 2>&1 ${CRON_MARK}\n`;
    const cr = fakeDeps('linux', { 'systemctl --user show-environment': { code: 1 }, 'crontab -l': { code: 0, stdout: line } });
    expect(serviceStatus(cr.deps, spec.script)).toMatchObject({ method: 'cron', target: spec.script, mismatch: false });
  });
});
