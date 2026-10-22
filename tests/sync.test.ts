import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getItem, getSyncState, listFiles, listItems, markReminderSent, reminderSent } from '../src/db/repo.js';
import { ApiError } from '../src/ilearn/api.js';
import type { ApiSubmission } from '../src/ilearn/api.js';
import { runReminderTick, runSync } from '../src/sync/sync.js';
import type { EventType } from '../src/types.js';
import { makeEnv, type TestEnv } from './helpers/fakeApi.js';

const HOUR = 3600_000;

function of(env: TestEnv, type: EventType) {
  return env.events().filter((e) => e.type === type);
}

async function afterInitial(over: Parameters<typeof makeEnv>[0] = {}): Promise<TestEnv> {
  const env = makeEnv(over);
  await runSync(env.ctx);
  env.clock.now = new Date(env.clock.now.getTime() + HOUR);
  return env;
}

const ownSubmission = (extra: Partial<ApiSubmission> = {}): ApiSubmission => ({
  id: 1, is_draft: false, is_redo: false, created_by: { id: 777 }, uploads: [], ...extra,
});

function markSubmitted(env: TestEnv): void {
  const hw = env.fake.data.homework[1]?.[0];
  if (hw) hw.submitted = true;
  env.fake.data.submissions[101] = [ownSubmission()];
}

describe('initial sync', () => {
  it('writes data, emits only sync.initial_completed, current semester only', async () => {
    const env = makeEnv();
    const report = await runSync(env.ctx);
    const ev = env.events();
    expect(ev.map((e) => e.type)).toEqual(['sync.initial_completed']);
    expect(ev[0]?.delivery).toBe('record');
    expect(report.initial).toBe(true);
    expect(report.courses).toBe(2);
    expect(report.pendingAssignments).toBe(1);
    expect(report.eventsEmitted).toBe(1);
    expect(getSyncState(env.db).initial_completed).toBe(true);
    expect(getSyncState(env.db).in_progress_courses).toEqual([]);
    expect(getSyncState(env.db).last_sync_at).not.toBeNull();
    expect(env.fake.count('activities:9')).toBe(0);

    const ids = listItems(env.db, {}).map((i) => i.id).sort();
    expect(ids).toEqual([
      'announcement:88000', 'assignment:101', 'course_info:1', 'course_info:2', 'course_score:1',
      'course_score:2', 'exam:301', 'material:102', 'video:103',
    ]);
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('pending');
    expect(getItem(env.db, 'assignment:101', 'assignment')?.due_at).toBe('2026-10-30T15:59:00.000Z');
    expect(listFiles(env.db, { status: 'done' })).toHaveLength(3);
  });

  it('suppresses sync.incomplete and does not finish while a course is incomplete', async () => {
    const env = makeEnv();
    env.fake.data.fail['homework:1'] = new ApiError(500, '/api/courses/1/homework-activities');
    const report = await runSync(env.ctx);
    expect(env.events()).toEqual([]);
    expect(report.incompleteCourses).toEqual(['資料結構']);
    const st = getSyncState(env.db);
    expect(st.initial_completed).toBe(false);
    expect(st.incomplete_courses).toEqual(['1']);
    expect(st.in_progress_courses).toEqual(['2']);

    delete env.fake.data.fail['homework:1'];
    await runSync(env.ctx);
    expect(of(env, 'sync.initial_completed')).toHaveLength(1);
    expect(env.events()).toHaveLength(1);
    expect(env.fake.count('activities:2')).toBe(1); // finished course is not refetched
    expect(getSyncState(env.db).initial_completed).toBe(true);
  });

  it('resumes after an AbortError without refetching finished courses', async () => {
    const env = makeEnv();
    env.fake.data.hooks['activities:2'] = () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(runSync(env.ctx)).rejects.toThrow('aborted');
    expect(env.events()).toEqual([]);
    expect(getSyncState(env.db).in_progress_courses).toEqual(['1']);
    expect(getSyncState(env.db).initial_completed).toBe(false);

    delete env.fake.data.hooks['activities:2'];
    await runSync(env.ctx);
    expect(env.fake.count('activities:1')).toBe(1);
    expect(env.fake.count('course:1')).toBe(1);
    expect(env.fake.count('activities:2')).toBe(2);
    expect(of(env, 'sync.initial_completed')).toHaveLength(1);
    expect(env.events()).toHaveLength(1);
    expect(env.fake.count('downloadUpload:5001')).toBe(1);
  });
});

