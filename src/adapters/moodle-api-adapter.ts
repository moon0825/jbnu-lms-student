/**
 * Moodle 공식 웹서비스(REST) 어댑터. moodle_mobile_app 토큰이 있을 때만 사용한다.
 * 전북대 LMS 는 학생에게 토큰 발급 경로(login/token.php, tool_mobile launch)를 열어 두지 않았으므로
 * 기본 실행에서는 비활성이며, 토큰이 확보되면 자동으로 우선 사용된다.
 */
import { LmsError, classifyMoodleErrorCode } from '../errors.js';
import type { LmsHttpClient, SessionCredentials } from '../http/client.js';
import type { Logger } from '../logging.js';
import { htmlToText } from '../text.js';
import { fromUnix, toIso } from '../time.js';
import type { Assignment, Attachment, Course, SubmissionState } from './types.js';

export interface SiteInfo {
  userid: number;
  fullname: string;
  sitename?: string;
  functions?: Array<{ name: string; version: string }>;
}

interface ApiAssignment {
  id: number;
  cmid: number;
  course: number;
  name: string;
  duedate: number;
  allowsubmissionsfromdate: number;
  cutoffdate: number;
  intro?: string;
  introattachments?: Array<{ filename: string; fileurl: string; filesize?: number; mimetype?: string }>;
}

function flatten(prefix: string, value: unknown, out: URLSearchParams): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(`${prefix}[${i}]`, v, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(`${prefix}[${k}]`, v, out);
  } else if (value !== undefined && value !== null) {
    out.set(prefix, String(value));
  }
}

export class MoodleApiAdapter {
  constructor(
    private readonly http: LmsHttpClient,
    private readonly credentials: () => SessionCredentials | null,
    private readonly logger: Logger,
  ) {}

  hasToken(): boolean {
    return Boolean(this.credentials()?.token);
  }

  async call<T>(wsfunction: string, params: Record<string, unknown> = {}): Promise<T> {
    const token = this.credentials()?.token;
    if (!token) throw new LmsError('UNSUPPORTED', '공식 API 토큰이 없습니다');
    const form = new URLSearchParams();
    form.set('wstoken', token);
    form.set('wsfunction', wsfunction);
    form.set('moodlewsrestformat', 'json');
    for (const [k, v] of Object.entries(params)) flatten(k, v, form);
    const res = await this.http.postForm<T | { exception?: string; errorcode?: string; message?: string }>('/webservice/rest/server.php', form, { withCookies: false });
    const body = res.body as { exception?: string; errorcode?: string };
    if (body && typeof body === 'object' && 'exception' in body) {
      const kind = classifyMoodleErrorCode(body.errorcode);
      this.logger.debug('REST 오류', { wsfunction, code: body.errorcode, kind });
      throw new LmsError(kind, kind === 'UNKNOWN' && body.errorcode ? `Moodle 오류 코드 ${body.errorcode}` : undefined, { retryable: false });
    }
    return res.body as T;
  }

  getSiteInfo(): Promise<SiteInfo> {
    return this.call<SiteInfo>('core_webservice_get_site_info');
  }

  async getUserCourses(userId: number): Promise<Course[]> {
    const rows = await this.call<Array<{ id: number; fullname: string; shortname: string; startdate?: number; enddate?: number; progress?: number | null; hidden?: boolean; category?: number; visible?: number }>>('core_enrol_get_users_courses', { userid: userId, returnusercount: 0 });
    const now = Date.now() / 1000;
    return rows.map((c) => ({
      id: c.id,
      fullName: c.fullname,
      shortName: c.shortname ?? null,
      url: `${this.http.baseUrl}/course/view.php?id=${c.id}`,
      startDate: toIso(fromUnix(c.startdate)),
      endDate: toIso(fromUnix(c.enddate)),
      progress: typeof c.progress === 'number' ? c.progress : null,
      category: null,
      hidden: Boolean(c.hidden),
      inProgress: c.startdate ? c.startdate <= now && (!c.enddate || c.enddate >= now) : null,
      source: 'moodle_api',
    }));
  }

  async getAssignments(courseIds: number[]): Promise<Assignment[]> {
    const data = await this.call<{ courses: Array<{ id: number; fullname: string; assignments: ApiAssignment[] }> }>('mod_assign_get_assignments', { courseids: courseIds });
    const out: Assignment[] = [];
    for (const course of data.courses ?? []) {
      for (const a of course.assignments ?? []) {
        const attachments: Attachment[] = (a.introattachments ?? []).map((f) => ({ name: f.filename, url: f.fileurl, mimeType: f.mimetype ?? null, size: f.filesize ? `${f.filesize}` : null }));
        out.push({
          id: `assign:${a.cmid}`,
          cmId: a.cmid,
          instanceId: a.id,
          courseId: a.course,
          courseName: course.fullname,
          title: a.name,
          url: `${this.http.baseUrl}/mod/assign/view.php?id=${a.cmid}`,
          allowSubmissionsFromAt: toIso(fromUnix(a.allowsubmissionsfromdate)),
          dueAt: toIso(fromUnix(a.duedate)),
          cutoffAt: toIso(fromUnix(a.cutoffdate)),
          submissionStatusText: null,
          submissionState: 'unknown',
          gradingStatusText: null,
          gradeText: null,
          lateAllowed: a.cutoffdate ? a.cutoffdate > a.duedate : a.duedate ? true : null,
          source: 'moodle_api',
          descriptionText: a.intro ? htmlToText(a.intro) : undefined,
          attachments,
        });
      }
    }
    return out;
  }

  async getSubmissionState(assignInstanceId: number): Promise<{ state: SubmissionState; statusText: string | null; gradingText: string | null }> {
    const data = await this.call<{ lastattempt?: { submission?: { status?: string }; graded?: boolean; submissionsenabled?: boolean } }>('mod_assign_get_submission_status', { assignid: assignInstanceId });
    const status = data.lastattempt?.submission?.status ?? null;
    const map: Record<string, SubmissionState> = { submitted: 'submitted', draft: 'draft', new: 'not_submitted', reopened: 'not_submitted' };
    return {
      state: status ? map[status] ?? 'unknown' : 'not_submitted',
      statusText: status,
      gradingText: data.lastattempt?.graded ? 'graded' : null,
    };
  }
}
