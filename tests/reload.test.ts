import { describe, expect, it } from 'vitest';
import { setCompletion } from '../src/db/repo.js';
import { commitReload, planReload } from '../src/sync/reload.js';
import { runSync } from '../src/sync/sync.js';
import { makeEnv, standardData, type TestEnv } from './helpers/fakeApi.js';

async function seededEnv(): Promise<TestEnv> {
  const d = standardData();
  d.activities[1]?.push(
    { id: 120, type: 'homework', title: '作業二（已交）', end_time: '2026-11-12T15:59:00Z', published: true },
    { id: 121, type: 'homework', title: '作業三（隊員已交）', end_time: '2026-11-13T15:59:00Z', published: true },
  );
  d.homework[1]?.push(
    { id: 120, title: '作業二（已交）', end_time: '2026-11-12T15:59:00Z', submit_by_group: false, submitted: true,
      submitted_status: 'submitted', is_closed: false, score: null, score_published: false },
    { id: 121, title: '作業三（隊員已交）', end_time: '2026-11-13T15:59:00Z', submit_by_group: true, submitted: false,
      submitted_status: null, is_closed: false, score: null, score_published: false },
  );
  d.submissions[120] = [{ id: 9, is_draft: false, is_redo: false, created_by: { id: 777 }, uploads: [] }];
  d.exams[1] = [
    { id: 301, title: '期中考', start_time: '2026-10-25T01:00:00Z', end_time: '2026-10-25T03:00:00Z' },
    { id: 302, title: '已開始的小考', start_time: '2026-10-20T01:00:00Z', end_time: '2026-10-20T03:00:00Z' },
    { id: 303, title: '期末考', start_time: '2026-11-20T01:00:00Z', end_time: '2026-11-20T03:00:00Z' },
  ];
  d.bulletins[1]?.push({
    id: 88002, title: '期中考 11/5 範圍公告', content: '<p>第一章到第三章</p>', created_at: '2026-10-21T02:00:00Z',
  });
  d.courseScore[1] = { total_score: '88.00', published: true };
  const env = makeEnv({ data: d });
  await runSync(env.ctx);
  setCompletion(env.db, 'assignment:121', 'teammate_marked', 'user');
  return env;
}

describe('planReload', () => {
  it('includes only items that need attention, with reload fields', async () => {
    const env = await seededEnv();
    const now = new Date('2026-10-22T05:00:00Z');
    const evs = planReload(env.db, now);
    const summary = evs.map((e) => `${e.type}|${e.item?.title}`).sort();
    expect(summary).toEqual([
      'announcement.new|期中考 11/5 範圍公告',
      'assignment.new|作業一',
      'exam.new|期中考',
      'grade.posted|學期總成績',
      'video.new|第一週影片',
    ]);
    const ids = new Set(evs.map((e) => e.reload_id));
    expect(ids.size).toBe(1);
    expect(evs.every((e) => e.reason === 'reload' && typeof e.reload_id === 'string')).toBe(true);
    expect(new Set(evs.map((e) => e.dedupe_key)).size).toBe(evs.length);
    expect(evs.every((e) => e.deliver_after === e.detected_at)).toBe(true);
    expect(JSON.stringify(evs)).not.toContain('88.00');
  });

  it('excludes completed and teammate-marked assignments, started exams, record announcements', async () => {
    const env = await seededEnv();
    const titles = planReload(env.db, new Date('2026-10-22T05:00:00Z')).map((e) => e.item?.title);
    expect(titles).not.toContain('作業二（已交）');
    expect(titles).not.toContain('作業三（隊員已交）');
    expect(titles).not.toContain('已開始的小考');
    expect(titles).not.toContain('期末考');
    expect(titles).not.toContain('歡迎修課');
  });

  it('includes a returned (pending again) assignment', async () => {
    const env = await seededEnv();
    env.fake.data.submissions[120] = [];
    env.clock.now = new Date(env.clock.now.getTime() + 3600_000);
    await runSync(env.ctx);
    const titles = planReload(env.db, new Date('2026-10-22T06:00:00Z')).map((e) => e.item?.title);
    expect(titles).toContain('作業二（已交）');
  });

  it('delivers immediately even during quiet hours and keeps original delivery', async () => {
    const env = await seededEnv();
    const night = new Date('2026-10-21T18:30:00Z'); // 02:30 Taipei
    const evs = planReload(env.db, night);
    expect(evs.every((e) => e.deliver_after === '2026-10-22T02:30:00+08:00')).toBe(true);
    expect(evs.find((e) => e.type === 'announcement.new')?.delivery).toBe('push');
  });

  it('uses a new reload_id on every call', async () => {
    const env = await seededEnv();
    const now = new Date('2026-10-22T05:00:00Z');
    const a = planReload(env.db, now);
    const b = planReload(env.db, now);
    expect(a[0]?.reload_id).not.toBe(b[0]?.reload_id);
  });
});

describe('commitReload', () => {
  it('appends a batch once, and a fresh plan again', async () => {
    const env = await seededEnv();
    const now = new Date('2026-10-22T05:00:00Z');
    const plan = planReload(env.db, now);
    const before = env.events().length;
    expect(commitReload(env.outbox, plan)).toBe(plan.length);
    expect(commitReload(env.outbox, plan)).toBe(0);
    expect(commitReload(env.outbox, planReload(env.db, now))).toBe(plan.length);
    expect(env.events().length).toBe(before + plan.length * 2);
  });
});
