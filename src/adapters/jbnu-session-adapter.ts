/**
 * 전북대 LMS 화면(HTML) 어댑터. 로그인된 브라우저 세션 쿠키로 페이지를 읽고 parsers/ 로 해석한다.
 * 읽기 전용이며 상태를 바꾸는 요청(POST 제출, 글쓰기 등)은 하지 않는다.
 */
import { LmsError } from '../errors.js';
import type { LmsHttpClient } from '../http/client.js';
import type { Logger } from '../logging.js';
import { parseAssignIndexPage, parseAssignView, type AssignIndexRow, type AssignViewData } from '../parsers/assign.js';
import type { ParserCompatibility } from '../parsers/compat.js';
import { parseCoursePage, type ParsedCoursePage } from '../parsers/course-page.js';
import { parseFileLinks, parseManageTokens, parseMyCourses, type FoundToken, type MyCourseLink } from '../parsers/misc.js';
import { parsePageMeta, type PageMeta } from '../parsers/page-meta.js';
import { parseUbboardArticle, parseUbboardList, type UbboardArticle, type UbboardListPage } from '../parsers/ubboard.js';
import type { MemoryCache } from '../services/cache.js';
import { safeFileName } from '../text.js';
import type { Attachment } from './types.js';

export interface DownloadedFile {
  buffer: Buffer;
  fileName: string;
  contentType: string | null;
  url: string;
}

const PAGE_TTL_MS = 60_000;

export class JbnuSessionAdapter {
  constructor(
    private readonly http: LmsHttpClient,
    private readonly logger: Logger,
    private readonly cache: MemoryCache,
  ) {}

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** 사용자 데이터나 HTML을 남기지 않고 파서 레이아웃 변화만 관찰한다. */
  private observeParser(parser: string, compatibility: ParserCompatibility): void {
    const payload = { parser, contractVersion: compatibility.contractVersion, layout: compatibility.layout, warnings: compatibility.warnings };
    if (compatibility.confidence === 'fallback') this.logger.warn('LMS 화면 호환 모드 사용', payload);
    else this.logger.debug('LMS 화면 파서 프로필', payload);
  }

  /** HTML 페이지를 가져오고 로그인 화면이면 세션 만료로 처리한다. */
  async fetchPage(pathOrUrl: string, ttlMs = PAGE_TTL_MS): Promise<{ html: string; meta: PageMeta; url: string }> {
    return this.cache.getOrFetch(`page:${pathOrUrl}`, ttlMs, async () => {
      const res = await this.http.getText(pathOrUrl);
      const meta = parsePageMeta(res.body);
      if (meta.isLoginPage || (!meta.loggedIn && /page-login-index|loginform/.test(res.body))) {
        throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
      }
      return { html: res.body, meta, url: res.url };
    });
  }

  async getPageMeta(path = '/my/'): Promise<PageMeta> {
    const { meta } = await this.fetchPage(path, 10_000);
    return meta;
  }

  async getMyCourses(): Promise<MyCourseLink[]> {
    for (const path of ['/my/courses.php', '/my/']) {
      try {
        const { html } = await this.fetchPage(path);
        const courses = parseMyCourses(html, this.baseUrl);
        if (courses.length) return courses;
      } catch (e) {
        if ((e as LmsError).kind === 'AUTH_EXPIRED') throw e;
        this.logger.debug('강좌 목록 화면 조회 실패', { path, kind: (e as LmsError).kind });
      }
    }
    return [];
  }

  async getCoursePage(courseId: number): Promise<ParsedCoursePage> {
    const { html } = await this.fetchPage(`/course/view.php?id=${courseId}`, 5 * 60_000);
    const parsed = parseCoursePage(html, this.baseUrl);
    this.observeParser('course-page', parsed.compatibility);
    if (!parsed.courseId) parsed.courseId = courseId;
    return parsed;
  }

