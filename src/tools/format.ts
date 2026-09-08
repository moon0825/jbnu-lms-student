/**
 * 도구 응답 텍스트(한국어 마크다운) 생성.
 * 원문 사실과 AI 추정을 구분하고, 항상 원문 URL 을 포함한다.
 */
import type { DateTime } from 'luxon';
import type { Announcement, Assignment, AuthStatus, Course, DataSource, Deadline, Material, SubmissionState } from '../adapters/types.js';
import { SOURCE_LABEL } from '../adapters/types.js';
import type { Note } from '../services/lms-service.js';
import { BUCKET_LABEL, bucketFor, formatKo, fromIso, nowSeoul, relativeKo } from '../time.js';

export const STATE_LABEL: Record<SubmissionState, string> = {
  submitted: '제출 완료 ✅',
  not_submitted: '미제출 ❗',
  draft: '초안 저장(미제출) ✏️',
  no_submission_required: '제출 불필요',
  unknown: '제출 상태 미확인',
};

export function lateLabel(lateAllowed: boolean | null): string {
  if (lateAllowed === true) return '지각 제출 가능';
  if (lateAllowed === false) return '마감 후 제출 불가';
  return '지각 허용 여부 미확인';
}

export function sourcesLine(sources: Iterable<DataSource>): string {
  const uniq = Array.from(new Set(sources));
  return uniq.length ? uniq.map((s) => SOURCE_LABEL[s]).join(', ') : '없음';
}

export function header(status: AuthStatus | null, title: string, sources: Iterable<DataSource>, now: DateTime = nowSeoul()): string {
  const who = status?.connected ? `연결됨(${status.displayName ?? '사용자'})` : '연결 안 됨';
  const sync = status?.lastSyncAt ? formatKo(fromIso(status.lastSyncAt)) : '없음';
  return [`## ${title}`, `기준 시각 ${formatKo(now)} (Asia/Seoul) · 로그인 ${who} · 마지막 동기화 ${sync} · 출처: ${sourcesLine(sources)}`, ''].join('\n');
}

export function notesBlock(notes: Note[]): string {
  if (!notes.length) return '';
  const warnings = notes.filter((n) => n.level === 'warn');
  const infos = notes.filter((n) => n.level === 'info');
  const lines: string[] = [];
  if (warnings.length) {
    lines.push(`### ⚠️ 일부 정보 확인 필요 (${warnings.length}건)`);
    lines.push(...warnings.map((n) => `- ${n.text}`));
  }
  if (infos.length) {
    if (lines.length) lines.push('');
    lines.push(...infos.map((n) => `ℹ️ ${n.text}`));
  }
  return `\n\n${lines.join('\n')}\n`;
}

/** 빈 결과와 부분 조회 실패를 명확히 구분한다. */
export function emptyState(notes: Note[], verifiedText: string): string {
  const failed = notes.filter((n) => n.level === 'warn');
  if (!failed.length) return `✅ ${verifiedText}`;
  const scopes = Array.from(new Set(failed.map((n) => n.scope).filter((v): v is string => Boolean(v))));
  const scopeText = scopes.length ? ` 영향 범위: ${scopes.slice(0, 3).join(', ')}${scopes.length > 3 ? ` 외 ${scopes.length - 3}곳` : ''}.` : '';
  return `⚠️ 확인된 항목은 0건이지만 ${failed.length}건의 조회가 실패해 전체 결과가 아닐 수 있습니다.${scopeText}`;
}

export function fmtCourse(c: Course): string {
  const bits = [`**${c.fullName}**`, `ID ${c.id}`];
  if (c.shortName) bits.push(c.shortName);
  if (c.category) bits.push(c.category);
  if (c.progress !== null) bits.push(`진행률 ${Math.round(c.progress)}%`);
  if (c.inProgress === false) bits.push('종료/예정');
  bits.push(c.url);
  return `- ${bits.join(' · ')}`;
}

export function fmtDeadline(d: Deadline, now: DateTime = nowSeoul()): string {
  const due = fromIso(d.dueAt);
  const bucket = BUCKET_LABEL[bucketFor(due, now)];
  const typeLabel = d.type === 'assignment' ? '과제' : d.type === 'quiz' ? '퀴즈' : d.type === 'forum' ? '토론' : d.type === 'attendance' ? '출석' : '일정';
  const bits = [`[${bucket}] ${formatKo(due)} (${relativeKo(due, now)})`, `**${d.title}**`, typeLabel];
  if (d.courseName) bits.push(d.courseName);
  if (d.type === 'assignment') bits.push(STATE_LABEL[d.submissionState], lateLabel(d.lateAllowed));
  bits.push(d.url);
  return `- ${bits.join(' · ')}`;
}

