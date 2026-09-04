import { createHash } from 'node:crypto';
import type { Assignment } from '../adapters/types.js';
import { fromIso, nowSeoul } from '../time.js';

export type SubmissionVerdict = 'confirmed_submitted' | 'draft_not_submitted' | 'not_submitted' | 'no_submission_required' | 'unknown';
export type SubmissionRisk = 'none' | 'warning' | 'critical' | 'unknown';

export interface SubmissionCheck {
  assignmentId: string;
  cmId: number | null;
  title: string;
  courseId: number;
  courseName: string | null;
  sourceUrl: string;
  verifiedAt: string;
  verdict: SubmissionVerdict;
  risk: SubmissionRisk;
  finalSubmissionConfirmed: boolean;
  schoolIssuedReceipt: false;
  dueAt: string | null;
  cutoffAt: string | null;
  submittedFiles: string[];
  evidence: string[];
  warnings: string[];
  nextAction: string;
  verificationFingerprint: string;
}

export function buildSubmissionCheck(assignment: Assignment, now = nowSeoul()): SubmissionCheck {
  const submittedFiles = (assignment.submittedFiles ?? []).map((f) => f.name);
  const evidence: string[] = ['LMS 과제 상세 화면을 이번 확인 시점에 다시 읽었습니다.'];
  if (assignment.submissionStatusText) evidence.push(`LMS 표시 제출 상태: ${assignment.submissionStatusText}`);
  if (submittedFiles.length) evidence.push(`LMS에 표시된 제출 파일 ${submittedFiles.length}개: ${submittedFiles.join(', ')}`);
  if (assignment.gradingStatusText) evidence.push(`채점 상태: ${assignment.gradingStatusText}`);

  const due = fromIso(assignment.dueAt);
  const cutoff = fromIso(assignment.cutoffAt);
  const afterDue = Boolean(due && now > due);
  const afterCutoff = Boolean(cutoff && now > cutoff);
  let verdict: SubmissionVerdict = 'unknown';
  let risk: SubmissionRisk = 'unknown';
  let nextAction = '원문을 열어 제출 상태와 제출물을 직접 확인하세요.';
  const warnings: string[] = [];

  switch (assignment.submissionState) {
    case 'submitted':
      verdict = 'confirmed_submitted';
      risk = 'none';
      nextAction = '현재 LMS 표시상 제출 완료입니다. 중요한 과제라면 제출 파일이 최종본인지 확인하세요.';
      if (!submittedFiles.length) warnings.push('제출 완료로 표시되지만 파일 목록은 없습니다. 온라인 텍스트 제출이거나 파일 목록을 읽지 못했을 수 있습니다.');
      break;
    case 'draft':
      verdict = 'draft_not_submitted';
      risk = 'critical';
      nextAction = '초안은 최종 제출이 아닙니다. 원문에서 최종 제출 버튼과 확인 절차를 완료하세요.';
      warnings.push('파일이 보여도 초안 상태이면 교수자에게 최종 제출된 것으로 처리되지 않을 수 있습니다.');
      break;
    case 'not_submitted':
      verdict = 'not_submitted';
      risk = afterDue ? 'critical' : 'warning';
      nextAction = afterCutoff
        ? '최종 제출 차단 시각이 지났습니다. 원문 상태를 확인하고 필요하면 담당 교원에게 문의하세요.'
        : afterDue
          ? '마감이 지났습니다. 지각 제출 가능 여부를 확인하고 즉시 처리하세요.'
          : '제출 요구사항을 확인하고 마감 전에 최종 제출까지 완료하세요.';
      break;
    case 'no_submission_required':
      verdict = 'no_submission_required';
      risk = 'none';
      nextAction = 'LMS 표시상 별도 제출이 필요하지 않습니다. 공지나 과제 설명에 다른 제출 경로가 있는지만 확인하세요.';
      break;
    default:
      warnings.push('LMS 화면에서 제출 상태를 확정적으로 분류하지 못했습니다.');
  }

  if (afterCutoff && verdict !== 'confirmed_submitted' && verdict !== 'no_submission_required') warnings.push('최종 제출 차단 시각이 지났습니다.');
  else if (afterDue && verdict !== 'confirmed_submitted' && verdict !== 'no_submission_required') warnings.push('표시된 마감 시각이 지났습니다.');
  if (assignment.lateAllowed === null && verdict !== 'confirmed_submitted') warnings.push('마감 후 제출 허용 여부를 확인하지 못했습니다.');

  const proof = {
    id: assignment.id,
    state: assignment.submissionState,
    status: assignment.submissionStatusText,
    files: submittedFiles,
    dueAt: assignment.dueAt,
    cutoffAt: assignment.cutoffAt,
  };
  return {
    assignmentId: assignment.id,
    cmId: assignment.cmId,
    title: assignment.title,
    courseId: assignment.courseId,
    courseName: assignment.courseName,
    sourceUrl: assignment.url,
    verifiedAt: now.toISO() ?? new Date().toISOString(),
    verdict,
    risk,
    finalSubmissionConfirmed: verdict === 'confirmed_submitted',
    schoolIssuedReceipt: false,
    dueAt: assignment.dueAt,
    cutoffAt: assignment.cutoffAt,
    submittedFiles,
    evidence,
    warnings,
    nextAction,
    verificationFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`,
  };
}
