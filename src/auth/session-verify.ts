/**
 * 사용자가 로그인을 마친 전용 브라우저 프로필을 Playwright 로 열어 세션을 검증하고
 * 필요한 최소 정보(LMS 쿠키, sesskey, 사용자 ID)를 추출한다.
 *
 * 원칙:
 * - LMS 호스트 외의 요청(SSO 포함)은 모두 차단한다. 로그인 자동화는 절대 하지 않는다.
 * - 화면은 기본적으로 headless 로 열며 사용자 입력을 요구하지 않는다.
 * - 가능하면 공식 모바일 토큰도 시도한다(전북대 설정상 실패가 정상이며, 실패해도 세션 방식으로 진행).
 */
import crypto from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright-core';
import type { AppConfig } from '../config.js';
import { LmsError } from '../errors.js';
import type { Logger } from '../logging.js';
import { parseManageTokens } from '../parsers/misc.js';
import { parsePageMeta } from '../parsers/page-meta.js';
import { findBrowser, isProfileLocked, type BrowserInfo } from './browser-login.js';

export interface VerifiedSession {
  loggedIn: true;
  cookies: Record<string, string>;
  sesskey: string | null;
  userId: number | null;
  displayName: string | null;
  token: string | null;
  tokenSource: 'managetoken' | 'launch' | null;
  browser: string;
  verifiedAt: string;
}

export interface NotLoggedIn {
  loggedIn: false;
  reason: string;
}

export async function verifyBrowserSession(config: AppConfig, logger: Logger, options: { tryToken?: boolean; browser?: BrowserInfo | null } = {}): Promise<VerifiedSession | NotLoggedIn> {
  const browser = options.browser ?? findBrowser(config.browserPreference);
  if (!browser) throw new LmsError('BROWSER_NOT_FOUND');
  if (isProfileLocked(config.profileDir)) throw new LmsError('BROWSER_BUSY');

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      executablePath: browser.path,
      headless: config.headlessVerify,
      timeout: 45_000,
      viewport: null,
      args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--profile-directory=Default'],
    });
  } catch (e) {
    if (isProfileLocked(config.profileDir)) throw new LmsError('BROWSER_BUSY', undefined, { cause: e });
    throw new LmsError('UNKNOWN', '세션 확인용 브라우저를 열지 못했습니다', { cause: e });
  }

  try {
    await context.route('**/*', (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).host;
      } catch {
        /* ignore */
      }
      if (host === config.lmsHost) return route.continue();
      return route.abort('blockedbyclient');
    });
    const page = context.pages()[0] ?? (await context.newPage());
    let html = '';
    let finalUrl = '';
    try {
      const res = await page.goto(`${config.baseUrl}/my/`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      finalUrl = res?.url() ?? page.url();
      html = await page.content();
    } catch (e) {
      throw new LmsError('NETWORK', 'LMS 화면을 열지 못했습니다', { cause: e });
    }
    const meta = parsePageMeta(html);
    if (meta.isLoginPage || !meta.loggedIn || /\/login\//.test(finalUrl)) {
      logger.info('브라우저 프로필에 유효한 LMS 세션이 없음');
      return { loggedIn: false, reason: 'LMS 로그인 화면이 표시되었습니다' };
    }
    const allCookies = await context.cookies();
    const rawCookies = allCookies.filter((c) => c.domain.replace(/^\./, '') === config.lmsHost.split(':')[0]);
    const cookies: Record<string, string> = {};
    for (const c of rawCookies) {
      cookies[c.name] = c.value;
    }
    if (!Object.keys(cookies).some((n) => /^MoodleSession/.test(n))) {
      return { loggedIn: false, reason: 'LMS 세션 쿠키를 찾지 못했습니다' };
    }

    let token: string | null = null;
    let tokenSource: VerifiedSession['tokenSource'] = null;
    if (options.tryToken !== false) {
      const found = await tryObtainToken(context, config, logger);
      token = found?.token ?? null;
      tokenSource = found?.source ?? null;
    }

    // 전용 프로필에는 LMS 쿠키만 다시 넣는다. SSO·포털 쿠키를 남기지 않는다.
    try {
      await context.clearCookies();
      if (rawCookies.length) await context.addCookies(rawCookies);
    } catch (e) {
      throw new LmsError('STORAGE', '로그인 프로필의 SSO 쿠키를 정리하지 못했습니다', { cause: e });
    }

    return {
      loggedIn: true,
      cookies,
      sesskey: meta.sesskey,
      userId: meta.userId,
      displayName: meta.displayName,
      token,
      tokenSource,
      browser: browser.displayName,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * 공식 토큰 확보 시도. 전북대 LMS 는 typeoflogin=1(앱 내 로그인) 설정이라 launch.php 가
 * "플러그인이 활성화되지 않았거나 구성되지 않았습니다" 를 돌려주는 것이 정상이다.
 * 관리자가 정책을 바꾸면 이 경로가 자동으로 살아난다.
 */
async function tryObtainToken(context: BrowserContext, config: AppConfig, logger: Logger): Promise<{ token: string; source: 'managetoken' | 'launch' } | null> {
  const request = context.request;
  try {
    const res = await request.get(`${config.baseUrl}/user/managetoken.php`, { maxRedirects: 3, timeout: 20_000 });
    if (res.ok()) {
      const tokens = parseManageTokens(await res.text());
      const mobile = tokens.find((t) => /mobile|모바일/i.test(t.service)) ?? tokens[0];
      if (mobile && (await validateToken(context, config, mobile.token))) {
        logger.info('기존 웹서비스 토큰을 발견해 사용합니다', { service: mobile.service });
        return { token: mobile.token, source: 'managetoken' };
      }
    }
  } catch (e) {
    logger.debug('managetoken 조회 실패', { error: (e as Error).message });
  }
  try {
    const passport = `${Date.now()}.${crypto.randomInt(100000, 999999)}`;
    const url = `${config.baseUrl}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${encodeURIComponent(passport)}&urlscheme=jbnulmsmcp`;
    const res = await request.get(url, { maxRedirects: 0, timeout: 20_000 });
    const location = res.headers()['location'] ?? '';
    if (res.status() >= 300 && res.status() < 400 && location.startsWith('jbnulmsmcp://token=')) {
      const decoded = Buffer.from(location.slice('jbnulmsmcp://token='.length), 'base64').toString('utf8');
      const [siteId, token] = decoded.split(':::');
      const expected = crypto.createHash('md5').update(`${config.baseUrl}${passport}`).digest('hex');
      if (siteId === expected && token && (await validateToken(context, config, token))) {
        logger.info('모바일 앱 실행 흐름으로 공식 토큰을 확보했습니다');
        return { token, source: 'launch' };
      }
    } else {
      logger.debug('launch.php 는 토큰을 주지 않음(설정상 정상)', { status: res.status() });
    }
  } catch (e) {
    logger.debug('launch.php 시도 실패', { error: (e as Error).message });
  }
  return null;
}

async function validateToken(context: BrowserContext, config: AppConfig, token: string): Promise<boolean> {
  try {
    const res = await context.request.post(`${config.baseUrl}/webservice/rest/server.php`, {
      form: { wstoken: token, wsfunction: 'core_webservice_get_site_info', moodlewsrestformat: 'json' },
      timeout: 20_000,
    });
    if (!res.ok()) return false;
    const body = (await res.json()) as { userid?: number; exception?: string };
    return Boolean(body && !body.exception && body.userid);
  } catch {
    return false;
  }
}
