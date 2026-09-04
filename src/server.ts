/**
 * MCP 서버 조립. STDIO 전송을 기본으로 하며, 테스트에서는 InMemory 전송으로 같은 서버를 쓴다.
 */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JbnuSessionAdapter } from './adapters/jbnu-session-adapter.js';
import { MoodleAjaxAdapter } from './adapters/moodle-ajax-adapter.js';
import { MoodleApiAdapter } from './adapters/moodle-api-adapter.js';
import { createSecretStore, type SecretStore } from './auth/secret-store.js';
import { SessionManager } from './auth/session-manager.js';
import { APP_NAME, APP_VERSION, loadConfig, type AppConfig } from './config.js';
import { LmsHttpClient } from './http/client.js';
import { Logger, defaultLogger } from './logging.js';
import { parsePageMeta } from './parsers/page-meta.js';
import { MemoryCache } from './services/cache.js';
import { FeedbackService } from './services/feedback-service.js';
import { LmsService } from './services/lms-service.js';
import { SnapshotStore } from './services/snapshot.js';
import { registerTools } from './tools/register.js';

export interface RuntimeOptions {
  config?: AppConfig;
  logger?: Logger;
  secretStore?: SecretStore;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  http: LmsHttpClient;
  sessionManager: SessionManager;
  service: LmsService;
  snapshots: SnapshotStore;
  cache: MemoryCache;
  feedback: FeedbackService;
  loginMode: 'plain' | 'assisted';
  loginWaitSec: number;
  keepAliveMs: number;
}

