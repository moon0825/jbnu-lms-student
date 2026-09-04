/**
 * 로그인용 일반 브라우저 실행.
 * - 자동화(CDP, Playwright)를 붙이지 않은 일반 Chrome/Edge 를 전용 프로필로 연다.
 *   전북대 SSO 는 개발자 도구·자동 제어를 탐지하므로 로그인 화면에는 자동화를 연결하지 않는다.
 * - 아이디, 비밀번호, 2차 인증, 패스키는 사용자가 직접 입력·승인한다. 이 코드는 어떤 값도 읽지 않는다.
 * - 전용 프로필은 비밀번호 저장·자동완성을 끈 상태로 만든다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SSO_ENTRY_PATH, type AppConfig } from '../config.js';
import { LmsError } from '../errors.js';
import type { Logger } from '../logging.js';

export interface BrowserInfo {
  name: 'chrome' | 'msedge' | 'custom';
  displayName: string;
  path: string;
}

function candidates(env: NodeJS.ProcessEnv): Array<BrowserInfo> {
  const pf = env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA ?? '';
  const list: BrowserInfo[] = [];
  if (process.platform === 'win32') {
    list.push(
      { name: 'chrome', displayName: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', displayName: 'Google Chrome', path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'chrome', displayName: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'msedge', displayName: 'Microsoft Edge', path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'msedge', displayName: 'Microsoft Edge', path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    );
  } else if (process.platform === 'darwin') {
    list.push(
      { name: 'chrome', displayName: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'msedge', displayName: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    );
  } else {
    list.push(
      { name: 'chrome', displayName: 'Google Chrome', path: '/usr/bin/google-chrome' },
      { name: 'chrome', displayName: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
      { name: 'msedge', displayName: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
    );
  }
  return list;
}

export function findBrowser(preference: string, env: NodeJS.ProcessEnv = process.env): BrowserInfo | null {
  const all = candidates(env);
  if (preference) {
    if (preference === 'chrome' || preference === 'msedge') {
      const hit = all.find((b) => b.name === preference && fs.existsSync(b.path));
      if (hit) return hit;
    } else if (fs.existsSync(preference)) {
      return { name: 'custom', displayName: path.basename(preference), path: preference };
    }
  }
  return all.find((b) => fs.existsSync(b.path)) ?? null;
}

/** 프로필이 브라우저에 의해 사용 중인지(잠금 파일) */
export function isProfileLocked(profileDir: string): boolean {
  return fs.existsSync(path.join(profileDir, 'lockfile')) || fs.existsSync(path.join(profileDir, 'SingletonLock'));
}

/** 전용 프로필에 비밀번호 저장·자동완성 비활성 설정을 미리 써 둔다(최초 1회). */
export function prepareProfile(profileDir: string): void {
  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefFile = path.join(defaultDir, 'Preferences');
  if (fs.existsSync(prefFile)) return;
  const prefs = {
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: { password_manager_enabled: false, default_content_setting_values: { notifications: 2 } },
    autofill: { credit_card_enabled: false, profile_enabled: false },
    browser: { has_seen_welcome_page: true, check_default_browser: false },
    signin: { allowed: false },
  };
  fs.writeFileSync(prefFile, JSON.stringify(prefs), 'utf8');
  fs.writeFileSync(path.join(profileDir, 'First Run'), '', 'utf8');
}

export interface LaunchResult {
  browser: BrowserInfo;
  url: string;
  pid: number | null;
  /** 프로세스 종료를 기다릴 수 있는 Promise (detached 가 아닐 때만 의미 있음) */
  exited: Promise<number | null>;
}

export function launchLoginBrowser(config: AppConfig, logger: Logger, options: { detached?: boolean; url?: string } = {}): LaunchResult {
  const browser = findBrowser(config.browserPreference);
  if (!browser) throw new LmsError('BROWSER_NOT_FOUND');
  fs.mkdirSync(config.profileDir, { recursive: true });
  prepareProfile(config.profileDir);
  const url = options.url ?? `${config.baseUrl}${SSO_ENTRY_PATH}`;
  const args = [
    `--user-data-dir=${config.profileDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-sync',
    '--new-window',
    '--window-size=1100,900',
    url,
  ];
  logger.info('로그인용 브라우저 실행', { browser: browser.displayName, detached: Boolean(options.detached) });
  const child = spawn(browser.path, args, {
    detached: Boolean(options.detached),
    stdio: 'ignore',
    windowsHide: false,
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  if (options.detached) child.unref();
  return { browser, url, pid: child.pid ?? null, exited };
}

/** 프로필 잠금이 풀릴 때까지 대기. 풀리면 true. */
export async function waitForProfileRelease(profileDir: string, timeoutMs: number, pollMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawLock = isProfileLocked(profileDir);
  while (Date.now() < deadline) {
    const locked = isProfileLocked(profileDir);
    if (!locked && sawLock) {
      await new Promise((r) => setTimeout(r, 1200)); // 프로세스가 파일을 완전히 놓을 시간
      return true;
    }
    if (!locked && !sawLock) {
      // 아직 브라우저가 프로필을 잠그기 전일 수 있다. 잠시 더 관찰한다.
      await new Promise((r) => setTimeout(r, pollMs));
      sawLock = isProfileLocked(profileDir);
      if (!sawLock && Date.now() - (deadline - timeoutMs) > 8000) return true;
      continue;
    }
    sawLock = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isProfileLocked(profileDir);
}
