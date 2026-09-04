/**
 * 기타 화면 파서: 폴더/자료 모듈, 나의 강좌 목록, 웹서비스 토큰 관리 화면.
 */
import * as cheerio from 'cheerio';
import type { Attachment } from '../adapters/types.js';
import { collapse, parseIntSafe, queryParam } from '../text.js';

function abs(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

/** /mod/folder/view.php, /mod/resource/view.php 등에서 첨부파일 링크를 뽑는다. */
export function parseFileLinks(html: string, baseUrl: string): Attachment[] {
  const $ = cheerio.load(html);
  const files: Attachment[] = [];
  const seen = new Set<string>();
  $('a[href*="pluginfile.php"]').each((_, a) => {
    const href = abs($(a).attr('href'), baseUrl);
    if (!href || seen.has(href)) return;
    const nameEl = $(a).find('.fp-filename').first();
    const name = collapse(nameEl.length ? nameEl.text() : $(a).text()) || decodeURIComponent(href.split('/').pop()?.split('?')[0] ?? '');
    if (!name) return;
    seen.add(href);
    files.push({ name, url: href.replace(/\?forcedownload=1$/, '') });
  });
  // resource 모듈이 iframe/object 로 파일을 보여주는 경우
  $('iframe[src*="pluginfile.php"], object[data*="pluginfile.php"], embed[src*="pluginfile.php"]').each((_, el) => {
    const href = abs($(el).attr('src') ?? $(el).attr('data'), baseUrl);
    if (!href || seen.has(href)) return;
    seen.add(href);
    files.push({ name: decodeURIComponent(href.split('/').pop()?.split('?')[0] ?? 'file'), url: href });
  });
  return files;
}

export interface MyCourseLink {
  id: number;
  fullName: string;
  url: string;
}

/** /my/ 또는 /my/courses.php 에서 강좌 링크를 추출한다 (AJAX 실패 시 폴백). */
export function parseMyCourses(html: string, baseUrl: string): MyCourseLink[] {
  const $ = cheerio.load(html);
  const out: MyCourseLink[] = [];
  $('a[href*="/course/view.php?id="]').each((_, a) => {
    const href = abs($(a).attr('href'), baseUrl);
    const id = parseIntSafe(queryParam(href, 'id'));
    if (!href || !id || id <= 1) return;
    const nameEl = $(a).find('.coursename, .multiline, .course-title, .coursefullname').first();
    const text = collapse(nameEl.length ? nameEl.text() : $(a).text()) || collapse($(a).attr('title') ?? '') || collapse($(a).attr('aria-label') ?? '');
    if (!text) return;
    const existing = out.find((c) => c.id === id);
    if (existing) {
      if (text.length > existing.fullName.length) existing.fullName = text;
      return;
    }
    out.push({ id, fullName: text, url: `${baseUrl}/course/view.php?id=${id}` });
  });
  return out;
}

export interface FoundToken {
  service: string;
  token: string;
}

/** /user/managetoken.php 에서 전체가 보이는 32자 토큰을 찾는다. */
export function parseManageTokens(html: string): FoundToken[] {
  const $ = cheerio.load(html);
  const out: FoundToken[] = [];
  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    const text = cells.map((__, td) => collapse($(td).text())).get();
    const token = text.map((t) => t.match(/\b([a-f0-9]{32})\b/i)?.[1]).find(Boolean);
    if (!token) return;
    const service = text.find((t) => /moodle_mobile_app|mobile|모바일/i.test(t)) ?? text.find((t) => t !== token && !/^\d+$/.test(t)) ?? 'unknown';
    out.push({ service, token });
  });
  return out;
}
