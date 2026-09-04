/**
 * 문제 신고·기능 제안 수집기.
 * LMS 인증정보와 학업 데이터는 받지 않으며, 모든 제출을 로컬에 먼저 원자적으로 저장한다.
 * HTTPS 수집 주소가 설정되면 같은 보고서를 즉시 전송하고 실패 시 재전송 대기 상태로 남긴다.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION } from '../config.js';
import { LmsError, toLmsError } from '../errors.js';
import { redactText } from '../logging.js';
import type { Logger } from '../logging.js';

export type FeedbackKind = 'problem' | 'feature';
export type FeedbackDelivery = 'stored_local' | 'sent' | 'queued_retry';

export interface FeedbackInput {
  kind: FeedbackKind;
  summary: string;
  details: string;
  diagnosticId?: string;
  affectedTool?: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  includeTechnicalContext?: boolean;
}

export interface FeedbackPayload {
  schemaVersion: 1;
  reportId: string;
  kind: FeedbackKind;
  summary: string;
  details: string;
  diagnosticId: string | null;
  affectedTool: string | null;
  stepsToReproduce: string | null;
  expectedBehavior: string | null;
  technicalContext: { appVersion: string; platform: NodeJS.Platform; arch: string; nodeMajor: number } | null;
  createdAt: string;
}

interface FeedbackRecord {
  payload: FeedbackPayload;
  delivery: FeedbackDelivery;
  attempts: number;
  lastAttemptAt: string | null;
  lastFailure: 'collector_not_configured' | 'timeout' | 'network' | 'http_error' | null;
  sentAt: string | null;
}

export interface FeedbackReceipt {
  reportId: string;
  kind: FeedbackKind;
  createdAt: string;
  delivery: FeedbackDelivery;
  collectorMode: 'local' | 'remote';
  collectorOrigin: string | null;
  retryAvailable: boolean;
  privacy: string;
}

export interface FeedbackStatus {
  collectorMode: 'local' | 'remote';
  collectorOrigin: string | null;
  configurationWarning: string | null;
  total: number;
  storedLocal: number;
  queuedRetry: number;
  sent: number;
  reportIds: Array<{ reportId: string; kind: FeedbackKind; delivery: FeedbackDelivery; createdAt: string }>;
  storageLocation: string;
  privacy: string;
}

export interface FeedbackServiceOptions {
  directory: string;
  endpoint?: string | null;
  token?: string | null;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const REPORT_ID = /^FB-\d{8}-[A-F0-9]{8}$/;
const DIAGNOSTIC_ID = /^JBNU-\d{8}-[A-F0-9]{6}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PRIVACY_NOTICE = '인증정보와 학업 내용을 자동 첨부하지 않으며 대표 비밀값·학번·연락처·JBNU URL·사용자 경로는 입력에서 제거합니다. 강좌명과 공지/과제 본문은 넣지 마세요.';

function makeReportId(now: string): string {
  return `FB-${now.slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** 사용자가 실수로 붙여 넣은 대표 개인정보·LMS URL·로컬 사용자 경로를 제거한다. */
export function sanitizeFeedbackText(value: string, maxLength: number): string {
  return redactText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[이메일 제거]')
    .replace(/(?<!\d)01[016789][- ]?\d{3,4}[- ]?\d{4}(?!\d)/g, '[전화번호 제거]')
    .replace(/(학번\s*[:=]?\s*)\d{6,12}/gi, '$1[제거]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[사용자 제거]')
    .replace(/https?:\/\/(?:lms|sso)\.jbnu\.ac\.kr\/[^\s)\]}]*/gi, '[JBNU URL 제거]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function parseEndpoint(raw: string | null | undefined): { url: URL | null; warning: string | null } {
  if (!raw) return { url: null, warning: null };
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      return { url: null, warning: '외부 피드백 수집 주소는 HTTPS만 허용됩니다.' };
    }
    return { url, warning: null };
  } catch {
    return { url: null, warning: '피드백 수집 주소 형식이 올바르지 않습니다.' };
  }
}

export class FeedbackService {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: URL | null;
  private readonly configurationWarning: string | null;
  private readonly timeoutMs: number;

