/**
 * 세션 수명 관리: 저장/로드, 상태 조회, 로그인 시작·완료, 연결 해제.
 * 비밀값(쿠키, 토큰)은 SecretStore 에만 두고 응답·로그에는 절대 넣지 않는다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { LmsError, toLmsError } from '../errors.js';
import type { SessionCredentials } from '../http/client.js';
import type { Logger } from '../logging.js';
import type { AuthStatus } from '../adapters/types.js';
import { formatKo, fromIso } from '../time.js';
import { assistedLogin } from './assisted-login.js';
import { findBrowser, getLoginWindowState, hasManagedBrowserProfile, isProfileLocked, launchLmsSourceBrowser, launchLoginBrowser, openLmsHomeInDedicatedBrowser, removeDedicatedLoginProfile, scrubCredentialArtifacts, scrubReusableBrowserProfile, terminateDedicatedBrowser, waitForProfileRelease } from './browser-login.js';
import { extractLmsCookies, hasLmsSessionCookie, purgeNonLmsCookies } from './chrome-cookies.js';
import type { SecretStore } from './secret-store.js';
import { verifyBrowserSession, type VerifiedSession } from './session-verify.js';

export interface StoredSession {
  version: 1;
  cookies: Record<string, string>;
  sesskey: string | null;
  token: string | null;
  userId: number | null;
  displayName: string | null;
  browser: string | null;
  connectedAt: string;
  lastVerifiedAt: string;
  lastSyncAt: string | null;
}

interface PendingLogin {
  startedAt: string;
  browser: string;
  pid: number | null;
  /** 패스키 완료 뒤 포털로 잘못 복귀했을 때 LMS 홈을 다시 연 시각 */
  portalForwardedAt?: string;
  /** 로그인 후 공개 홈과 동일한 제목이 보일 때 보호된 나의 강의 화면을 다시 연 시각 */
  lmsHomeForwardedAt?: string;
}

export interface SessionChecker {
  /** 세션이 유효하면 true, 만료면 false. 네트워크 오류는 throw */
  (creds: SessionCredentials): Promise<boolean>;
}

export interface HttpVerifier {
  /** 주어진 쿠키로 /my/ 를 읽어 로그인 여부와 sesskey/userId/표시이름을 돌려준다. 로그인 아니면 null. */
  (cookies: Record<string, string>): Promise<{ sesskey: string | null; userId: number | null; displayName: string | null } | null>;
}

