/**
 * 모든 날짜·시간은 Asia/Seoul 기준으로 계산하고 표시한다.
 */
import { DateTime, Interval } from 'luxon';
import { TIMEZONE } from './config.js';

export type DeadlineBucket = 'overdue' | 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'later' | 'no_date';

const WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일'];

export function nowSeoul(): DateTime {
  return DateTime.now().setZone(TIMEZONE);
}

export function fromUnix(seconds: number | null | undefined): DateTime | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return DateTime.fromSeconds(seconds, { zone: TIMEZONE });
}

export function fromIso(iso: string | null | undefined): DateTime | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: TIMEZONE });
  return dt.isValid ? dt : null;
}

export function toIso(dt: DateTime | null | undefined): string | null {
  return dt && dt.isValid ? dt.setZone(TIMEZONE).toISO() : null;
}

/** 예: 2026-09-05(금) 23:59 */
export function formatKo(dt: DateTime | null | undefined, withTime = true): string {
  if (!dt || !dt.isValid) return '날짜 정보 없음';
  const d = dt.setZone(TIMEZONE);
  const base = `${d.toFormat('yyyy-MM-dd')}(${WEEKDAY_KO[d.weekday - 1]})`;
  return withTime ? `${base} ${d.toFormat('HH:mm')}` : base;
}

/** 남은 시간 또는 지난 시간을 한국어로. 예: "3시간 20분 남음", "2일 지남" */
export function relativeKo(target: DateTime | null | undefined, now: DateTime = nowSeoul()): string {
  if (!target || !target.isValid) return '기한 없음';
  const diffMin = Math.round(target.diff(now, 'minutes').minutes);
  const abs = Math.abs(diffMin);
  const suffix = diffMin >= 0 ? '남음' : '지남';
  if (abs < 1) return '지금';
  if (abs < 60) return `${abs}분 ${suffix}`;
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  if (abs < 24 * 60) return mins ? `${hours}시간 ${mins}분 ${suffix}` : `${hours}시간 ${suffix}`;
  const days = Math.floor(abs / (24 * 60));
  const remH = Math.floor((abs - days * 24 * 60) / 60);
  return remH ? `${days}일 ${remH}시간 ${suffix}` : `${days}일 ${suffix}`;
}

export function startOfDay(dt: DateTime): DateTime {
  return dt.setZone(TIMEZONE).startOf('day');
}

/** 월요일 시작 ~ 일요일 끝 */
export function weekRange(now: DateTime = nowSeoul()): { start: DateTime; end: DateTime } {
  const start = now.setZone(TIMEZONE).startOf('week');
  const end = start.plus({ days: 7 }).minus({ milliseconds: 1 });
  return { start, end };
}

export function bucketFor(target: DateTime | null | undefined, now: DateTime = nowSeoul()): DeadlineBucket {
  if (!target || !target.isValid) return 'no_date';
  const t = target.setZone(TIMEZONE);
  if (t < now) return 'overdue';
  const today = startOfDay(now);
  if (t < today.plus({ days: 1 })) return 'today';
  if (t < today.plus({ days: 2 })) return 'tomorrow';
  const { end } = weekRange(now);
  if (t <= end) return 'this_week';
  if (t <= end.plus({ days: 7 })) return 'next_week';
  return 'later';
}

export const BUCKET_LABEL: Record<DeadlineBucket, string> = {
  overdue: '기한 초과',
  today: '오늘',
  tomorrow: '내일',
  this_week: '이번 주',
  next_week: '다음 주',
  later: '그 이후',
  no_date: '기한 없음',
};

export function isWithin(target: DateTime | null | undefined, start: DateTime, end: DateTime): boolean {
  if (!target || !target.isValid) return false;
  return Interval.fromDateTimes(start, end).contains(target);
}

const KO_FULL_DATE = /(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?/;
const TIME_AMPM = /(오전|오후|AM|PM)\s*(\d{1,2})(?::(\d{2}))?/i;
const TIME_24 = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/**
 * LMS 화면에 표시되는 다양한 한국어 날짜 형식을 해석한다.
 * 예: "2026년 9월 5일 금요일 오후 11:59", "2026-09-05 23:59", "2026.09.05 오후 6:00"
 * 해석에 실패하면 null 을 돌려 준다(추정하지 않음).
 */
export function parseKoreanDateTime(text: string | null | undefined, now: DateTime = nowSeoul()): DateTime | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  const m = s.match(KO_FULL_DATE);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    const md = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (md) {
      year = now.year;
      month = Number(md[1]);
      day = Number(md[2]);
    }
  }
  if (!year || !month || !day) return null;
  let hour = 0;
  let minute = 0;
  const ampm = s.match(TIME_AMPM);
  if (ampm) {
    const marker = ampm[1].toUpperCase();
    const isPm = marker === '오후' || marker === 'PM';
    hour = (Number(ampm[2]) % 12) + (isPm ? 12 : 0);
    minute = ampm[3] ? Number(ampm[3]) : 0;
  } else {
    const t24 = s.match(TIME_24);
    if (t24) {
      hour = Number(t24[1]);
      minute = Number(t24[2]);
    }
  }
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone: TIMEZONE });
  return dt.isValid ? dt : null;
}