export function fmtAssignment(a: Assignment, now: DateTime = nowSeoul()): string {
  const due = fromIso(a.dueAt);
  const bits = [`**${a.title}**`];
  if (a.courseName) bits.push(a.courseName);
  bits.push(due ? `마감 ${formatKo(due)} (${relativeKo(due, now)})` : '마감 정보 없음');
  if (a.cutoffAt) bits.push(`최종 마감 ${formatKo(fromIso(a.cutoffAt))}`);
  bits.push(STATE_LABEL[a.submissionState]);
  if (a.submissionStatusText && a.submissionState === 'unknown') bits.push(`원문 상태 "${a.submissionStatusText}"`);
  bits.push(lateLabel(a.lateAllowed));
  if (a.gradeText && a.gradeText !== '-') bits.push(`성적 ${a.gradeText}`);
  if (a.cmId) bits.push(`cm_id ${a.cmId}`);
  bits.push(a.url);
  return `- ${bits.join(' · ')}`;
}

export function fmtAnnouncement(a: Announcement): string {
  const marks = `${a.isPinned ? '📌 ' : ''}${a.isNew ? '🆕 ' : ''}${a.hasAttachment ? '📎 ' : ''}`;
  const bits = [`${marks}**${a.title}**`];
  if (a.courseName) bits.push(a.courseName);
  if (a.author) bits.push(a.author);
  bits.push(a.createdAt ? formatKo(fromIso(a.createdAt), /T00:00/.test(a.createdAt) ? false : true) : '날짜 없음');
  if (a.boardCmId) bits.push(`board_cm_id ${a.boardCmId}`);
  const bwid = a.id.split(':')[2];
  if (bwid && /^\d+$/.test(bwid)) bits.push(`bwid ${bwid}`);
  bits.push(a.url);
  return `- ${bits.join(' · ')}`;
}

export function fmtMaterial(m: Material): string {
  const kind = { file: '파일', folder: '폴더', link: '링크', video: '동영상', page: '페이지', other: m.modName }[m.kind];
  const bits = [`[${kind}] **${m.name}**`, m.sectionTitle];
  if (!m.visible) bits.push('숨김/제한');
  if (m.availabilityText) bits.push(m.availabilityText);
  if (m.files.length) bits.push(`파일 ${m.files.length}개: ${m.files.map((f) => f.name).slice(0, 5).join(', ')}${m.files.length > 5 ? ' …' : ''}`);
  bits.push(`cm_id ${m.cmId}`);
  if (m.url) bits.push(m.url);
  return `- ${bits.join(' · ')}`;
}

export function fmtStatus(s: AuthStatus): string {
  const lines = [
    `- 상태: ${s.connected ? '✅ 연결됨' : s.pendingLogin ? '⏳ 로그인 진행 중' : '❌ 연결 안 됨'}`,
    `- 사용자: ${s.displayName ?? '알 수 없음'}`,
    `- 인증 방식: ${{ none: '없음', session: '브라우저 세션 재사용', token: '공식 API 토큰', 'session+token': '브라우저 세션 + 공식 API 토큰' }[s.mode]}`,
    `- 연결 시각: ${s.connectedAt ? formatKo(fromIso(s.connectedAt)) : '-'} · 마지막 확인: ${s.lastVerifiedAt ? formatKo(fromIso(s.lastVerifiedAt)) : '-'} · 마지막 동기화: ${s.lastSyncAt ? formatKo(fromIso(s.lastSyncAt)) : '-'}`,
    `- 저장 방식: ${s.storageBackend === 'dpapi' ? 'Windows DPAPI 암호화 파일' : s.storageBackend === 'keychain' ? 'macOS Keychain' : s.storageBackend === 'plain' ? '평문 파일(사용자 전용 권한)' : '메모리'}`,
    `- 브라우저: ${s.browser ?? '미확인'}`,
    `- 메시지: ${s.message}`,
  ];
  if (s.warnings.length) lines.push(...s.warnings.map((w) => `- ⚠️ ${w}`));
  return lines.join('\n');
}
