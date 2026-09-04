/**
 * 오류 분류와 복구 가능한 한국어 UX.
 * 내부 예외 원문 대신 안전한 설명, 영향 범위, 다음 행동, 진단 ID를 제공한다.
 */
import { randomBytes } from 'node:crypto';

export type ErrorKind =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_PENDING'
  | 'BROWSER_BUSY'
  | 'BROWSER_NOT_FOUND'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'MAINTENANCE'
  | 'SERVER'
  | 'PARSE'
  | 'UNSUPPORTED'
  | 'STORAGE'
  | 'DISK_FULL'
  | 'DOWNLOAD_TOO_LARGE'
  | 'INVALID_INPUT'
  | 'UNKNOWN';

export type ErrorSeverity = 'warning' | 'error';
export type RecoveryActionType = 'login' | 'check_status' | 'retry' | 'change_input' | 'open_lms' | 'free_space' | 'contact_support' | 'report_problem';

export interface RecoveryAction {
  type: RecoveryActionType;
  label: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

export interface UserFacingError {
  kind: ErrorKind;
  severity: ErrorSeverity;
  title: string;
  message: string;
  hint: string;
  operation: string;
  impact: string;
  automaticRecovery: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
  recoveryAction: RecoveryAction | null;
  reportAction: RecoveryAction;
  diagnosticId: string;
  occurredAt: string;
}

export interface ErrorPresentationContext {
  operation?: string;
  tool?: string;
  impact?: string;
  diagnosticId?: string;
  occurredAt?: string;
}

const MESSAGES: Record<ErrorKind, { title: string; message: string; hint: string; severity?: ErrorSeverity }> = {
  AUTH_REQUIRED: {
    title: 'LMS 로그인이 필요합니다',
    message: '아직 전북대 LMS에 연결되어 있지 않습니다.',
    hint: 'connect_lms를 실행하고 통합로그인의 세 번째 "아이디 로그인" 탭에서 1차 로그인한 뒤, 2차 인증에서 패스키를 선택하세요. LMS 홈이 보이면 자동 저장이 끝날 때까지 창을 닫지 마세요.',
    severity: 'warning',
  },
  AUTH_EXPIRED: {
    title: 'LMS 세션이 만료되었습니다',
    message: '저장된 로그인 세션이 더 이상 유효하지 않습니다. LMS는 일정 시간 사용하지 않으면 자동으로 로그아웃됩니다.',
    hint: 'connect_lms로 다시 로그인해 주세요. 전용 브라우저에 SSO 세션이 남아 있으면 패스키 확인만으로 빠르게 끝날 수 있습니다.',
    severity: 'warning',
  },
  AUTH_PENDING: {
    title: '로그인 완료를 기다리고 있습니다',
    message: '로그인용 브라우저가 열려 있지만 LMS 세션 저장은 아직 끝나지 않았습니다.',
    hint: '브라우저에서 인증을 마치고 실제 수강 과목이 보이는 LMS 홈을 유지한 뒤 get_auth_status를 실행하세요.',
    severity: 'warning',
  },
  BROWSER_BUSY: {
    title: '로그인 창을 확인해 주세요',
    message: '로그인용 브라우저 프로필이 사용 중이어서 세션 저장을 마칠 수 없습니다.',
    hint: '전용 로그인 창에서 LMS 홈까지 이동한 뒤 창을 그대로 두고 get_auth_status를 다시 실행하세요.',
    severity: 'warning',
  },
  BROWSER_NOT_FOUND: {
    title: '지원 브라우저를 찾지 못했습니다',
    message: 'Google Chrome 또는 Microsoft Edge 실행 파일을 찾지 못했습니다.',
    hint: 'Chrome 또는 Edge를 설치하거나 JBNU_LMS_BROWSER에 브라우저 실행 파일의 절대 경로를 지정하세요.',
  },
  FORBIDDEN: {
    title: '이 항목에 접근할 권한이 없습니다',
    message: '로그인은 되어 있지만 학생 계정으로 이 항목을 볼 수 없습니다. 미수강, 비공개 또는 공개 기간 전일 수 있습니다.',
    hint: 'LMS 웹에서 같은 항목이 보이는지 확인하세요. 웹에서도 보이지 않으면 담당 교수자나 LMS 관리자에게 문의하세요.',
    severity: 'warning',
  },
  NOT_FOUND: {
    title: '항목을 찾을 수 없습니다',
    message: '요청한 강좌, 과제 또는 게시글이 없거나 이동·삭제되었습니다.',
    hint: '목록 도구로 최신 ID와 URL을 다시 확인한 뒤 재시도하세요.',
    severity: 'warning',
  },
  RATE_LIMITED: {
    title: 'LMS가 요청 속도를 제한했습니다',
    message: '짧은 시간에 요청이 몰려 LMS 서버가 추가 요청을 잠시 제한하고 있습니다.',
    hint: '안내된 대기 시간이 지난 뒤 다시 시도하세요. 여러 강좌를 반복 조회하는 요청은 간격을 두는 것이 좋습니다.',
    severity: 'warning',
  },
  TIMEOUT: {
    title: 'LMS 응답이 늦어 중단했습니다',
    message: '제한 시간 안에 LMS 응답을 받지 못했습니다.',
    hint: '네트워크 상태를 확인하고 잠시 후 재시도하세요. 계속 반복되면 JBNU_LMS_TIMEOUT_MS 값을 늘릴 수 있습니다.',
  },
  NETWORK: {
    title: 'LMS에 연결할 수 없습니다',
    message: '네트워크 문제로 lms.jbnu.ac.kr에 접속하지 못했습니다.',
    hint: '인터넷 연결, VPN, 방화벽을 확인한 뒤 다시 시도하세요. LMS 웹사이트도 열리지 않으면 학교 측 장애일 수 있습니다.',
  },
  MAINTENANCE: {
    title: 'LMS가 점검 중이거나 일시 중단되었습니다',
    message: 'LMS 서버가 현재 요청을 처리할 수 없다고 응답했습니다.',
    hint: '안내된 대기 시간이 지난 뒤 LMS 웹사이트 상태를 확인하고 다시 시도하세요.',
    severity: 'warning',
  },
  SERVER: {
    title: 'LMS 서버에서 오류가 발생했습니다',
    message: 'LMS 서버가 정상적으로 처리하지 못한 응답을 보냈습니다.',
    hint: '잠시 후 다시 시도하세요. 반복되면 LMS 웹사이트가 정상 동작하는지 확인하세요.',
  },
  PARSE: {
    title: 'LMS 화면 형식이 바뀐 것 같습니다',
    message: '화면 구조가 예상과 달라 일부 정보를 안전하게 추출하지 못했습니다.',
    hint: '원문 LMS 화면에서 내용을 직접 확인하세요. 반복되면 진단 ID와 도구 이름을 함께 알려 주세요.',
  },
  UNSUPPORTED: {
    title: '현재 방식으로 지원되지 않는 요청입니다',
    message: '현재 인증 방식이나 안전 정책 안에서는 이 기능을 수행할 수 없습니다.',
    hint: '도구가 안내한 대체 입력이나 LMS 원문 화면을 사용하세요.',
    severity: 'warning',
  },
  STORAGE: {
    title: '로컬 저장소를 사용할 수 없습니다',
    message: '인증 정보나 상태 파일을 안전하게 읽거나 쓰지 못했습니다.',
    hint: '%LOCALAPPDATA%\\jbnu-lms-mcp 폴더 권한과 보안 프로그램의 차단 여부를 확인한 뒤 다시 시도하세요.',
  },
  DISK_FULL: {
    title: '저장 공간이 부족합니다',
    message: '파일 또는 상태 정보를 저장할 디스크 여유 공간이 없습니다.',
    hint: '저장 드라이브의 여유 공간을 확보하거나 다른 target_dir을 지정한 뒤 다시 시도하세요.',
    severity: 'warning',
  },
  DOWNLOAD_TOO_LARGE: {
    title: '파일이 안전 다운로드 한도를 초과했습니다',
    message: '파일이 기본 다운로드 한도인 200MB보다 커서 로컬 저장을 중단했습니다.',
    hint: 'LMS 원문 링크를 브라우저에서 직접 내려받으세요. 파일 일부는 저장하지 않았습니다.',
    severity: 'warning',
  },
  INVALID_INPUT: {
    title: '입력값을 확인해 주세요',
    message: '도구에 전달된 값이 형식이나 실행 조건에 맞지 않습니다.',
    hint: '목록 도구가 반환한 강좌 ID, cm_id, board_cm_id, bwid 또는 URL을 그대로 사용하세요.',
    severity: 'warning',
  },
  UNKNOWN: {
    title: '예상하지 못한 오류가 발생했습니다',
    message: '요청을 안전하게 완료하지 못했습니다.',
    hint: '한 번 다시 시도하고, 반복되면 진단 ID와 도구 이름을 함께 알려 주세요. 로그에는 비밀번호·쿠키·패스키가 기록되지 않습니다.',
  },
};

export class LmsError extends Error {
  readonly kind: ErrorKind;
  /** 사용자에게 보여도 안전한 추가 설명 (토큰, 쿠키, 본문 없음) */
  readonly detail?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(kind: ErrorKind, detail?: string, options?: { cause?: unknown; retryable?: boolean; retryAfterSeconds?: number | null }) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'LmsError';
    this.kind = kind;
    this.detail = detail;
    this.retryable = options?.retryable ?? ['TIMEOUT', 'NETWORK', 'MAINTENANCE', 'SERVER', 'RATE_LIMITED'].includes(kind);
    this.retryAfterSeconds = normalizeRetryAfter(options?.retryAfterSeconds);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  toUserFacing(context: ErrorPresentationContext = {}): UserFacingError {
    return presentUserError(this, context);
  }
}

export function isLmsError(err: unknown): err is LmsError {
  return err instanceof LmsError || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'LmsError');
}

