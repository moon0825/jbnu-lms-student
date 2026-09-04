/**
 * 과제 설명에서 요구사항·제출물 단서를 뽑는 휴리스틱.
 * 결과는 항상 source: 'estimate' 로 표시되며 원문(descriptionText)과 구분해서 보여 준다.
 */
import type { DateTime } from 'luxon';
import type { Assignment } from '../adapters/types.js';
import { formatKo, fromIso, parseKoreanDateTime } from '../time.js';

export interface DateConflict {
  mentioned: string;
  parsedDay: string | null;
  systemField: 'due' | 'cutoff';
  systemDay: string;
  note: string;
}

export interface AssignmentAnalysis {
  source: 'estimate';
  requirementLines: string[];
  deliverableFormats: string[];
  lengthHints: string[];
  dateMentions: string[];
  /** 본문 날짜가 LMS 마감과 다른 날일 때(하루 늦게 제출하는 사고 방지) */
  dateConflicts: DateConflict[];
  /** "내일·다음 주·D-3" 등 게시 시점 기준 상대 표현(지금과 다를 수 있음) */
  relativeDateMentions: string[];
  teamWork: 'team' | 'individual' | 'unknown';
  submissionMethodHints: string[];
  attachmentsToRead: string[];
  cautions: string[];
}

const FORMAT_RE = /\b(pdf|hwp|hwpx|docx?|pptx?|xlsx?|zip|ipynb|py|java|c|cpp|md|txt|jpg|png|mp4)\b/gi;
const LENGTH_RE = /(\d+\s*(?:페이지|쪽|장|매|자|단어|words?|pages?)\s*(?:이내|이상|내외|분량)?)/gi;
const DATE_RE = /(\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*\(?[월화수목금토일]\)?)?(?:\s*(?:오전|오후)?\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)?|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}(?:\s*\d{1,2}:\d{2})?|\d{1,2}[.\-/]\d{1,2}\s*(?:까지|마감))/g;
const RELATIVE_RE = /(내일모레|모레|내일|오늘\s*자정|글피|다음\s*주|이번\s*주말|이번\s*주|금주|차주|\d+\s*일\s*(?:후|뒤|이내)|[Dd]\s*[-−–]\s*\d+)/g;
const HAS_TIME_RE = /(\d{1,2}\s*시|\d{1,2}:\d{2}|오전|오후|정오|자정|AM|PM|noon|midnight)/i;

/** 본문 날짜 언급을 LMS 마감/최종마감과 일(day) 단위로 대조해 불일치를 찾는다. */
function findDateConflicts(mentions: string[], dueAt: string | null | undefined, cutoffAt: string | null | undefined): DateConflict[] {
  const targets: Array<{ field: 'due' | 'cutoff'; dt: DateTime }> = [];
  const due = fromIso(dueAt ?? null);
  const cutoff = fromIso(cutoffAt ?? null);
  if (due) targets.push({ field: 'due', dt: due });
  if (cutoff && (!due || cutoff.toISODate() !== due.toISODate())) targets.push({ field: 'cutoff', dt: cutoff });
  if (!targets.length) return [];
  const conflicts: DateConflict[] = [];
  for (const mention of mentions) {
    const parsed = parseKoreanDateTime(mention);
    if (!parsed) continue;
    const day = parsed.toISODate();
    // 본문 날짜가 어떤 시스템 날짜와도 같은 '일'이 아니면 불일치 후보
    if (targets.some((t) => t.dt.toISODate() === day)) continue;
    const nearest = targets[0];
    const noTime = !HAS_TIME_RE.test(mention);
    conflicts.push({
      mentioned: mention,
      parsedDay: day,
      systemField: nearest.field,
      systemDay: formatKo(nearest.dt, false),
      note: noTime ? '본문에 시각이 없어 자정으로 해석했습니다. 실제 마감 시각을 원문에서 확인하세요.' : 'LMS 마감과 다른 날짜입니다. 어느 것이 맞는지 원문·교수자에게 확인하세요.',
    });
  }
  return conflicts.slice(0, 6);
}

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
  const relativeDateMentions = Array.from(new Set((text.match(RELATIVE_RE) ?? []).map((s) => s.replace(/\s+/g, ' ').trim()))).slice(0, 6);
  const dateConflicts = findDateConflicts(dateMentions, a.dueAt, a.cutoffAt);
  const teamWork: AssignmentAnalysis['teamWork'] = /팀\s*(?:별|과제|프로젝트|단위)|조별|그룹\s*(?:별|과제)/.test(text) ? 'team' : /개인\s*(?:별|과제|단위)/.test(text) ? 'individual' : 'unknown';
  const submissionMethodHints = lines.filter((l) => /이메일|e-?mail|메일로|온라인 제출|LMS|업로드|오프라인|인쇄|출력|직접 제출|깃허브|github|링크/i.test(l)).slice(0, 5);
  const attachmentsToRead = (a.attachments ?? []).map((f) => f.name);
  const cautions: string[] = [];
  if (!text.trim()) cautions.push('과제 설명 본문이 비어 있습니다. 첨부파일이나 강의 공지에 요구사항이 있을 수 있습니다.');
  for (const c of dateConflicts) cautions.push(`본문 "${c.mentioned}"(${c.parsedDay ?? '해석 불가'})이(가) LMS ${c.systemField === 'due' ? '마감' : '최종 마감'} ${c.systemDay}과 다릅니다. ${c.note}`);
  if (relativeDateMentions.length) cautions.push(`본문에 상대 날짜 표현(${relativeDateMentions.join(', ')})이 있습니다. 게시 시점 기준이라 실제 날짜가 다를 수 있으니 원문에서 확인하세요.`);
  if (!dateConflicts.length && dateMentions.length && a.dueAt) cautions.push('본문에 언급된 날짜와 LMS 마감 일시가 다르면 LMS 마감 일시를 우선하되 교수자에게 확인하세요.');
  if (!a.dueAt) cautions.push('LMS 에 마감 일시가 설정되어 있지 않습니다. 본문 날짜 언급을 확인하세요.');
  if (a.cutoffAt && a.dueAt && a.cutoffAt > a.dueAt) cautions.push('마감 후에도 최종 마감(제출 차단) 전까지 지각 제출이 가능하지만 감점이 있을 수 있습니다.');
  return { source: 'estimate', requirementLines, deliverableFormats, lengthHints, dateMentions, dateConflicts, relativeDateMentions, teamWork, submissionMethodHints, attachmentsToRead, cautions };
}
