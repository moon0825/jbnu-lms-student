/**
 * 전북대 LMS(Coursemos) 전용 게시판 모듈 mod_ubboard 화면 파서.
 * 목록: /mod/ubboard/view.php?id=<cmid>[&page=N]
 * 본문: /mod/ubboard/article.php?id=<cmid>&bwid=<bwid>
 *
 * 화면 구조가 바뀌어도 최대한 견디도록 셀 헤더 텍스트와 여러 선택자를 함께 쓴다.
 */
import * as cheerio from 'cheerio';
import type { Attachment } from '../adapters/types.js';
import { LmsError } from '../errors.js';
import { collapse, htmlToText, parseIntSafe, queryParam } from '../text.js';
import { parseKoreanDateTime, toIso } from '../time.js';

export interface UbboardListItem {
  bwid: number | null;
  number: number | null;
  title: string;
  url: string;
  author: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  views: number | null;
  isPinned: boolean;
  hasAttachment: boolean;
  isNew: boolean;
}

export interface UbboardListPage {
  cmId: number | null;
  boardTitle: string | null;
  items: UbboardListItem[];
  currentPage: number;
  totalPages: number | null;
}

export interface UbboardArticle {
  bwid: number | null;
  cmId: number | null;
  title: string;
  author: string | null;
  createdAt: string | null;
  views: number | null;
  bodyHtml: string;
  bodyText: string;
  attachments: Attachment[];
}

function absolute(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

function toDateIso(text: string | null): string | null {
  return toIso(parseKoreanDateTime(text));
}

export function parseUbboardList(html: string, baseUrl: string, pageUrl?: string): UbboardListPage {
  const $ = cheerio.load(html);
  const table = $('table.ubboard_table, .ubboard_list table, .ubboard table').first();
  const boardTitle = collapse($('h2.main, .page-header-headings h1, h1').first().text()) || null;
  const cmId = parseIntSafe(queryParam(pageUrl ?? $('form.keyword_search').attr('action') ?? '', 'id')) ?? parseIntSafe($('input[name="id"]').first().attr('value'));

  if (!table.length) {
    if ($('a[href*="/mod/ubboard/article.php"]').length === 0) {
      // 게시글이 없거나 화면 구조가 다르다. 빈 목록으로 돌려주되 호출자가 구분할 수 있게 한다.
      return { cmId, boardTitle, items: [], currentPage: 1, totalPages: null };
    }
  }

  const headers = table.find('thead th').map((_, th) => collapse($(th).text())).get();
  const colIndex = (re: RegExp): number => headers.findIndex((h) => re.test(h));
  const idxTitle = colIndex(/제목|title|subject/i);
  const idxAuthor = colIndex(/작성자|writer|author/i);
  const idxCreated = colIndex(/작성일|등록일|date|created/i);
  const idxModified = colIndex(/수정일|modified|updated/i);
  const idxViews = colIndex(/조회|hit|views/i);
  const idxNumber = colIndex(/번호|no\.?$|number/i);

  const items: UbboardListItem[] = [];
  const rows = table.length ? table.find('tbody tr') : $('tr');
  rows.each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;
    const link = $(tr).find('a[href*="article.php"]').first();
    if (!link.length) return;
    const href = absolute(link.attr('href'), baseUrl);
    if (!href) return;
    const cellText = (idx: number): string | null => (idx >= 0 && cells.eq(idx).length ? collapse(cells.eq(idx).text()) : null);
    const firstCell = cells.eq(0);
    const firstCellText = collapse(firstCell.text());
    const iconAlt = (firstCell.find('img').attr('alt') ?? '') + ' ' + (firstCell.find('img').attr('src') ?? '');
    const isPinned = /공지|notice/i.test(iconAlt) || $(tr).find('.notice_bold, .notice, .pinned').length > 0 || $(tr).hasClass('notice');
    const number = parseIntSafe(idxNumber >= 0 ? cellText(idxNumber) : firstCellText);
    const titleCell = idxTitle >= 0 ? cells.eq(idxTitle) : link.closest('td');
    const iconsInTitle = titleCell.find('img').map((__, img) => `${$(img).attr('alt') ?? ''} ${$(img).attr('src') ?? ''}`).get().join(' ');
    const hasAttachment = /attach|disk|file|첨부|clip/i.test(iconsInTitle);
    const isNew = /icon%2Fnew|\bnew\b|새\s*글|newarticle/i.test(iconsInTitle) || titleCell.find('.new, .badge-new, .newarticle').length > 0;
    const title = collapse(link.text()) || collapse(titleCell.text());
    items.push({
      bwid: parseIntSafe(queryParam(href, 'bwid')),
      number: isPinned ? null : number,
      title,
      url: href,
      author: cellText(idxAuthor),
      createdAt: toDateIso(cellText(idxCreated)),
      modifiedAt: toDateIso(cellText(idxModified)),
      views: parseIntSafe(cellText(idxViews)),
      isPinned,
      hasAttachment,
      isNew,
    });
  });

  // 페이지 정보
  let currentPage = parseIntSafe(queryParam(pageUrl ?? '', 'page')) ?? 1;
  const active = $('.pagination .active, .pagination li.active a, .paging .current').first();
  if (active.length) currentPage = parseIntSafe(collapse(active.text())) ?? currentPage;
  let totalPages: number | null = null;
  $('.pagination a[href*="page="]').each((_, a) => {
    const p = parseIntSafe(queryParam($(a).attr('href'), 'page'));
    if (p && (!totalPages || p > totalPages)) totalPages = p;
  });
  if (totalPages === null && items.length) totalPages = 1;

  return { cmId, boardTitle, items, currentPage, totalPages };
}

