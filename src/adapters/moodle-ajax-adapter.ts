/**
 * Moodle 웹 AJAX API 어댑터 (lib/ajax/service.php).
 * 브라우저 세션 쿠키 + sesskey 로 호출하며, db/services.php 에서 'ajax' => true 로 선언된 함수만 사용할 수 있다.
 * 공식 모바일 토큰이 없어도 동작하는 것이 장점이다.
 */
import { LmsError, classifyMoodleErrorCode } from '../errors.js';
import type { LmsHttpClient, SessionCredentials } from '../http/client.js';
import type { Logger } from '../logging.js';
import { htmlToText } from '../text.js';
import { fromUnix, toIso } from '../time.js';
import type { Course } from './types.js';

interface AjaxEnvelope {
  error: boolean;
  data?: unknown;
  exception?: { message?: string; errorcode?: string; debuginfo?: string };
}

export interface AjaxCourse {
  id: number;
  fullname: string;
  shortname: string;
  viewurl?: string;
  startdate?: number;
  enddate?: number;
  progress?: number | null;
  hasprogress?: boolean;
  hidden?: boolean;
  visible?: boolean;
  coursecategory?: string;
  fullnamedisplay?: string;
}

export interface AjaxActionEvent {
  id: number;
  name: string;
  description?: string;
  modulename?: string;
  activityname?: string;
  instance?: number;
  eventtype?: string;
  timestart: number;
  timesort: number;
  overdue?: boolean;
  course?: { id: number; fullname: string; shortname?: string; viewurl?: string };
  action?: { name?: string; url?: string; actionable?: boolean; itemcount?: number };
  url?: string;
  formattedtime?: string;
  normalisedeventtype?: string;
}

export interface CourseStateCm {
  id: number;
  name: string;
  visible?: boolean;
  uservisible?: boolean;
  sectionid?: number;
  sectionnumber?: number;
  module?: string;
  modname?: string;
  url?: string;
  hascmrestrictions?: boolean;
  completionstate?: number;
}

export interface CourseStateSection {
  id: number;
  section?: number;
  number?: number;
  title: string;
  visible?: boolean;
  cmlist: number[];
  sectionurl?: string;
}

export interface CourseState {
  course: { id: number; sectionlist: number[] };
  section: CourseStateSection[];
  cm: CourseStateCm[];
}

export interface ModuleUpdate {
  id: number;
  updates: Array<{ name: string; timeupdated: number; itemids?: number[] }>;
}

export class MoodleAjaxAdapter {
  constructor(
    private readonly http: LmsHttpClient,
    private readonly credentials: () => SessionCredentials | null,
    private readonly logger: Logger,
  ) {}

  async call<T>(methodname: string, args: Record<string, unknown> = {}): Promise<T> {
    const creds = this.credentials();
    if (!creds?.sesskey) throw new LmsError('AUTH_REQUIRED');
    const res = await this.http.postJson<AjaxEnvelope[] | AjaxEnvelope>(
      `/lib/ajax/service.php?sesskey=${encodeURIComponent(creds.sesskey)}&info=${encodeURIComponent(methodname)}`,
      [{ index: 0, methodname, args }],
    );
    const body = Array.isArray(res.body) ? res.body[0] : res.body;
    if (!body) throw new LmsError('PARSE', 'AJAX 응답이 비어 있습니다');
    if (body.error) {
      const code = body.exception?.errorcode;
      const kind = classifyMoodleErrorCode(code);
      this.logger.debug('AJAX 오류', { methodname, code, kind });
      throw new LmsError(kind, kind === 'UNKNOWN' && code ? `Moodle 오류 코드 ${code}` : undefined, { retryable: false });
    }
    return body.data as T;
  }

  async getEnrolledCourses(classification: 'all' | 'inprogress' | 'future' | 'past' = 'all'): Promise<Course[]> {
    const data = await this.call<{ courses: AjaxCourse[] }>('core_course_get_enrolled_courses_by_timeline_classification', {
      classification,
      limit: 0,
      offset: 0,
      sort: 'fullname',
    });
    const now = Date.now() / 1000;
    return (data.courses ?? []).map((c) => ({
      id: c.id,
      fullName: c.fullnamedisplay || c.fullname,
      shortName: c.shortname ?? null,
      url: c.viewurl || `${this.http.baseUrl}/course/view.php?id=${c.id}`,
      startDate: toIso(fromUnix(c.startdate)),
      endDate: toIso(fromUnix(c.enddate)),
      progress: typeof c.progress === 'number' && c.hasprogress !== false ? c.progress : null,
      category: c.coursecategory ?? null,
      hidden: Boolean(c.hidden),
      inProgress: classification === 'inprogress' ? true : c.startdate ? c.startdate <= now && (!c.enddate || c.enddate >= now) : null,
      source: 'moodle_ajax',
    }));
  }

  async getActionEvents(fromUnixSec: number, toUnixSec?: number, limit = 50): Promise<AjaxActionEvent[]> {
    const args: Record<string, unknown> = { timesortfrom: Math.floor(fromUnixSec), limitnum: limit, limittononsuspendedevents: true };
    if (toUnixSec) args.timesortto = Math.floor(toUnixSec);
    const data = await this.call<{ events: AjaxActionEvent[] }>('core_calendar_get_action_events_by_timesort', args);
    return data.events ?? [];
  }

  async getCourseState(courseId: number): Promise<CourseState | null> {
    const raw = await this.call<string | CourseState>('core_courseformat_get_state', { courseid: courseId });
    if (!raw) return null;
    try {
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as CourseState;
    } catch {
      throw new LmsError('PARSE', '강좌 상태 JSON 해석 실패');
    }
  }

  async getUpdatesSince(courseId: number, sinceUnixSec: number): Promise<ModuleUpdate[]> {
    const data = await this.call<{ instances: Array<{ contextlevel: string; id: number; updates: ModuleUpdate['updates'] }> }>('core_course_get_updates_since', {
      courseid: courseId,
      since: Math.floor(sinceUnixSec),
      filter: [],
    });
    return (data.instances ?? []).filter((i) => i.contextlevel === 'module').map((i) => ({ id: i.id, updates: i.updates ?? [] }));
  }

  async getUserDisplayName(userId: number): Promise<string | null> {
    try {
      const data = await this.call<Array<{ fullname?: string }>>('core_user_get_users_by_field', { field: 'id', values: [userId] });
      return data?.[0]?.fullname ?? null;
    } catch (e) {
      this.logger.debug('사용자 이름 조회 실패', { kind: (e as LmsError).kind });
      return null;
    }
  }

  static eventDescriptionText(ev: AjaxActionEvent): string | null {
    return ev.description ? htmlToText(ev.description) : null;
  }
}
