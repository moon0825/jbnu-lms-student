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
import { hasKnownEmptyState, parserCompatibility, type ParserCompatibility } from './compat.js';

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
  compatibility: ParserCompatibility;
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
  compatibility: ParserCompatibility;
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
  const grid = $('.ubboard .grid-table, .ubboard_list .grid-table').first();
  const boardTitle = collapse($('.mod-info-title, h2.main, .page-header-headings h1, h1').first().text()) || null;
  const cmId = parseIntSafe(queryParam(pageUrl ?? $('form.keyword_search').attr('action') ?? '', 'id')) ?? parseIntSafe($('input[name="id"]').first().attr('value'));

  const articleLinks = $('a[href*="/mod/ubboard/article.php"], a[href*="article.php"][href*="bwid="]');
  let compatibility = parserCompatibility(table.length ? 'legacy-table' : grid.length ? 'coursemos-grid' : 'semantic-links', table.length || grid.length ? 'high' : 'fallback');
  if (!table.length && !grid.length && articleLinks.length === 0) {
    if (hasKnownEmptyState(collapse($('body').text()), [/게시글이\s*없/i])) {
      return { cmId, boardTitle, items: [], currentPage: 1, totalPages: null, compatibility: parserCompatibility('recognized-empty-state') };
    }
    throw new LmsError('PARSE', '공지 목록 영역과 정상 빈 화면을 모두 찾지 못했습니다');
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
  const rows = table.length ? table.find('tbody tr') : grid.find('.grid-row').not('.grid-row-header');
  rows.each((_, tr) => {
    const isGrid = !table.length;
    const cells = isGrid ? $(tr).children('.grid-cell') : $(tr).find('td');
    if (!cells.length) return;
    const link = $(tr).find('a[href*="article.php"]').first();
    if (!link.length) return;
    const href = absolute(link.attr('href'), baseUrl);
    if (!href) return;
    const cellText = (idx: number): string | null => (idx >= 0 && cells.eq(idx).length ? collapse(cells.eq(idx).text()) : null);
    const gridCell = (name: string) => $(tr).find(`.grid-cell-${name}`).first();
    const firstCell = isGrid ? gridCell('number') : cells.eq(0);
    const firstCellText = collapse(firstCell.text());
    const iconAlt = (firstCell.find('img').attr('alt') ?? '') + ' ' + (firstCell.find('img').attr('src') ?? '');
    const isPinned = /공지|notice/i.test(iconAlt) || $(tr).find('.notice_bold, .notice, .pinned').length > 0 || $(tr).hasClass('notice');
    const number = parseIntSafe(isGrid ? firstCellText : idxNumber >= 0 ? cellText(idxNumber) : firstCellText);
    const titleCell = isGrid ? gridCell('subject') : idxTitle >= 0 ? cells.eq(idxTitle) : link.closest('td');
    const iconsInTitle = titleCell.find('img').map((__, img) => `${$(img).attr('alt') ?? ''} ${$(img).attr('src') ?? ''}`).get().join(' ');
    const hasAttachment = /attach|disk|file|첨부|clip/i.test(iconsInTitle);
    const isNew = /icon%2Fnew|\bnew\b|새\s*글|newarticle/i.test(iconsInTitle) || titleCell.find('.new, .badge-new, .newarticle').length > 0;
    const title = collapse(link.text()) || collapse(titleCell.text());
    items.push({
      bwid: parseIntSafe(queryParam(href, 'bwid')),
      number: isPinned ? null : number,
      title,
      url: href,
      author: isGrid ? collapse(gridCell('writer').text()) || null : cellText(idxAuthor),
      createdAt: toDateIso(isGrid ? collapse(gridCell('date').text()) || null : cellText(idxCreated)),
      modifiedAt: isGrid ? null : toDateIso(cellText(idxModified)),
      views: parseIntSafe(isGrid ? collapse(gridCell('viewcount').text()) : cellText(idxViews)),
      isPinned,
      hasAttachment,
      isNew,
    });
  });

  // CSS 클래스가 바뀌어도 article.php + bwid 링크는 의미가 안정적이므로 최소 정보를 복구한다.
  if (!table.length && !grid.length) {
    const seen = new Set<string>();
    articleLinks.each((_, a) => {
      const link = $(a);
      const href = absolute(link.attr('href'), baseUrl);
      if (!href || seen.has(href)) return;
      const bwid = parseIntSafe(queryParam(href, 'bwid'));
      const title = collapse(link.text()) || collapse(link.attr('title') ?? '') || collapse(link.attr('aria-label') ?? '');
      if (!bwid || !title) return;
      seen.add(href);
      const row = link.closest('tr, li, article, .card, .list-group-item, [data-region="post"]');
      const scope = row.length ? row : link.parent();
      const iconText = scope.find('img, [aria-label], [title]').map((__, el) => `${$(el).attr('alt') ?? ''} ${$(el).attr('aria-label') ?? ''} ${$(el).attr('title') ?? ''}`).get().join(' ');
      const dateText = collapse(scope.find('time, .date, .created, [data-field="date"]').first().attr('datetime') ?? scope.find('time, .date, .created, [data-field="date"]').first().text()) || null;
      items.push({
        bwid,
        number: parseIntSafe(scope.attr('data-number')),
        title,
        url: href,
        author: collapse(scope.find('.author, .writer, [data-field="author"]').first().text()) || null,
        createdAt: toDateIso(dateText),
        modifiedAt: null,
        views: parseIntSafe(collapse(scope.find('.views, .viewcount, [data-field="views"]').first().text())),
        isPinned: /공지|notice|pinned/i.test(`${scope.attr('class') ?? ''} ${iconText}`),
        hasAttachment: /첨부|attach|clip|file/i.test(iconText) || scope.find('a[href*="pluginfile.php"]').length > 0,
        isNew: /새\s*글|\bnew\b/i.test(`${scope.attr('class') ?? ''} ${iconText}`),
      });
    });
    if (!items.length) throw new LmsError('PARSE', '공지 링크는 찾았지만 게시글 ID와 제목을 해석하지 못했습니다');
    compatibility = parserCompatibility('semantic-links', 'fallback', ['공지 목록 CSS 변경 후보']);
  }

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

  return { cmId, boardTitle, items, currentPage, totalPages, compatibility };
}