export function parseUbboardArticle(html: string, baseUrl: string, pageUrl?: string): UbboardArticle {
  const $ = cheerio.load(html);
  const view = $('.ubboard_view').first();
  if (!view.length) {
    if (/비밀번호|password_confirm/.test(html) && $('.ubboard_view').length === 0 && $('#password_confirm').length && !$('.content').length) {
      throw new LmsError('FORBIDDEN', '비밀글이라 본문을 열 수 없습니다');
    }
    throw new LmsError('PARSE', '게시글 화면 구조를 찾지 못했습니다');
  }
  const title = collapse(view.find('.subject').first().text()) || collapse($('h2.main, h1').first().text());
  const infoText = (cls: string): string | null => {
    const el = view.find(`.info .${cls}`).first();
    if (!el.length) return null;
    const clone = el.clone();
    clone.find('.title').remove();
    return collapse(clone.text()).replace(/^:\s*/, '') || null;
  };
  const author = infoText('writer');
  const createdAt = toDateIso(infoText('date'));
  const views = parseIntSafe(infoText('hit'));
  const contentEl = view.find('.content .text_to_html, .content').first();
  const bodyHtml = contentEl.html() ?? '';
  const bodyText = htmlToText(bodyHtml);
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  view.find('.files a[href], .file a[href], a[href*="pluginfile.php"], a[href*="download.php"]').each((_, a) => {
    const href = absolute($(a).attr('href'), baseUrl);
    const name = collapse($(a).text()) || (href ? decodeURIComponent(href.split('/').pop() ?? '') : '');
    if (!href || seen.has(href) || !name) return;
    // 본문 이미지 링크는 첨부로 취급하지 않는다 (files 영역 밖의 이미지 링크)
    if ($(a).closest('.content').length && $(a).find('img').length && !$(a).closest('.files').length) return;
    seen.add(href);
    attachments.push({ name, url: href });
  });
  return {
    bwid: parseIntSafe(queryParam(pageUrl ?? '', 'bwid')),
    cmId: parseIntSafe(queryParam(pageUrl ?? '', 'id')),
    title,
    author,
    createdAt,
    views,
    bodyHtml,
    bodyText,
    attachments,
  };
}
