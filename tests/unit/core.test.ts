import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { Announcement, Assignment, Deadline } from '../../src/adapters/types.js';
import { LmsError, classifyMoodleErrorCode, formatUserError, toLmsError } from '../../src/errors.js';
import { analyzeAssignment } from '../../src/services/assignment-analysis.js';
import { buildDailyBriefing, buildWeeklyPlan } from '../../src/services/briefing.js';
import { dedupeBy, mergeFill } from '../../src/services/dedupe.js';
import { applyToSnapshot, diffSnapshot, emptySnapshot } from '../../src/services/snapshot.js';
import { htmlToText, safeFileName } from '../../src/text.js';
import { bucketFor, formatKo, parseKoreanDateTime, relativeKo, weekRange } from '../../src/time.js';

const NOW = DateTime.fromISO('2026-09-04T10:00:00', { zone: 'Asia/Seoul' });

describe('time', () => {
  it('한국어 날짜 형식을 해석한다', () => {
    expect(parseKoreanDateTime('2026년 9월 5일 금요일 오후 11:59')?.toISO()).toBe('2026-09-05T23:59:00.000+09:00');
    expect(parseKoreanDateTime('2026-09-05 23:59')?.toISO()).toBe('2026-09-05T23:59:00.000+09:00');
    expect(parseKoreanDateTime('2026.09.05 오전 12:30')?.toISO()).toBe('2026-09-05T00:30:00.000+09:00');
    expect(parseKoreanDateTime('2026-08-24')?.toISO()).toBe('2026-08-24T00:00:00.000+09:00');
    expect(parseKoreanDateTime('9월 12일 오후 6:00', NOW)?.toISO()).toBe('2026-09-12T18:00:00.000+09:00');
    expect(parseKoreanDateTime('내일까지')).toBeNull();
    expect(parseKoreanDateTime('')).toBeNull();
  });
  it('버킷을 오늘/내일/이번 주/기한 초과로 구분한다', () => {
    expect(bucketFor(NOW.minus({ hours: 1 }), NOW)).toBe('overdue');
    expect(bucketFor(NOW.plus({ hours: 5 }), NOW)).toBe('today');
    expect(bucketFor(NOW.plus({ days: 1 }), NOW)).toBe('tomorrow');
    expect(bucketFor(NOW.plus({ days: 2 }), NOW)).toBe('this_week'); // 9/6 토
    expect(bucketFor(NOW.plus({ days: 4 }), NOW)).toBe('next_week'); // 9/8 월
    expect(bucketFor(NOW.plus({ days: 20 }), NOW)).toBe('later');
    expect(bucketFor(null, NOW)).toBe('no_date');
  });
  it('상대 시간을 한국어로 표현한다', () => {
    expect(relativeKo(NOW.plus({ hours: 3, minutes: 20 }), NOW)).toBe('3시간 20분 남음');
    expect(relativeKo(NOW.minus({ days: 2 }), NOW)).toBe('2일 지남');
    expect(relativeKo(NOW.plus({ days: 1, hours: 2 }), NOW)).toBe('1일 2시간 남음');
    expect(formatKo(NOW)).toBe('2026-09-04(금) 10:00');
    const { start, end } = weekRange(NOW);
    expect(start.toISODate()).toBe('2026-08-31');
    expect(end.toISODate()).toBe('2026-09-06');
  });
});

