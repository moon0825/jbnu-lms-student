import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LmsHttpClient } from '../../src/http/client.js';
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
  it('404 는 NOT_FOUND', async () => {
    await expect(client().getText('/course/view.php?id=999')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
  it('버퍼 다운로드와 파일 이름 헤더', async () => {
    const res = await client().getBuffer('/mod/resource/view.php?id=4001');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.body.toString()).toContain('%PDF');
  });
});
