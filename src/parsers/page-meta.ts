/**
 * Moodle 페이지 공통 메타데이터 해석 (M.cfg, 로그인 상태, 표시 이름).
 */
import * as cheerio from 'cheerio';
import { collapse } from '../text.js';

export interface PageMeta {
  sesskey: string | null;
  userId: number | null;
  wwwroot: string | null;
  loggedIn: boolean;
  isLoginPage: boolean;
  displayName: string | null;
  title: string | null;
}

export function extractMoodleCfg(html: string): Record<string, unknown> | null {
  const m = html.match(/M\.cfg\s*=\s*(\{[\s\S]*?\});\s*(?:var|M\.|<\/script>|\/\/)/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    // 일부 테마는 JSON 뒤에 JS 표현식을 붙인다. 필요한 키만 정규식으로 뽑는다.
    const sesskey = html.match(/"sesskey"\s*:\s*"([^"]+)"/);
    const userId = html.match(/"userId"\s*:\s*(\d+)/);
    const wwwroot = html.match(/"wwwroot"\s*:\s*"([^"]+)"/);
    return {
      sesskey: sesskey?.[1],
      userId: userId ? Number(userId[1]) : undefined,
      wwwroot: wwwroot?.[1]?.replace(/\\\//g, '/'),
    };
  }
}

export function parsePageMeta(html: string): PageMeta {
  const cfg = extractMoodleCfg(html) ?? {};
  const $ = cheerio.load(html);
  const userId = typeof cfg.userId === 'number' ? cfg.userId : Number(cfg.userId ?? 0) || null;
  const bodyId = $('body').attr('id') ?? '';
  const title = collapse($('title').first().text()) || null;
  const isLoginPage = bodyId === 'page-login-index' || $('form#login, form[action*="login/index.php"]').length > 0 || /\/login\/index\.php/.test($('link[rel="canonical"]').attr('href') ?? '');
  const displayName =
    firstText($, [
      '.usermenu .usertext',
      '[data-region="user-menu"] .usertext',
      '.userbutton .usertext',
      '#user-menu-toggle .usertext',
      '.usermenu .userbutton',
      '.user-name',
      '.username',
      '.logininfo a[href*="/user/profile.php"]',
    ]) ?? null;
  return {
    sesskey: typeof cfg.sesskey === 'string' && cfg.sesskey ? cfg.sesskey : null,
    userId: userId && userId > 0 ? userId : null,
    wwwroot: typeof cfg.wwwroot === 'string' ? cfg.wwwroot : null,
    loggedIn: Boolean(userId && userId > 0) && !isLoginPage,
    isLoginPage,
    displayName,
    title,
  };
}

function firstText($: cheerio.CheerioAPI, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      const txt = collapse(el.text());
      if (txt) return txt;
    }
  }
  return undefined;
}
