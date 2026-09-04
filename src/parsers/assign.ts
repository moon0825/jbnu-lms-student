/**
 * mod_assign 화면 파서.
 * 목록: /mod/assign/index.php?id=<courseid>
 * 상세: /mod/assign/view.php?id=<cmid>
 */
import * as cheerio from 'cheerio';
import type { Attachment, SubmissionState } from '../adapters/types.js';
import { LmsError } from '../errors.js';
import { collapse, htmlToText, parseIntSafe, queryParam } from '../text.js';
import { parseKoreanDateTime, toIso } from '../time.js';
import { hasKnownEmptyState, normalizeLabel, parserCompatibility, type ParserCompatibility } from './compat.js';

export interface AssignIndexRow {
  cmId: number | null;
  title: string;
  url: string;
  sectionTitle: string | null;
  dueText: string | null;
  dueAt: string | null;
  submissionStatusText: string | null;
  gradeText: string | null;
}

export interface AssignViewData {
  cmId: number | null;
  courseId: number | null;
  title: string;
  descriptionText: string;
  attachments: Attachment[];
  submittedFiles: Attachment[];
  statusTable: Record<string, string>;
  dueAt: string | null;
  cutoffAt: string | null;
  allowSubmissionsFromAt: string | null;
  submissionStatusText: string | null;
  gradingStatusText: string | null;
  timeRemainingText: string | null;
  gradeText: string | null;
  submissionState: SubmissionState;
  compatibility: ParserCompatibility;
}

export interface AssignIndexPage {
  rows: AssignIndexRow[];
  compatibility: ParserCompatibility;
}

const RE_DUE = /^(마감\s*일시|마감일|마감|제출\s*마감|due\s*date|due)$/i;
const RE_CUTOFF = /최종\s*마감|제출\s*차단|차단\s*일시|cut[\s-]?off/i;
const RE_ALLOW_FROM = /허용\s*시작|제출\s*시작|시작\s*일시|열림|allow\s*submissions\s*from|opens|opened/i;
const RE_REMAINING = /남은\s*시간|time\s*remaining/i;
const RE_SUB_STATUS = /^제출\s*상태|submission\s*status/i;
const RE_GRADING = /채점\s*상태|grading\s*status/i;
const RE_GRADE = /^(성적|평점|점수|grade)$/i;

