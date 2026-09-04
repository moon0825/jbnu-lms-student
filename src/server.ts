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
import { MemoryCache } from './services/cache.js';
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
  sessionManager = new SessionManager(config, store, logger, checker);
  const ajax = new MoodleAjaxAdapter(http, () => sessionManager.credentials(), logger);
  const session = new JbnuSessionAdapter(http, logger, cache);
  const api = new MoodleApiAdapter(http, () => sessionManager.credentials(), logger);
  const snapshots = new SnapshotStore(path.join(config.stateDir, 'snapshot.json'));
  const loginMode: 'plain' | 'assisted' = env.JBNU_LMS_LOGIN_MODE === 'plain' ? 'plain' : 'assisted';
  const loginWaitSec = Number.parseInt(env.JBNU_LMS_AUTO_LOGIN_WAIT_SEC ?? '', 10) || 90;
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
  return { config, logger, http, sessionManager, service, snapshots, cache, loginMode, loginWaitSec, keepAliveMs };
}

export function createMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        '전북대학교 LMS(JBNU LXP) 학생용 읽기 전용 도우미입니다. 모든 시각은 Asia/Seoul 기준입니다. ' +
        '"오늘 해야 할 일" 류 질문에는 get_daily_briefing, 주간 정리는 get_weekly_study_plan, 새 공지는 get_announcements(only_new) 또는 get_recent_changes 를 사용하세요. ' +
        '세션이 만료되면 도구가 자동으로 로그인 창을 열어 줍니다. 사용자가 브라우저에서 패스키/2차 인증을 직접 완료해야 하며, 도구에 비밀번호나 인증 코드를 넣지 마세요. ' +
        '응답의 "AI 추정" 표시가 있는 부분은 원문이 아니라 추정입니다.',
    },
  );
  registerTools(server, {
    service: runtime.service,
    sessionManager: runtime.sessionManager,
    snapshots: runtime.snapshots,
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