export class SessionManager {
  private cached: StoredSession | null | undefined;
  private expiredHint = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SecretStore,
    private readonly logger: Logger,
    private readonly checker?: SessionChecker,
    private readonly httpVerifier?: HttpVerifier,
    /** 세션이 바뀌거나 해제될 때 호출된다(이전 계정 캐시 비우기 등). */
    private readonly onSessionReset?: () => void,
  ) {}

  private get pendingFile(): string {
    return path.join(this.config.dataDir, 'login-pending.json');
  }

  async load(force = false): Promise<StoredSession | null> {
    if (this.cached !== undefined && !force) return this.cached;
    try {
      this.cached = await this.store.load<StoredSession>();
    } catch (e) {
      this.logger.warn('저장된 세션을 읽지 못했습니다', { error: (e as Error).message });
      this.cached = null;
    }
    return this.cached;
  }

  /** HTTP 클라이언트용 자격 증명 제공자 (동기). load() 이후에만 값이 있다. */
  credentials(): SessionCredentials | null {
    const s = this.cached;
    if (!s) return null;
    return { cookies: s.cookies, sesskey: s.sesskey, token: s.token };
  }

  markSync(): void {
    if (this.cached) this.cached.lastSyncAt = new Date().toISOString();
  }

  markExpired(): void {
    this.expiredHint = true;
  }

  private async readPending(): Promise<PendingLogin | null> {
    try {
      return JSON.parse(await fs.readFile(this.pendingFile, 'utf8')) as PendingLogin;
    } catch {
      return null;
    }
  }

  private async writePending(p: PendingLogin | null): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    if (p) await fs.writeFile(this.pendingFile, JSON.stringify(p), 'utf8');
    else await fs.rm(this.pendingFile, { force: true });
  }

  /** 로그인용 브라우저를 연다(자동화 없음). */
  async startLogin(): Promise<{ browser: string; url: string; profileLocked: boolean }> {
    if (isProfileLocked(this.config.profileDir)) {
      return { browser: findBrowser(this.config.browserPreference)?.displayName ?? '', url: '', profileLocked: true };
    }
    const result = launchLoginBrowser(this.config, this.logger, { detached: true });
    await this.writePending({ startedAt: new Date().toISOString(), browser: result.browser.displayName, pid: result.pid });
    return { browser: result.browser.displayName, url: result.url, profileLocked: false };
  }

  /**
   * 로그인 전체 흐름. assisted 면 Playwright 창에서 완료를 자동 감지하고,
   * plain 이면 일반 브라우저를 띄운 뒤 LMS 화면을 감지해 세션 보존 종료하고 검증한다.
   */
  async loginFlow(mode: 'plain' | 'assisted', waitMs: number): Promise<AuthStatus> {
    if (mode === 'assisted') {
      try {
        const v = await assistedLogin(this.config, this.logger, { timeoutMs: waitMs });
        if (v.loggedIn) return this.saveVerified(v);
        this.logger.warn('보조 로그인이 완료되지 않음', { reason: v.reason });
        // 사용자가 로그인 후 창을 직접 닫은 경우: 프로필에 세션이 남아 있을 수 있으므로 headless 검증으로 이어간다.
        await waitForProfileRelease(this.config.profileDir, 15_000);
        try {
          const completed = await this.completeLogin();
          if (completed.connected) return completed;
        } catch (e) {
          this.logger.debug('창 닫힘 후 프로필 검증 실패', { kind: toLmsError(e).kind });
        }
        return this.buildStatus(await this.load(true), { pending: false, extraWarning: `로그인이 완료되지 않았습니다 (${v.reason}).` });
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind === 'BROWSER_BUSY' || err.kind === 'BROWSER_NOT_FOUND') throw err;
        this.logger.warn('보조 로그인 실패, 일반 브라우저 방식으로 전환', { kind: err.kind });
      }
    }
    const start = await this.startLogin();
    if (start.profileLocked) this.logger.info('이미 열린 로그인 브라우저를 기다립니다');
    return this.waitAndComplete(waitMs);
  }

  /**
   * 브라우저가 닫힌 뒤 프로필의 세션을 검증하고 저장한다.
   * Windows 에서는 프로필 쿠키를 직접 읽어 HTTP 로만 검증한다. 실패하더라도 Playwright 로
   * 로그인 프로필을 다시 열지 않는다. 전북대 SSO 가 원격 디버깅 연결을 탐지하기 때문이다.
   * 다른 플랫폼만 기존의 LMS-origin 제한 Playwright 검증을 사용한다.
   */
  async completeLogin(): Promise<AuthStatus> {
    if (isProfileLocked(this.config.profileDir)) throw new LmsError('BROWSER_BUSY');
    scrubCredentialArtifacts(this.config.profileDir);
    if (process.platform === 'win32' && this.httpVerifier) {
      let status: AuthStatus;
      try {
        const fromCookies = await this.completeFromCookies();
        if (fromCookies) {
          status = fromCookies;
        } else {
          this.expiredHint = true;
          status = this.buildStatus(await this.load(true), {
            pending: false,
            extraWarning: 'LMS 세션이 만들어지지 않았습니다. 통합로그인의 세 번째 "아이디 로그인" 탭에서 아이디·비밀번호로 1차 인증한 뒤, 2차 인증 화면에서 패스키를 선택해 완료해 주세요. 두 번째 "패스키 인증 로그인" 탭과는 다른 경로입니다.',
          });
        }
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind === 'BROWSER_BUSY') throw err;
        this.expiredHint = true;
        this.logger.warn('쿠키 직접 검증 실패', { kind: err.kind });
        status = this.buildStatus(await this.load(true), {
          pending: false,
          extraWarning: `브라우저를 자동화 없이 검증하지 못했습니다: ${err.toUserFacing().message}`,
        });
      }
      await this.writePending(null);
      // 성공하면 LMS 쿠키만 남긴 원문 보기 전용 프로필로 전환한다. 환경설정으로 예전의 즉시 폐기도 가능하다.
      if (status.connected) return this.config.retainBrowserProfile ? this.finishReusableProfile(status) : this.finishDisposableProfile(status);
      status.warnings.push('인증 재시도 횟수를 줄이기 위해 로그인 전용 프로필은 이 PC의 사용자 전용 저장소에 유지했습니다. 비밀번호·자동완성 데이터는 제거했습니다.');
      return status;
    }
    const verified = await verifyBrowserSession(this.config, this.logger, { tryToken: true });
    if (!verified.loggedIn) {
      return this.buildStatus(await this.load(true), { pending: Boolean(await this.readPending()), extraWarning: `브라우저 프로필에서 로그인 상태를 확인하지 못했습니다 (${verified.reason}).` });
    }
    return this.saveVerified(verified);
  }

  /** 전용 프로필 쿠키를 복호화해 HTTP 로 검증하고 저장한다. 로그인 상태가 아니면 null. */
  private async completeFromCookies(): Promise<AuthStatus | null> {
    if (!this.httpVerifier) return null;
    const { cookies } = await extractLmsCookies(this.config.profileDir, this.config.lmsHost);
    if (!hasLmsSessionCookie(cookies)) {
      this.logger.debug('프로필에 LMS 세션 쿠키가 없음');
      return null;
    }
    const meta = await this.httpVerifier(cookies);
    if (!meta) {
      this.logger.debug('쿠키로 /my/ 검증 실패(로그인 아님)');
      return null;
    }
    const status = await this.saveVerified({
      loggedIn: true,
      cookies,
      sesskey: meta.sesskey,
      userId: meta.userId,
      displayName: meta.displayName,
      token: null,
      tokenSource: null,
      browser: `${findBrowser(this.config.browserPreference)?.displayName ?? '브라우저'} (쿠키)`,
      verifiedAt: new Date().toISOString(),
    });
    return status;
  }

  private async saveVerified(verified: VerifiedSession): Promise<AuthStatus> {
    const previous = await this.load(true);
    // 계정이 바뀌면(또는 이전 세션이 없다가 새로 로그인하면) 이전 계정의 캐시를 반드시 비운다.
    if (!previous || previous.userId !== verified.userId) {
      try {
        this.onSessionReset?.();
      } catch (e) {
        this.logger.debug('세션 전환 캐시 초기화 실패', { error: (e as Error).message });
      }
    }
    const session: StoredSession = {
      version: 1,
      cookies: verified.cookies,
      sesskey: verified.sesskey,
      token: verified.token ?? previous?.token ?? null,
      userId: verified.userId,
      displayName: verified.displayName ?? previous?.displayName ?? null,
      browser: verified.browser,
      connectedAt: new Date().toISOString(),
      lastVerifiedAt: verified.verifiedAt,
      lastSyncAt: null,
    };
    await this.store.save(session);
    this.cached = session;
    this.expiredHint = false;
    await this.writePending(null);
    this.logger.info('LMS 세션 저장 완료', { backend: this.store.backend, hasToken: Boolean(session.token) });
    return this.buildStatus(session, { pending: false });
  }

  private async finishDisposableProfile(status: AuthStatus): Promise<AuthStatus> {
    try {
      const removed = removeDedicatedLoginProfile(this.config.profileDir);
      this.logger.info('전용 로그인 프로필 폐기 완료', { removed });
      await this.writePending(null);
    } catch (e) {
      const err = toLmsError(e);
      this.logger.warn('전용 로그인 프로필 폐기 실패', { kind: err.kind });
      status.warnings.push('로그인용 일회성 브라우저 프로필을 자동 삭제하지 못했습니다. 전용 창을 닫은 뒤 get_auth_status를 다시 실행해 주세요.');
    }
    return status;
  }

  private async secureReusableProfile(): Promise<{ removedNonLmsCookies: number; removedArtifacts: number }> {
    if (!hasManagedBrowserProfile(this.config.profileDir)) return { removedNonLmsCookies: 0, removedArtifacts: 0 };
    if (isProfileLocked(this.config.profileDir)) throw new LmsError('BROWSER_BUSY');
    const removedNonLmsCookies = await purgeNonLmsCookies(this.config.profileDir, this.config.lmsHost);
    const removedArtifacts = scrubReusableBrowserProfile(this.config.profileDir).length;
    return { removedNonLmsCookies, removedArtifacts };
  }

  /** 로그인 성공 뒤 LMS 쿠키만 남긴 전용 프로필을 원문 보기에 재사용한다. */
  private async finishReusableProfile(status: AuthStatus): Promise<AuthStatus> {
    try {
      const cleaned = await this.secureReusableProfile();
      this.logger.info('원문 보기 프로필 보안 정리 완료', cleaned);
      await this.writePending(null);
    } catch (e) {
      const err = toLmsError(e);
      this.logger.warn('원문 보기 프로필 보안 정리 실패', { kind: err.kind });
      status.warnings.push('원문 보기 프로필의 보안 정리를 마치지 못했습니다. 전용 창을 닫고 get_auth_status를 다시 실행하거나 disconnect_lms에서 브라우저 프로필 삭제를 선택해 주세요.');
    }
    return status;
  }

  /**
   * 같은 LMS의 읽기 화면을 전용 일반 브라우저로 연다. 쿠키는 명령행이나 URL에 넣지 않는다.
   * 창을 닫으면 가능한 경우 세션을 갱신하고 SSO 흔적·방문 기록·캐시를 다시 정리한다.
   */
  async openSource(rawUrl: string): Promise<{ browser: string; url: string; profileReady: boolean; existingWindow: boolean; loginMayBeRequired: boolean }> {
    const wasLocked = isProfileLocked(this.config.profileDir);
    if (!wasLocked && hasManagedBrowserProfile(this.config.profileDir)) {
      try {
        await this.secureReusableProfile();
      } catch (e) {
        const err = toLmsError(e);
        this.logger.warn('원문 보기 전 사전 정리 실패', { kind: err.kind });
      }
    }
    const launched = launchLmsSourceBrowser(this.config, this.logger, rawUrl);
    const loginMayBeRequired = !launched.profileReadyBeforeOpen;
    void launched.exited.then(async () => {
      const released = await waitForProfileRelease(this.config.profileDir, 15_000, 250);
      if (!released) return;
      try {
        await this.completeFromCookies();
      } catch (e) {
        this.logger.debug('원문 브라우저 종료 후 세션 갱신 생략', { kind: toLmsError(e).kind });
      }
      try {
        if (this.config.retainBrowserProfile) await this.secureReusableProfile();
        else removeDedicatedLoginProfile(this.config.profileDir);
      } catch (e) {
        this.logger.warn('원문 브라우저 종료 후 프로필 정리 실패', { kind: toLmsError(e).kind });
      }
    });
    return {
      browser: launched.browser.displayName,
      url: launched.url,
      profileReady: launched.profileReadyBeforeOpen,
      existingWindow: launched.existingWindow,
      loginMayBeRequired,
    };
  }

  /**
   * 일반 브라우저가 열려 있는 동안 LMS 쿠키를 짧은 간격으로 확인한다.
   *
   * Chrome은 실행 중 쿠키 DB를 Windows에서 배타적으로 잠그고 정상 종료 때 MoodleSession을 지울 수 있다.
   * 따라서 대표 창 제목이 로그인 화면에서 JBNU LXP로 안정적으로 바뀌면, 앱이 시작한 전용 PID 트리만
   * 강제 종료해 쿠키 DB를 보존한 뒤 DPAPI 세션으로 옮긴다. SSO DOM·입력값·네트워크에는 연결하지 않는다.
   */
  async waitAndComplete(timeoutMs: number): Promise<AuthStatus> {
    if (process.platform !== 'win32' || !this.httpVerifier) {
      const released = await waitForProfileRelease(this.config.profileDir, timeoutMs);
      if (!released) {
        return this.buildStatus(await this.load(), { pending: true, extraWarning: '아직 로그인 브라우저 창이 열려 있습니다. LMS 홈이 보이면 창을 닫지 말고 잠시 기다려 주세요.' });
      }
      return this.completeLogin();
    }

    const started = Date.now();
    const deadline = started + timeoutMs;
    const pollMs = Math.min(this.config.loginPollIntervalMs, 750);
    let sawLock = false;
    let pending = await this.readPending();
    let authenticatedSince = 0;
    let portalForwarded = Boolean(pending?.portalForwardedAt);
    let lmsHomeForwarded = Boolean(pending?.lmsHomeForwardedAt);

    while (Date.now() < deadline) {
      const locked = isProfileLocked(this.config.profileDir);
      if (locked) {
        sawLock = true;
        const windowState = pending?.pid ? await getLoginWindowState(pending.pid, this.config.profileDir) : 'unknown';
        if (windowState === 'authenticated-portal' && pending?.pid && !portalForwarded) {
          portalForwarded = openLmsHomeInDedicatedBrowser(this.config);
          if (portalForwarded) {
            pending = { ...pending, portalForwardedAt: new Date().toISOString() };
            await this.writePending(pending);
            this.logger.info('포털 인증 완료 감지, 같은 세션으로 LMS 홈 다시 열기');
          }
          authenticatedSince = 0;
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          continue;
        }
        if (windowState === 'lms-home' && pending?.pid && !lmsHomeForwarded) {
          lmsHomeForwarded = openLmsHomeInDedicatedBrowser(this.config);
          if (lmsHomeForwarded) {
            pending = { ...pending, lmsHomeForwardedAt: new Date().toISOString() };
            await this.writePending(pending);
            this.logger.info('LMS 홈 감지, 로그인 확인용 나의 강의 화면 다시 열기');
          }
          authenticatedSince = 0;
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          continue;
        }
        if (windowState === 'authenticated-lms') {
          if (!authenticatedSince) authenticatedSince = Date.now();
          if (Date.now() - authenticatedSince >= 5_000 && pending?.pid) {
            this.logger.info('LMS 화면 감지, 전용 브라우저 세션 보존 종료');
            const stopped = await terminateDedicatedBrowser(pending.pid);
            if (!stopped) {
              return this.buildStatus(await this.load(), { pending: true, extraWarning: 'LMS 화면은 확인했지만 로그인용 브라우저를 안전하게 종료하지 못했습니다. 창을 닫지 말고 get_auth_status를 다시 실행해 주세요.' });
            }
            const released = await waitForProfileRelease(this.config.profileDir, 15_000, 250);
            if (!released) throw new LmsError('BROWSER_BUSY');
            return this.completeLogin();
          }
        } else {
          authenticatedSince = 0;
        }
      } else if (sawLock || Date.now() - started > 8_000) {
        return this.completeLogin();
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return this.buildStatus(await this.load(), { pending: true, extraWarning: '아직 로그인 브라우저 창이 열려 있습니다. LMS 홈이 표시되면 창을 닫지 말고 잠시 기다려 주세요. 연결 저장 뒤 창은 자동으로 닫힙니다.' });
  }

  async getStatus(options: { verify?: boolean } = {}): Promise<AuthStatus> {
    let pending = await this.readPending();
    const session = await this.load();
    if (pending?.pid && isProfileLocked(this.config.profileDir)) {
      const windowState = await getLoginWindowState(pending.pid, this.config.profileDir);
      if (windowState === 'authenticated-lms') {
        const stopped = await terminateDedicatedBrowser(pending.pid);
        if (stopped && await waitForProfileRelease(this.config.profileDir, 15_000, 250)) return this.completeLogin();
      } else if ((windowState === 'authenticated-portal' && !pending.portalForwardedAt) || (windowState === 'lms-home' && !pending.lmsHomeForwardedAt)) {
        const opened = openLmsHomeInDedicatedBrowser(this.config);
        if (opened) {
          pending = windowState === 'authenticated-portal'
            ? { ...pending, portalForwardedAt: new Date().toISOString() }
            : { ...pending, lmsHomeForwardedAt: new Date().toISOString() };
          await this.writePending(pending);
        }
      }
    }
    if (pending && !isProfileLocked(this.config.profileDir)) {
      // 브라우저를 닫은 상태 → 자동으로 완료 시도
      try {
        return await this.completeLogin();
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind !== 'BROWSER_BUSY') this.logger.warn('로그인 완료 처리 실패', { kind: err.kind });
        return this.buildStatus(session, { pending: true, extraWarning: err.toUserFacing().message });
      }
    }
    if (session && options.verify && this.checker) {
      try {
        const ok = await this.checker(this.credentials()!);
        if (ok) {
          session.lastVerifiedAt = new Date().toISOString();
          this.expiredHint = false;
        } else {
          this.expiredHint = true;
        }
      } catch (e) {
        return this.buildStatus(session, { pending: Boolean(pending), extraWarning: `세션 확인 중 오류: ${toLmsError(e).toUserFacing().title}` });
      }
    }
    return this.buildStatus(session, { pending: Boolean(pending) });
  }

  async disconnect(options: { deleteProfile?: boolean } = {}): Promise<{ removedSession: boolean; removedProfile: boolean }> {
    const hadSession = await this.store.exists();
    await this.store.delete();
    this.cached = null;
    this.expiredHint = false;
    // 다음 사용자가 이전 계정의 강좌·과제·공지 캐시를 보지 않도록 즉시 비운다.
    try {
      this.onSessionReset?.();
    } catch (e) {
      this.logger.debug('연결 해제 캐시 초기화 실패', { error: (e as Error).message });
    }
    await this.writePending(null);
    let removedProfile = false;
    if (options.deleteProfile) {
      if (isProfileLocked(this.config.profileDir)) throw new LmsError('BROWSER_BUSY');
      removedProfile = removeDedicatedLoginProfile(this.config.profileDir);
    }
    this.logger.info('LMS 연결 해제', { removedSession: hadSession, removedProfile });
    return { removedSession: hadSession, removedProfile };
  }

  buildStatus(session: StoredSession | null, opts: { pending: boolean; extraWarning?: string }): AuthStatus {
    const warnings: string[] = [];
    if (this.store.backend === 'plain') warnings.push('이 플랫폼에서는 DPAPI 를 쓸 수 없어 세션이 사용자 전용 권한의 파일에 평문으로 저장됩니다.');
    if (opts.extraWarning) warnings.push(opts.extraWarning);
    const connected = Boolean(session) && !this.expiredHint;
    if (session && this.expiredHint) warnings.push('저장된 세션이 만료된 것으로 보입니다. connect_lms 로 다시 로그인해 주세요.');
    const mode: AuthStatus['mode'] = !session ? 'none' : session.token && session.cookies ? 'session+token' : session.token ? 'token' : 'session';
    let message: string;
    if (opts.pending && !connected) message = '로그인 브라우저가 열려 있습니다. 통합인증을 완료한 뒤 LMS 홈이 보이면 창을 닫지 말고 기다리거나 get_auth_status 를 실행해 주세요.';
    else if (!session) message = '연결되지 않았습니다. connect_lms 를 실행해 로그인해 주세요.';
    else if (!connected) message = '세션이 만료되었습니다. connect_lms 로 다시 로그인해 주세요.';
    else message = `연결됨 (${session.displayName ?? '사용자'}) · 마지막 확인 ${formatKo(fromIso(session.lastVerifiedAt))}`;
    return {
      connected,
      mode,
      displayName: session?.displayName ?? null,
      userId: session?.userId ?? null,
      connectedAt: session?.connectedAt ?? null,
      lastVerifiedAt: session?.lastVerifiedAt ?? null,
      lastSyncAt: session?.lastSyncAt ?? null,
      storageBackend: this.store.backend,
      storageLocation: this.store.location,
      profileDir: this.config.profileDir,
      browser: session?.browser ?? findBrowser(this.config.browserPreference)?.displayName ?? null,
      pendingLogin: opts.pending,
      warnings,
      message,
    };
  }
}
