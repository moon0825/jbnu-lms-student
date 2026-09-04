/**
 * LMS 전용 HTTP 클라이언트.
 * - 호스트 고정: 설정된 LMS 호스트 외에는 요청하지 않으며 쿠키·토큰을 절대 보내지 않는다.
 * - 타임아웃, 재시도(지수 백오프), 동시성 제한, 최소 요청 간격(속도 제한)
 * - 로그인 페이지/SSO 로 리다이렉트되면 AUTH_EXPIRED 로 분류
 */
import { LmsError, classifyHttpStatus, toLmsError } from '../errors.js';
import type { Logger } from '../logging.js';

export interface SessionCredentials {
  cookies: Record<string, string>;
  sesskey: string | null;
  token: string | null;
}

export interface HttpClientOptions {
  baseUrl: string;
  lmsHost: string;
  timeoutMs: number;
  minIntervalMs: number;
  maxConcurrent: number;
  maxRetries: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** 기본 true: 세션 쿠키 첨부 */
  withCookies?: boolean;
  /** 기본 'follow' (LMS 호스트 안에서만 최대 5회) */
  redirect?: 'follow' | 'manual';
  responseType?: 'text' | 'json' | 'buffer';
  timeoutMs?: number;
  /** 기본 false. true 면 로그인 리다이렉트도 오류가 아니라 응답으로 돌려준다 */
  allowLoginRedirect?: boolean;
}

