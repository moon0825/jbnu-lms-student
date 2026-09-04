/**
 * 과제 설명에서 요구사항·제출물 단서를 뽑는 휴리스틱.
 * 결과는 항상 source: 'estimate' 로 표시되며 원문(descriptionText)과 구분해서 보여 준다.
 */
import type { Assignment } from '../adapters/types.js';

export interface AssignmentAnalysis {
  source: 'estimate';
  requirementLines: string[];
  deliverableFormats: string[];
  lengthHints: string[];
  dateMentions: string[];
  teamWork: 'team' | 'individual' | 'unknown';
  submissionMethodHints: string[];
  attachmentsToRead: string[];
  cautions: string[];
}

const FORMAT_RE = /\b(pdf|hwp|hwpx|docx?|pptx?|xlsx?|zip|ipynb|py|java|c|cpp|md|txt|jpg|png|mp4)\b/gi;
const LENGTH_RE = /(\d+\s*(?:페이지|쪽|장|매|자|단어|words?|pages?)\s*(?:이내|이상|내외|분량)?)/gi;
const DATE_RE = /(\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*\(?[월화수목금토일]\)?)?(?:\s*(?:오전|오후)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)?|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}(?:\s*\d{1,2}:\d{2})?|\d{1,2}[.\-/]\d{1,2}\s*(?:까지|마감))/g;

export function analyzeAssignment(a: Pick<Assignment, 'descriptionText' | 'attachments' | 'title' | 'dueAt' | 'cutoffAt'>): AssignmentAnalysis {
  const text = a.descriptionText ?? '';
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const requirementLines = lines.filter((l) => /제출|작성|포함|필수|반드시|형식|양식|분량|파일|보고서|발표|코드|구현|분석|정리|요약|설명|기한|마감|평가|배점|감점|기준/.test(l) && l.length <= 200).slice(0, 15);
  const deliverableFormats = Array.from(new Set((text.match(FORMAT_RE) ?? []).map((s) => s.toLowerCase())));
  const lengthHints = Array.from(new Set((text.match(LENGTH_RE) ?? []).map((s) => s.replace(/\s+/g, ' ').trim()))).slice(0, 8);
  const dateMentions = Array.from(new Set((text.match(DATE_RE) ?? []).map((s) => s.replace(/\s+/g, ' ').trim()))).slice(0, 8);
  const teamWork: AssignmentAnalysis['teamWork'] = /팀\s*(?:별|과제|프로젝트|단위)|조별|그룹\s*(?:별|과제)/.test(text) ? 'team' : /개인\s*(?:별|과제|단위)/.test(text) ? 'individual' : 'unknown';
  const submissionMethodHints = lines.filter((l) => /이메일|e-?mail|메일로|온라인 제출|LMS|업로드|오프라인|인쇄|출력|직접 제출|깃허브|github|링크/i.test(l)).slice(0, 5);
  const attachmentsToRead = (a.attachments ?? []).map((f) => f.name);
  const cautions: string[] = [];
  if (!text.trim()) cautions.push('과제 설명 본문이 비어 있습니다. 첨부파일이나 강의 공지에 요구사항이 있을 수 있습니다.');
  if (dateMentions.length && a.dueAt) cautions.push('본문에 언급된 날짜와 LMS 마감 일시가 다르면 LMS 마감 일시를 우선하되 교수자에게 확인하세요.');
  if (!a.dueAt) cautions.push('LMS 에 마감 일시가 설정되어 있지 않습니다. 본문 날짜 언급을 확인하세요.');
  if (a.cutoffAt && a.dueAt && a.cutoffAt > a.dueAt) cautions.push('마감 후에도 최종 마감(제출 차단) 전까지 지각 제출이 가능하지만 감점이 있을 수 있습니다.');
  return { source: 'estimate', requirementLines, deliverableFormats, lengthHints, dateMentions, teamWork, submissionMethodHints, attachmentsToRead, cautions };
}
