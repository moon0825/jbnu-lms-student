/**
 * 로그인용 일반 브라우저 실행.
 * - 자동화(CDP, Playwright)를 붙이지 않은 일반 Chrome/Edge 를 전용 프로필로 연다.
 *   전북대 SSO 는 개발자 도구·자동 제어를 탐지하므로 로그인 화면에는 자동화를 연결하지 않는다.
 * - 아이디, 비밀번호, 2차 인증, 패스키는 사용자가 직접 입력·승인한다. 이 코드는 어떤 값도 읽지 않는다.
 * - 전용 프로필은 비밀번호 저장·자동완성을 끈 상태로 만든다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config.js';
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
      { name: 'chrome', displayName: 'Google Chrome', path: path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
      { name: 'msedge', displayName: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'msedge', displayName: 'Microsoft Edge', path: path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge') },
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

export const CREDENTIAL_ARTIFACTS = [
  'Login Data',
  'Login Data-journal',
  'Login Data-wal',
  'Login Data-shm',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Login Data For Account-wal',
  'Login Data For Account-shm',
  'Web Data',
  'Web Data-journal',
  'Web Data-wal',
  'Web Data-shm',
  'Account Web Data',
  'Account Web Data-journal',
  'Account Web Data-wal',
  'Account Web Data-shm',
] as const;

export const PROFILE_MARKER = '.jbnu-lms-mcp-profile';

const REUSABLE_PROFILE_ARTIFACTS = [
  'History',
  'History-journal',
  'History-wal',
  'History-shm',
  'Visited Links',
  'Top Sites',
  'Top Sites-journal',
  'Favicons',
  'Favicons-journal',
  'Sessions',
  'Session Storage',
  'Local Storage',
  'IndexedDB',
  'Service Worker',
  'Cache',
  'Code Cache',
  'GPUCache',
] as const;

function assertManagedProfile(profileDir: string): string {
  const resolved = path.resolve(profileDir);
  if (path.basename(resolved).toLowerCase() !== 'browser-profile') {
    throw new LmsError('STORAGE', '안전하지 않은 로그인 프로필 경로입니다');
  }
  if (!fs.existsSync(path.join(resolved, PROFILE_MARKER))) {
    throw new LmsError('STORAGE', '전용 로그인 프로필 표식이 없습니다');
  }
  return resolved;
}

export function hasManagedBrowserProfile(profileDir: string): boolean {
  return path.basename(path.resolve(profileDir)).toLowerCase() === 'browser-profile'
    && fs.existsSync(path.join(profileDir, PROFILE_MARKER));
}

/** 전용 프로필에 저장될 수 있는 비밀번호·자동완성 DB를 제거한다. 쿠키 DB는 건드리지 않는다. */
export function scrubCredentialArtifacts(profileDir: string): string[] {
  if (isProfileLocked(profileDir)) throw new LmsError('BROWSER_BUSY');
  const defaultDir = path.join(profileDir, 'Default');
  const removed: string[] = [];
  for (const name of CREDENTIAL_ARTIFACTS) {
    const file = path.join(defaultDir, name);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * 원문 보기용 프로필에서 LMS 쿠키 DB와 환경설정만 남기고 방문 흔적·사이트 저장소·캐시를 지운다.
 * 호출 전에 브라우저 잠금이 풀려 있어야 하며, 앱이 만든 전용 프로필만 대상으로 한다.
 */
export function scrubReusableBrowserProfile(profileDir: string): string[] {
  if (isProfileLocked(profileDir)) throw new LmsError('BROWSER_BUSY');
  const resolved = assertManagedProfile(profileDir);
  const defaultDir = path.join(resolved, 'Default');
  const removed = scrubCredentialArtifacts(resolved);
  for (const name of REUSABLE_PROFILE_ARTIFACTS) {
    const target = path.join(defaultDir, name);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  for (const name of ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache']) {
    const target = path.join(resolved, name);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * 사용자가 프로필 삭제를 요청하거나 유지 설정을 끈 경우 전용 프로필 전체를 폐기한다.
 *
 * 전용 프로필에는 SSO 콜백 URL, 임시 토큰, 사이트 저장소가 남을 수 있으므로 LMS 쿠키를
 * DPAPI 세션으로 옮긴 뒤 재사용하지 않는다. 실수로 일반 브라우저 프로필을 지우지 않도록
 * 앱이 만든 marker와 고정된 마지막 경로명을 모두 확인한다.
 */
export function removeDedicatedLoginProfile(profileDir: string): boolean {
  if (!fs.existsSync(profileDir)) return false;
  if (isProfileLocked(profileDir)) throw new LmsError('BROWSER_BUSY');
  const resolved = assertManagedProfile(profileDir);
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

/**
 * 전용 프로필 설정을 준비한다.
 * - 비밀번호 저장·자동완성·동기화 비활성
 * - session.restore_on_startup = 1 ("이전 세션 이어서"): Chrome 은 이 설정이 있어야 만료일 없는
 *   세션 쿠키(MoodleSession 등)를 창을 닫은 뒤에도 디스크에 유지한다. 없으면 창을 닫는 순간 로그인이 사라진다.
 * 브라우저가 프로필을 잠그고 있으면 건드리지 않는다.
 */
export function prepareProfile(profileDir: string): void {
  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, PROFILE_MARKER), 'managed by jbnu-lms-mcp\n', 'utf8');
  const prefFile = path.join(defaultDir, 'Preferences');
  if (isProfileLocked(profileDir)) return;
  scrubCredentialArtifacts(profileDir);
  let prefs: Record<string, unknown> = {};
  if (fs.existsSync(prefFile)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8')) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  } else {
    fs.writeFileSync(path.join(profileDir, 'First Run'), '', 'utf8');
  }
  const obj = (key: string): Record<string, unknown> => {
    const cur = prefs[key];
    if (!cur || typeof cur !== 'object') prefs[key] = {};
    return prefs[key] as Record<string, unknown>;
  };
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  Object.assign(obj('profile'), { password_manager_enabled: false, exit_type: 'Normal', exited_cleanly: true });
  Object.assign(obj('autofill'), { credit_card_enabled: false, profile_enabled: false });
  Object.assign(obj('browser'), { has_seen_welcome_page: true, check_default_browser: false });
  Object.assign(obj('signin'), { allowed: false });
  Object.assign(obj('session'), { restore_on_startup: 1 });
  fs.writeFileSync(prefFile, JSON.stringify(prefs), 'utf8');
}

export interface LaunchResult {
  browser: BrowserInfo;
  url: string;
  pid: number | null;
  /** 프로세스 종료를 기다릴 수 있는 Promise (detached 가 아닐 때만 의미 있음) */
  exited: Promise<number | null>;
}

/** 로그인·원문 보기 전용 Chromium 인수. 패스키 인증 팝업은 이 전용 프로필에서만 허용한다. */
export function buildLoginBrowserArgs(profileDir: string, url: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-sync',
    '--disable-popup-blocking',
    '--restore-last-session',
    '--new-window',
    '--window-size=1100,900',
    url,
  ];
}

export function launchLoginBrowser(config: AppConfig, logger: Logger, options: { detached?: boolean; url?: string } = {}): LaunchResult {
  const browser = findBrowser(config.browserPreference);
  if (!browser) throw new LmsError('BROWSER_NOT_FOUND');
  fs.mkdirSync(config.profileDir, { recursive: true });
  prepareProfile(config.profileDir);
  // 이전에 열려 있던 탭(오류 화면 등)이 복원되지 않도록 세션 파일만 제거한다. 쿠키는 유지된다.
  if (!isProfileLocked(config.profileDir)) {
    fs.rmSync(path.join(config.profileDir, 'Default', 'Sessions'), { recursive: true, force: true });
    fs.rmSync(path.join(config.profileDir, 'DevToolsActivePort'), { force: true });
  }
  // SSO 주소를 직접 열면 Moodle이 복귀 대상(wantsurl)과 로그인 세션을 만들지 못할 수 있다.
  // 반드시 보호된 LMS 화면에서 시작해 /login/index.php → SSO의 공식 리다이렉트 체인을 따른다.
  const url = options.url ?? `${config.baseUrl}/my/`;
  const args = buildLoginBrowserArgs(config.profileDir, url);
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

const BLOCKED_SOURCE_QUERY_KEYS = new Set(['sesskey', 'token', 'wstoken', 'password', 'passkey', 'otp', 'action', 'confirm', 'delete']);

function sourceQueryKeys(pathname: string): Set<string> {
  if (pathname === '/my/' || pathname === '/my') return new Set(['redirect']);
  if (pathname === '/course/view.php') return new Set(['id', 'section']);
  if (pathname === '/calendar/view.php') return new Set(['view', 'time', 'course', 'category']);
  if (pathname === '/mod/ubboard/article.php') return new Set(['id', 'bwid', 'page', 'listsize', 'categoryid']);
  return new Set(['id']);
}

/** 같은 LMS의 읽기 화면만 허용하고, 원문 표시에 필요 없는 쿼리와 fragment를 제거한다. */
export function validateLmsSourceUrl(baseUrl: string, rawUrl: string): string {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(rawUrl);
  } catch {
    throw new LmsError('INVALID_INPUT', '올바른 LMS 원문 URL이 아닙니다');
  }
  if (target.origin !== base.origin || target.username || target.password) {
    throw new LmsError('INVALID_INPUT', '전북대 LMS와 동일한 출처의 URL만 열 수 있습니다');
  }
  const pathname = target.pathname.toLowerCase();
  const safeModulePath = /^\/mod\/(assign|quiz|forum|folder|page|resource|ubboard|book)\/view\.php$/.test(pathname);
  const safePath = pathname === '/my/'
    || pathname === '/my'
    || pathname === '/course/view.php'
    || pathname === '/calendar/view.php'
    || pathname === '/mod/ubboard/article.php'
    || safeModulePath;
  if (!safePath) throw new LmsError('INVALID_INPUT', '강좌·공지·과제·자료·달력의 읽기 화면만 열 수 있습니다');

  for (const key of target.searchParams.keys()) {
    if (BLOCKED_SOURCE_QUERY_KEYS.has(key.toLowerCase())) {
      throw new LmsError('INVALID_INPUT', '민감하거나 상태를 변경할 수 있는 URL 매개변수는 허용하지 않습니다');
    }
  }
  const allowed = sourceQueryKeys(pathname);
  for (const key of [...target.searchParams.keys()]) {
    if (!allowed.has(key.toLowerCase())) target.searchParams.delete(key);
  }
  for (const [key, value] of [...target.searchParams.entries()]) {
    const normalized = key.toLowerCase();
    if (['id', 'bwid', 'page', 'listsize', 'categoryid', 'section', 'time', 'course', 'category'].includes(normalized) && value && !/^\d+$/.test(value)) {
      target.searchParams.delete(key);
    }
    if (normalized === 'redirect' && !/^[01]$/.test(value)) target.searchParams.delete(key);
    if (normalized === 'view' && !/^(month|day|upcoming)$/.test(value)) target.searchParams.delete(key);
  }
  const idRequired = pathname === '/course/view.php' || pathname === '/mod/ubboard/article.php' || safeModulePath;
  if (idRequired && !/^\d+$/.test(target.searchParams.get('id') ?? '')) {
    throw new LmsError('INVALID_INPUT', '원문 URL에 올바른 항목 ID가 필요합니다');
  }
  if (pathname === '/mod/ubboard/article.php' && !/^\d+$/.test(target.searchParams.get('bwid') ?? '')) {
    throw new LmsError('INVALID_INPUT', '공지 원문 URL에 올바른 게시글 ID가 필요합니다');
  }
  target.hash = '';
  return target.toString();
}

export interface SourceBrowserLaunch extends LaunchResult {
  profileReadyBeforeOpen: boolean;
  existingWindow: boolean;
}

/** 자동화·원격 디버깅 없이 전용 Chrome 프로필로 검증된 LMS 원문 화면을 연다. */
export function launchLmsSourceBrowser(config: AppConfig, logger: Logger, rawUrl: string): SourceBrowserLaunch {
  const url = validateLmsSourceUrl(config.baseUrl, rawUrl);
  const profileReadyBeforeOpen = hasManagedBrowserProfile(config.profileDir);
  const existingWindow = isProfileLocked(config.profileDir);
  const result = launchLoginBrowser(config, logger, { detached: true, url });
  logger.info('LMS 원문 브라우저 실행', { browser: result.browser.displayName, profileReadyBeforeOpen, existingWindow });
  return { ...result, profileReadyBeforeOpen, existingWindow };
}

export type LoginWindowState = 'authenticated-lms' | 'lms-home' | 'authenticated-portal' | 'authentication' | 'unknown';

/** 창 제목만으로 로그인 완료 여부를 보수적으로 분류한다. 제목 원문은 로그에 남기지 않는다. */
export function classifyLoginWindowTitle(title: string): LoginWindowState {
  const normalized = title.trim();
  if (!normalized) return 'unknown';
  if (/사이트에 로그인|log in to the site|전북대학교 로그인|패스키 인증 로그인|\bUI Page\b/i.test(normalized)) {
    return 'authentication';
  }
  if (/^(?:홈|home)\s*\|\s*JBNU\s+LXP/i.test(normalized)) return 'lms-home';
  if (/JBNU\s+LXP/i.test(normalized)) return 'authenticated-lms';
  if (/전북대학교 포털시스템/i.test(normalized)) return 'authenticated-portal';
  return 'unknown';
}

/**
 * 전용 프로필의 최신 방문 위치를 URL의 host/path와 제목만으로 분류한다.
 * 쿼리 문자열은 반환하거나 로그에 남기지 않는다. 창 제목만으로는 공개 LMS 화면을
 * 로그인 완료로 오인할 수 있어, 실제 LMS 경로와 함께 확인할 때 사용한다.
 */
export function classifyLoginHistoryEntry(url: string, title: string): LoginWindowState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  if (host === 'portal.jbnu.ac.kr') return 'authenticated-portal';
  if (host === 'sso.jbnu.ac.kr' || host === 'pass.jbnu.ac.kr') return 'authentication';
  if (host !== 'lms.jbnu.ac.kr') return 'unknown';
  if (/사이트에 로그인|log in to the site/i.test(title) || pathname.startsWith('/login/') || pathname.startsWith('/exsignon/')) {
    return 'authentication';
  }
  return 'authenticated-lms';
}

/** 실행 중 Chrome이 공유 읽기를 허용하는 History 사본만 잠깐 읽는다. 원본과 쿠키는 건드리지 않는다. */
export async function getLoginHistoryState(profileDir: string): Promise<LoginWindowState> {
  const historyFile = path.join(profileDir, 'Default', 'History');
  if (!fs.existsSync(historyFile)) return 'unknown';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-lms-history-'));
  const copy = path.join(tempDir, 'History');
  try {
    fs.copyFileSync(historyFile, copy);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const row = db.prepare('SELECT url, title FROM urls ORDER BY last_visit_time DESC LIMIT 1').get() as { url?: unknown; title?: unknown } | undefined;
      if (!row || typeof row.url !== 'string') return 'unknown';
      return classifyLoginHistoryEntry(row.url, typeof row.title === 'string' ? row.title : '');
    } finally {
      db.close();
    }
  } catch {
    return 'unknown';
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 앱이 직접 시작한 전용 Chrome broker PID의 대표 창 제목만 확인한다. */
export function getLoginWindowState(pid: number, profileDir?: string): Promise<LoginWindowState> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve('unknown');
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){[Console]::Out.Write($p.MainWindowTitle)}`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let title = '';
    child.stdout.on('data', (chunk) => { title += chunk.toString('utf8'); });
    child.once('error', () => resolve('unknown'));
    child.once('close', async () => {
      const titleState = classifyLoginWindowTitle(title);
      const historyState = profileDir ? await getLoginHistoryState(profileDir) : 'unknown';
      // LMS 완료는 두 독립 신호가 일치할 때만 인정한다. 포털 복귀는 어느 한쪽만으로도 안전하게 재탐색할 수 있다.
      if (titleState === 'authenticated-lms' && historyState === 'authenticated-lms') return resolve('authenticated-lms');
      if (titleState === 'lms-home') return resolve('lms-home');
      if (titleState === 'authenticated-portal' || historyState === 'authenticated-portal') return resolve('authenticated-portal');
      if (titleState === 'authentication' || historyState === 'authentication') return resolve('authentication');
      return resolve('unknown');
    });
  });
}

/** 이미 인증된 포털로 잘못 복귀했을 때 같은 전용 프로필/창에서 LMS 홈을 다시 연다. */
export function openLmsHomeInDedicatedBrowser(config: AppConfig): boolean {
  const browser = findBrowser(config.browserPreference);
  if (!browser || !isProfileLocked(config.profileDir)) return false;
  try {
    const child = spawn(browser.path, [
      `--user-data-dir=${config.profileDir}`,
      '--profile-directory=Default',
      `${config.baseUrl}/my/`,
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 로그인 완료 뒤 전용 Chrome 프로세스 트리만 즉시 종료해 세션 쿠키의 정상 종료 삭제를 막는다. */
export function terminateDedicatedBrowser(pid: number): Promise<boolean> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
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
