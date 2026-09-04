/**
 * /course/view.php?id=<courseid> 화면 파서 (Moodle 4.x 표준 + Coursemos 테마 대응).
 * 주요 데이터는 core_courseformat_get_state AJAX 로 받고, 이 파서는 폴백과
 * 전북대 전용 메뉴(공지사항 ubboard) 탐색에 쓴다.
 */
import * as cheerio from 'cheerio';
import type { Attachment, CourseModule, CourseSection } from '../adapters/types.js';
import { collapse, htmlToText, parseIntSafe, queryParam } from '../text.js';
import { parseKoreanDateTime, toIso } from '../time.js';

export interface ParsedCoursePage {
  courseId: number | null;
  title: string | null;
  sections: CourseSection[];
  noticeBoardCmId: number | null;
  noticeBoardUrl: string | null;
  ubboardLinks: Array<{ cmId: number; url: string; text: string }>;
}

function abs(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

export function detectModName(el: cheerio.Cheerio<any>): string {
  const cls = el.attr('class') ?? '';
  const m = cls.match(/modtype_([a-z0-9_]+)/);
  if (m) return m[1];
  const dataMod = el.attr('data-modname') ?? el.find('[data-modname]').first().attr('data-modname');
  if (dataMod) return dataMod;
  const href = el.find('a[href*="/mod/"]').first().attr('href') ?? '';
  const hm = href.match(/\/mod\/([a-z0-9_]+)\//);
  return hm ? hm[1] : 'unknown';
}

export function parseCoursePage(html: string, baseUrl: string): ParsedCoursePage {
  const $ = cheerio.load(html);
  const courseId = parseIntSafe($('body').attr('class')?.match(/course-(\d+)/)?.[1]) ?? parseIntSafe(html.match(/"courseId"\s*:\s*(\d+)/)?.[1]);
  const title = collapse($('.page-header-headings h1, #page-header h1, h1').first().text()) || null;

  const sections: CourseSection[] = [];
  const sectionEls = $('li.section, [data-for="section"], .course-section').filter((_, el) => $(el).find('li.activity, [data-for="cmitem"], .activity-item').length > 0 || $(el).find('.sectionname, [data-for="section_title"]').length > 0);
  sectionEls.each((_, el) => {
    const $s = $(el);
    if ($s.parents('li.section, [data-for="section"]').length) return; // 중첩 방지
    const number = parseIntSafe($s.attr('data-number') ?? $s.attr('data-sectionid') ?? $s.attr('id')?.replace(/^section-/, ''));
    const sectionId = parseIntSafe($s.attr('data-id') ?? $s.attr('data-sectionid'));
    const sectionTitle = collapse($s.find('.sectionname, [data-for="section_title"], .section-title, h3').first().text()) || (number !== null ? `${number}주차` : '섹션');
    const summary = $s.find('.summarytext, .section-summary, [data-for="sectioninfo"] .summary').first().html();
    const modules: CourseModule[] = [];
    $s.find('li.activity, [data-for="cmitem"], .activity-item').each((__, mel) => {
      const $m = $(mel);
      if ($m.parents('li.activity').length && $m.is('.activity-item')) return; // li 와 내부 item 중복 방지
      const cmId = parseIntSafe($m.attr('data-id') ?? $m.attr('id')?.replace(/^module-/, '') ?? queryParam($m.find('a[href*="/mod/"]').first().attr('href'), 'id'));
      if (!cmId) return;
      if (modules.some((x) => x.cmId === cmId)) return;
      const modName = detectModName($m);
      const link = $m.find('a.aalink, .activityname a, a[href*="/mod/"]').first();
      const nameEl = $m.find('.instancename, [data-activityname], .activityname').first().clone();
      nameEl.find('.accesshide').remove();
      const name = collapse(nameEl.text()) || collapse(link.text()) || $m.attr('data-activityname') || modName;
      const url = abs(link.attr('href'), baseUrl);
      const visible = !($m.hasClass('dimmed') || $m.find('.dimmed_text, .isrestricted').length > 0 || /숨김|hidden from students/i.test(collapse($m.find('.badge').text())));
      const availabilityText = collapse($m.find('.availabilityinfo, .isrestricted').first().text()) || null;
      const descriptionHtml = $m.find('.activity-altcontent, .contentafterlink, .activity-description, .description').first().html();
      const files: Attachment[] = [];
      $m.find('a[href*="pluginfile.php"]').each((___, a) => {
        const href = abs($(a).attr('href'), baseUrl);
        const fname = collapse($(a).text()) || decodeURIComponent(href?.split('/').pop() ?? '');
        if (href && !files.some((f) => f.url === href)) files.push({ name: fname, url: href });
      });
      const dates: Array<{ label: string; at: string }> = [];
      $m.find('.activity-dates div, .activity-dates, [data-region="activity-dates"] div').each((___, d) => {
        const text = collapse($(d).text());
        const mm = text.match(/^([^:：]+)[:：]\s*(.+)$/);
        if (!mm) return;
        const at = toIso(parseKoreanDateTime(mm[2]));
        if (at && !dates.some((x) => x.label === mm[1].trim())) dates.push({ label: mm[1].trim(), at });
      });
      modules.push({
        cmId,
        modName,
        name,
        url,
        visible,
        availabilityText,
        descriptionText: descriptionHtml ? htmlToText(descriptionHtml) : null,
        files,
        dates,
      });
    });
    sections.push({
      id: sectionId,
      number,
      title: sectionTitle,
      visible: !$s.hasClass('hidden') && !$s.find('> .section-hidden, .badge:contains("숨김")').length,
      summaryText: summary ? htmlToText(summary) : null,
      modules,
    });
  });

  const ubboardLinks: Array<{ cmId: number; url: string; text: string }> = [];
  $('a[href*="/mod/ubboard/view.php"]').each((_, a) => {
    const href = abs($(a).attr('href'), baseUrl);
    const cmId = parseIntSafe(queryParam(href, 'id'));
    if (!href || !cmId) return;
    const text = collapse($(a).text()) || collapse($(a).attr('title') ?? '');
    if (!ubboardLinks.some((x) => x.cmId === cmId)) ubboardLinks.push({ cmId, url: href, text });
  });
  const notice = ubboardLinks.find((l) => /공지|notice|announce/i.test(l.text)) ?? ubboardLinks[0] ?? null;

  return {
    courseId,
    title,
    sections,
    noticeBoardCmId: notice?.cmId ?? null,
    noticeBoardUrl: notice?.url ?? null,
    ubboardLinks,
  };
}
