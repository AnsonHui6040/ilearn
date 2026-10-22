import type { Delivery } from '../types.js';

export type RuleField = 'title' | 'body' | 'course_info_diff';

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  scope: 'all' | string[];
  fields: RuleField[];
  any: string[];
  all: string[];
  none: string[];
  regex: string[];
  action: Delivery;
}

function rule(
  id: string,
  name: string,
  action: Delivery,
  any: string[],
  none: string[] = [],
  fields: RuleField[] = ['title', 'body'],
): Rule {
  return { id, name, enabled: true, scope: 'all', fields, any, all: [], none, regex: [], action };
}

export const DEFAULT_RULES: Rule[] = [
  rule(
    'exam', '考試／測驗', 'push',
    ['考試', '期中考', '期末考', '小考', '隨堂測驗', '測驗', 'exam', 'midterm', 'final', 'quiz'],
    ['成績', '分數', '公布', '檢討', 'grade', 'score'],
  ),
  rule('deadline', '繳交／截止', 'push', ['繳交', '截止', '期限', '最後一天', '上傳', 'due', 'deadline']),
  rule('deadline_change', '截止延長／提前', 'push', ['延期', '延長', '展延', '提前', '改期', 'extended']),
  rule(
    'class_cancel', '停課／調課／補課', 'push',
    ['停課', '休課', '調課', '補課', '不上課', '取消上課', '颱風假', '放假'],
  ),
  rule(
    'room_change', '更換教室', 'push',
    ['更換教室', '教室異動', '改至', '移至', '地點變更', 'room change'],
    [],
    ['title', 'body', 'course_info_diff'],
  ),
  rule(
    'online_class', '改線上上課', 'push',
    ['線上上課', '遠距', '視訊', 'Google Meet', 'Teams', 'Webex', '直播'],
  ),
  rule('presentation', '報告／分組', 'push', ['報告', '簡報', '上台', '分組', '組別'], ['成績']),
  rule('attendance', '點名／出席', 'push', ['點名', '出席', '請假', '缺席']),
  rule(
    'syllabus_change', '大綱／進度變更', 'push',
    ['課程大綱', '進度調整', '評分方式', '配分'],
    [],
    ['title', 'body', 'course_info_diff'],
  ),
  rule('grade_release', '成績相關公告', 'record', ['成績', '分數', '公布成績', 'grade', 'score']),
  rule('event', '演講／參訪', 'record', ['演講', '講座', '參訪', '校外教學', '工作坊']),
  rule('material', '新教材', 'record', ['講義', '投影片', '教材', 'slides']),
  rule('survey', '問卷', 'record', ['問卷', '調查', '教學評量']),
];
