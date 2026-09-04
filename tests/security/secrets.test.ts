/**
 * 보안 테스트: 비밀값이 응답·로그·저장 파일·요청 대상에 새지 않는지 확인한다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DpapiFileStore, PlainFileStore } from '../../src/auth/secret-store.js';
import { LmsHttpClient } from '../../src/http/client.js';
import { Logger, redactText, redactValue } from '../../src/logging.js';
import { createHarness, type TestHarness } from '../helpers/runtime.js';
import { startMockLms, VALID_COOKIE, VALID_SESSKEY, VALID_TOKEN, type MockLms } from '../helpers/mock-lms.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRETS = [VALID_COOKIE, VALID_SESSKEY, VALID_TOKEN];

describe('로그 마스킹', () => {
  it('쿠키·토큰·sesskey·비밀번호를 가린다', () => {
    const line = `Cookie: MoodleSession=${VALID_COOKIE}; wstoken=${VALID_TOKEN} sesskey=${VALID_SESSKEY} password=hunter2 token: abc123`;
    const out = redactText(line);
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abc123');
  });
  it('객체 필드 이름 기준으로도 가린다 (본문 포함)', () => {
    const v = redactValue({ cookies: { MoodleSession: VALID_COOKIE }, sesskey: VALID_SESSKEY, descriptionText: '과제 본문', nested: { token: VALID_TOKEN, ok: 'visible' } }) as Record<string, unknown>;
    const json = JSON.stringify(v);
    for (const s of SECRETS) expect(json).not.toContain(s);
    expect(json).not.toContain('과제 본문');
    expect(json).toContain('visible');
  });
  it('Logger 출력에 비밀값이 없다', () => {
    const lines: string[] = [];
    const logger = new Logger('debug', (l) => lines.push(l));
    logger.debug('요청', { url: `/lib/ajax/service.php?sesskey=${VALID_SESSKEY}`, cookie: VALID_COOKIE, token: VALID_TOKEN });
    logger.error(`실패 MoodleSession=${VALID_COOKIE}`);
    const all = lines.join('\n');
    for (const s of SECRETS) expect(all).not.toContain(s);
  });
});

describe('도구 응답에 비밀값이 없다', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createHarness({ session: { token: VALID_TOKEN } });
  });
  afterAll(async () => {
    await h.close();
  });
  it('여러 도구의 텍스트·구조화 응답·로그를 검사한다', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_auth_status', {}],
      ['list_courses', {}],
      ['get_course_overview', { course_id: 101 }],
      ['get_announcements', {}],
      ['get_assignments', {}],
      ['get_assignment_detail', { cm_id: 5001 }],
      ['get_upcoming_deadlines', {}],
      ['get_course_materials', { course_id: 101 }],
      ['get_daily_briefing', {}],
      ['get_recent_changes', {}],
      ['report_lms_problem', { summary: '보안 마스킹 확인 신고', details: `로그인 오류가 발생했습니다. MoodleSession=${VALID_COOKIE} sesskey=${VALID_SESSKEY} token=${VALID_TOKEN}`, confirm_submit: true }],
    ];
    for (const [name, args] of calls) {
      const r = await h.callText(name, args);
      const blob = `${r.text}\n${JSON.stringify(r.structured ?? {})}`;
      for (const s of SECRETS) expect(blob, `${name} 응답에 비밀값`).not.toContain(s);
    }
    const logs = h.logLines.join('\n');
    for (const s of SECRETS) expect(logs, '로그에 비밀값').not.toContain(s);
    // 과제 본문·공지 본문이 로그에 남지 않는다
    expect(logs).not.toContain('A4 5페이지 이내');
    expect(logs).not.toContain('10월 20일(월)');
    const feedbackFiles = fs.readdirSync(path.join(h.dataDir, 'feedback')).map((name) => fs.readFileSync(path.join(h.dataDir, 'feedback', name), 'utf8')).join('\n');
    for (const s of SECRETS) expect(feedbackFiles, '피드백 로컬 파일에 비밀값').not.toContain(s);
  });
  it('쿠키는 LMS 호스트로만 전송된다', () => {
    for (const req of h.mock.requests) {
      if (req.cookie) expect(req.cookie).toContain(`MoodleSession=${VALID_COOKIE}`);
    }
  });
});

describe('호스트 고정', () => {
  let mock: MockLms;
  beforeAll(async () => {
    mock = await startMockLms();
  });
  afterAll(async () => {
    await mock.close();
  });
  it('LMS 외부 호스트 요청을 거부하고 외부 리다이렉트를 따라가지 않는다', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(String(input));
      return fetch(input, init);
    };
    const client = new LmsHttpClient({ baseUrl: mock.baseUrl, lmsHost: mock.host, timeoutMs: 3000, minIntervalMs: 1, maxConcurrent: 1, maxRetries: 0, logger: new Logger('silent'), fetchImpl }, () => ({ cookies: { MoodleSession: VALID_COOKIE }, sesskey: VALID_SESSKEY, token: null }));
    await expect(client.getText('http://evil.example.invalid/steal')).rejects.toMatchObject({ kind: 'UNSUPPORTED' });
    const res = await client.getText('/redirect-external');
    expect(res.status).toBe(302);
    expect(seen.some((u) => u.includes('evil.example'))).toBe(false);
  });
});

describe('저장소', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-store-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('평문 저장소는 base64 봉투로 저장하고 다시 읽는다', async () => {
    const store = new PlainFileStore(path.join(dir, 'plain.json'));
    await store.save({ cookies: { MoodleSession: VALID_COOKIE } });
    expect(await store.load<{ cookies: { MoodleSession: string } }>()).toEqual({ cookies: { MoodleSession: VALID_COOKIE } });
    await store.delete();
    expect(await store.exists()).toBe(false);
  });
  it.runIf(process.platform === 'win32')('Windows DPAPI 저장소 파일에는 평문 비밀값이 없다', async () => {
    const file = path.join(dir, 'session.dpapi');
    const store = new DpapiFileStore(file);
    await store.save({ cookies: { MoodleSession: VALID_COOKIE }, sesskey: VALID_SESSKEY, token: VALID_TOKEN });
    const raw = fs.readFileSync(file, 'utf8');
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(raw).not.toContain(Buffer.from(VALID_COOKIE).toString('base64'));
    const back = await store.load<{ cookies: { MoodleSession: string }; token: string }>();
    expect(back?.cookies.MoodleSession).toBe(VALID_COOKIE);
    expect(back?.token).toBe(VALID_TOKEN);
    await store.delete();
  }, 60_000);
});

describe('저장소 검사 스크립트', () => {
  it('저장소에 토큰·쿠키·비밀번호가 없다', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-secrets.mjs'), ROOT], { encoding: 'utf8' });
    expect(out).toContain('비밀값 없음');
  });
  it('심어 둔 비밀값을 탐지한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-leak-'));
    const planted = ['Moodle', 'Session'].join('') + '=' + 'abcdef1234567890' + 'abcdef';
    fs.writeFileSync(path.join(dir, 'leak.txt'), `${planted}
wstoken=${'f'.repeat(32)}
`);
    let failed = false;
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-secrets.mjs'), dir], { encoding: 'utf8' });
    } catch (e) {
      failed = true;
      expect(String((e as { stdout?: string }).stdout)).toContain('leak.txt');
    }
    expect(failed).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