export interface HttpResponse<T = string> {
  status: number;
  url: string;
  headers: Headers;
  body: T;
  /** 요청이 LMS 로그인 화면으로 넘어갔는지 */
  loginRedirected: boolean;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jbnu-lms-mcp/0.1 (read-only student assistant)';

class RateLimiter {
  private active = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number, private readonly minIntervalMs: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart = Date.now();
    return () => {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export function isLoginUrl(url: string): boolean {
  return /\/login\/index\.php|\/exsignon\/|sso\.jbnu\.ac\.kr|\/login\/logout\.php/i.test(url);
}

/** Retry-After(초 또는 HTTP-date)를 사용자에게 안내할 초 단위로 정규화한다. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(86_400, Math.max(0, Math.ceil((at - nowMs) / 1000)));
}

export class LmsHttpClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: HttpClientOptions,
    private readonly credentials: () => SessionCredentials | null,
  ) {
    this.limiter = new RateLimiter(opts.maxConcurrent, opts.minIntervalMs);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** 상대 경로를 절대 URL 로 만들고, LMS 호스트·프로토콜이 아니면 거부한다. */
  resolve(pathOrUrl: string): string {
    const url = new URL(pathOrUrl, `${this.opts.baseUrl}/`);
    if (!this.isSameOrigin(url)) {
      const base = new URL(this.opts.baseUrl);
      throw new LmsError('UNSUPPORTED', `LMS(${base.protocol}//${this.opts.lmsHost}) 외부(${url.protocol}//${url.host})로는 요청하지 않습니다`, { retryable: false });
    }
    return url.toString();
  }

  /** 호스트와 프로토콜(https)이 모두 baseUrl 과 같은지. http 다운그레이드로 쿠키가 평문 전송되는 것을 막는다. */
  private isSameOrigin(url: URL): boolean {
    const base = new URL(this.opts.baseUrl);
    return url.host === this.opts.lmsHost && url.protocol === base.protocol;
  }

  private cookieHeader(): string | null {
    const creds = this.credentials();
    if (!creds || !creds.cookies) return null;
    const pairs = Object.entries(creds.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
    return pairs.length ? pairs.join('; ') : null;
  }

  async request<T = string>(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const url = this.resolve(pathOrUrl);
    const method = options.method ?? 'GET';
    const maxRetries = this.opts.maxRetries;
    let attempt = 0;
    let lastError: LmsError | null = null;
    while (attempt <= maxRetries) {
      const release = await this.limiter.acquire();
      try {
        return await this.once<T>(url, method, options);
      } catch (e) {
        const err = toLmsError(e);
        lastError = err;
        if (!err.retryable || attempt === maxRetries) throw err;
        const exponential = Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
        // 서버가 긴 대기를 요구하더라도 MCP 호출 하나를 오래 붙들지 않는다.
        // 전체 권장 시간은 LmsError에 보존해 최종 UX에서 안내한다.
        const backoff = Math.min(10_000, Math.max(exponential, (err.retryAfterSeconds ?? 0) * 1000));
        this.opts.logger.debug('요청 재시도', { url, attempt: attempt + 1, kind: err.kind, backoff });
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        release();
      }
      attempt += 1;
    }
    throw lastError ?? new LmsError('UNKNOWN');
  }

  private async once<T>(startUrl: string, method: 'GET' | 'POST', options: RequestOptions): Promise<HttpResponse<T>> {
    let url = startUrl;
    let hops = 0;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const withCookies = options.withCookies ?? true;
    // 첫 요청만 POST, 리다이렉트 이후는 GET
    let currentMethod = method;
    let body = options.body;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers: Record<string, string> = {
        'User-Agent': this.opts.userAgent ?? DEFAULT_UA,
        Accept: options.responseType === 'json' ? 'application/json, text/plain, */*' : '*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
        ...(options.headers ?? {}),
      };
      if (withCookies) {
        const cookie = this.cookieHeader();
        if (cookie) headers.Cookie = cookie;
      }
      // 타임아웃 타이머는 응답 본문 수신까지 유지한다(헤더만 받고 본문이 멈추는 경우도 타임아웃 적용).
      try {
        let res: Response;
        try {
          this.opts.logger.debug('HTTP 요청', { method: currentMethod, url });
          res = await this.fetchImpl(url, {
            method: currentMethod,
            headers,
            body: currentMethod === 'POST' ? body : undefined,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (e) {
          throw toLmsError(e, 'NETWORK');
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) throw new LmsError('SERVER', `리다이렉트 응답에 위치 정보가 없습니다 (HTTP ${res.status})`);
          const next = new URL(location, url);
          const loginRedirect = isLoginUrl(next.toString());
          if (loginRedirect) {
            if (options.allowLoginRedirect) {
              return { status: res.status, url: next.toString(), headers: res.headers, body: '' as T, loginRedirected: true };
            }
            throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
          }
          if (!this.isSameOrigin(next)) {
            // 외부 호스트나 http 다운그레이드로는 따라가지 않고, 쿠키도 보내지 않는다.
            return { status: res.status, url: next.toString(), headers: res.headers, body: '' as T, loginRedirected: false };
          }
          if (options.redirect === 'manual') {
            return { status: res.status, url: next.toString(), headers: res.headers, body: '' as T, loginRedirected: false };
          }
          hops += 1;
          if (hops > 5) throw new LmsError('SERVER', '리다이렉트가 너무 많습니다');
          url = next.toString();
          currentMethod = 'GET';
          body = undefined;
          continue;
        }

        const kind = classifyHttpStatus(res.status);
        if (kind) {
          const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          throw new LmsError(kind, `HTTP ${res.status}`, {
            retryable: ['SERVER', 'MAINTENANCE', 'TIMEOUT', 'RATE_LIMITED'].includes(kind),
            retryAfterSeconds,
          });
        }

        const finalUrl = res.url || url;
        if (isLoginUrl(finalUrl) && !options.allowLoginRedirect) {
          throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
        }

        let parsed: unknown;
        try {
          if (options.responseType === 'buffer') {
            parsed = Buffer.from(await res.arrayBuffer());
          } else if (options.responseType === 'json') {
            const text = await res.text();
            try {
              parsed = JSON.parse(text);
            } catch {
              if (/<form[^>]*login|로그인|login\/index\.php/i.test(text)) throw new LmsError('AUTH_EXPIRED', undefined, { retryable: false });
              throw new LmsError('PARSE', 'JSON 응답이 아닙니다');
            }
          } else {
            parsed = await res.text();
          }
        } catch (e) {
          // 본문 수신 중 abort(타임아웃)·네트워크 오류. 이미 분류된 LmsError 는 그대로 유지된다.
          throw toLmsError(e, 'NETWORK');
        }
        return { status: res.status, url: finalUrl, headers: res.headers, body: parsed as T, loginRedirected: false };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  getText(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse<string>> {
    return this.request<string>(pathOrUrl, { ...options, responseType: 'text' });
  }

  getJson<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>(pathOrUrl, { ...options, responseType: 'json' });
  }

  postJson<T>(pathOrUrl: string, json: unknown, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>(pathOrUrl, {
      ...options,
      method: 'POST',
      body: JSON.stringify(json),
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
      responseType: 'json',
    });
  }

  postForm<T>(pathOrUrl: string, form: URLSearchParams, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>(pathOrUrl, {
      ...options,
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
      responseType: options.responseType ?? 'json',
    });
  }

  getBuffer(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse<Buffer>> {
    return this.request<Buffer>(pathOrUrl, { ...options, responseType: 'buffer', timeoutMs: options.timeoutMs ?? this.opts.timeoutMs * 6 });
  }
}