export function buildRuntime(options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  const logger = options.logger ?? defaultLogger;
  logger.setLevel(config.logLevel);
  const store = options.secretStore ?? createSecretStore(config.sessionFile);
  const cache = new MemoryCache();
  let sessionManager: SessionManager;
  const http = new LmsHttpClient(
    {
      baseUrl: config.baseUrl,
      lmsHost: config.lmsHost,
      timeoutMs: config.requestTimeoutMs,
      minIntervalMs: config.minRequestIntervalMs,
      maxConcurrent: config.maxConcurrentRequests,
      maxRetries: config.maxRetries,
      logger,
      fetchImpl: options.fetchImpl,
    },
    () => sessionManager.credentials(),
  );
  const checker = async (): Promise<boolean> => {
    const res = await http.getText('/my/', { allowLoginRedirect: true });
    return !res.loginRedirected;
  };
  // 프로필에서 읽은 쿠키를 HTTP 로 검증한다(브라우저를 재실행하지 않아 세션 쿠키가 유지됨).
  const httpVerifier = async (cookies: Record<string, string>) => {
    const res = await http.getText('/my/', { allowLoginRedirect: true, withCookies: false, headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
    if (res.loginRedirected) return null;
    const meta = parsePageMeta(res.body);
    if (meta.isLoginPage || !meta.loggedIn) return null;
    return { sesskey: meta.sesskey, userId: meta.userId, displayName: meta.displayName };
  };
  sessionManager = new SessionManager(config, store, logger, checker, httpVerifier, () => cache.clear());
  const ajax = new MoodleAjaxAdapter(http, () => sessionManager.credentials(), logger);
  const session = new JbnuSessionAdapter(http, logger, cache);
  const api = new MoodleApiAdapter(http, () => sessionManager.credentials(), logger);
  const snapshots = new SnapshotStore(path.join(config.stateDir, 'snapshot.json'));
  const feedback = new FeedbackService({
    directory: path.join(config.dataDir, 'feedback'),
    endpoint: config.feedbackEndpoint,
    token: config.feedbackToken,
    timeoutMs: config.feedbackTimeoutMs,
    logger,
    fetchImpl: options.fetchImpl,
  });
  // 전북대 SSO 는 자동화 브라우저(원격 디버깅 포트 포함)를 탐지해 차단하므로 기본은 plain(자동화 없음)이다.
  const loginMode: 'plain' | 'assisted' = env.JBNU_LMS_LOGIN_MODE === 'assisted' ? 'assisted' : 'plain';
  const loginWaitSec = Number.parseInt(env.JBNU_LMS_AUTO_LOGIN_WAIT_SEC ?? '', 10) || 120;
  const keepAliveMs = env.JBNU_LMS_KEEPALIVE === '0' ? 0 : (Number.parseInt(env.JBNU_LMS_KEEPALIVE_MIN ?? '', 10) || 20) * 60_000;
  const service = new LmsService({
    config,
    logger,
    cache,
    sessionManager,
    ajax,
    session,
    api,
    snapshots,
    autoLogin: env.JBNU_LMS_AUTO_LOGIN !== '0',
    autoLoginWaitMs: loginWaitSec * 1000,
    loginMode,
  });
  return { config, logger, http, sessionManager, service, snapshots, feedback, cache, loginMode, loginWaitSec, keepAliveMs };
}

export function createMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        '전북대학교 LMS(JBNU LXP) 학생용 도우미이며 LMS 기능은 조회 전용입니다. 모든 시각은 Asia/Seoul 기준입니다. ' +
        '"놓친 것 있나" 또는 종합 점검에는 get_attention_inbox, "오늘 해야 할 일"에는 get_daily_briefing, 주간 정리는 get_weekly_study_plan을 사용하세요. ' +
        '제출 완료 여부가 중요하면 목록 상태를 그대로 단정하지 말고 check_assignment_submission으로 과제 상세 화면을 다시 확인하세요. 캘린더 반영 전에는 get_calendar_sync_candidates로 확정 후보를 만든 뒤 연결된 캘린더에서 중복을 검색하세요. ' +
        '새 공지는 get_announcements(only_new) 또는 get_recent_changes를 사용하세요. 미시청 온라인 강의·미이수 활동은 get_activity_completion으로 확인하되, 완료 추적이 없는 활동은 미이수로 단정하지 마세요. ' +
        '사용자가 LMS 원문을 열어 달라고 하면 채팅의 일반 링크 대신 open_lms_source를 사용해 로그인 전용 브라우저로 여세요. ' +
        '세션이 만료되면 도구가 자동으로 로그인 창을 열어 줍니다. 사용자가 브라우저에서 패스키/2차 인증을 직접 완료해야 하며, 도구에 비밀번호나 인증 코드를 넣지 마세요. ' +
        '응답의 "AI 추정" 표시가 있는 부분은 원문이 아니라 추정입니다. 문제 신고·기능 제안은 사용자에게 제출 내용과 수집 위치를 먼저 보여 주고 명시적으로 승인받은 경우에만 접수하세요. ' +
        '학업 답변은 도구 호출 과정보다 결과를 앞세우고, 첫 화면에 지금 할 일 최대 3개를 마감 임박 순으로 제시하세요. 내부 ID는 후속 조회에 꼭 필요할 때만 보여 주세요.',
    },
  );
  registerTools(server, {
    service: runtime.service,
    sessionManager: runtime.sessionManager,
    snapshots: runtime.snapshots,
    feedback: runtime.feedback,
    logger: runtime.logger,
    defaultLoginMode: runtime.loginMode,
    defaultLoginWaitSec: runtime.loginWaitSec,
  });
  return server;
}

/** 서버가 켜져 있는 동안 세션을 주기적으로 연장한다 (사용자 편의 우선 설정). */
export function startKeepAlive(runtime: Runtime): NodeJS.Timeout | null {
  if (!runtime.keepAliveMs) return null;
  const timer = setInterval(async () => {
    try {
      await runtime.sessionManager.load();
      if (!runtime.sessionManager.credentials()) return;
      const res = await runtime.http.getText('/my/', { allowLoginRedirect: true });
      if (res.loginRedirected) {
        runtime.sessionManager.markExpired();
        runtime.logger.info('keep-alive: 세션 만료 감지');
      } else {
        runtime.logger.debug('keep-alive: 세션 연장');
      }
    } catch (e) {
      runtime.logger.debug('keep-alive 실패', { error: (e as Error).message });
    }
  }, runtime.keepAliveMs);
  timer.unref();
  return timer;
}

export async function serveStdio(options: RuntimeOptions = {}): Promise<void> {
  const runtime = buildRuntime(options);
  const server = createMcpServer(runtime);
  await runtime.sessionManager.load();
  startKeepAlive(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  runtime.logger.info(`${APP_NAME} ${APP_VERSION} STDIO 서버 시작`, { dataDir: runtime.config.dataDir, loginMode: runtime.loginMode });
}
