import { createHash } from 'node:crypto';
import type { Announcement, DataSource, Deadline, Material } from '../adapters/types.js';
import { fromIso, nowSeoul, relativeKo } from '../time.js';
import type { ChangeSet, SnapshotAssignment } from './snapshot.js';

export type AttentionPriority = 'critical' | 'high' | 'normal' | 'low';
export type AttentionKind = 'deadline' | 'announcement' | 'assignment_change' | 'material' | 'module_update' | 'removed_assignment';
export type AttentionStatus = 'action_required' | 'review_required' | 'information';

export interface CalendarCandidate {
  fingerprint: string;
  sourceKey: string;
  sourceKind: Deadline['type'];
  title: string;
  courseId: number | null;
  courseName: string | null;
  dueAt: string;
  timezone: 'Asia/Seoul';
  sourceUrl: string;
  confidence: 'exact';
  disposition: 'auto_ready' | 'review_required';
  dispositionReason: string;
  suggestedReminderMinutes: number[];
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  courseId: number | null;
  courseName: string | null;
  dueAt: string | null;
  sourceUrl: string | null;
  priority: AttentionPriority;
  status: AttentionStatus;
  signals: string[];
  recommendedAction: string;
  source: DataSource | 'mixed';
  calendarCandidate: CalendarCandidate | null;
}

export interface ModuleUpdate {
  courseId: number;
  courseName: string | null;
  cmId: number;
  name: string;
  updates: string[];
  url: string | null;
}

export interface AttentionInbox {
  generatedAt: string;
  firstRun: boolean;
  since: string | null;
  topItems: AttentionItem[];
  remainingItems: AttentionItem[];
  counts: Record<AttentionPriority, number> & { reviewRequired: number; total: number };
}

function stableFingerprint(sourceKey: string): string {
  return `sha256:${createHash('sha256').update(`jbnu-lms-calendar:v1:${sourceKey}`).digest('hex')}`;
}

export function calendarCandidateFromDeadline(deadline: Deadline, now = nowSeoul()): CalendarCandidate {
  const due = fromIso(deadline.dueAt);
  const eligible = Boolean(due && due >= now && deadline.submissionState !== 'submitted');
  const course = deadline.courseName ? `${deadline.courseName} - ` : '';
  return {
    fingerprint: stableFingerprint(`${deadline.type}:${deadline.id}`),
    sourceKey: deadline.id,
    sourceKind: deadline.type,
    title: `[LMS] ${course}${deadline.title} 마감`,
    courseId: deadline.courseId,
    courseName: deadline.courseName,
    dueAt: deadline.dueAt,
    timezone: 'Asia/Seoul',
    sourceUrl: deadline.url,
    confidence: 'exact',
    disposition: eligible ? 'auto_ready' : 'review_required',
    dispositionReason: eligible
      ? 'LMS의 구조화된 마감 시각을 사용했으며 미제출 상태입니다.'
      : deadline.submissionState === 'submitted'
        ? '이미 제출 완료된 항목이라 자동 생성 대상에서 제외해야 합니다.'
        : '마감이 지났거나 시각을 확인할 수 없어 사용자 검토가 필요합니다.',
    suggestedReminderMinutes: [24 * 60, 2 * 60],
  };
}