describe('later syncs', () => {
  it('announcement 改至 M201 emits one announcement.new with room_change', async () => {
    const env = await afterInitial();
    env.fake.data.bulletins[1]?.push({
      id: 88001, title: '改至 M201 上課', content: '<p>下週起</p>', created_at: '2026-10-22T04:30:00Z',
    });
    await runSync(env.ctx);
    await runSync(env.ctx);
    const evs = of(env, 'announcement.new');
    expect(evs).toHaveLength(1);
    const e = evs[0];
    expect(e?.categories).toContain('room_change');
    expect(e?.delivery).toBe('push');
    expect(e?.dedupe_key).toBe('announcement.new:announcement:88001');
    expect(e?.item?.id).toBe('announcement:88001');
    expect(e?.course).toEqual({ id: '1', name: '資料結構', semester: '115-1' });
  });

  it('new assignment emits assignment.new; first-seen already-submitted one does not', async () => {
    const env = await afterInitial();
    env.fake.data.activities[1]?.push(
      { id: 105, type: 'homework', title: '作業二', end_time: '2026-11-10T15:59:00Z', published: true },
      { id: 106, type: 'homework', title: '作業三', end_time: '2026-11-11T15:59:00Z', published: true },
    );
    env.fake.data.homework[1]?.push(
      { id: 105, title: '作業二', end_time: '2026-11-10T15:59:00Z', submit_by_group: false, submitted: false,
        submitted_status: null, is_closed: false, score: null, score_published: false },
      { id: 106, title: '作業三', end_time: '2026-11-11T15:59:00Z', submit_by_group: false, submitted: true,
        submitted_status: 'submitted', is_closed: false, score: null, score_published: false },
    );
    env.fake.data.submissions[106] = [ownSubmission()];
    await runSync(env.ctx);
    const evs = of(env, 'assignment.new');
    expect(evs.map((e) => e.item?.title)).toEqual(['作業二']);
    expect(evs[0]?.item?.due_at).toBe('2026-11-10T23:59:00+08:00');
    expect(getItem(env.db, 'assignment:106', 'assignment')?.completion).toBe('completed');
  });

  it('homework() 500 keeps assignments and completion, emits sync.incomplete', async () => {
    const env = await afterInitial();
    markSubmitted(env);
    await runSync(env.ctx);
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('completed');
    env.fake.data.fail['homework:1'] = new ApiError(500, '/api/courses/1/homework-activities');
    env.fake.data.homework[1] = [];
    env.fake.data.activities[1] = (env.fake.data.activities[1] ?? []).filter((a) => a.type !== 'homework');
    const report = await runSync(env.ctx);
    expect(listItems(env.db, { kind: 'assignment' })).toHaveLength(1);
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('completed');
    const inc = of(env, 'sync.incomplete');
    expect(inc).toHaveLength(1);
    expect(inc[0]?.delivery).toBe('push');
    expect(inc[0]?.course?.id).toBe('1');
    expect(report.incompleteCourses).toEqual(['資料結構']);
    expect(getSyncState(env.db).incomplete_courses).toEqual(['1']);
    expect(of(env, 'assignment.returned')).toHaveLength(0);
  });

  it('emits assignment.returned once when a completed assignment loses its submission', async () => {
    const env = makeEnv();
    markSubmitted(env);
    await runSync(env.ctx);
    env.clock.now = new Date(env.clock.now.getTime() + HOUR);
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('completed');

    env.fake.data.submissions[101] = [];
    await runSync(env.ctx);
    expect(of(env, 'assignment.returned')).toHaveLength(1);
    expect(of(env, 'assignment.returned')[0]?.delivery).toBe('push');
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('pending');
    env.clock.now = new Date(env.clock.now.getTime() + HOUR);
    await runSync(env.ctx);
    expect(of(env, 'assignment.returned')).toHaveLength(1);
  });

  it('submissions() failure leaves state unchanged and emits no returned', async () => {
    const env = makeEnv();
    markSubmitted(env);
    await runSync(env.ctx);
    env.clock.now = new Date(env.clock.now.getTime() + HOUR);
    env.fake.data.fail['submissions:101'] = new ApiError(504, '/api/activities/101/students/777/submission_list');
    await runSync(env.ctx);
    expect(getItem(env.db, 'assignment:101', 'assignment')?.completion).toBe('completed');
    expect(of(env, 'assignment.returned')).toHaveLength(0);
    expect(of(env, 'sync.incomplete')).toHaveLength(1);
  });

  it('group assignment without own submission stays pending with teammate hint', async () => {
    const env = makeEnv();
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) { hw.submit_by_group = true; hw.submitted = true; }
    env.fake.data.submissions[101] = [ownSubmission({ created_by: { id: 5 } })];
    await runSync(env.ctx);
    const it = getItem(env.db, 'assignment:101', 'assignment');
    expect(it?.completion).toBe('pending');
    expect(it?.teammate_hint).toBe(true);
    expect(it?.group).toBe(true);
  });

  it('score appearing emits grade.posted without the score in the event', async () => {
    const env = await afterInitial();
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) { hw.score = 87.35; hw.score_published = true; }
    await runSync(env.ctx);
    await runSync(env.ctx);
    const evs = of(env, 'grade.posted');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.delivery).toBe('push');
    expect(evs[0]?.item?.title).toBe('作業一');
    expect(JSON.stringify(evs[0])).not.toContain('87.35');
    expect(getItem(env.db, 'assignment:101', 'assignment')?.score).toBe('87.35');
  });

  it('course total score becomes published emits grade.posted', async () => {
    const env = await afterInitial();
    env.fake.data.courseScore[1] = { total_score: '91.20', published: true };
    await runSync(env.ctx);
    const evs = of(env, 'grade.posted');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.item?.title).toBe('學期總成績');
    expect(JSON.stringify(evs[0])).not.toContain('91.20');
  });

  it('first instructor comment emits feedback.posted without the text', async () => {
    const env = makeEnv();
    markSubmitted(env);
    await runSync(env.ctx);
    env.clock.now = new Date(env.clock.now.getTime() + HOUR);
    env.fake.data.submissions[101] = [ownSubmission({ instructor_comment: '結構清楚但缺測試' })];
    await runSync(env.ctx);
    await runSync(env.ctx);
    const evs = of(env, 'feedback.posted');
    expect(evs).toHaveLength(1);
    expect(JSON.stringify(evs[0])).not.toContain('結構清楚');
    expect(getItem(env.db, 'assignment:101', 'assignment')?.feedback).toBe('結構清楚但缺測試');
  });

  it('due date change is recorded and clears sent reminders', async () => {
    const env = await afterInitial();
    markReminderSent(env.db, 'assignment:101', 'P1D', '2026-10-29T00:00:00Z');
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) hw.end_time = '2026-11-02T15:59:00Z';
    await runSync(env.ctx);
    const row = env.db.prepare('SELECT old_due, new_due FROM due_history WHERE item_id = ?').all('assignment:101');
    expect(row).toEqual([{ old_due: '2026-10-30T15:59:00.000Z', new_due: '2026-11-02T15:59:00.000Z' }]);
    expect(reminderSent(env.db, 'assignment:101', 'P1D')).toBe(false);
  });

  it('course info baseline is silent, a room change emits course.info_changed', async () => {
    const env = await afterInitial();
    await runSync(env.ctx);
    expect(of(env, 'course.info_changed')).toHaveLength(0);
    env.html.room = 'M201';
    await runSync(env.ctx);
    const e = of(env, 'course.info_changed').find((x) => x.course?.id === '1');
    expect(e?.categories).toContain('room_change');
    expect(e?.summary).toContain('教室異動：M134 → M201');
    expect(e?.summary).toContain('上課時間變更');
    expect(e?.delivery).toBe('push');
    await runSync(env.ctx);
    expect(of(env, 'course.info_changed').filter((x) => x.course?.id === '1')).toHaveLength(1);
  });

  it('common_fields change emits course.info_changed labelled by title; page fetch failure is silent', async () => {
    const env = await afterInitial();
    env.html.fail = true;
    await runSync(env.ctx);
    expect(of(env, 'course.info_changed')).toHaveLength(0);
    expect(of(env, 'sync.incomplete')).toHaveLength(0);
    const d = env.fake.data.details[1];
    if (d?.course_outline?.common_fields?.[0]) d.course_outline.common_fields[0].description = '期中 30% 期末 70%';
    await runSync(env.ctx);
    const e = of(env, 'course.info_changed')[0];
    expect(e?.summary).toContain('評分方式變更');
    expect(e?.categories).toContain('syllabus_change');
  });

  it('report lists pending assignments due in 3 days', async () => {
    const env = await afterInitial();
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) hw.end_time = '2026-10-24T15:59:00Z';
    const report = await runSync(env.ctx);
    expect(report.initial).toBe(false);
    expect(report.pendingAssignments).toBe(1);
    expect(report.upcoming3d).toEqual([{ title: '作業一', due_at: '2026-10-24T23:59:00+08:00' }]);
  });

  it('keeps courses that disappear and never deletes items', async () => {
    const env = await afterInitial();
    env.fake.data.courses = env.fake.data.courses.filter((c) => c.id !== 1);
    await runSync(env.ctx);
    expect(getItem(env.db, 'assignment:101', 'assignment')).toBeDefined();
  });

  it('downloads new files during a later sync', async () => {
    const env = await afterInitial();
    env.fake.data.activities[1]?.push({
      id: 110, type: 'material', title: '第二週講義', published: true,
      uploads: [{ id: 5010, name: '講義2.pdf', size: 3, allow_download: true, link: null }],
    });
    env.fake.data.blobs[5010] = 'abc';
    await runSync(env.ctx);
    const f = listFiles(env.db, {}).find((x) => x.upload_id === '5010');
    expect(f?.status).toBe('done');
    expect(existsSync(join(env.root, f?.local_path ?? 'x'))).toBe(true);
    expect(of(env, 'material.new')).toHaveLength(1);
  });
});

