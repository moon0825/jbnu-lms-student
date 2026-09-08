/**
 * 도메인 모델. 모든 시각은 ISO 8601 (Asia/Seoul 오프셋 포함) 문자열이다.
 * source 는 데이터 출처를 나타내며, 사용자에게 그대로 노출되어 원문/추정 구분에 쓰인다.
 */
export type DataSource = 'moodle_api' | 'moodle_ajax' | 'lms_page' | 'local_snapshot' | 'estimate';

export const SOURCE_LABEL: Record<DataSource, string> = {
  moodle_api: 'Moodle 공식 API',
  moodle_ajax: 'Moodle 웹 AJAX API',
  lms_page: 'LMS 화면 해석',
  local_snapshot: '로컬 스냅샷',
  estimate: 'AI 추정',
};

export interface Attachment {
  name: string;
  url: string;
  size?: string | null;
  mimeType?: string | null;
}

export interface Course {
  id: number;
  fullName: string;
  shortName: string | null;
  url: string;
  startDate: string | null;
  endDate: string | null;
  progress: number | null;
  category: string | null;
  hidden: boolean;
  /** 진행 중(inprogress) 여부. 알 수 없으면 null */
  inProgress: boolean | null;
  source: DataSource;
}

export interface Announcement {
  /** 예: ubboard:<cmid>:<bwid>, forum:<discussionid> */
  id: string;
  courseId: number | null;
  courseName: string | null;
  boardCmId: number | null;
  title: string;
  author: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  /** 게시판 상단 고정 공지(중요) */
  isPinned: boolean;
  /** 화면에서 "새 글" 표시 또는 스냅샷 기준 새로 발견 */
  isNew: boolean;
  hasAttachment: boolean;
  views: number | null;
  url: string;
  source: DataSource;
  bodyText?: string;
  attachments?: Attachment[];
}

export type SubmissionState = 'submitted' | 'not_submitted' | 'draft' | 'no_submission_required' | 'unknown';

export interface Assignment {
  /** assign:<cmid> */
  id: string;
  cmId: number | null;
  instanceId: number | null;
  courseId: number;
  courseName: string | null;
  title: string;
  url: string;
  allowSubmissionsFromAt: string | null;
  dueAt: string | null;
  cutoffAt: string | null;
  /** 화면에 표시된 제출 상태 원문 */
  submissionStatusText: string | null;
  submissionState: SubmissionState;
  gradingStatusText: string | null;
  gradeText: string | null;
  /** 마감 후 제출 허용 여부. cutoff 가 없거나 due 보다 뒤면 true. 판단 불가면 null */
  lateAllowed: boolean | null;
  source: DataSource;
  descriptionText?: string;
  attachments?: Attachment[];
  submittedFiles?: Attachment[];
  timeRemainingText?: string | null;
  /** 원문 표에 있던 기타 항목(예: 제출 유형) */
  extra?: Record<string, string>;
}

export type DeadlineType = 'assignment' | 'quiz' | 'forum' | 'attendance' | 'other';

export interface Deadline {
  id: string;
  type: DeadlineType;
  moduleName: string | null;
  title: string;
  courseId: number | null;
  courseName: string | null;
  dueAt: string;
  url: string;
  actionText: string | null;
  overdue: boolean;
  submissionState: SubmissionState;
  lateAllowed: boolean | null;
  source: DataSource;
}

export type MaterialKind = 'file' | 'folder' | 'link' | 'video' | 'page' | 'other';

export interface CourseModule {
  cmId: number;
  modName: string;
  name: string;
  url: string | null;
  visible: boolean;
  availabilityText: string | null;
  descriptionText: string | null;
  files: Attachment[];
  /** 모듈에 붙은 일정 (예: 마감 일시) */
  dates: Array<{ label: string; at: string }>;
  /**
   * 이수(완료) 추적 상태. null 이면 이 활동에 완료 추적이 설정되지 않았거나 확인하지 못함.
   * 0=미완료, 1=완료, 2=완료(통과), 3=완료(미통과이나 이수 처리). Moodle completionstate 값.
   */
  completionState?: number | null;
}

export interface CourseSection {
  id: number | null;
  number: number | null;
  title: string;
  visible: boolean;
  summaryText: string | null;
  modules: CourseModule[];
}

export interface CourseOverview {
  course: Course;
  sections: CourseSection[];
  noticeBoard: { cmId: number; url: string } | null;
  source: DataSource;
  fetchedAt: string;
}

export interface Material {
  cmId: number;
  courseId: number;
  courseName: string | null;
  sectionTitle: string;
  sectionNumber: number | null;
  /** 섹션 제목에서 추출한 주차. 없으면 null */
  week: number | null;
  name: string;
  modName: string;
  kind: MaterialKind;
  url: string | null;
  files: Attachment[];
  visible: boolean;
  availabilityText: string | null;
  source: DataSource;
}

export type AuthMode = 'none' | 'session' | 'token' | 'session+token';

export interface AuthStatus {
  connected: boolean;
  mode: AuthMode;
  displayName: string | null;
  userId: number | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  storageBackend: 'dpapi' | 'keychain' | 'plain' | 'memory';
  storageLocation: string;
  profileDir: string;
  browser: string | null;
  pendingLogin: boolean;
  warnings: string[];
  message: string;
}

export interface Note {
  level: 'info' | 'warn';
  text: string;
  /** 부분 실패를 기계적으로 처리할 때 쓰는 안정적인 오류 종류 */
  code?: import('../errors.js').ErrorKind;
  /** 영향을 받은 강좌·기능 범위 */
  scope?: string;
  retryable?: boolean;
  recoveryAction?: import('../errors.js').RecoveryAction | null;
}