  constructor(private readonly options: FeedbackServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const endpoint = parseEndpoint(options.endpoint);
    this.endpoint = endpoint.url;
    this.configurationWarning = endpoint.warning;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 8_000));
  }

  async submit(input: FeedbackInput): Promise<FeedbackReceipt> {
    const now = new Date().toISOString();
    const summary = sanitizeFeedbackText(input.summary, 160);
    const details = sanitizeFeedbackText(input.details, 4_000);
    if (summary.length < 5 || details.length < 10) throw new LmsError('INVALID_INPUT', '개인정보 제거 후에도 요약 5자, 상세 내용 10자 이상이 필요합니다', { retryable: false });
    if (input.diagnosticId && !DIAGNOSTIC_ID.test(input.diagnosticId)) throw new LmsError('INVALID_INPUT', 'diagnostic_id 형식이 올바르지 않습니다', { retryable: false });
    if (input.affectedTool && !TOOL_NAME.test(input.affectedTool)) throw new LmsError('INVALID_INPUT', 'affected_tool 형식이 올바르지 않습니다', { retryable: false });
    const payload: FeedbackPayload = {
      schemaVersion: 1,
      reportId: makeReportId(now),
      kind: input.kind,
      summary,
      details,
      diagnosticId: input.diagnosticId ?? null,
      affectedTool: input.affectedTool ?? null,
      stepsToReproduce: input.stepsToReproduce ? sanitizeFeedbackText(input.stepsToReproduce, 2_000) || null : null,
      expectedBehavior: input.expectedBehavior ? sanitizeFeedbackText(input.expectedBehavior, 2_000) || null : null,
      technicalContext: input.includeTechnicalContext === false ? null : {
        appVersion: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        nodeMajor: Number(process.versions.node.split('.')[0]),
      },
      createdAt: now,
    };
    let record: FeedbackRecord = {
      payload,
      delivery: this.endpoint ? 'queued_retry' : 'stored_local',
      attempts: 0,
      lastAttemptAt: null,
      lastFailure: this.endpoint ? null : 'collector_not_configured',
      sentAt: null,
    };
    await this.save(record);
    if (this.endpoint) {
      record = await this.deliver(record);
      await this.save(record);
    }
    this.options.logger.info('피드백 접수', { reportId: payload.reportId, kind: payload.kind, delivery: record.delivery });
    return this.receipt(record);
  }

  async status(): Promise<FeedbackStatus> {
    const records = await this.loadAll();
    records.sort((a, b) => b.payload.createdAt.localeCompare(a.payload.createdAt));
    return {
      collectorMode: this.endpoint ? 'remote' : 'local',
      collectorOrigin: this.endpoint?.origin ?? null,
      configurationWarning: this.configurationWarning,
      total: records.length,
      storedLocal: records.filter((r) => r.delivery === 'stored_local').length,
      queuedRetry: records.filter((r) => r.delivery === 'queued_retry').length,
      sent: records.filter((r) => r.delivery === 'sent').length,
      reportIds: records.slice(0, 50).map((r) => ({ reportId: r.payload.reportId, kind: r.payload.kind, delivery: r.delivery, createdAt: r.payload.createdAt })),
      storageLocation: this.options.directory,
      privacy: PRIVACY_NOTICE,
    };
  }

  async retryQueued(limit = 20): Promise<{ attempted: number; sent: number; remaining: number; endpointConfigured: boolean }> {
    if (!this.endpoint) {
      const status = await this.status();
      return { attempted: 0, sent: 0, remaining: status.queuedRetry, endpointConfigured: false };
    }
    const queued = (await this.loadAll()).filter((r) => r.delivery === 'queued_retry').slice(0, Math.max(1, Math.min(100, limit)));
    let sent = 0;
    for (const item of queued) {
      const updated = await this.deliver(item);
      await this.save(updated);
      if (updated.delivery === 'sent') sent += 1;
    }
    const remaining = (await this.loadAll()).filter((r) => r.delivery === 'queued_retry').length;
    return { attempted: queued.length, sent, remaining, endpointConfigured: true };
  }

  async discard(reportId: string): Promise<{ removed: boolean; remoteCopyMayRemain: boolean }> {
    if (!REPORT_ID.test(reportId)) throw new LmsError('INVALID_INPUT', 'report_id 형식이 올바르지 않습니다', { retryable: false });
    let previous: FeedbackRecord | null = null;
    try {
      previous = JSON.parse(await fs.readFile(this.fileFor(reportId), 'utf8')) as FeedbackRecord;
    } catch {
      /* 없는 보고서는 멱등적으로 처리 */
    }
    const removed = await fs.rm(this.fileFor(reportId), { force: true }).then(() => Boolean(previous));
    return { removed, remoteCopyMayRemain: previous?.delivery === 'sent' };
  }

  private receipt(record: FeedbackRecord): FeedbackReceipt {
    return {
      reportId: record.payload.reportId,
      kind: record.payload.kind,
      createdAt: record.payload.createdAt,
      delivery: record.delivery,
      collectorMode: this.endpoint ? 'remote' : 'local',
      collectorOrigin: this.endpoint?.origin ?? null,
      retryAvailable: record.delivery === 'queued_retry',
      privacy: PRIVACY_NOTICE,
    };
  }

  private fileFor(reportId: string): string {
    return path.join(this.options.directory, `${reportId}.json`);
  }

  private async save(record: FeedbackRecord): Promise<void> {
    await fs.mkdir(this.options.directory, { recursive: true });
    const file = this.fileFor(record.payload.reportId);
    const temporary = `${file}.${process.pid}-${randomBytes(3).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } catch (e) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw toLmsError(e, 'STORAGE');
    }
  }

  private async loadAll(): Promise<FeedbackRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw toLmsError(e, 'STORAGE');
    }
    const records: FeedbackRecord[] = [];
    for (const name of names.filter((n) => /^FB-\d{8}-[A-F0-9]{8}\.json$/.test(n))) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.options.directory, name), 'utf8')) as FeedbackRecord;
        if (record?.payload && REPORT_ID.test(record.payload.reportId)) records.push(record);
      } catch {
        this.options.logger.warn('손상된 피드백 파일 무시', { fileName: name });
      }
    }
    return records;
  }

  private async deliver(record: FeedbackRecord): Promise<FeedbackRecord> {
    if (!this.endpoint) return { ...record, delivery: 'stored_local', lastFailure: 'collector_not_configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const attempted: FeedbackRecord = { ...record, attempts: record.attempts + 1, lastAttemptAt: new Date().toISOString() };
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': `jbnu-lms-mcp/${APP_VERSION}`,
        'Idempotency-Key': record.payload.reportId,
        'X-JBNU-LMS-Feedback-Schema': '1',
      };
      if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(record.payload),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return { ...attempted, delivery: 'queued_retry', lastFailure: 'http_error', sentAt: null };
      return { ...attempted, delivery: 'sent', lastFailure: null, sentAt: new Date().toISOString() };
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return { ...attempted, delivery: 'queued_retry', lastFailure: timeout ? 'timeout' : 'network', sentAt: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
