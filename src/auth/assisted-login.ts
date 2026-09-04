/**
 * 보조(assisted) 로그인: Playwright 가 전용 프로필로 실제 브라우저 창을 띄우고,
 * 사용자가 직접 통합인증(패스키/2차 인증)을 마치면 LMS 세션이 생긴 것을 감지해 창을 자동으로 닫는다.
 *
 * - SSO 화면의 내용은 읽거나 조작하지 않는다. 감지는 두 가지 신호로만 한다:
 *   (1) LMS 호스트의 MoodleSession 쿠키가 새로 생기면 /my/ 를 한 번 요청해 200 인지 확인
 *   (2) 현재 탭이 LMS 호스트(로그인 화면 제외)이면 M.cfg 의 로그인 여부 확인
 * - 아이디·비밀번호·OTP·패스키를 입력하거나 저장하지 않는다.
 * - 학교 SSO 가 자동화 브라우저를 차단하면 실패할 수 있다. 그 경우 일반 브라우저 방식으로 안내한다.
 */
import { chromium, type BrowserContext } from 'playwright-core';
import type { AppConfig } from '../config.js';
import { LmsError } from '../errors.js';
import { isLoginUrl } from '../http/client.js';
import type { Logger } from '../logging.js';
import { parsePageMeta } from '../parsers/page-meta.js';
import { findBrowser, isProfileLocked, prepareProfile } from './browser-login.js';
import type { NotLoggedIn, VerifiedSession } from './session-verify.js';

export async function assistedLogin(config: AppConfig, logger: Logger, options: { timeoutMs?: number } = {}): Promise<VerifiedSession | NotLoggedIn> {
  const browser = findBrowser(config.browserPreference);
  if (!browser) throw new LmsError('BROWSER_NOT_FOUND');
  if (isProfileLocked(config.profileDir)) throw new LmsError('BROWSER_BUSY');
  prepareProfile(config.profileDir);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const lmsDomain = config.lmsHost.split(':')[0];

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      executablePath: browser.path,
      headless: false,
      viewport: null,
      timeout: 45_000,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--profile-directory=Default', '--window-size=1100,900'],
    });
  } catch (e) {
    if (isProfileLocked(config.profileDir)) throw new LmsError('BROWSER_BUSY', undefined, { cause: e });
    throw new LmsError('UNKNOWN', '로그인용 브라우저를 열지 못했습니다', { cause: e });
  }

  const collectCookies = async (): Promise<Record<string, string>> => {
    const raw = await context.cookies(config.baseUrl);
    const cookies: Record<string, string> = {};
    for (const c of raw) if (c.domain.replace(/^\./, '') === lmsDomain) cookies[c.name] = c.value;
    return cookies;
  };

  const finish = (cookies: Record<string, string>, meta: { sesskey: string | null; userId: number | null; displayName: string | null }): VerifiedSession => ({
    loggedIn: true,
    cookies,
    sesskey: meta.sesskey,
    userId: meta.userId,
    displayName: meta.displayName,
    token: null,
    tokenSource: null,
    browser: `${browser.displayName} (assisted)`,
    verifiedAt: new Date().toISOString(),
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // LMS가 복귀 대상과 세션을 먼저 만들도록 보호된 /my/에서 공식 로그인 체인을 시작한다.
    page.goto(`${config.baseUrl}/my/`, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    let lastSessionCookie = '';
    while (Date.now() < deadline) {
      const pages = context.pages();
      if (pages.length === 0) return { loggedIn: false, reason: '로그인 창이 닫혔습니다' };

      // 신호 1: 새 MoodleSession 쿠키 → /my/ 로 확인 (어느 탭이 보이든 상관없음)
      const cookies = await collectCookies().catch(() => ({} as Record<string, string>));
      const sessionName = Object.keys(cookies).find((n) => /^MoodleSession/.test(n));
      if (sessionName && cookies[sessionName] !== lastSessionCookie) {
        lastSessionCookie = cookies[sessionName];
        try {
          const res = await context.request.get(`${config.baseUrl}/my/`, { maxRedirects: 0, timeout: 15_000 });
          if (res.status() === 200) {
            const meta = parsePageMeta(await res.text());
            if (meta.loggedIn) {
              logger.info('보조 로그인 완료 감지 (세션 쿠키)');
              return finish(await collectCookies(), meta);
            }
          }
        } catch (e) {
          logger.debug('세션 확인 요청 실패', { error: (e as Error).message });
        }
      }

      // 신호 2: 현재 탭이 LMS 화면
      for (const p of pages) {
        let host = '';
        try {
          host = new URL(p.url()).host;
        } catch {
          continue;
        }
        if (host !== config.lmsHost || isLoginUrl(p.url())) continue;
        const meta = await p
          .evaluate(() => {
            const cfg = (window as unknown as { M?: { cfg?: { userId?: number; sesskey?: string } } }).M?.cfg;
            const nameEl = document.querySelector('.usermenu .usertext, [data-region="user-menu"] .usertext, .userbutton .usertext');
            return { userId: Number(cfg?.userId ?? 0), sesskey: cfg?.sesskey ?? null, displayName: nameEl?.textContent?.trim() ?? null };
          })
          .catch(() => null);
        if (meta && meta.userId > 0) {
          const c = await collectCookies();
          if (!Object.keys(c).some((n) => /^MoodleSession/.test(n))) continue;
          logger.info('보조 로그인 완료 감지 (LMS 화면)');
          return finish(c, meta);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { loggedIn: false, reason: '제한 시간 안에 로그인이 완료되지 않았습니다' };
  } finally {
    await context.close().catch(() => undefined);
  }
}
