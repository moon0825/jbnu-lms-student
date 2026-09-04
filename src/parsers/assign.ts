/**
 * mod_assign 화면 파서.
 * 목록: /mod/assign/index.php?id=<courseid>
 * 상세: /mod/assign/view.php?id=<cmid>
 */
import * as cheerio from 'cheerio';
import type { Attachment, SubmissionState } from '../adapters/types.js';
import { collapse, htmlToText, parseIntSafe, queryParam } from '../text.js';
import { parseKoreanDateTime, toIso } from '../time.js';

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

export function parseAssignIndex(html: string, baseUrl: string): AssignIndexRow[] {
  const $ = cheerio.load(html);
  const rows: AssignIndexRow[] = [];
  $('table').each((_, table) => {
    const $t = $(table);
    if (!$t.find('a[href*="/mod/assign/view.php"]').length) return;
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
  return rows;
}

export function parseAssignView(html: string, baseUrl: string, pageUrl?: string): AssignViewData {
  const $ = cheerio.load(html);
  const title = collapse($('.page-header-headings h1, #page-header h1, h1, h2.main').first().text()) || '(제목 없음)';

  const descEl = $('#intro, .activity-description, [data-region="activity-information"] ~ .activity-description, .assign-intro, .box.generalbox.boxaligncenter').first();
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
  $('.activity-dates div, [data-region="activity-dates"] div, .activity-dates').each((_, d) => {
    const text = collapse($(d).text());
    const m = text.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (m && !(m[1].trim() in statusTable)) statusTable[m[1].trim()] = m[2].trim();
  });

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
  };
}
