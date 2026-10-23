import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliExit } from '../cli/context.js';

/** 背景服務：由系統排程每 5 分鐘執行一次 `ilearn run`。 */

export interface ServiceSpec {
  /** Node 的絕對路徑 */
  node: string;
  /** dist/cli/index.js 的絕對路徑 */
  script: string;
  /** 資料根 */
  root: string;
  /** 資料根由 ILEARN_HOME 指定時，排程也要帶上 */
  customRoot: boolean;
}

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  run(cmd: string, args: string[], input?: string): { code: number; stdout: string; stderr: string };
  writeFile(path: string, data: string): void;
  removeFile(path: string): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
}

export type ServiceMethod = 'launchd' | 'systemd' | 'cron' | 'schtasks';

export interface ServiceStatus {
  installed: boolean;
  method: ServiceMethod | null;
  detail: string;
}

const LABEL = 'thu-ilearn.run';
const UNIT = 'thu-ilearn';
const TASK = 'thu-ilearn';
export const CRON_MARK = '# thu-ilearn';

const logFile = (spec: ServiceSpec): string => join(spec.root, 'logs', 'run.log');
const plistPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitDir = (home: string): string => join(home, '.config', 'systemd', 'user');

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function quoted(p: string): string {
  if (p.includes('"')) throw new CliExit(1, `路徑含有雙引號，無法建立排程：${p}`);
  return `"${p}"`;
}

export function launchdPlist(spec: ServiceSpec): string {
  const env = spec.customRoot
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ILEARN_HOME</key>\n    <string>${xml(spec.root)}</string>\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.script)}</string>
    <string>run</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
${env}  <key>StandardOutPath</key>
  <string>${xml(logFile(spec))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile(spec))}</string>
</dict>
</plist>
`;
}

export function systemdUnits(spec: ServiceSpec): { service: string; timer: string } {
  const env = spec.customRoot ? `Environment=${quoted(`ILEARN_HOME=${spec.root}`)}\n` : '';
  return {
    service: `[Unit]
Description=thu-ilearn 同步與提醒

[Service]
Type=oneshot
${env}ExecStart=${quoted(spec.node)} ${quoted(spec.script)} run
StandardOutput=append:${logFile(spec)}
StandardError=append:${logFile(spec)}
`,
    timer: `[Unit]
Description=每 5 分鐘執行 thu-ilearn

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

function cronLine(spec: ServiceSpec): string {
  const env = spec.customRoot ? `ILEARN_HOME=${quoted(spec.root)} ` : '';
  return `*/5 * * * * ${env}${quoted(spec.node)} ${quoted(spec.script)} run >> ${quoted(logFile(spec))} 2>&1 ${CRON_MARK}`;
}

function must(r: { code: number; stderr: string }, what: string): void {
  if (r.code !== 0) throw new CliExit(1, `${what}失敗：${r.stderr.trim() || `exit code ${r.code}`}`);
}

const hasSystemd = (d: ServiceDeps): boolean => d.run('systemctl', ['--user', 'show-environment']).code === 0;

function readCrontab(d: ServiceDeps): string[] {
  const r = d.run('crontab', ['-l']);
  // 沒有 crontab 時 exit code 不為 0，視為空白
  return r.code === 0 ? r.stdout.split('\n').filter((l) => l !== '') : [];
}

function writeCrontab(d: ServiceDeps, lines: string[]): void {
  must(d.run('crontab', ['-'], lines.length ? `${lines.join('\n')}\n` : ''), '更新 crontab ');
}

