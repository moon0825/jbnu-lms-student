/**
 * 익명화된 fixture 로 전북대 LMS 를 흉내 내는 로컬 HTTP 서버.
 * - MoodleSession=valid-cookie-value 쿠키가 없으면 로그인 페이지로 303 리다이렉트 (Moodle require_login 동작)
 * - AJAX 는 sesskey=testsesskey 일 때만 성공
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const VALID_COOKIE = 'valid-cookie-value';
export const VALID_SESSKEY = 'testsesskey';
export const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

export interface RecordedRequest {
  method: string;
  url: string;
  cookie: string | null;
  body: string;
}

export interface MockLms {
  baseUrl: string;
  host: string;
  requests: RecordedRequest[];
  sessionValid: boolean;
  flakyRemaining: number;
  close(): Promise<void>;
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

const ajaxData = JSON.parse(fixture('ajax-data.json')) as Record<string, unknown>;

function emptyCoursePage(id: number, title: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><script>var M={};M.cfg={"wwwroot":"http://localhost","sesskey":"${VALID_SESSKEY}","userId":12345,"courseId":${id}};</script></head><body id="page-course-view-topics" class="course-${id}"><div id="page-header"><h1>${title}</h1></div><div class="course-content"><ul class="topics"><li id="section-0" class="section main" data-number="0"><h3 class="sectionname">개요</h3><ul class="section"></ul></li></ul></div></body></html>`;
}

function emptyAssignIndex(): string {
  return `<!DOCTYPE html><html><head><title>과제</title><script>var M={};M.cfg={"sesskey":"${VALID_SESSKEY}","userId":12345};</script></head><body id="page-mod-assign-index"><div id="region-main"><p>이 강좌에는 과제가 없습니다.</p></div></body></html>`;
}

function emptyUbboardPage2(): string {
  return `<!DOCTYPE html><html><head><title>공지사항</title><script>var M={};M.cfg={"sesskey":"${VALID_SESSKEY}","userId":12345};</script></head><body id="page-mod-ubboard-view"><div id="region-main"><h2 class="main">공지사항</h2><table class="ubboard_table"><thead><tr><th>번호</th><th>제목</th></tr></thead><tbody></tbody></table></div></body></html>`;
}

export async function startMockLms(): Promise<MockLms> {
  const requests: RecordedRequest[] = [];
  const state = { sessionValid: true, flakyRemaining: 1 };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookie = req.headers.cookie ?? null;
    requests.push({ method: req.method ?? 'GET', url: url.pathname + url.search, cookie, body });
    const loggedIn = state.sessionValid && Boolean(cookie && cookie.includes(`MoodleSession=${VALID_COOKIE}`));
    const html = (content: string, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    };
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const redirectToLogin = () => {
      res.writeHead(303, { Location: 'http://localhost/login/index.php' });
      res.end();
    };
    const p = url.pathname;

    if (p === '/login/index.php') return html(fixture('login-page.html'));
    if (p === '/slow') {
      await new Promise((r) => setTimeout(r, 1500));
      return html('<html>slow</html>');
    }
    if (p === '/flaky') {
      if (state.flakyRemaining > 0) {
        state.flakyRemaining -= 1;
        return html('<html>error</html>', 503);
      }
      return html('<html>ok</html>');
    }
    if (p === '/rate-limited') {
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '7' });
      return res.end('<html>slow down</html>');
    }
    if (p === '/maintenance') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '120' });
      return res.end('<html>maintenance</html>');
    }
    if (p === '/redirect-external') {
      res.writeHead(302, { Location: 'http://evil.example.invalid/steal' });
      return res.end();
    }
    if (p === '/webservice/rest/server.php') {
      const params = new URLSearchParams(body);
      if (params.get('wstoken') !== VALID_TOKEN) return json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: '잘못된 토큰' });
      if (params.get('wsfunction') === 'core_webservice_get_site_info') return json({ userid: 12345, fullname: '홍길동', sitename: '테스트 LMS', functions: [] });
      return json({ exception: 'moodle_exception', errorcode: 'invalidrecord', message: 'unknown function' });
    }
    if (p === '/lib/ajax/service.php') {
      if (!loggedIn) return json([{ error: true, exception: { errorcode: 'servicerequireslogin', message: '로그인이 필요합니다' } }]);
      if (url.searchParams.get('sesskey') !== VALID_SESSKEY) return json([{ error: true, exception: { errorcode: 'invalidsesskey', message: '잘못된 세션 키' } }]);
      let calls: Array<{ methodname: string; args: Record<string, unknown> }> = [];
      try {
        calls = JSON.parse(body);
      } catch {
        return json([{ error: true, exception: { errorcode: 'invalidparameter', message: 'bad json' } }]);
      }
      const results = calls.map((c) => {
        if (c.methodname === 'core_calendar_get_action_events_by_timesort' && Number(c.args.limitnum) > 50) {
          return { error: true, exception: { errorcode: 'invalidparameter', message: 'Limit must be between 1 and 50 (inclusive)' } };
        }
        const data = ajaxData[c.methodname];
        if (data === undefined) return { error: true, exception: { errorcode: 'invalidrecord', message: `unknown ${c.methodname}` } };
        if (c.methodname === 'core_courseformat_get_state') {
          if (c.args.courseid !== 101) return { error: true, exception: { errorcode: 'invalidrecord', message: 'no state' } };
          return { error: false, data: JSON.stringify(data) };
        }
        if (c.methodname === 'core_course_get_updates_since' && (c.args.courseid !== 101 || Number(c.args.since) >= 1788436000)) return { error: false, data: { instances: [], warnings: [] } };
        return { error: false, data };
      });
      return json(results);
    }
    if (!loggedIn) return redirectToLogin();

    if (p === '/my/' || p === '/my/index.php' || p === '/my/courses.php') return html(fixture('my-page.html'));
    if (p === '/course/view.php') {
      const id = Number(url.searchParams.get('id'));
      if (id === 101) return html(fixture('course-view.html'));
      if (id === 102) return html(emptyCoursePage(102, '테스트 강좌 B'));
      return html('<html><body>invalidcourse</body></html>', 404);
    }
    if (p === '/mod/ubboard/view.php') {
      if (url.searchParams.get('page') === '2') return html(emptyUbboardPage2());
      return html(fixture('ubboard-list.html'));
    }
    if (p === '/mod/ubboard/article.php') {
      if (url.searchParams.get('bwid') === '90001') return html(fixture('ubboard-article.html'));
      return html('<html><body>없는 글</body></html>', 404);
    }
    if (p === '/mod/assign/index.php') return html(Number(url.searchParams.get('id')) === 101 ? fixture('assign-index.html') : emptyAssignIndex());
    if (p === '/mod/assign/view.php') return html(fixture('assign-view.html'));
    if (p === '/mod/folder/view.php') return html(fixture('folder-view.html'));
    if (p === '/mod/resource/view.php') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''%EA%B0%95%EC%9D%98%EC%9E%90%EB%A3%8C.pdf" });
      return res.end(Buffer.from('%PDF-1.4 fixture'));
    }
    if (p === '/user/managetoken.php') return html(fixture('managetoken.html'));
    if (p.startsWith('/pluginfile.php')) {
      const name = decodeURIComponent(p.split('/').pop() ?? 'file.bin');
      res.writeHead(200, { 'Content-Type': name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"` });
      return res.end(Buffer.from(`fixture-bytes:${name}`));
    }
    return html('<html><body>not found</body></html>', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    host: `127.0.0.1:${addr.port}`,
    requests,
    get sessionValid() {
      return state.sessionValid;
    },
    set sessionValid(v: boolean) {
      state.sessionValid = v;
    },
    get flakyRemaining() {
      return state.flakyRemaining;
    },
    set flakyRemaining(v: number) {
      state.flakyRemaining = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
