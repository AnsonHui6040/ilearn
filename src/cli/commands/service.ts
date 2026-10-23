import { installService, uninstallService, type ServiceDeps, type ServiceMethod, type ServiceSpec } from '../../service/service.js';
import { CliExit, isSetUp, NOT_SET_UP } from '../context.js';

/** 安裝背景服務會修改系統排程，只能由本人在互動終端操作。 */
export function serviceInstallCommand(o: { isTTY: boolean; root: string; deps: ServiceDeps; spec: ServiceSpec }): {
  method: ServiceMethod;
  detail: string;
} {
  if (!o.isTTY) throw new CliExit(1, '安裝背景服務需要在互動終端機執行');
  if (!isSetUp(o.root)) throw new CliExit(2, NOT_SET_UP);
  return installService(o.deps, o.spec);
}

export function serviceUninstallCommand(o: { isTTY: boolean; deps: ServiceDeps }): string {
  if (!o.isTTY) throw new CliExit(1, '移除背景服務需要在互動終端機執行');
  return uninstallService(o.deps);
}