export function installService(d: ServiceDeps, spec: ServiceSpec): { method: ServiceMethod; detail: string } {
  d.mkdir(join(spec.root, 'logs'));
  switch (d.platform) {
    case 'darwin': {
      const plist = plistPath(d.home);
      d.mkdir(join(d.home, 'Library', 'LaunchAgents'));
      d.writeFile(plist, launchdPlist(spec));
      d.run('launchctl', ['bootout', `gui/${d.uid}/${LABEL}`]); // 舊的設定先卸載，未載入時會失敗，可忽略
      must(d.run('launchctl', ['bootstrap', `gui/${d.uid}`, plist]), '載入 LaunchAgent ');
      return { method: 'launchd', detail: `已建立 ${plist}` };
    }
    case 'linux': {
      if (hasSystemd(d)) {
        const dir = unitDir(d.home);
        const u = systemdUnits(spec);
        d.mkdir(dir);
        d.writeFile(join(dir, `${UNIT}.service`), u.service);
        d.writeFile(join(dir, `${UNIT}.timer`), u.timer);
        must(d.run('systemctl', ['--user', 'daemon-reload']), '重新載入 systemd ');
        must(d.run('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]), '啟用 systemd timer ');
        return {
          method: 'systemd',
          detail: `已建立 ${UNIT}.timer。如果這是 VPS，登出後要繼續執行，請自己執行 loginctl enable-linger`,
        };
      }
      const lines = readCrontab(d).filter((l) => !l.includes(CRON_MARK));
      writeCrontab(d, [...lines, cronLine(spec)]);
      return { method: 'cron', detail: '已加入 crontab' };
    }
    case 'win32': {
      if (spec.customRoot) throw new CliExit(1, 'Windows 尚未支援以 ILEARN_HOME 自訂資料位置的背景服務');
      must(
        d.run('schtasks', ['/Create', '/TN', TASK, '/SC', 'MINUTE', '/MO', '5', '/TR', `${quoted(spec.node)} ${quoted(spec.script)} run`, '/F']),
        '建立工作排程器工作 ',
      );
      return { method: 'schtasks', detail: `已建立工作排程器工作 ${TASK}` };
    }
    default:
      throw new CliExit(1, '這個作業系統尚未支援背景服務');
  }
}

export function serviceStatus(d: ServiceDeps): ServiceStatus {
  switch (d.platform) {
    case 'darwin': {
      if (!d.exists(plistPath(d.home))) return { installed: false, method: null, detail: '未安裝' };
      const loaded = d.run('launchctl', ['print', `gui/${d.uid}/${LABEL}`]).code === 0;
      return loaded
        ? { installed: true, method: 'launchd', detail: '已安裝（LaunchAgent）' }
        : { installed: false, method: 'launchd', detail: '有設定檔但未載入，請重新安裝' };
    }
    case 'linux': {
      if (d.exists(join(unitDir(d.home), `${UNIT}.timer`))) {
        const active = d.run('systemctl', ['--user', 'is-active', `${UNIT}.timer`]).code === 0;
        return active
          ? { installed: true, method: 'systemd', detail: '已安裝（systemd timer）' }
          : { installed: false, method: 'systemd', detail: 'timer 未啟用，請重新安裝' };
      }
      return readCrontab(d).some((l) => l.includes(CRON_MARK))
        ? { installed: true, method: 'cron', detail: '已安裝（crontab）' }
        : { installed: false, method: null, detail: '未安裝' };
    }
    case 'win32':
      return d.run('schtasks', ['/Query', '/TN', TASK]).code === 0
        ? { installed: true, method: 'schtasks', detail: '已安裝（工作排程器）' }
        : { installed: false, method: null, detail: '未安裝' };
    default:
      return { installed: false, method: null, detail: '這個作業系統尚未支援背景服務' };
  }
}

export function uninstallService(d: ServiceDeps): string {
  switch (d.platform) {
    case 'darwin': {
      d.run('launchctl', ['bootout', `gui/${d.uid}/${LABEL}`]);
      const plist = plistPath(d.home);
      if (!d.exists(plist)) return '沒有安裝背景服務';
      d.removeFile(plist);
      return '已移除背景服務';
    }
    case 'linux': {
      const dir = unitDir(d.home);
      if (d.exists(join(dir, `${UNIT}.timer`))) {
        d.run('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]);
        d.removeFile(join(dir, `${UNIT}.timer`));
        d.removeFile(join(dir, `${UNIT}.service`));
        d.run('systemctl', ['--user', 'daemon-reload']);
        return '已移除背景服務';
      }
      const lines = readCrontab(d);
      if (!lines.some((l) => l.includes(CRON_MARK))) return '沒有安裝背景服務';
      writeCrontab(d, lines.filter((l) => !l.includes(CRON_MARK)));
      return '已移除背景服務';
    }
    case 'win32':
      return d.run('schtasks', ['/Delete', '/TN', TASK, '/F']).code === 0 ? '已移除背景服務' : '沒有安裝背景服務';
    default:
      throw new CliExit(1, '這個作業系統尚未支援背景服務');
  }
}

export function defaultServiceDeps(): ServiceDeps {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    run: (cmd, args, input) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', ...(input !== undefined ? { input } : {}) });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
    },
    writeFile: (p, data) => writeFileSync(p, data, { mode: 0o644 }),
    removeFile: (p) => rmSync(p, { force: true }),
    exists: (p) => existsSync(p),
    mkdir: (p) => void mkdirSync(p, { recursive: true }),
  };
}

/**
 * PATH 中指向同一個 Node 的連結（例如 Homebrew 的 /opt/homebrew/bin/node），
 * 升級 Node 後仍然有效；找不到時沿用目前執行中的 Node。
 */
export function stableNodePath(execPath: string, pathEnv: string | undefined, realpath: (p: string) => string | null): string {
  const target = realpath(execPath);
  if (target === null) return execPath;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    if (candidate !== execPath && realpath(candidate) === target) return candidate;
  }
  return execPath;
}

const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** 以目前執行中的 Node 與這份程式建立排程。 */
export function defaultServiceSpec(root: string): ServiceSpec {
  return {
    node: stableNodePath(process.execPath, process.env.PATH, realpathOrNull),
    script: fileURLToPath(new URL('../cli/index.js', import.meta.url)),
    root,
    customRoot: Boolean(process.env.ILEARN_HOME),
  };
}