export function buildCalendarCandidates(deadlines: Deadline[], now = nowSeoul()): CalendarCandidate[] {
  const seen = new Set<string>();
  const result: CalendarCandidate[] = [];
  for (const deadline of deadlines) {
    const candidate = calendarCandidateFromDeadline(deadline, now);
    if (seen.has(candidate.fingerprint)) continue;
    seen.add(candidate.fingerprint);
    result.push(candidate);
  }
  return result.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function priorityForDeadline(deadline: Deadline, now = nowSeoul()): AttentionPriority {
  const due = fromIso(deadline.dueAt);
  if (!due) return 'normal';
  const hours = due.diff(now, 'hours').hours;
  if (hours < 0 || hours <= 24) return 'critical';
  if (hours <= 72) return 'high';
  if (hours <= 24 * 7) return 'normal';
  return 'low';
}

const PRIORITY_ORDER: Record<AttentionPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

function announcementItem(a: Announcement, updated: boolean): AttentionItem {
  return {
    id: `announcement:${a.id}`,
    kind: 'announcement',
    title: a.title,
    courseId: a.courseId,
    courseName: a.courseName,
    dueAt: null,
    sourceUrl: a.url,
    priority: updated || a.isPinned ? 'high' : 'normal',
    status: 'review_required',
    signals: [updated ? '이미 게시된 공지가 수정되었습니다.' : '새 공지가 게시되었습니다.', ...(a.hasAttachment ? ['첨부파일이 있습니다.'] : [])],
    recommendedAction: updated ? '변경된 날짜·장소·요구사항과 첨부파일을 확인하세요.' : '본문을 열어 행동이 필요한 공지인지 확인하세요.',
    source: a.source,
    calendarCandidate: null,
  };
}

function materialItem(m: Material): AttentionItem {
  return {
    id: `material:${m.courseId}:${m.cmId}`,
    kind: 'material',
    title: m.name,
    courseId: m.courseId,
    courseName: m.courseName,
    dueAt: null,
    sourceUrl: m.url,
    priority: 'low',
    status: 'information',
    signals: [`${m.sectionTitle}에 새 수업자료가 추가되었습니다.`],
    recommendedAction: '이번 주 학습 대상이면 자료를 확인하거나 내려받으세요.',
    source: m.source,
    calendarCandidate: null,
  };
}

function removedAssignmentItem(a: SnapshotAssignment): AttentionItem {
  return {
    id: `removed-assignment:${a.courseId}:${a.url}`,
    kind: 'removed_assignment',
    title: a.title,
    courseId: a.courseId,
    courseName: a.courseName,
    dueAt: a.dueAt,
    sourceUrl: a.url,
    priority: 'high',
    status: 'review_required',
    signals: ['이전에 보이던 과제가 현재 조회 결과에서 확인되지 않습니다.'],
    recommendedAction: '취소·숨김·일시적인 조회 실패를 구분하기 전에는 캘린더 일정이나 로컬 기록을 삭제하지 마세요.',
    source: 'local_snapshot',
    calendarCandidate: null,
  };
}

export function buildAttentionInbox(input: { deadlines: Deadline[]; changes: ChangeSet; moduleUpdates?: ModuleUpdate[]; now?: ReturnType<typeof nowSeoul> }): AttentionInbox {
  const now = input.now ?? nowSeoul();
  const items = new Map<string, AttentionItem>();

  for (const d of input.deadlines) {
    const key = d.type === 'assignment' ? `assignment:${d.id}` : `deadline:${d.id}`;
    items.set(key, {
      id: key,
      kind: 'deadline',
      title: d.title,
      courseId: d.courseId,
      courseName: d.courseName,
      dueAt: d.dueAt,
      sourceUrl: d.url,
      priority: priorityForDeadline(d, now),
      status: 'action_required',
      signals: [`마감 ${relativeKo(fromIso(d.dueAt), now)}`, ...(d.overdue ? ['기한이 지났습니다.'] : []), ...(d.lateAllowed === false ? ['마감 후 제출이 허용되지 않습니다.'] : [])],
      recommendedAction: d.overdue ? '원문에서 지각 제출 가능 여부를 확인하고 즉시 처리하세요.' : '요구사항과 제출 상태를 확인하고 작업 시간을 확보하세요.',
      source: d.source,
      calendarCandidate: calendarCandidateFromDeadline(d, now),
    });
  }

  // 빈 스냅샷과의 첫 비교는 현재의 모든 항목을 기술적으로 "새 항목"으로 만든다.
  // 학생에게 실제 신규 알림처럼 보이지 않도록 첫 실행에는 확정 마감만 표시한다.
  for (const a of input.changes.firstRun ? [] : input.changes.newAssignments) {
    const key = `assignment:${a.id}`;
    const old = items.get(key);
    if (old) {
      old.signals.unshift('새 과제가 게시되었습니다.');
      if (PRIORITY_ORDER[old.priority] > PRIORITY_ORDER.high) old.priority = 'high';
    } else {
      items.set(key, {
        id: key,
        kind: 'deadline',
        title: a.title,
        courseId: a.courseId,
        courseName: a.courseName,
        dueAt: a.dueAt,
        sourceUrl: a.url,
        priority: 'high',
        status: 'review_required',
        signals: ['새 과제가 게시되었지만 구조화된 마감 후보에 포함되지 않았습니다.'],
        recommendedAction: '과제 상세에서 마감과 제출 조건을 확인하세요.',
        source: a.source,
        calendarCandidate: null,
      });
    }
  }

  for (const c of input.changes.firstRun ? [] : input.changes.changedAssignments) {
    const key = `assignment:${c.assignment.id}`;
    const old = items.get(key);
    if (old) {
      old.kind = 'assignment_change';
      old.priority = 'high';
      old.status = 'review_required';
      old.signals.unshift(...c.changes);
      old.recommendedAction = '변경된 마감·제출 조건을 원문에서 확인하고 기존 계획을 조정하세요.';
    } else {
      items.set(key, {
        id: key,
        kind: 'assignment_change',
        title: c.assignment.title,
        courseId: c.assignment.courseId,
        courseName: c.assignment.courseName,
        dueAt: c.assignment.dueAt,
        sourceUrl: c.assignment.url,
        priority: 'high',
        status: 'review_required',
        signals: c.changes,
        recommendedAction: '변경된 마감·제출 조건을 원문에서 확인하고 기존 계획을 조정하세요.',
        source: c.assignment.source,
        calendarCandidate: null,
      });
    }
  }

  for (const a of input.changes.firstRun ? [] : input.changes.newAnnouncements) items.set(`announcement:${a.id}`, announcementItem(a, false));
  for (const a of input.changes.firstRun ? [] : input.changes.updatedAnnouncements) items.set(`announcement:${a.id}`, announcementItem(a, true));
  for (const m of input.changes.firstRun ? [] : input.changes.newMaterials) items.set(`material:${m.courseId}:${m.cmId}`, materialItem(m));
  for (const a of input.changes.firstRun ? [] : input.changes.removedAssignments) items.set(`removed-assignment:${a.courseId}:${a.url}`, removedAssignmentItem(a));

  for (const u of input.changes.firstRun ? [] : (input.moduleUpdates ?? [])) {
    const key = `module-update:${u.courseId}:${u.cmId}`;
    if (items.has(`material:${u.courseId}:${u.cmId}`)) continue;
    items.set(key, {
      id: key,
      kind: 'module_update',
      title: u.name,
      courseId: u.courseId,
      courseName: u.courseName,
      dueAt: null,
      sourceUrl: u.url,
      priority: 'normal',
      status: 'review_required',
      signals: [`LMS 변경 기록: ${u.updates.join(', ') || '내용 변경'}`],
      recommendedAction: '자료나 활동의 변경 내용을 확인하세요.',
      source: 'moodle_ajax',
      calendarCandidate: null,
    });
  }

  const sorted = [...items.values()].sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p) return p;
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return a.title.localeCompare(b.title, 'ko');
  });
  const counts = {
    critical: sorted.filter((i) => i.priority === 'critical').length,
    high: sorted.filter((i) => i.priority === 'high').length,
    normal: sorted.filter((i) => i.priority === 'normal').length,
    low: sorted.filter((i) => i.priority === 'low').length,
    reviewRequired: sorted.filter((i) => i.status === 'review_required').length,
    total: sorted.length,
  };
  return {
    generatedAt: now.toISO() ?? new Date().toISOString(),
    firstRun: input.changes.firstRun,
    since: input.changes.since,
    topItems: sorted.slice(0, 3),
    remainingItems: sorted.slice(3),
    counts,
  };
}