describe('errors', () => {
  it('Moodle 오류 코드를 분류한다', () => {
    expect(classifyMoodleErrorCode('invalidsesskey')).toBe('AUTH_EXPIRED');
    expect(classifyMoodleErrorCode('nopermissions')).toBe('FORBIDDEN');
    expect(classifyMoodleErrorCode('invalidrecord')).toBe('NOT_FOUND');
    expect(classifyMoodleErrorCode(undefined)).toBe('UNKNOWN');
  });
  it('사용자 메시지에 해결 방법이 포함되고 기술 코드가 노출되지 않는다', () => {
    const text = formatUserError(new LmsError('AUTH_EXPIRED'));
    expect(text).toContain('세션이 만료');
    expect(text).toContain('해결 방법');
    expect(text).not.toMatch(/AUTH_EXPIRED/);
    const t2 = toLmsError(new Error('fetch failed: ECONNREFUSED'));
    expect(t2.kind).toBe('NETWORK');
    const t3 = toLmsError(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(t3.kind).toBe('TIMEOUT');
  });
});

describe('text', () => {
  it('HTML 을 읽기 쉬운 텍스트로 바꾼다', () => {
    const t = htmlToText('<p>안녕<br>하세요</p><ul><li>하나</li><li>둘</li></ul><script>alert(1)</script><a href="https://x.test/a">링크</a>');
    expect(t).toContain('안녕\n하세요');
    expect(t).toContain('- 하나');
    expect(t).not.toContain('alert');
    expect(t).toContain('링크 (https://x.test/a)');
  });
  it('파일 이름을 안전하게 만든다', () => {
    expect(safeFileName('a/b\\c:d*e?.pdf')).toBe('a_b_c_d_e_.pdf');
  });
});

describe('dedupe', () => {
  it('키가 겹치면 앞 항목을 우선하고 빈 값을 보완한다', () => {
    const items = [
      { id: 'a', title: '과제', due: null as string | null, state: 'unknown' },
      { id: 'a', title: '과제', due: '2026-09-05', state: 'submitted' },
      { id: 'b', title: '다른 과제', due: null, state: 'unknown' },
    ];
    const out = dedupeBy(items, (i) => [i.id]);
    expect(out).toHaveLength(2);
    expect(out[0].due).toBe('2026-09-05');
    expect(out[0].state).toBe('submitted');
    expect(mergeFill({ a: 1, b: null }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
  });
});

function deadline(over: Partial<Deadline>): Deadline {
  return { id: 'assign:1', type: 'assignment', moduleName: 'assign', title: '과제', courseId: 101, courseName: '강좌', dueAt: NOW.plus({ days: 1 }).toISO()!, url: 'http://x', actionText: null, overdue: false, submissionState: 'not_submitted', lateAllowed: null, source: 'moodle_ajax', ...over };
}

describe('briefing', () => {
  it('일일 브리핑이 버킷과 제안을 만든다', () => {
    const b = buildDailyBriefing({ deadlines: [deadline({ id: '1', dueAt: NOW.plus({ hours: 3 }).toISO()! }), deadline({ id: '2', dueAt: NOW.minus({ days: 1 }).toISO()! })], announcements: [], changes: null, now: NOW });
    expect(b.buckets.today).toHaveLength(1);
    expect(b.buckets.overdue).toHaveLength(1);
    expect(b.suggestions.source).toBe('estimate');
    expect(b.suggestions.items.join(' ')).toContain('오늘 마감');
  });
  it('주간 계획이 요일별로 나누고 초안/점검을 제안한다', () => {
    const p = buildWeeklyPlan({ deadlines: [deadline({ id: '1', dueAt: NOW.plus({ days: 2 }).toISO()! })], now: NOW });
    expect(p.days).toHaveLength(7);
    expect(p.days.find((d) => d.isToday)?.date).toBe('2026-09-04');
    expect(p.days[6].deadlines).toHaveLength(1); // 일요일(9/6)
    expect(p.days[5].suggestedTasks.join(' ')).toContain('최종 점검');
    expect(p.days[4].suggestedTasks.join(' ')).toContain('초안');
  });
});

describe('snapshot diff', () => {
  const ann = (id: string, title = '공지'): Announcement => ({ id, courseId: 101, courseName: '강좌', boardCmId: 1, title, author: null, createdAt: null, modifiedAt: null, isPinned: false, isNew: false, hasAttachment: false, views: null, url: 'http://x', source: 'lms_page' });
  const asg = (id: string, dueAt: string | null, state: Assignment['submissionState'] = 'not_submitted'): Assignment => ({ id, cmId: 1, instanceId: null, courseId: 101, courseName: '강좌', title: '과제', url: 'http://x', allowSubmissionsFromAt: null, dueAt, cutoffAt: null, submissionStatusText: null, submissionState: state, gradingStatusText: null, gradeText: null, lateAllowed: null, source: 'lms_page' });
  it('첫 실행 후 새 항목과 변경을 감지한다', () => {
    const prev = emptySnapshot();
    const first = diffSnapshot(prev, { announcements: [ann('a1')], assignments: [asg('s1', '2026-09-05')], materials: [] });
    expect(first.firstRun).toBe(true);
    const saved = { ...applyToSnapshot(prev, { announcements: [ann('a1')], assignments: [asg('s1', '2026-09-05')], materials: [] }, [101]), savedAt: '2026-09-01T00:00:00Z' };
    const second = diffSnapshot(saved, { announcements: [ann('a1'), ann('a2', '새 공지')], assignments: [asg('s1', '2026-09-06', 'submitted')], materials: [] });
    expect(second.firstRun).toBe(false);
    expect(second.newAnnouncements.map((a) => a.id)).toEqual(['a2']);
    expect(second.changedAssignments[0].changes.join(' ')).toContain('마감 변경');
    expect(second.changedAssignments[0].changes.join(' ')).toContain('submitted');
  });
});

describe('assignment analysis', () => {
  it('요구사항 단서를 추정으로 표시한다', () => {
    const a = analyzeAssignment({ title: '보고서', dueAt: '2026-09-05T23:59:00+09:00', cutoffAt: '2026-09-07T23:59:00+09:00', descriptionText: '분량: A4 5페이지 이내\n형식: PDF 파일로 제출\n개인 과제입니다.\n9월 5일까지 LMS 온라인 제출', attachments: [{ name: 'template.docx', url: 'http://x' }] });
    expect(a.source).toBe('estimate');
    expect(a.deliverableFormats).toContain('pdf');
    expect(a.lengthHints[0]).toContain('5페이지');
    expect(a.teamWork).toBe('individual');
    expect(a.attachmentsToRead).toEqual(['template.docx']);
    expect(a.cautions.join(' ')).toContain('지각 제출');
  });
});
