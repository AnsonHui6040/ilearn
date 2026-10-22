import { describe, expect, it } from 'vitest';
import { judgeHomework, judgeVideo, type HomeworkInput, type HomeworkSubmission } from '../src/domain/completion.js';

const USER = 100;

function sub(over: Partial<HomeworkSubmission> = {}): HomeworkSubmission {
  return { is_draft: false, is_redo: false, created_by_id: null, upload_creator_ids: [], ...over };
}

function input(over: Partial<HomeworkInput> = {}): HomeworkInput {
  return {
    group: false,
    listSubmitted: false,
    submissions: [],
    userId: USER,
    previous: null,
    userMarkedTeammate: false,
    ...over,
  };
}

describe('judgeHomework personal', () => {
  it('valid submission -> completed', () => {
    const r = judgeHomework(input({ submissions: [sub({ created_by_id: USER })] }));
    expect(r).toEqual({ state: 'completed', teammateHint: false, returned: false, unverified: false });
  });

  it('draft only -> pending', () => {
    expect(judgeHomework(input({ submissions: [sub({ is_draft: true })] })).state).toBe('pending');
  });

  it('redo only -> pending', () => {
    expect(judgeHomework(input({ submissions: [sub({ is_redo: true })] })).state).toBe('pending');
  });

  it('listSubmitted but empty list -> pending, no hint (Phase 0)', () => {
    const r = judgeHomework(input({ listSubmitted: true, submissions: [] }));
    expect(r.state).toBe('pending');
    expect(r.teammateHint).toBe(false);
  });
});

describe('judgeHomework group', () => {
  it('created_by_id is user -> completed', () => {
    expect(judgeHomework(input({ group: true, submissions: [sub({ created_by_id: USER })] })).state).toBe('completed');
  });

  it('created_by null, uploads by user -> completed', () => {
    const r = judgeHomework(input({ group: true, submissions: [sub({ upload_creator_ids: [USER] })] }));
    expect(r.state).toBe('completed');
  });

  it('only teammate record -> pending with hint', () => {
    const r = judgeHomework(input({ group: true, submissions: [sub({ created_by_id: 5 })] }));
    expect(r.state).toBe('pending');
    expect(r.teammateHint).toBe(true);
  });

  it('listSubmitted with empty list -> pending with hint', () => {
    const r = judgeHomework(input({ group: true, listSubmitted: true, submissions: [] }));
    expect(r.state).toBe('pending');
    expect(r.teammateHint).toBe(true);
  });

  it('nothing at all -> pending, no hint', () => {
    const r = judgeHomework(input({ group: true }));
    expect(r.state).toBe('pending');
    expect(r.teammateHint).toBe(false);
  });

  it('userMarkedTeammate -> teammate_marked', () => {
    const r = judgeHomework(input({ group: true, userMarkedTeammate: true }));
    expect(r.state).toBe('teammate_marked');
  });

  it('teammate_marked then own upload -> completed', () => {
    const r = judgeHomework(
      input({ group: true, userMarkedTeammate: true, previous: 'teammate_marked', submissions: [sub({ upload_creator_ids: [USER] })] }),
    );
    expect(r.state).toBe('completed');
  });

  it('draft by user does not count', () => {
    const r = judgeHomework(input({ group: true, submissions: [sub({ is_draft: true, created_by_id: USER })] }));
    expect(r.state).toBe('pending');
  });
});

describe('judgeHomework failures and returns', () => {
  it('submissions null, previous completed -> stays completed, unverified', () => {
    const r = judgeHomework(input({ submissions: null, previous: 'completed' }));
    expect(r).toEqual({ state: 'completed', teammateHint: false, returned: false, unverified: true });
  });

  it('submissions null, no previous -> pending', () => {
    const r = judgeHomework(input({ submissions: null }));
    expect(r.state).toBe('pending');
    expect(r.unverified).toBe(true);
  });

  it('previous completed, now pending with data -> returned', () => {
    const r = judgeHomework(input({ previous: 'completed', submissions: [] }));
    expect(r.state).toBe('pending');
    expect(r.returned).toBe(true);
  });

  it('previous completed, still completed -> not returned', () => {
    const r = judgeHomework(input({ previous: 'completed', submissions: [sub({ created_by_id: USER })] }));
    expect(r.returned).toBe(false);
  });

  it('previous pending, pending -> not returned', () => {
    expect(judgeHomework(input({ previous: 'pending' })).returned).toBe(false);
  });
});

describe('judgeVideo', () => {
  it('undefined -> pending', () => {
    expect(judgeVideo(undefined)).toBe('pending');
  });
  it('full -> completed', () => {
    expect(judgeVideo({ completeness: 'full' })).toBe('completed');
  });
  it('part -> pending', () => {
    expect(judgeVideo({ completeness: 'part' })).toBe('pending');
  });
});
