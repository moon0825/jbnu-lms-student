/**
 * 오류 분류와 한국어 사용자 메시지.
 * 기술적 오류 코드는 내부용으로만 유지하고, 사용자에게는 원인과 해결 방법을 함께 보여 준다.
 */
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
  | 'SERVER'
  | 'PARSE'
  | 'UNSUPPORTED'
  | 'STORAGE'
  | 'INVALID_INPUT'
  | 'UNKNOWN';

export interface UserFacingError {
  kind: ErrorKind;
  title: string;
  message: string;
  hint: string;
}

const MESSAGES: Record<ErrorKind, { title: string; message: string; hint: string }> = {
  AUTH_REQUIRED: {
    title: 'LMS 로그인이 필요합니다',
    message: '아직 전북대 LMS에 연결되어 있지 않습니다.',
    hint: 'connect_lms 도구를 실행해 열리는 브라우저에서 통합인증(패스키 포함)을 직접 완료한 뒤 브라우저 창을 닫고, get_auth_status로 연결을 확인해 주세요.',
  },
  AUTH_EXPIRED: {
    title: 'LMS 세션이 만료되었습니다',
    message: '저장된 로그인 세션이 더 이상 유효하지 않습니다. LMS는 일정 시간 사용하지 않으면 자동으로 로그아웃됩니다.',
    hint: 'connect_lms 도구로 다시 로그인해 주세요. 브라우저 프로필에 SSO 세션이 남아 있으면 패스키 확인만으로 빠르게 끝납니다.',
  },
  AUTH_PENDING: {
    title: '로그인 진행 중',
    message: '로그인용 브라우저 창을 열었습니다. 창에서 전북대 통합인증(패스키 또는 2차 인증)을 직접 완료해 주세요.',
    hint: '로그인이 끝나면 브라우저 창을 닫고 같은 질문을 다시 해 주세요. 연결은 자동으로 이어집니다.',
  },
  BROWSER_BUSY: {
    title: '브라우저 창이 아직 열려 있습니다',
    message: '로그인용 브라우저 프로필이 사용 중이어서 세션을 확인할 수 없습니다.',
    hint: '로그인용으로 열린 브라우저 창을 모두 닫은 뒤 get_auth_status를 다시 실행해 주세요.',
  },
  BROWSER_NOT_FOUND: {
    title: '브라우저를 찾을 수 없습니다',
    message: 'Google Chrome 또는 Microsoft Edge 실행 파일을 찾지 못했습니다.',
    hint: 'Chrome 또는 Edge를 설치하거나 환경 변수 JBNU_LMS_BROWSER 에 브라우저 실행 파일 경로를 지정해 주세요.',
  },
  FORBIDDEN: {
    title: '접근 권한이 없습니다',
    message: '로그인은 되어 있지만 이 항목을 볼 권한이 없습니다. 수강 중이 아니거나 교수자가 아직 공개하지 않은 항목일 수 있습니다.',
    hint: 'LMS 웹사이트에서 같은 항목이 보이는지 확인해 주세요. 웹에서도 보이지 않으면 담당 교수자나 LMS 관리자에게 문의해야 합니다.',
  },
  NOT_FOUND: {
    title: '항목을 찾을 수 없습니다',
    message: '요청한 강좌, 과제 또는 게시글이 존재하지 않거나 삭제되었습니다.',
    hint: 'ID가 정확한지 확인하고 list_courses 또는 get_course_overview 로 최신 목록을 다시 조회해 주세요.',
  },
  RATE_LIMITED: {
    title: '요청이 너무 잦습니다',
    message: 'LMS 서버 보호를 위해 요청 속도를 제한하고 있습니다.',
    hint: '잠시 후 다시 시도해 주세요. 한 번에 많은 강좌를 조회하면 시간이 더 걸릴 수 있습니다.',
  },
  TIMEOUT: {
    title: 'LMS 응답 시간이 초과되었습니다',
    message: 'LMS 서버가 제한 시간 안에 응답하지 않았습니다.',
    hint: '네트워크 상태를 확인하고 잠시 후 다시 시도해 주세요. 계속 반복되면 JBNU_LMS_TIMEOUT_MS 값을 늘릴 수 있습니다.',
  },
  NETWORK: {
    title: 'LMS에 연결할 수 없습니다',
    message: '네트워크 오류로 lms.jbnu.ac.kr 에 접속하지 못했습니다.',
    hint: '인터넷 연결, VPN, 방화벽 설정을 확인해 주세요. 학교 서버 점검 중일 수도 있습니다.',
  },
  SERVER: {
    title: 'LMS 서버 오류',
    message: 'LMS 서버가 오류 응답을 보냈습니다.',
    hint: '잠시 후 다시 시도해 주세요. 반복되면 LMS 웹사이트가 정상 동작하는지 확인해 주세요.',
  },
  PARSE: {
    title: '화면 형식을 해석하지 못했습니다',
    message: 'LMS 화면 구조가 예상과 달라 일부 정보를 추출하지 못했습니다. LMS 업데이트로 화면이 바뀌었을 수 있습니다.',
    hint: '원문 URL로 직접 확인해 주세요. 이 문제는 파서 업데이트가 필요하므로 이슈로 알려 주시면 도움이 됩니다.',
  },
  UNSUPPORTED: {
    title: '지원되지 않는 기능입니다',
    message: '현재 인증 방식이나 LMS 설정에서는 이 기능을 사용할 수 없습니다.',
    hint: '대체 방법이 있으면 함께 안내됩니다. docs/03-auth-decision-record.md 에 지원 범위가 정리되어 있습니다.',
  },
  STORAGE: {
    title: '로컬 저장소 오류',
    message: '인증 정보나 상태 파일을 읽거나 쓰지 못했습니다.',
    hint: '데이터 폴더(%LOCALAPPDATA%\\jbnu-lms-mcp) 권한을 확인하거나 disconnect_lms 후 다시 연결해 주세요.',
  },
  INVALID_INPUT: {
    title: '입력값이 올바르지 않습니다',
    message: '도구에 전달된 값이 형식에 맞지 않습니다.',
    hint: '강좌 ID, 과제 ID 등은 list_courses 나 get_assignments 결과에 있는 값을 그대로 사용해 주세요.',
  },
  UNKNOWN: {
    title: '알 수 없는 오류',
    message: '예상하지 못한 오류가 발생했습니다.',
    hint: '같은 요청을 다시 시도해 보고, 계속되면 JBNU_LMS_LOG_LEVEL=debug 로 실행해 로그를 확인해 주세요.',
  },
};

export class LmsError extends Error {
  readonly kind: ErrorKind;
  /** 사용자에게 보여도 안전한 추가 설명 (토큰, 쿠키, 본문 없음) */
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(kind: ErrorKind, detail?: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'LmsError';
    this.kind = kind;
    this.detail = detail;
    this.retryable = options?.retryable ?? ['TIMEOUT', 'NETWORK', 'SERVER', 'RATE_LIMITED'].includes(kind);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toUserFacing(): UserFacingError {
    const base = MESSAGES[this.kind];
    return {
      kind: this.kind,
      title: base.title,
      message: this.detail ? `${base.message} (${this.detail})` : base.message,
      hint: base.hint,
    };
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

/** 사용자에게 보여줄 한국어 오류 블록(마크다운) */
export function formatUserError(err: unknown): string {
  const e = toLmsError(err).toUserFacing();
  return [`⚠️ ${e.title}`, '', e.message, '', `해결 방법: ${e.hint}`].join('\n');
}
