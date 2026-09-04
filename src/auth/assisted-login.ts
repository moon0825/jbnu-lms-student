/**
 * 보조(assisted) 로그인: Playwright 가 전용 프로필로 실제 브라우저 창을 띄우고,
 * 사용자가 직접 통합인증(패스키/2차 인증)을 마치면 LMS 홈 도착을 감지해 창을 자동으로 닫는다.
 *
 * - SSO 화면의 내용은 읽거나 조작하지 않는다. 확인하는 것은 현재 탭의 URL 호스트뿐이며,
 *   LMS 호스트로 돌아온 뒤에만 M.cfg 의 로그인 여부를 읽는다.
 * - 아이디·비밀번호·OTP·패스키를 입력하거나 저장하지 않는다.
 * - 이 방식은 사용자가 창을 닫지 않아도 되므로 UX 가 좋지만, 학교 SSO 가 자동화 브라우저를
 *   차단하는 경우 실패할 수 있다. 실패하면 일반 브라우저 방식으로 안내한다.
 */
import { chromium, type BrowserContext } from 'playwright-core';
import { SSO_ENTRY_PATH, type AppConfig } from '../config.js';
import { LmsError } from '../errors.js';
import { isLoginUrl } from '../http/client.js';
import type { Logger } from '../logging.js';
import { findBrowser, isProfileLocked, prepareProfile } from './browser-login.js';
import type { NotLoggedIn, VerifiedSession } from './session-verify.js';

export async function assistedLogin(config: AppConfig, logger: Logger, options: { timeoutMs?: number } = {}): Promise<VerifiedSession | NotLoggedIn> {
  const browser = findBrowser(config.browserPreference);
  if (!browser) throw new LmsError('BROWSER_NOT_FOUND');
  if (isProfileLocked(config.profileDir)) throw new LmsError('BROWSER_BUSY');
  prepareProfile(config.profileDir);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

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

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.goto(`${config.baseUrl}${SSO_ENTRY_PATH}`, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pages = context.pages();
      if (pages.length === 0) return { loggedIn: false, reason: '로그인 창이 닫혔습니다' };
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
          const rawCookies = await context.cookies(config.baseUrl);
          const cookies: Record<string, string> = {};
          for (const c of rawCookies) if (c.domain.replace(/^\./, '') === config.lmsHost.split(':')[0]) cookies[c.name] = c.value;
          if (!Object.keys(cookies).some((n) => /^MoodleSession/.test(n))) continue;
          logger.info('보조 로그인 완료 감지');
          return {
            loggedIn: true,
            cookies,
            sesskey: meta.sesskey,
            userId: meta.userId,
            displayName: meta.displayName,
            token: null,
            tokenSource: null,
            browser: `${browser.displayName} (assisted)`,
            verifiedAt: new Date().toISOString(),
          };
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { loggedIn: false, reason: '제한 시간 안에 로그인이 완료되지 않았습니다' };
  } finally {
    await context.close().catch(() => undefined);
  }
}