export function classifyHttpStatus(status: number): ErrorKind | null {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 503) return 'MAINTENANCE';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'UNKNOWN';
  return null;
}

/** Moodle 예외 errorcode 를 오류 종류로 변환한다. */
export function classifyMoodleErrorCode(code: string | undefined): ErrorKind {
  switch (code) {
    case 'invalidsesskey':
    case 'servicerequireslogin':
    case 'requireloginerror':
    case 'sessionexpired':
    case 'invalidtoken':
    case 'accessexception':
      return 'AUTH_EXPIRED';
    case 'nopermissions':
    case 'requiredcapability':
    case 'notenrolled':
    case 'noaccess':
    case 'coursehidden':
      return 'FORBIDDEN';
    case 'invalidrecord':
    case 'invalidcoursemodule':
    case 'invalidcourseid':
    case 'coursenotfound':
      return 'NOT_FOUND';
    case 'invalidparameter':
    case 'invalidresponse':
      return 'INVALID_INPUT';
    case 'webservicenotavailable':
    case 'accessnotallowed':
    case 'servicenotavailable':
    case 'wsaccessuserdeleted':
    case 'wsaccessusersuspended':
      return 'UNSUPPORTED';
    default:
      return 'UNKNOWN';
  }
}

export function toLmsError(err: unknown, fallbackKind: ErrorKind = 'UNKNOWN'): LmsError {
  if (isLmsError(err)) return err as LmsError;
  if (err instanceof Error) {
    const msg = err.message || '';
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') return new LmsError('DISK_FULL', undefined, { cause: err, retryable: false });
    if (code && ['EACCES', 'EPERM', 'EROFS'].includes(code)) return new LmsError('STORAGE', undefined, { cause: err, retryable: false });
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
      return new LmsError('TIMEOUT', undefined, { cause: err });
    }
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(msg)) {
      return new LmsError('NETWORK', undefined, { cause: err });
    }
    return new LmsError(fallbackKind, undefined, { cause: err });
  }
  return new LmsError(fallbackKind);
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(86_400, Math.ceil(value)));
}

function safeDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  const redacted = detail
    .replace(/(MoodleSession|sesskey|token|password|passwd|cookie)\s*[:=]\s*[^\s,;)]+/gi, '$1=[숨김]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return redacted ? `${redacted.slice(0, 300)}${redacted.length > 300 ? '…' : ''}` : null;
}

function diagnosticId(occurredAt: string): string {
  const day = occurredAt.slice(0, 10).replaceAll('-', '');
  return `JBNU-${day}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function recoveryAction(kind: ErrorKind, retryAfterSeconds: number | null): RecoveryAction | null {
  if (kind === 'AUTH_REQUIRED' || kind === 'AUTH_EXPIRED') return { type: 'login', label: 'LMS 다시 연결', tool: 'connect_lms', arguments: { wait_seconds: 120 } };
  if (kind === 'AUTH_PENDING' || kind === 'BROWSER_BUSY') return { type: 'check_status', label: '로그인 완료 상태 확인', tool: 'get_auth_status', arguments: { verify: true } };
  if (['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'MAINTENANCE', 'SERVER', 'UNKNOWN'].includes(kind)) {
    return { type: 'retry', label: retryAfterSeconds ? `${retryAfterSeconds}초 후 다시 시도` : '잠시 후 다시 시도', ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  }
  if (kind === 'INVALID_INPUT' || kind === 'NOT_FOUND') return { type: 'change_input', label: '최신 목록에서 입력값 다시 선택' };
  if (kind === 'DOWNLOAD_TOO_LARGE' || kind === 'FORBIDDEN' || kind === 'PARSE' || kind === 'UNSUPPORTED') return { type: 'open_lms', label: 'LMS 원문에서 직접 확인' };
  if (kind === 'DISK_FULL') return { type: 'free_space', label: '저장 공간 확보 또는 경로 변경' };
  if (kind === 'BROWSER_NOT_FOUND' || kind === 'STORAGE') return { type: 'contact_support', label: '설치 및 권한 설정 확인' };
  return null;
}

function automaticRecovery(kind: ErrorKind, retryable: boolean): string {
  if (kind === 'AUTH_REQUIRED' || kind === 'AUTH_EXPIRED') return '저장 세션 재검증이 가능한 경우 한 차례 복구한 뒤에만 이 오류를 표시합니다.';
  if (retryable) return '일시 오류는 제한 횟수만큼 자동 재시도한 뒤에만 이 오류를 표시합니다.';
  return '사용자 확인이 필요한 오류라 자동으로 반복 실행하지 않았습니다.';
}

export function presentUserError(err: unknown, context: ErrorPresentationContext = {}): UserFacingError {
  const e = toLmsError(err);
  const base = MESSAGES[e.kind];
  const occurredAt = context.occurredAt ?? new Date().toISOString();
  const detail = safeDetail(e.detail);
  const operation = context.operation ?? 'LMS 요청';
  const retryable = Boolean(e.retryable);
  const retryAfterSeconds = normalizeRetryAfter(e.retryAfterSeconds);
  const id = context.diagnosticId ?? diagnosticId(occurredAt);
  return {
    kind: e.kind,
    severity: base.severity ?? 'error',
    title: base.title,
    message: detail ? `${base.message} (${detail})` : base.message,
    hint: base.hint,
    operation,
    impact: context.impact ?? `${operation} 작업을 완료하지 못했습니다. LMS의 원본 데이터는 변경되지 않았습니다.`,
    automaticRecovery: automaticRecovery(e.kind, retryable),
    retryable,
    retryAfterSeconds,
    recoveryAction: recoveryAction(e.kind, retryAfterSeconds),
    reportAction: {
      type: 'report_problem',
      label: '문제가 반복되면 진단 ID로 신고',
      tool: 'report_lms_problem',
      arguments: { diagnostic_id: id, ...(context.tool ? { affected_tool: context.tool } : {}) },
    },
    diagnosticId: id,
    occurredAt,
  };
}

export function formatPresentedError(e: UserFacingError): string {
  const lines = [
    `### ⚠️ ${e.title}`,
    '',
    e.message,
    '',
    `- 요청: ${e.operation}`,
    `- 영향 범위: ${e.impact}`,
    `- 자동 복구: ${e.automaticRecovery}`,
  ];
  if (e.retryAfterSeconds !== null) lines.push(`- 권장 대기: ${e.retryAfterSeconds}초`);
  lines.push(`- 해결 방법: ${e.hint}`);
  if (e.recoveryAction) lines.push(`- 다음 행동: ${e.recoveryAction.label}`);
  lines.push(`- 문제 신고: ${e.reportAction.label} (${e.reportAction.tool})`);
  lines.push(`- 진단 ID: ${e.diagnosticId}`);
  return lines.join('\n');
}

/** 사용자에게 보여줄 한국어 오류 블록(마크다운) */
export function formatUserError(err: unknown, context: ErrorPresentationContext = {}): string {
  return formatPresentedError(presentUserError(err, context));
}