  async getUbboardList(cmId: number, page = 1): Promise<UbboardListPage> {
    const url = `/mod/ubboard/view.php?id=${cmId}${page > 1 ? `&page=${page}` : ''}`;
    const { html } = await this.fetchPage(url);
    const parsed = parseUbboardList(html, this.baseUrl, `${this.baseUrl}${url}`);
    this.observeParser('ubboard-list', parsed.compatibility);
    if (!parsed.cmId) parsed.cmId = cmId;
    return parsed;
  }

  async getUbboardArticle(cmId: number, bwid: number): Promise<UbboardArticle> {
    const url = `/mod/ubboard/article.php?id=${cmId}&bwid=${bwid}`;
    const { html } = await this.fetchPage(url, 5 * 60_000);
    const parsed = parseUbboardArticle(html, this.baseUrl, `${this.baseUrl}${url}`);
    this.observeParser('ubboard-article', parsed.compatibility);
    return parsed;
  }

  async getAssignIndex(courseId: number): Promise<AssignIndexRow[]> {
    const { html } = await this.fetchPage(`/mod/assign/index.php?id=${courseId}`);
    const parsed = parseAssignIndexPage(html, this.baseUrl);
    this.observeParser('assign-index', parsed.compatibility);
    return parsed.rows;
  }

  async getAssignView(cmId: number): Promise<AssignViewData> {
    const url = `/mod/assign/view.php?id=${cmId}`;
    const { html } = await this.fetchPage(url);
    const parsed = parseAssignView(html, this.baseUrl, `${this.baseUrl}${url}`);
    this.observeParser('assign-view', parsed.compatibility);
    return parsed;
  }

  /**
   * 모듈 화면에서 파일 링크를 찾는다. resource 처럼 view.php 가 바로 파일을 내려주는 경우 directFile 로 돌려준다.
   */
  async getModuleFiles(modName: string, cmId: number): Promise<{ files: Attachment[]; directFile: DownloadedFile | null }> {
    const url = `/mod/${modName}/view.php?id=${cmId}`;
    const res = await this.http.getBuffer(url);
    const contentType = res.headers.get('content-type');
    if (contentType && !/text\/html/i.test(contentType)) {
      return { files: [], directFile: { buffer: res.body, fileName: fileNameFrom(res.headers, res.url), contentType, url: res.url } };
    }
    const html = res.body.toString('utf8');
    const meta = parsePageMeta(html);
    if (meta.isLoginPage) throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
    return { files: parseFileLinks(html, this.baseUrl), directFile: null };
  }

  async downloadFile(url: string): Promise<DownloadedFile> {
    const res = await this.http.getBuffer(url);
    const contentType = res.headers.get('content-type');
    if (contentType && /text\/html/i.test(contentType)) {
      const html = res.body.toString('utf8');
      const meta = parsePageMeta(html);
      if (meta.isLoginPage) throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
      if (/nopermissions|권한|접근할 수 없/.test(html)) throw new LmsError('FORBIDDEN');
      throw new LmsError('NOT_FOUND', '파일 대신 HTML 화면이 돌아왔습니다');
    }
    return { buffer: res.body, fileName: fileNameFrom(res.headers, res.url), contentType, url: res.url };
  }

  async findWebServiceTokens(): Promise<FoundToken[]> {
    try {
      const res = await this.http.getText('/user/managetoken.php', { allowLoginRedirect: true });
      if (res.loginRedirected) return [];
      return parseManageTokens(res.body);
    } catch (e) {
      this.logger.debug('토큰 관리 화면 조회 실패', { kind: (e as LmsError).kind });
      return [];
    }
  }
}

function fileNameFrom(headers: Headers, url: string): string {
  const cd = headers.get('content-disposition') ?? '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return safeFileName(decodeURIComponent(star[1].replace(/^"|"$/g, '')));
    } catch {
      /* fallthrough */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain) return safeFileName(plain[1]);
  try {
    const last = new URL(url).pathname.split('/').pop() ?? 'file';
    return safeFileName(decodeURIComponent(last));
  } catch {
    return 'file';
  }
}
