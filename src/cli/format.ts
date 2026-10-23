import type { PendingSummaries } from '../summaries/summaries.js';
import type { IlearnEvent } from '../types.js';
import type { announcementsCommand, coursesCommand, courseCommand, filesSearchCommand, gradesCommand, statusCommand, tasksCommand } from './commands/query.js';

type Ret<T extends (...a: never[]) => unknown> = ReturnType<T>;

const short = (iso: string | null): string => (iso === null ? '無' : iso.slice(5, 16).replace('T', ' '));

export function tasksText(r: Ret<typeof tasksCommand>): string {
  const lines: string[] = [];
  if (r.initial_sync_in_progress) lines.push('首次同步進行中，以下清單可能不完整');
  if (r.incomplete_courses.length > 0) lines.push(`資料可能不完整的課程：${r.incomplete_courses.join('、')}`);
  if (r.tasks.length === 0) lines.push('目前沒有未完成的作業或影片');
  for (const t of r.tasks) {
    const tag = t.kind === 'video' ? '影片' : '作業';
    const flags = [t.not_started ? '尚未開放' : '', t.overdue ? '已逾期' : '', t.teammate_hint ? '隊員可能已交' : ''].filter(Boolean).join('，');
    lines.push(`${short(t.due_at)}  ${t.course ?? ''}  ${tag}：${t.title}${flags ? `（${flags}）` : ''}  ${t.id}`);
  }
  return lines.join('\n');
}

export function eventsText(events: IlearnEvent[]): string {
  if (events.length === 0) return '沒有事件';
  return events
    .map((e) => `${e.event_id}  ${e.detected_at.slice(5, 16).replace('T', ' ')}  ${e.type}  ${e.course?.name ?? '系統'}  ${e.item?.title ?? ''}`.trimEnd())
    .join('\n');
}

export function coursesText(rows: Ret<typeof coursesCommand>): string {
  if (rows.length === 0) return '還沒有課程資料，請先執行 ilearn sync';
  return rows.map((c) => `${c.id}  ${c.semester}  ${c.name}${c.current ? '' : '（保留）'}`).join('\n');
}

export function courseText(r: Ret<typeof courseCommand>): string {
  const lines = [`${r.course.name}（${r.course.semester}）`];
  if (r.schedule.text) lines.push(`上課時間：${r.schedule.text}`);
  lines.push(`待辦 ${r.todo.length}，已完成 ${r.completed.length}，考試 ${r.exams.length}，公告 ${r.announcements.length}，檔案 ${r.files.length}`);
  for (const t of r.todo) lines.push(`  待辦 ${short(t.due_at)}  ${t.title}`);
  for (const e of r.exams) lines.push(`  考試 ${short(e.start_at)}  ${e.title}`);
  return lines.join('\n');
}

export function announcementsText(rows: Ret<typeof announcementsCommand>): string {
  if (rows.length === 0) return '沒有符合的公告';
  return rows.map((a) => `${short(a.posted_at)}  ${a.course ?? ''}  ${a.title}  [${a.categories.join(',')}]`).join('\n');
}

export function gradesText(rows: Ret<typeof gradesCommand>): string {
  if (rows.length === 0) return '目前沒有分數';
  return rows.map((g) => `${g.course ?? ''}  ${g.title}  ${g.score}${g.score_published ? '' : '（未公布）'}`).join('\n');
}

export function filesText(rows: Ret<typeof filesSearchCommand>): string {
  if (rows.length === 0) return '找不到符合的檔案';
  return rows.map((f) => `${f.id}  ${f.course ?? ''}  ${f.name}  ${f.local_path ?? f.link ?? f.status}`).join('\n');
}

export function statusText(s: Ret<typeof statusCommand>): string {
  const lines = [
    `帳號：${s.username ?? '尚未登入'}`,
    `環境：${s.environment === 'vps' ? 'VPS' : '桌面'}`,
    `最近同步：${s.last_sync_at ?? '尚未同步'}`,
  ];
  if (s.initial_sync_in_progress) {
    const p = s.first_sync_progress;
    lines.push(`首次同步進行中：課程 ${p?.courses_done ?? 0}/${p?.courses_total ?? '?'}，檔案 ${p?.files_done ?? 0}/${p?.files_total ?? 0}`);
  }
  if (s.incomplete_courses.length > 0) lines.push(`資料可能不完整的課程：${s.incomplete_courses.join('、')}`);
  lines.push(`檔案：已下載 ${s.files.done}，待下載 ${s.files.pending}，失敗 ${s.files.failed}，略過 ${s.files.skipped}`);
  if (s.last_error) lines.push(`最近錯誤（${s.last_error.at}）：${s.last_error.message}`);
  for (const [name, d] of [['本機指令 hook', s.delivery.hook], ['本機 webhook', s.delivery.webhook]] as const) {
    if (!d.enabled && d.retrying === 0 && d.gave_up === 0) continue;
    const parts = [d.enabled ? '已啟用' : '已停用'];
    if (d.retrying > 0) parts.push(`重試中 ${d.retrying} 則`);
    if (d.gave_up > 0) parts.push(`超過 24 小時放棄 ${d.gave_up} 則（outbox 仍保留）`);
    if (d.last_error && (d.retrying > 0 || d.gave_up > 0)) parts.push(`最近錯誤：${d.last_error}`);
    lines.push(`${name}：${parts.join('，')}`);
  }
  if (s.rules_warning) lines.push(`注意：${s.rules_warning}`);
  return lines.join('\n');
}

export function pendingSummariesText(r: PendingSummaries): string {
  const lines = [r.agent_write ? 'agent 可寫入摘要' : 'agent 目前不可寫入摘要（使用者可在 ilearn setup 第 8 步或 ilearn ui 開啟）'];
  lines.push(`今天還可以寫 ${r.remaining_today} 則，待摘要 ${r.pending.length} 則`);
  for (const t of r.pending) lines.push(`${t.target_id}  ${t.kind === 'material' ? '教材' : '公告'}  ${t.course.name}  ${t.title}`);
  return lines.join('\n');
}
