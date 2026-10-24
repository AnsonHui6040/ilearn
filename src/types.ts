export type Delivery = 'force_push' | 'push' | 'record';

export type EventType =
  | 'assignment.new'
  | 'assignment.due_reminder'
  | 'assignment.returned'
  | 'exam.new'
  | 'exam.reminder'
  | 'video.new'
  | 'announcement.new'
  | 'material.new'
  | 'survey.new'
  | 'course.info_changed'
  | 'grade.posted'
  | 'feedback.posted'
  | 'auth.expired'
  | 'sync.incomplete'
  | 'sync.initial_completed';

/** 推送時實際送出的事件：正式事件，或只出現在 delivery test 的測試事件。 */
export type WireEvent = Omit<IlearnEvent, 'type'> & { type: EventType | 'delivery.test' };

export type ItemKind =
  | 'assignment'
  | 'exam'
  | 'video'
  | 'announcement'
  | 'material'
  | 'survey'
  | 'course_info'
  | 'grade'
  | 'feedback'
  | 'system';

/** semester 如 "115-1" */
export interface CourseRef {
  id: string;
  name: string;
  semester: string;
}

export interface EventItem {
  id: string;
  kind: ItemKind;
  title: string;
  due_at: string | null;
  url: string | null;
}

export interface IlearnEvent {
  schema: 'thu-ilearn.event.v1';
  event_id: string;
  type: EventType;
  detected_at: string;
  deliver_after: string;
  delivery: Delivery;
  categories: string[];
  matched_rules: string[];
  course: CourseRef | null;
  item: EventItem | null;
  summary: string | null;
  dedupe_key: string;
  offset?: string;
  reason?: 'reload';
  reload_id?: string;
  note?: string;
}

export type CompletionState = 'pending' | 'completed' | 'teammate_marked';
