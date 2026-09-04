import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LmsHttpClient, parseRetryAfter } from '../../src/http/client.js';
import { Logger } from '../../src/logging.js';
import { startMockLms, VALID_COOKIE, type MockLms } from '../helpers/mock-lms.js';

let mock: MockLms;
const logger = new Logger('silent');

function client(opts: Partial<{ timeoutMs: number; maxRetries: number; cookies: Record<string, string> | null; fetchImpl: typeof fetch }> = {}): LmsHttpClient {
  return new LmsHttpClient(
    { baseUrl: mock.baseUrl, lmsHost: mock.host, timeoutMs: opts.timeoutMs ?? 5000, minIntervalMs: 1, maxConcurrent: 2, maxRetries: opts.maxRetries ?? 1, logger, fetchImpl: opts.fetchImpl },
    () => (opts.cookies === null ? null : { cookies: opts.cookies ?? { MoodleSession: VALID_COOKIE }, sesskey: 'testsesskey', token: null }),
  );
}

beforeAll(async () => {
  mock = await startMockLms();
});
afterAll(async () => {
  await mock.close();
});

describe('LmsHttpClient', () => {
  it('세션 쿠키를 붙여 페이지를 가져온다', async () => {
    const res = await client().getText('/my/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('홍길동');
    const last = mock.requests.at(-1)!;
    expect(last.cookie).toContain(`MoodleSession=${VALID_COOKIE}`);
  });
  it('로그인 리다이렉트를 세션 만료로 분류한다', async () => {
    await expect(client({ cookies: {} }).getText('/my/')).rejects.toMatchObject({ kind: 'AUTH_EXPIRED' });
    const res = await client({ cookies: {} }).getText('/my/', { allowLoginRedirect: true });
    expect(res.loginRedirected).toBe(true);
  });
  it('타임아웃을 TIMEOUT 으로 분류한다', async () => {
    await expect(client({ timeoutMs: 300, maxRetries: 0 }).getText('/slow')).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
  it('5xx 응답은 재시도한다', async () => {
    mock.flakyRemaining = 1;
    const res = await client({ maxRetries: 2 }).getText('/flaky');
    expect(res.status).toBe(200);
  });
  it('Retry-After를 보존하고 503 점검과 429 속도 제한을 구분한다', async () => {
    await expect(client({ maxRetries: 0 }).getText('/rate-limited')).rejects.toMatchObject({ kind: 'RATE_LIMITED', retryAfterSeconds: 7 });
    await expect(client({ maxRetries: 0 }).getText('/maintenance')).rejects.toMatchObject({ kind: 'MAINTENANCE', retryAfterSeconds: 120 });
    expect(parseRetryAfter('7', 0)).toBe(7);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1_000)).toBe(9);
    expect(parseRetryAfter('n/a', 0)).toBeNull();
  });
  it('404 는 NOT_FOUND', async () => {
    await expect(client().getText('/course/view.php?id=999')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
  it('버퍼 다운로드와 파일 이름 헤더', async () => {
    const res = await client().getBuffer('/mod/resource/view.php?id=4001');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.body.toString()).toContain('%PDF');
  });
});

describe('호스트·프로토콜 고정', () => {
  // 운영은 https 이므로 https baseUrl 로 고정 검증한다(resolve 는 네트워크를 쓰지 않음).
  const https = new LmsHttpClient(
    { baseUrl: 'https://lms.jbnu.ac.kr', lmsHost: 'lms.jbnu.ac.kr', timeoutMs: 5000, minIntervalMs: 1, maxConcurrent: 1, maxRetries: 0, logger },
    () => ({ cookies: { MoodleSession: 'x' }, sesskey: 's', token: null }),
  );
  it('LMS 호스트 상대경로는 절대 https URL 로 만든다', () => {
    expect(https.resolve('/my/')).toBe('https://lms.jbnu.ac.kr/my/');
  });
  it('외부 호스트는 거부한다', () => {
    expect(() => https.resolve('https://evil.example.com/steal')).toThrowError(/외부|LMS/);
  });
  it('같은 호스트라도 http 다운그레이드는 거부한다(쿠키 평문 전송 방지)', () => {
    expect(() => https.resolve('http://lms.jbnu.ac.kr/my/')).toThrowError(/외부|LMS/);
    try {
      https.resolve('http://lms.jbnu.ac.kr/my/');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { kind?: string }).kind).toBe('UNSUPPORTED');
    }
  });
});