export function parseUbboardArticle(html: string, baseUrl: string, pageUrl?: string): UbboardArticle {
  const $ = cheerio.load(html);
  const legacyView = $('.ubboard_view').first();
  const modernView = $('.ubboard').filter((_, el) => $(el).find('.article-content').length > 0).first();
  const semanticView = $('article:has(.post-content), [data-region="post"]:has([data-region="post-content"]), main article, #region-main article').first();
  const view = legacyView.length ? legacyView : modernView.length ? modernView : semanticView;
  const compatibility = parserCompatibility(legacyView.length ? 'legacy-view' : modernView.length ? 'coursemos-article' : 'semantic-article', semanticView.length && !legacyView.length && !modernView.length ? 'fallback' : 'high', semanticView.length && !legacyView.length && !modernView.length ? ['공지 본문 CSS 변경 후보'] : []);
  if (!view.length) {
    if (/비밀번호|password_confirm/.test(html) && $('.ubboard_view').length === 0 && $('#password_confirm').length && !$('.content').length) {
      throw new LmsError('FORBIDDEN', '비밀글이라 본문을 열 수 없습니다');
    }
    throw new LmsError('PARSE', '게시글 화면 구조를 찾지 못했습니다');
  }
  const title = collapse(view.find('.subject, .article-title').first().text()) || collapse($('h2.main, h1').first().text());
  const infoText = (cls: string): string | null => {
    const el = view.find(`.info .${cls}`).first();
    if (!el.length) return null;
    const clone = el.clone();
    clone.find('.title').remove();
    return collapse(clone.text()).replace(/^:\s*/, '') || null;
  };
  const author = infoText('writer') ?? (collapse(view.find('.subject-box-description .csms-user-picture .text-truncate').first().text()) || null);
  const createdAt = toDateIso(infoText('date') ?? (collapse(view.find('.subject-description-date').first().text()) || null));
  const views = parseIntSafe(infoText('hit') ?? collapse(view.find('.subject-description-viewcount').first().text()));
  let contentEl = view.find('.content .text_to_html, .article-content, [data-region="post-content"], .post-content, .content').first();
  if (!contentEl.length && view.is('article')) contentEl = view;
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
    compatibility,
  };
}
