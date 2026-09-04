/**
 * 일일 브리핑과 주간 학습 계획 생성. 원문 사실(마감·상태)과 AI 제안(우선순위·시간 배분)을 분리해 표시한다.
 */
import { DateTime } from 'luxon';
import type { Announcement, Deadline, Note } from '../adapters/types.js';
import type { ChangeSet } from './snapshot.js';
import { BUCKET_LABEL, bucketFor, formatKo, fromIso, nowSeoul, relativeKo, weekRange, type DeadlineBucket } from '../time.js';

export interface DailyBriefing {
  generatedAt: string;
  todayLabel: string;
  buckets: Record<DeadlineBucket, Deadline[]>;
  newAnnouncements: Announcement[];
  changes: ChangeSet | null;
  suggestions: { source: 'estimate'; items: string[] };
  notes: Note[];
}

export interface WeeklyPlanDay {
  date: string;
  label: string;
  isToday: boolean;
  deadlines: Deadline[];
  suggestedTasks: string[];
}

export interface WeeklyPlan {
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  days: WeeklyPlanDay[];
  nextWeekPreview: Deadline[];
  overdue: Deadline[];
  suggestions: { source: 'estimate'; items: string[] };
  notes: Note[];
}

const WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일'];

function groupByBucket(deadlines: Deadline[], now: DateTime): Record<DeadlineBucket, Deadline[]> {
  const buckets: Record<DeadlineBucket, Deadline[]> = { overdue: [], today: [], tomorrow: [], this_week: [], next_week: [], later: [], no_date: [] };
  for (const d of deadlines) buckets[bucketFor(fromIso(d.dueAt), now)].push(d);
  for (const k of Object.keys(buckets) as DeadlineBucket[]) buckets[k].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return buckets;
}

export function buildDailyBriefing(input: { deadlines: Deadline[]; announcements: Announcement[]; changes: ChangeSet | null; notes?: Note[]; now?: DateTime }): DailyBriefing {
  const now = input.now ?? nowSeoul();
  const buckets = groupByBucket(input.deadlines, now);
  const suggestions: string[] = [];
  if (buckets.overdue.length) suggestions.push(`기한이 지난 항목 ${buckets.overdue.length}건이 있습니다. 지각 제출이 허용되는지 먼저 확인하고, 가능하면 오늘 처리하세요.`);
  if (buckets.today.length) suggestions.push(`오늘 마감 ${buckets.today.length}건을 최우선으로 처리하세요: ${buckets.today.map((d) => d.title).join(', ')}`);
  if (buckets.tomorrow.length) suggestions.push(`내일 마감 ${buckets.tomorrow.length}건은 오늘 초안을 끝내 두면 여유가 생깁니다.`);
  if (buckets.this_week.length && !buckets.today.length) suggestions.push('오늘 마감은 없습니다. 이번 주 마감 항목 중 가장 이른 것부터 시작하세요.');
  if (!input.deadlines.length) suggestions.push('확인된 마감이 없습니다. 새 공지와 수업자료를 훑어보며 다음 과제를 미리 준비하세요.');
  const newAnnouncements = [...input.announcements].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 10);
  if (newAnnouncements.length) suggestions.push(`새 공지 ${newAnnouncements.length}건 중 [필독]·[중요] 표시가 있는 글부터 읽으세요.`);
  return {
    generatedAt: now.toISO() ?? '',
    todayLabel: formatKo(now, false),
    buckets,
    newAnnouncements,
    changes: input.changes,
    suggestions: { source: 'estimate', items: suggestions },
    notes: input.notes ?? [],
  };
}

export function buildWeeklyPlan(input: { deadlines: Deadline[]; notes?: Note[]; now?: DateTime }): WeeklyPlan {
  const now = input.now ?? nowSeoul();
  const { start, end } = weekRange(now);
  const days: WeeklyPlanDay[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = start.plus({ days: i });
    const dayEnd = day.endOf('day');
    const items = input.deadlines.filter((d) => {
      const dt = fromIso(d.dueAt);
      return dt && dt >= day && dt <= dayEnd;
    });
    days.push({ date: day.toISODate() ?? '', label: `${day.toFormat('MM-dd')}(${WEEKDAY_KO[i]})`, isToday: day.hasSame(now, 'day'), deadlines: items, suggestedTasks: [] });
  }
  const overdue = input.deadlines.filter((d) => {
    const dt = fromIso(d.dueAt);
    return dt && dt < now && d.submissionState !== 'submitted';
  });
  const nextWeekPreview = input.deadlines.filter((d) => {
    const dt = fromIso(d.dueAt);
    return dt && dt > end && dt <= end.plus({ days: 7 });
  });
  // 제안: 마감 2일 전 초안, 마감 전날 최종 점검 (추정)
  const todayIdx = days.findIndex((d) => d.isToday);
  for (const d of input.deadlines) {
    const due = fromIso(d.dueAt);
    if (!due || d.submissionState === 'submitted') continue;
    const draftDay = due.minus({ days: 2 }).startOf('day');
    const checkDay = due.minus({ days: 1 }).startOf('day');
    for (const day of days) {
      const dayStart = DateTime.fromISO(day.date, { zone: now.zoneName ?? 'Asia/Seoul' });
      if (dayStart < now.startOf('day')) continue;
      if (dayStart.hasSame(draftDay, 'day') && !due.hasSame(dayStart, 'day')) day.suggestedTasks.push(`[초안] ${d.title} (마감 ${relativeKo(due, now)})`);
      if (dayStart.hasSame(checkDay, 'day') && !due.hasSame(dayStart, 'day')) day.suggestedTasks.push(`[최종 점검] ${d.title}`);
    }
  }
  if (todayIdx >= 0 && overdue.length) days[todayIdx].suggestedTasks.unshift(...overdue.map((d) => `[기한 초과 처리] ${d.title}`));
  const suggestions: string[] = [];
  const total = days.reduce((n, d) => n + d.deadlines.length, 0);
  if (total === 0) suggestions.push('이번 주 마감이 없습니다. 다음 주 항목을 미리 시작하면 좋습니다.');
  const busiest = [...days].sort((a, b) => b.deadlines.length - a.deadlines.length)[0];
  if (busiest && busiest.deadlines.length >= 2) suggestions.push(`${busiest.label} 에 마감이 ${busiest.deadlines.length}건 몰려 있습니다. 그 전날까지 하나는 끝내 두세요.`);
  return {
    generatedAt: now.toISO() ?? '',
    weekStart: start.toISODate() ?? '',
    weekEnd: end.toISODate() ?? '',
    days,
    nextWeekPreview,
    overdue,
    suggestions: { source: 'estimate', items: suggestions },
    notes: input.notes ?? [],
  };
}

export function bucketLabel(b: DeadlineBucket): string {
  return BUCKET_LABEL[b];
}
