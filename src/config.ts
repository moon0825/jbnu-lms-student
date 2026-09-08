import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'jbnu-lms-mcp';
export const APP_VERSION = '0.7.1';
export const DEFAULT_BASE_URL = 'https://lms.jbnu.ac.kr';
export const TIMEZONE = 'Asia/Seoul';
/** 진단용 전북대 LMS 통합인증 중계 경로. 로그인 시작점으로 직접 사용하지 않는다. */
export const SSO_ENTRY_PATH = '/exsignon/sso/sso_index.php';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  baseUrl: string;
  lmsHost: string;
  dataDir: string;
  profileDir: string;
  sessionFile: string;
  stateDir: string;
  downloadDir: string;
  /** 'chrome' | 'msedge' | 실행 파일 절대 경로 | '' (자동) */
  browserPreference: string;
  /** 원문을 재로그인 없이 열 수 있도록 정리된 전용 브라우저 프로필을 유지 */
  retainBrowserProfile: boolean;
  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxConcurrentRequests: number;
  maxRetries: number;
  logLevel: LogLevel;
  /** 세션 검증용 Playwright 창을 숨길지 여부 */
  headlessVerify: boolean;
  /** 로그인 후 자동 확인 폴링 간격(ms) */
  loginPollIntervalMs: number;
  /** 선택적 HTTPS 피드백 수집 webhook. 미설정 시 로컬에만 저장 */
  feedbackEndpoint: string | null;
  /** 피드백 webhook 인증 토큰. 응답·로그에 노출하지 않는다 */
  feedbackToken: string | null;
  feedbackTimeoutMs: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function intEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (env.JBNU_LMS_DATA_DIR) return env.JBNU_LMS_DATA_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseUrl = stripTrailingSlash(env.JBNU_LMS_BASE_URL || DEFAULT_BASE_URL);
  const lmsHost = new URL(baseUrl).host;
  const dataDir = defaultDataDir(env);
  const logLevel = (env.JBNU_LMS_LOG_LEVEL as LogLevel) || 'warn';
  return {
    baseUrl,
    lmsHost,
    dataDir,
    profileDir: path.join(dataDir, 'browser-profile'),
    sessionFile: path.join(dataDir, 'session.dpapi'),
    stateDir: path.join(dataDir, 'state'),
    downloadDir: env.JBNU_LMS_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'jbnu-lms'),
    browserPreference: env.JBNU_LMS_BROWSER || '',
    retainBrowserProfile: env.JBNU_LMS_RETAIN_BROWSER_PROFILE !== '0',
    requestTimeoutMs: intEnv(env.JBNU_LMS_TIMEOUT_MS, 20_000),
    minRequestIntervalMs: intEnv(env.JBNU_LMS_MIN_INTERVAL_MS, 250),
    maxConcurrentRequests: intEnv(env.JBNU_LMS_MAX_CONCURRENCY, 3),
    maxRetries: intEnv(env.JBNU_LMS_MAX_RETRIES, 2),
    logLevel: ['silent', 'error', 'warn', 'info', 'debug'].includes(logLevel) ? logLevel : 'warn',
    headlessVerify: env.JBNU_LMS_HEADLESS_VERIFY !== '0',
    loginPollIntervalMs: intEnv(env.JBNU_LMS_LOGIN_POLL_MS, 750),
    feedbackEndpoint: env.JBNU_LMS_FEEDBACK_URL || null,
    feedbackToken: env.JBNU_LMS_FEEDBACK_TOKEN || null,
    feedbackTimeoutMs: intEnv(env.JBNU_LMS_FEEDBACK_TIMEOUT_MS, 8_000),
  };
}
