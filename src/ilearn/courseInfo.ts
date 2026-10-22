import * as cheerio from 'cheerio';

export interface ScheduleSlot {
  weekday: number;
  periods: string[];
  room: string | null;
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7 };

export function courseViewUrl(courseCode: string): string | null {
  const m = /^(\d{3})(\d)_(\w+)$/.exec(courseCode);
  if (!m) return null;
  return `https://course.thu.edu.tw/view/${m[1]}/${m[2]}/${m[3]}`;
}

export function parseScheduleText(s: string): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  const re = /([一二三四五六日])\s*\/\s*([\w,\s]+?)\s*(?:\[([^\]]*)\])?(?=\s|$|[一二三四五六日]\s*\/)/g;
  for (const m of s.matchAll(re)) {
    const weekday = WEEKDAY[m[1] ?? ''];
    if (!weekday) continue;
    const periods = (m[2] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (periods.length === 0) continue;
    out.push({ weekday, periods, room: m[3]?.trim() || null });
  }
  return out;
}

function clean(s: string): string {
  return s.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim();
}

export function parseCourseView(html: string): {
  schedule: ScheduleSlot[];
  rawScheduleText: string;
  grading: { item: string; percent: number }[];
} {
  const $ = cheerio.load(html);

  // 上課時間：標題在 .card 內，每個時段是 span.badge；備援為 th/td 相鄰格
  let rawScheduleText = '';
  $('h1, h2, h3, h4, h5, h6, th, dt, label, strong, b').each((_, el) => {
    if (rawScheduleText || clean($(el).text()) !== '上課時間') return;
    const card = $(el).closest('.card');
    if (card.length) {
      rawScheduleText = card
        .find('.badge')
        .toArray()
        .map((b) => clean($(b).text()))
        .filter(Boolean)
        .join(' ');
    } else {
      const next = $(el).next();
      if (next.length) rawScheduleText = clean(next.text());
    }
  });

  // 評分方式：標題之後的第一個 table，不含表頭列
  const grading: { item: string; percent: number }[] = [];
  const heading = $('h1, h2, h3, h4, h5, h6')
    .toArray()
    .find((h) => $(h).text().includes('評分方式'));
  if (heading) {
    let table: ReturnType<typeof $> | null = null;
    for (let node = $(heading); node.length && !table; node = node.parent()) {
      const after = node.nextAll();
      const found = after.filter('table').add(after.find('table')).first();
      if (found.length) table = found;
    }
    table?.find('tr').each((_, tr) => {
      if ($(tr).find('th').length > 0) return;
      const cells = $(tr).find('td').toArray().map((c) => clean($(c).text()));
      const item = cells[0];
      const pct = /^(\d+(?:\.\d+)?)\s*%?$/.exec(cells[1] ?? '');
      if (item && pct?.[1]) grading.push({ item, percent: Number(pct[1]) });
    });
  }

  return { schedule: parseScheduleText(rawScheduleText), rawScheduleText, grading };
}