function abs(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

export function classifySubmissionText(text: string | null | undefined): SubmissionState {
  if (!text) return 'unknown';
  const t = text.replace(/\s+/g, ' ').trim();
  if (/채점을 위해 제출|제출 완료|제출됨|submitted for grading|^submitted$/i.test(t)) return 'submitted';
  if (/초안|draft/i.test(t)) return 'draft';
  if (/제출 안\s*함|제출하지 않음|미제출|제출물 없음|no submission|no attempt|not submitted|nothing has been submitted/i.test(t)) return 'not_submitted';
  if (/제출이 필요하지 않|no submission required/i.test(t)) return 'no_submission_required';
  return 'unknown';
}

export function parseAssignIndexPage(html: string, baseUrl: string): AssignIndexPage {
  const $ = cheerio.load(html);
  const rows: AssignIndexRow[] = [];
  let matchedTable = false;
  $('table').each((_, table) => {
    const $t = $(table);
    if (!$t.find('a[href*="/mod/assign/view.php"]').length) return;
    matchedTable = true;
    const headers = $t.find('thead th, tr:first-child th').map((__, th) => collapse($(th).text())).get();
    const idx = (re: RegExp): number => headers.findIndex((h) => re.test(h));
    const iTitle = idx(/과제|assignment|이름|name/i);
    const iDue = idx(/마감|due/i);
    const iStatus = idx(/제출|submission/i);
    const iGrade = idx(/성적|grade|점수/i);
    const iSection = idx(/주차|주제|week|topic|section|섹션/i);
    let lastSection: string | null = null;
    $t.find('tbody tr, tr').each((__, tr) => {
      const cells = $(tr).find('td');
      if (!cells.length) return;
      const link = $(tr).find('a[href*="/mod/assign/view.php"]').first();
      const cellText = (i: number): string | null => (i >= 0 && cells.eq(i).length ? collapse(cells.eq(i).text()) || null : null);
      const sectionText = cellText(iSection);
      if (sectionText) lastSection = sectionText;
      if (!link.length) return;
      const href = abs(link.attr('href'), baseUrl);
      if (!href) return;
      const dueText = cellText(iDue);
      rows.push({
        cmId: parseIntSafe(queryParam(href, 'id')),
        title: collapse(link.text()) || cellText(iTitle) || '(제목 없음)',
        url: href,
        sectionTitle: lastSection,
        dueText,
        dueAt: toIso(parseKoreanDateTime(dueText)),
        submissionStatusText: cellText(iStatus),
        gradeText: cellText(iGrade),
      });
    });
  });

  if (rows.length) return { rows, compatibility: parserCompatibility('assignment-table') };

  // 테이블이 카드·목록 UI로 바뀐 경우에도 안정적인 모듈 URL로 최소 필드를 복구한다.
  const seen = new Set<number>();
  $('a[href*="/mod/assign/view.php"]').each((_, a) => {
    const link = $(a);
    const href = abs(link.attr('href'), baseUrl);
    const cmId = parseIntSafe(queryParam(href, 'id'));
    if (!href || !cmId || seen.has(cmId)) return;
    const scope = link.closest('li, article, .card, .activity-item, .list-group-item, [data-region="activity"]');
    const container = scope.length ? scope : link.parent();
    const title = collapse(link.text()) || collapse(link.attr('title') ?? '') || collapse(link.attr('aria-label') ?? '');
    if (!title) return;
    const time = container.find('time, [data-field="due"], .due-date, .duedate').first();
    const dueText = collapse(time.attr('datetime') ?? time.text()) || null;
    const statusText = collapse(container.find('[data-field="submission-status"], .submission-status, .status').first().text()) || null;
    const gradeText = collapse(container.find('[data-field="grade"], .grade').first().text()) || null;
    const sectionTitle = collapse(container.closest('section, [data-for="section"]').find('h2, h3, .sectionname, [data-for="section_title"]').first().text()) || null;
    seen.add(cmId);
    rows.push({ cmId, title, url: href, sectionTitle, dueText, dueAt: toIso(parseKoreanDateTime(dueText)), submissionStatusText: statusText, gradeText });
  });
  if (rows.length) return { rows, compatibility: parserCompatibility('semantic-assignment-links', 'fallback', ['과제 목록 CSS 변경 후보']) };

  if (matchedTable || hasKnownEmptyState(collapse($('body').text()), [/과제가\s*없/i, /과제물(?:들)?(?:이|가|들가)?\s*없/i])) {
    return { rows: [], compatibility: parserCompatibility(matchedTable ? 'empty-assignment-table' : 'recognized-empty-state') };
  }
  throw new LmsError('PARSE', '과제 목록 영역과 정상 빈 화면을 모두 찾지 못했습니다');
}

/** 기존 호출자를 위한 배열 반환 API. 새 코드는 parseAssignIndexPage로 호환성 정보도 확인한다. */
export function parseAssignIndex(html: string, baseUrl: string): AssignIndexRow[] {
  return parseAssignIndexPage(html, baseUrl).rows;
}

export function parseAssignView(html: string, baseUrl: string, pageUrl?: string): AssignViewData {
  const $ = cheerio.load(html);
  const title = collapse($('.page-header-headings h1, #page-header h1, h1, h2.main').first().text()) || '(제목 없음)';

  const descEl = $('#intro, .activity-description, [data-region="activity-information"] ~ .activity-description, .assign-intro, .box.generalbox.boxaligncenter, [data-region="activity-description"], .assignment-description').first();
  const descriptionText = htmlToText(descEl.html() ?? '');

  const attachments: Attachment[] = [];
  const submittedFiles: Attachment[] = [];
  const seen = new Set<string>();
  $('a[href*="pluginfile.php"]').each((_, a) => {
    const href = abs($(a).attr('href'), baseUrl);
    if (!href || seen.has(href)) return;
    const name = collapse($(a).text()) || decodeURIComponent(href.split('/').pop() ?? '');
    if (!name) return;
    seen.add(href);
    const inSubmission = $(a).closest('.submissionstatustable, .submissionsummarytable, .fileuploadsubmission, [data-region="submission"], .assignsubmission_file').length > 0 || /assignsubmission_file|submission_files/.test(href);
    (inSubmission ? submittedFiles : attachments).push({ name, url: href });
  });

  // 상태 표 (th → td)
  const statusTable: Record<string, string> = {};
  $('table.generaltable tr, .submissionstatustable tr, .submissionsummarytable tr, table tr').each((_, tr) => {
    const th = $(tr).find('th').first();
    const td = $(tr).find('td').first();
    if (!th.length || !td.length) return;
    const key = collapse(th.text()).replace(/[:：]$/, '');
    const value = collapse(td.text());
    if (key && value && !(key in statusTable)) statusTable[key] = value;
  });
  // Moodle 4.x 활동 일정 영역 ("허용 시작: ...", "마감: ...")
  // 컨테이너 자신을 매칭하면 여러 날짜가 한 값으로 뭉개지므로, 개별 항목(자식 div)만 파싱하고
  // 자식 div 가 없을 때만 컨테이너 텍스트를 줄 단위로 나눠 파싱한다.
  const addDatePart = (raw: string): void => {
    const m = collapse(raw).match(/^([^:：]+)[:：]\s*(.+)$/);
    if (m && !(m[1].trim() in statusTable)) statusTable[m[1].trim()] = m[2].trim();
  };
  $('.activity-dates, [data-region="activity-dates"]').each((_, container) => {
    const childDivs = $(container).children('div');
    if (childDivs.length) childDivs.each((__, d) => addDatePart($(d).text()));
    else for (const line of $(container).text().split(/\n+/)) addDatePart(line);
  });
  // 정의 목록이나 data-label 기반 카드로 바뀐 상태 영역을 지원한다.
  $('dt').each((_, dt) => {
    const dd = $(dt).next('dd');
    const key = normalizeLabel(collapse($(dt).text()));
    const value = collapse(dd.text());
    if (key && value && !(key in statusTable)) statusTable[key] = value;
  });
  $('[data-label]').each((_, el) => {
    const key = normalizeLabel(collapse($(el).attr('data-label') ?? ''));
    const value = collapse($(el).attr('data-value') ?? $(el).find('[data-value], .value').first().text() ?? $(el).text());
    if (key && value && !(key in statusTable)) statusTable[key] = value;
  });

  const pageIdentity = `${$('body').attr('id') ?? ''} ${$('body').attr('class') ?? ''}`;
  if (!Object.keys(statusTable).length && !descriptionText && !attachments.length && !submittedFiles.length && !/mod-assign|assign-view|page-mod-assign/i.test(pageIdentity)) {
    throw new LmsError('PARSE', '과제 상세 영역을 찾지 못했습니다');
  }
  const compatibility = Object.keys(statusTable).length
    ? parserCompatibility($('table.generaltable, .submissionstatustable, .submissionsummarytable').length ? 'assignment-status-table' : 'semantic-status-fields', $('table.generaltable, .submissionstatustable, .submissionsummarytable').length ? 'high' : 'fallback', $('table.generaltable, .submissionstatustable, .submissionsummarytable').length ? [] : ['과제 상태 CSS 변경 후보'])
    : parserCompatibility('assignment-content-only', 'fallback', ['과제 상태 필드를 찾지 못함']);

  const find = (re: RegExp, exclude?: RegExp): string | null => {
    for (const [k, v] of Object.entries(statusTable)) {
      if (re.test(k) && !(exclude && exclude.test(k))) return v;
    }
    return null;
  };
  const dueText = find(RE_DUE) ?? find(/마감|due/i, RE_CUTOFF);
  const cutoffText = find(RE_CUTOFF);
  const allowText = find(RE_ALLOW_FROM);
  const submissionStatusText = find(RE_SUB_STATUS) ?? find(/제출 상태|submission status/i);
  const gradingStatusText = find(RE_GRADING);
  const timeRemainingText = find(RE_REMAINING);
  const gradeText = find(RE_GRADE);

  return {
    cmId: parseIntSafe(queryParam(pageUrl ?? '', 'id')) ?? parseIntSafe($('body').attr('class')?.match(/cmid-(\d+)/)?.[1]),
    courseId: parseIntSafe($('body').attr('class')?.match(/course-(\d+)/)?.[1]) ?? parseIntSafe(queryParam($('a[href*="/course/view.php?id="]').first().attr('href'), 'id')),
    title,
    descriptionText,
    attachments,
    submittedFiles,
    statusTable,
    dueAt: toIso(parseKoreanDateTime(dueText)),
    cutoffAt: toIso(parseKoreanDateTime(cutoffText)),
    allowSubmissionsFromAt: toIso(parseKoreanDateTime(allowText)),
    submissionStatusText,
    gradingStatusText,
    timeRemainingText,
    gradeText,
    submissionState: classifySubmissionText(submissionStatusText),
    compatibility,
  };
}
