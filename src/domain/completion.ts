import type { CompletionState } from '../types.js';

export interface HomeworkSubmission {
  is_draft: boolean;
  is_redo: boolean;
  created_by_id: number | null;
  upload_creator_ids: number[];
}

export interface HomeworkInput {
  group: boolean;
  listSubmitted: boolean;
  /** null = fetching submission_list failed */
  submissions: HomeworkSubmission[] | null;
  userId: number;
  previous: CompletionState | null;
  userMarkedTeammate: boolean;
}

export interface HomeworkResult {
  state: CompletionState;
  teammateHint: boolean;
  returned: boolean;
  unverified: boolean;
}

export function judgeHomework(i: HomeworkInput): HomeworkResult {
  if (i.submissions === null) {
    return { state: i.previous ?? 'pending', teammateHint: false, returned: false, unverified: true };
  }

  const valid = i.submissions.filter((s) => !s.is_draft && !s.is_redo);
  let state: CompletionState;
  let teammateHint = false;

  if (!i.group) {
    state = valid.length > 0 ? 'completed' : 'pending';
  } else {
    const own = valid.some((s) => s.created_by_id === i.userId || s.upload_creator_ids.includes(i.userId));
    if (own) {
      state = 'completed';
    } else if (i.userMarkedTeammate) {
      state = 'teammate_marked';
    } else {
      state = 'pending';
      teammateHint = i.listSubmitted || valid.length > 0;
    }
  }

  const returned = i.previous === 'completed' && state === 'pending';
  return { state, teammateHint, returned, unverified: false };
}

export function judgeVideo(read: { completeness: 'full' | 'part' } | undefined): 'pending' | 'completed' {
  return read?.completeness === 'full' ? 'completed' : 'pending';
}