describe('runReminderTick', () => {
  function withDue(due: string, over: Parameters<typeof makeEnv>[0] = {}) {
    const env = makeEnv(over);
    const hw = env.fake.data.homework[1]?.[0];
    if (hw) hw.end_time = due;
    const act = env.fake.data.activities[1]?.[0];
    if (act) act.end_time = due;
    return env;
  }

  it('does nothing before the initial sync completes', async () => {
    const env = withDue('2026-10-22T08:00:00Z');
    expect(await runReminderTick(env.ctx)).toBe(0);
  });

  it('sends P1D then PT3H (force_push) and never twice', async () => {
    const env = withDue('2026-10-30T15:59:00Z'); // 23:59 Taipei
    await runSync(env.ctx);
    env.clock.now = new Date('2026-10-30T10:00:00Z'); // 18:00 Taipei
    expect(await runReminderTick(env.ctx)).toBe(1);
    expect(await runReminderTick(env.ctx)).toBe(0);
    const first = of(env, 'assignment.due_reminder');
    expect(first[0]?.offset).toBe('P1D');
    expect(first[0]?.delivery).toBe('push');
    expect(first[0]?.dedupe_key).toBe('assignment.due_reminder:assignment:101:P1D');
    env.clock.now = new Date('2026-10-30T13:00:00Z'); // 21:00 Taipei
    expect(await runReminderTick(env.ctx)).toBe(1);
    const second = of(env, 'assignment.due_reminder').find((e) => e.offset === 'PT3H');
    expect(second?.delivery).toBe('force_push');
    expect(second?.item?.due_at).toBe('2026-10-30T23:59:00+08:00');
  });

  it('does not send for completed assignments', async () => {
    const env = withDue('2026-10-30T15:59:00Z');
    markSubmitted(env);
    await runSync(env.ctx);
    env.clock.now = new Date('2026-10-30T13:00:00Z');
    expect(await runReminderTick(env.ctx)).toBe(0);
    expect(of(env, 'assignment.due_reminder')).toHaveLength(0);
  });

  it('does not send for teammate_marked assignments', async () => {
    const env = withDue('2026-10-30T15:59:00Z');
    await runSync(env.ctx);
    env.db.prepare("UPDATE items SET completion = 'teammate_marked' WHERE id = 'assignment:101'").run();
    env.clock.now = new Date('2026-10-30T13:00:00Z');
    expect(await runReminderTick(env.ctx)).toBe(0);
  });

  it('holds a push reminder during quiet hours without marking it sent', async () => {
    const env = withDue('2026-10-22T23:30:00Z', {
      config: { reminders: { offsets: ['PT3H'] }, force_push_offsets: [] },
    }); // due 07:30 Taipei 10-23
    await runSync(env.ctx);
    env.clock.now = new Date('2026-10-22T21:00:00Z'); // 05:00 Taipei
    expect(await runReminderTick(env.ctx)).toBe(0);
    expect(reminderSent(env.db, 'assignment:101', 'PT3H')).toBe(false);
    env.clock.now = new Date('2026-10-22T23:00:00Z'); // 07:00 Taipei
    expect(await runReminderTick(env.ctx)).toBe(1);
  });

  it('force_push reminder goes out immediately at night and supersedes P1D', async () => {
    const env = withDue('2026-10-22T23:30:00Z'); // due 07:30 Taipei 10-23
    await runSync(env.ctx);
    env.clock.now = new Date('2026-10-22T21:00:00Z'); // 05:00 Taipei, quiet, PT3H force_push
    expect(await runReminderTick(env.ctx)).toBe(1);
    const evs = of(env, 'assignment.due_reminder');
    expect(evs.map((e) => e.offset)).toEqual(['PT3H']);
    expect(evs[0]?.delivery).toBe('force_push');
    expect(reminderSent(env.db, 'assignment:101', 'P1D')).toBe(true); // marked, not emitted
    env.clock.now = new Date('2026-10-22T23:00:00Z'); // 07:00
    expect(await runReminderTick(env.ctx)).toBe(0);
  });

  it('reminds for exams until they start', async () => {
    const env = makeEnv();
    await runSync(env.ctx);
    env.clock.now = new Date('2026-11-04T23:00:00Z'); // 2h before the 09:00 Taipei exam
    expect(await runReminderTick(env.ctx)).toBeGreaterThan(0);
    const ex = of(env, 'exam.reminder');
    expect(ex.length).toBeGreaterThan(0);
    expect(ex.every((e) => e.item?.kind === 'exam')).toBe(true);
    env.clock.now = new Date('2026-11-05T01:30:00Z');
    const before = of(env, 'exam.reminder').length;
    await runReminderTick(env.ctx);
    expect(of(env, 'exam.reminder')).toHaveLength(before);
  });
});
