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
import { findBrowser, isProfileLocked, launchLoginBrowser, waitForProfileRelease } from './browser-login.js';
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
}

export interface SessionChecker {
  /** 세션이 유효하면 true, 만료면 false. 네트워크 오류는 throw */
  (creds: SessionCredentials): Promise<boolean>;
}

export class SessionManager {
  private cached: StoredSession | null | undefined;
  private expiredHint = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SecretStore,
    private readonly logger: Logger,
    private readonly checker?: SessionChecker,
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
   * plain 이면 일반 브라우저를 띄운 뒤 창이 닫히길 기다렸다가 검증한다.
   */
  async loginFlow(mode: 'plain' | 'assisted', waitMs: number): Promise<AuthStatus> {
    if (mode === 'assisted') {
      try {
        const v = await assistedLogin(this.config, this.logger, { timeoutMs: waitMs });
        if (v.loggedIn) return this.saveVerified(v);
        this.logger.warn('보조 로그인이 완료되지 않음', { reason: v.reason });
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

  /** 브라우저가 닫힌 뒤 프로필의 세션을 검증하고 저장한다. */
  async completeLogin(): Promise<AuthStatus> {
    const verified = await verifyBrowserSession(this.config, this.logger, { tryToken: true });
    if (!verified.loggedIn) {
      return this.buildStatus(await this.load(true), { pending: Boolean(await this.readPending()), extraWarning: `브라우저 프로필에서 로그인 상태를 확인하지 못했습니다 (${verified.reason}).` });
    }
    return this.saveVerified(verified);
  }

  private async saveVerified(verified: VerifiedSession): Promise<AuthStatus> {
    const previous = await this.load(true);
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

  /** 로그인 브라우저가 닫히길 기다렸다가 완료 처리. */
  async waitAndComplete(timeoutMs: number): Promise<AuthStatus> {
    const released = await waitForProfileRelease(this.config.profileDir, timeoutMs);
    if (!released) {
      return this.buildStatus(await this.load(), { pending: true, extraWarning: '아직 로그인 브라우저 창이 열려 있습니다. 로그인 후 창을 닫아 주세요.' });
    }
    return this.completeLogin();
  }

  async getStatus(options: { verify?: boolean } = {}): Promise<AuthStatus> {
    const pending = await this.readPending();
    const session = await this.load();
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
    await this.writePending(null);
    let removedProfile = false;
    if (options.deleteProfile) {
      if (isProfileLocked(this.config.profileDir)) throw new LmsError('BROWSER_BUSY');
      await fs.rm(this.config.profileDir, { recursive: true, force: true });
      removedProfile = true;
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
    if (opts.pending && !connected) message = '로그인 브라우저가 열려 있습니다. 통합인증을 완료한 뒤 브라우저 창을 모두 닫고 get_auth_status 를 실행해 주세요.';
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
