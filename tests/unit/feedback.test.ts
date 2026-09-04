import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/logging.js';
import { FeedbackService, sanitizeFeedbackText } from '../../src/services/feedback-service.js';

const roots: string[] = [];
const logger = new Logger('silent');

function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-feedback-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('FeedbackService', () => {
  it('원격 주소가 없으면 즉시 로컬 접수하고 개인정보를 제거한다', async () => {
    const dir = directory();
    const service = new FeedbackService({ directory: dir, logger });
    const phone = ['010', '1234', '5678'].join('-');
    const receipt = await service.submit({
      kind: 'problem',
      summary: '공지 조회 오류가 반복됩니다',
      details: `학번: 202612345, user@example.com, ${phone}, C:\\Users\\student\\file.txt, https://lms.jbnu.ac.kr/course/view.php?id=99 password=do-not-store`,
      diagnosticId: 'JBNU-20260904-ABC123',
      affectedTool: 'get_announcements',
    });
    expect(receipt).toMatchObject({ delivery: 'stored_local', collectorMode: 'local', retryAvailable: false });
    expect(receipt.reportId).toMatch(/^FB-\d{8}-[A-F0-9]{8}$/);
    const stored = fs.readFileSync(path.join(dir, `${receipt.reportId}.json`), 'utf8');
    expect(stored).not.toContain('202612345');
    expect(stored).not.toContain('user@example.com');
    expect(stored).not.toContain(phone);
    expect(stored).not.toContain('student\\file');
    expect(stored).not.toContain('course/view.php');
    expect(stored).not.toContain('do-not-store');
    const status = await service.status();
    expect(status).toMatchObject({ total: 1, storedLocal: 1, queuedRetry: 0, sent: 0 });
    expect((await service.discard(receipt.reportId)).removed).toBe(true);
    expect((await service.status()).total).toBe(0);
  });

  it('HTTPS 수집기로 즉시 전송하고 idempotency 키를 붙인다', async () => {
    const dir = directory();
    let seenUrl = '';
    let seenHeaders: Headers | null = null;
    let seenBody = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      seenBody = String(init?.body ?? '');
      return new Response(null, { status: 202 });
    };
    const service = new FeedbackService({ directory: dir, endpoint: 'https://feedback.example.test/v1/reports', logger, fetchImpl });
    const receipt = await service.submit({ kind: 'feature', summary: '알림 필터가 필요합니다', details: '강좌별로 공지 알림을 끄고 켤 수 있으면 좋겠습니다.', expectedBehavior: '강좌별 알림 설정' });
    expect(receipt.delivery).toBe('sent');
    expect(seenUrl).toBe('https://feedback.example.test/v1/reports');
    expect(seenHeaders!.get('idempotency-key')).toBe(receipt.reportId);
    expect(JSON.parse(seenBody)).toMatchObject({ reportId: receipt.reportId, kind: 'feature', schemaVersion: 1 });
    expect(await service.status()).toMatchObject({ sent: 1, queuedRetry: 0 });
  });

  it('전송 실패를 보관하고 같은 접수 번호로 재시도한다', async () => {
    const dir = directory();
    let fail = true;
    const ids: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      ids.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      return new Response(null, { status: fail ? 503 : 204 });
    };
    const service = new FeedbackService({ directory: dir, endpoint: 'https://feedback.example.test/v1/reports', logger, fetchImpl });
    const receipt = await service.submit({ kind: 'problem', summary: '자료 다운로드가 실패합니다', details: '다운로드를 실행하면 저장 단계에서 멈춥니다.' });
    expect(receipt).toMatchObject({ delivery: 'queued_retry', retryAvailable: true });
    fail = false;
    expect(await service.retryQueued()).toMatchObject({ attempted: 1, sent: 1, remaining: 0 });
    expect(ids).toEqual([receipt.reportId, receipt.reportId]);
  });

  it('외부 HTTP 주소를 거부하고 로컬 보관으로 안전하게 전환한다', async () => {
    const service = new FeedbackService({ directory: directory(), endpoint: 'http://collector.example.test/report', logger });
    const receipt = await service.submit({ kind: 'problem', summary: '설정 확인이 필요합니다', details: '외부 HTTP 주소는 사용하면 안 됩니다.' });
    expect(receipt.delivery).toBe('stored_local');
    expect((await service.status()).configurationWarning).toContain('HTTPS');
  });

  it('제어 문자와 긴 입력을 정규화한다', () => {
    expect(sanitizeFeedbackText('  abc\u0000def  ', 5)).toBe('abcde');
  });
});
