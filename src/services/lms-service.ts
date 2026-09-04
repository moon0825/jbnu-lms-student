/**
 * 도구 계층이 사용하는 고수준 서비스. 어댑터를 조합하고 중복 제거·출처 표기·자동 로그인을 담당한다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MoodleAjaxAdapter, AjaxActionEvent } from '../adapters/moodle-ajax-adapter.js';
import type { MoodleApiAdapter } from '../adapters/moodle-api-adapter.js';
import type { JbnuSessionAdapter } from '../adapters/jbnu-session-adapter.js';
import type { Announcement, Assignment, Course, CourseModule, CourseOverview, CourseSection, Deadline, DeadlineType, Material, MaterialKind, Note } from '../adapters/types.js';
import type { SessionManager } from '../auth/session-manager.js';
import type { AppConfig } from '../config.js';
import { LmsError, toLmsError } from '../errors.js';
import type { Logger } from '../logging.js';
import { classifySubmissionText } from '../parsers/assign.js';
import { fromIso, nowSeoul, toIso } from '../time.js';
import { safeFileName } from '../text.js';
import { analyzeAssignment, type AssignmentAnalysis } from './assignment-analysis.js';
import { buildDailyBriefing, buildWeeklyPlan, type DailyBriefing, type WeeklyPlan } from './briefing.js';
import type { MemoryCache } from './cache.js';
import { dedupeBy, normalizeKey } from './dedupe.js';
import { applyToSnapshot, diffSnapshot, type ChangeSet, type SnapshotStore } from './snapshot.js';

export interface LmsServiceDeps {
  config: AppConfig;
  logger: Logger;
  cache: MemoryCache;
  sessionManager: SessionManager;
  ajax: MoodleAjaxAdapter;
  session: JbnuSessionAdapter;
  api: MoodleApiAdapter;
  snapshots: SnapshotStore;
  /** 세션 만료 시 자동으로 로그인 창을 띄울지 */
  autoLogin: boolean;
  /** 자동 로그인 대기 시간(ms) */
  autoLoginWaitMs: number;
  loginMode: 'plain' | 'assisted';
}

export type { Note };

export interface CourseNotice {
  courseId: number;
  courseName: string;
  boardCmId: number | null;
  boardUrl: string | null;
}

const MATERIAL_KIND: Record<string, MaterialKind> = {
  resource: 'file',
  ubfile: 'file',
  folder: 'folder',
  url: 'link',
  vod: 'video',
  ubvideo: 'video',
  video: 'video',
  kollus: 'video',
  mediacore: 'video',
  commons: 'video',
  page: 'page',
  book: 'page',
  lesson: 'page',
  ubcontent: 'page',
  scorm: 'page',
  h5pactivity: 'page',
  hvp: 'page',
};

const NON_MATERIAL = new Set(['label', 'assign', 'quiz', 'forum', 'ubboard', 'attendance', 'ubattendance', 'chat', 'choice', 'feedback', 'survey', 'workshop', 'ubsurvey', 'zoom', 'bigbluebuttonbn', 'onlinetext']);

export class LmsService {
  constructor(private readonly deps: LmsServiceDeps) {}

  get config(): AppConfig {
    return this.deps.config;
  }

  // ---------- 인증 래퍼 ----------

  async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    const sm = this.deps.sessionManager;
    await sm.load();
    if (!sm.credentials()) {
      if (!this.deps.autoLogin) throw new LmsError('AUTH_REQUIRED');
      await this.autoLogin();
    }
    try {
      const result = await fn();
      sm.markSync();
      return result;
    } catch (e) {
      const err = toLmsError(e);
      if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') {
        sm.markExpired();
        this.deps.cache.clear();
        if (!this.deps.autoLogin) throw err;
        await this.autoLogin();
        const result = await fn();
        sm.markSync();
        return result;
      }
      throw err;
    }
  }

  /** 로그인 창을 띄우고 완료를 기다린다. 완료되지 않으면 AUTH_PENDING. */
  async autoLogin(): Promise<void> {
    const sm = this.deps.sessionManager;
    const status = await sm.loginFlow(this.deps.loginMode, this.deps.autoLoginWaitMs);
    if (!status.connected) throw new LmsError('AUTH_PENDING', undefined, { retryable: false });
  }

  // ---------- 강좌 ----------

  async listCourses(options: { includeAll?: boolean } = {}): Promise<{ courses: Course[]; notes: Note[] }> {
    return this.withAuth(async () => {
      const notes: Note[] = [];
      const all = await this.deps.cache.getOrFetch('courses:all', 5 * 60_000, async () => {
        try {
          if (this.deps.api.hasToken()) {
            const uid = (await this.deps.sessionManager.load())?.userId;
            if (uid) return await this.deps.api.getUserCourses(uid);
          }
        } catch (e) {
          this.deps.logger.debug('API 강좌 조회 실패, AJAX 로 전환', { kind: toLmsError(e).kind });
        }
        try {
          return await this.deps.ajax.getEnrolledCourses('all');
        } catch (e) {
          const err = toLmsError(e);
          if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
          this.deps.logger.warn('AJAX 강좌 조회 실패, 화면 해석으로 전환', { kind: err.kind });
          const links = await this.deps.session.getMyCourses();
          return links.map<Course>((l) => ({ id: l.id, fullName: l.fullName, shortName: null, url: l.url, startDate: null, endDate: null, progress: null, category: null, hidden: false, inProgress: null, source: 'lms_page' }));
        }
      });
      let courses = all.filter((c) => !c.hidden);
      if (!options.includeAll) {
        const current = courses.filter((c) => c.inProgress !== false);
        if (current.length) courses = current;
        else notes.push({ level: 'info', text: '진행 중으로 표시된 강좌가 없어 전체 강좌를 보여 줍니다.' });
      }
      courses.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ko'));
      return { courses, notes };
    });
  }

  private async courseMap(): Promise<Map<number, Course>> {
    const { courses } = await this.listCourses({ includeAll: true });
    return new Map(courses.map((c) => [c.id, c]));
  }

  private async resolveCourses(courseId?: number): Promise<Course[]> {
    if (courseId) {
      const map = await this.courseMap();
      const c = map.get(courseId);
      if (c) return [c];
      return [{ id: courseId, fullName: `강좌 ${courseId}`, shortName: null, url: `${this.config.baseUrl}/course/view.php?id=${courseId}`, startDate: null, endDate: null, progress: null, category: null, hidden: false, inProgress: null, source: 'lms_page' }];
    }
    return (await this.listCourses()).courses;
  }

  async getCourseOverview(courseId: number): Promise<CourseOverview> {
    return this.withAuth(() =>
      this.deps.cache.getOrFetch(`overview:${courseId}`, 5 * 60_000, async () => {
        const [state, page] = await Promise.all([
          this.deps.ajax.getCourseState(courseId).catch((e) => {
            const err = toLmsError(e);
            if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
            this.deps.logger.debug('courseformat state 실패', { courseId, kind: err.kind });
            return null;
          }),
          this.deps.session.getCoursePage(courseId),
        ]);
        const map = await this.courseMap();
        const course: Course = map.get(courseId) ?? { id: courseId, fullName: page.title ?? `강좌 ${courseId}`, shortName: null, url: `${this.config.baseUrl}/course/view.php?id=${courseId}`, startDate: null, endDate: null, progress: null, category: null, hidden: false, inProgress: null, source: 'lms_page' };
        const pageModules = new Map<number, CourseModule>();
        for (const s of page.sections) for (const m of s.modules) pageModules.set(m.cmId, m);
        let sections: CourseSection[];
        let source: CourseOverview['source'] = 'lms_page';
        if (state && Array.isArray(state.section) && state.section.length) {
          source = 'moodle_ajax';
          const cmById = new Map(state.cm.map((cm) => [cm.id, cm]));
          const order = state.course?.sectionlist?.length ? state.course.sectionlist : state.section.map((s) => s.id);
          sections = order
            .map((sid) => state.section.find((s) => s.id === sid))
            .filter((s): s is NonNullable<typeof s> => Boolean(s))
            .map((s) => ({
              id: s.id,
              number: s.number ?? s.section ?? null,
              title: s.title || (s.number != null ? `${s.number}주차` : '섹션'),
              visible: s.visible !== false,
              summaryText: null,
              modules: (s.cmlist ?? [])
                .map((cmid) => cmById.get(cmid))
                .filter((cm): cm is NonNullable<typeof cm> => Boolean(cm))
                .map((cm) => {
                  const fromPage = pageModules.get(cm.id);
                  const modName = cm.module ?? cm.modname ?? fromPage?.modName ?? 'unknown';
                  return {
                    cmId: cm.id,
                    modName,
                    name: cm.name || fromPage?.name || modName,
                    url: cm.url ?? fromPage?.url ?? (modName !== 'label' ? `${this.config.baseUrl}/mod/${modName}/view.php?id=${cm.id}` : null),
                    visible: (cm.uservisible ?? cm.visible ?? true) && (fromPage?.visible ?? true),
                    availabilityText: fromPage?.availabilityText ?? (cm.hascmrestrictions ? '접근 제한 조건 있음' : null),
                    descriptionText: fromPage?.descriptionText ?? null,
                    files: fromPage?.files ?? [],
                    dates: fromPage?.dates ?? [],
                  };
                }),
            }));
          // 화면에는 있는데 state 에 없는 모듈(전북대 전용 모듈 등) 보완
          for (const ps of page.sections) {
            for (const pm of ps.modules) {
              if (sections.some((s) => s.modules.some((m) => m.cmId === pm.cmId))) continue;
              const target = sections.find((s) => s.number === ps.number) ?? sections.find((s) => s.title === ps.title);
              if (target) target.modules.push(pm);
              else sections.push({ ...ps });
            }
          }
        } else {
          sections = page.sections;
        }
        return {
          course,
          sections,
          noticeBoard: page.noticeBoardCmId ? { cmId: page.noticeBoardCmId, url: page.noticeBoardUrl ?? `${this.config.baseUrl}/mod/ubboard/view.php?id=${page.noticeBoardCmId}` } : null,
          source,
          fetchedAt: new Date().toISOString(),
        };
      }),
    );
  }

  // ---------- 공지 ----------

  async findNoticeBoard(course: Course): Promise<CourseNotice> {
    const ov = await this.getCourseOverview(course.id);
    if (ov.noticeBoard) return { courseId: course.id, courseName: course.fullName, boardCmId: ov.noticeBoard.cmId, boardUrl: ov.noticeBoard.url };
    const ub = ov.sections.flatMap((s) => s.modules).find((m) => m.modName === 'ubboard' && /공지|notice/i.test(m.name)) ?? ov.sections.flatMap((s) => s.modules).find((m) => m.modName === 'ubboard');
    if (ub) return { courseId: course.id, courseName: course.fullName, boardCmId: ub.cmId, boardUrl: ub.url };
    return { courseId: course.id, courseName: course.fullName, boardCmId: null, boardUrl: null };
  }

  async getAnnouncements(options: { courseId?: number; limit?: number; pages?: number; onlyNew?: boolean } = {}): Promise<{ announcements: Announcement[]; notes: Note[] }> {
    return this.withAuth(async () => {
      const limit = options.limit ?? 20;
      const pages = Math.max(1, Math.min(options.pages ?? 1, 5));
      const courses = await this.resolveCourses(options.courseId);
      const notes: Note[] = [];
      const snapshot = await this.deps.snapshots.load();
      const results: Announcement[] = [];
      for (const course of courses) {
        let board: CourseNotice;
        try {
          board = await this.findNoticeBoard(course);
        } catch (e) {
          const err = toLmsError(e);
          if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
          notes.push({ level: 'warn', text: `${course.fullName}: 강좌 화면을 읽지 못했습니다 (${err.toUserFacing().title}).` });
          continue;
        }
        if (!board.boardCmId) {
          notes.push({ level: 'info', text: `${course.fullName}: 공지사항 게시판(ubboard)을 찾지 못했습니다.` });
          continue;
        }
        for (let p = 1; p <= pages; p += 1) {
          let list;
          try {
            list = await this.deps.session.getUbboardList(board.boardCmId, p);
          } catch (e) {
            const err = toLmsError(e);
            if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
            notes.push({ level: 'warn', text: `${course.fullName}: 공지 목록을 읽지 못했습니다 (${err.toUserFacing().title}).` });
            break;
          }
          for (const item of list.items) {
            const id = `ubboard:${board.boardCmId}:${item.bwid ?? item.url}`;
            results.push({
              id,
              courseId: course.id,
              courseName: course.fullName,
              boardCmId: board.boardCmId,
              title: item.title,
              author: item.author,
              createdAt: item.createdAt,
              modifiedAt: item.modifiedAt,
              isPinned: item.isPinned,
              isNew: item.isNew || (snapshot.savedAt !== null && !snapshot.announcements[id]),
              hasAttachment: item.hasAttachment,
              views: item.views,
              url: item.url,
              source: 'lms_page',
            });
          }
          if (!list.totalPages || p >= list.totalPages) break;
        }
      }
      let announcements = dedupeBy(results, (a) => [a.id, normalizeKey('ann', a.courseId, a.title, a.createdAt)]);
      if (options.onlyNew) announcements = announcements.filter((a) => a.isNew);
      announcements.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || Number(b.isPinned) - Number(a.isPinned));
      return { announcements: announcements.slice(0, limit), notes };
    });
  }

  async getAnnouncementDetail(boardCmId: number, bwid: number): Promise<Announcement> {
    return this.withAuth(async () => {
      const art = await this.deps.session.getUbboardArticle(boardCmId, bwid);
      const courseId = await this.courseIdForBoard(boardCmId);
      const map = await this.courseMap();
      return {
        id: `ubboard:${boardCmId}:${bwid}`,
        courseId,
        courseName: courseId ? map.get(courseId)?.fullName ?? null : null,
        boardCmId,
        title: art.title,
        author: art.author,
        createdAt: art.createdAt,
        modifiedAt: null,
        isPinned: false,
        isNew: false,
        hasAttachment: art.attachments.length > 0,
        views: art.views,
        url: `${this.config.baseUrl}/mod/ubboard/article.php?id=${boardCmId}&bwid=${bwid}`,
        source: 'lms_page',
        bodyText: art.bodyText,
        attachments: art.attachments,
      };
    });
  }

  private async courseIdForBoard(boardCmId: number): Promise<number | null> {
    const key = `board->course:${boardCmId}`;
    const cached = this.deps.cache.get<number>(key);
    if (cached) return cached;
    for (const c of (await this.listCourses({ includeAll: true })).courses) {
      const ov = this.deps.cache.get<CourseOverview>(`overview:${c.id}`);
      if (ov?.noticeBoard?.cmId === boardCmId) {
        this.deps.cache.set(key, c.id, 60 * 60_000);
        return c.id;
      }
    }
    return null;
  }

  // ---------- 과제 ----------

  private eventsToDeadlines(events: AjaxActionEvent[], courses: Map<number, Course>): Deadline[] {
    return events
      .filter((ev) => ev.timesort && ev.action?.actionable !== false)
      .map((ev) => {
        const mod = ev.modulename ?? null;
        const type: DeadlineType = mod === 'assign' ? 'assignment' : mod === 'quiz' ? 'quiz' : mod === 'forum' ? 'forum' : /attendance/.test(mod ?? '') ? 'attendance' : 'other';
        const url = ev.action?.url ?? ev.url ?? (ev.course ? ev.course.viewurl ?? '' : '');
        const cmId = url.match(/[?&]id=(\d+)/)?.[1];
        return {
          id: mod && cmId ? `${mod}:${cmId}` : `event:${ev.id}`,
          type,
          moduleName: mod,
          title: ev.activityname || ev.name,
          courseId: ev.course?.id ?? null,
          courseName: ev.course ? courses.get(ev.course.id)?.fullName ?? ev.course.fullname : null,
          dueAt: toIso(fromIso(new Date(ev.timesort * 1000).toISOString())) ?? new Date(ev.timesort * 1000).toISOString(),
          url: url || (ev.course?.viewurl ?? this.config.baseUrl),
          actionText: ev.action?.name ?? null,
          overdue: Boolean(ev.overdue) || ev.timesort * 1000 < Date.now(),
          submissionState: type === 'assignment' ? 'not_submitted' : 'unknown',
          lateAllowed: null,
          source: 'moodle_ajax',
        } satisfies Deadline;
      });
  }

  async getAssignments(options: { courseId?: number; includeSubmitted?: boolean } = {}): Promise<{ assignments: Assignment[]; notes: Note[] }> {
    return this.withAuth(async () => {
      const courses = await this.resolveCourses(options.courseId);
      const map = await this.courseMap();
      const notes: Note[] = [];
      const collected: Assignment[] = [];
      if (this.deps.api.hasToken()) {
        try {
          collected.push(...(await this.deps.api.getAssignments(courses.map((c) => c.id))));
        } catch (e) {
          this.deps.logger.debug('API 과제 조회 실패', { kind: toLmsError(e).kind });
        }
      }
      for (const course of courses) {
        try {
          const rows = await this.deps.session.getAssignIndex(course.id);
          for (const r of rows) {
            const state = classifySubmissionText(r.submissionStatusText);
            collected.push({
              id: `assign:${r.cmId ?? r.url}`,
              cmId: r.cmId,
              instanceId: null,
              courseId: course.id,
              courseName: course.fullName,
              title: r.title,
              url: r.url,
              allowSubmissionsFromAt: null,
              dueAt: r.dueAt,
              cutoffAt: null,
              submissionStatusText: r.submissionStatusText,
              submissionState: state,
              gradingStatusText: null,
              gradeText: r.gradeText,
              lateAllowed: null,
              source: 'lms_page',
              extra: r.sectionTitle ? { section: r.sectionTitle } : undefined,
            });
          }
        } catch (e) {
          const err = toLmsError(e);
          if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
          notes.push({ level: 'warn', text: `${course.fullName}: 과제 목록을 읽지 못했습니다 (${err.toUserFacing().title}).` });
        }
      }
      // 타임라인 이벤트로 미제출 여부 보강 (이벤트가 있으면 아직 제출하지 않은 과제)
      try {
        const now = Math.floor(Date.now() / 1000);
        const events = await this.deps.ajax.getActionEvents(now - 60 * 86400, now + 120 * 86400, 100);
        for (const d of this.eventsToDeadlines(events.filter((e) => e.modulename === 'assign'), map)) {
          if (options.courseId && d.courseId !== options.courseId) continue;
          collected.push({
            id: d.id,
            cmId: Number(d.id.split(':')[1]) || null,
            instanceId: null,
            courseId: d.courseId ?? 0,
            courseName: d.courseName,
            title: d.title,
            url: d.url,
            allowSubmissionsFromAt: null,
            dueAt: d.dueAt,
            cutoffAt: null,
            submissionStatusText: null,
            submissionState: 'not_submitted',
            gradingStatusText: null,
            gradeText: null,
            lateAllowed: null,
            source: 'moodle_ajax',
          });
        }
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
        this.deps.logger.debug('타임라인 이벤트 조회 실패', { kind: err.kind });
      }
      let assignments = dedupeBy(collected, (a) => [a.cmId ? `assign:${a.cmId}` : null, normalizeKey('asg', a.courseId, a.title, a.dueAt?.slice(0, 10))]);
      if (options.includeSubmitted === false) assignments = assignments.filter((a) => a.submissionState !== 'submitted');
      assignments.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
      return { assignments, notes };
    });
  }

  async getAssignmentDetail(cmId: number): Promise<{ assignment: Assignment; analysis: AssignmentAnalysis }> {
    return this.withAuth(async () => {
      const v = await this.deps.session.getAssignView(cmId);
      const map = await this.courseMap();
      const courseId = v.courseId ?? 0;
      const lateAllowed = v.cutoffAt && v.dueAt ? v.cutoffAt > v.dueAt : v.dueAt ? (v.cutoffAt ? null : true) : null;
      const assignment: Assignment = {
        id: `assign:${cmId}`,
        cmId,
        instanceId: null,
        courseId,
        courseName: map.get(courseId)?.fullName ?? null,
        title: v.title,
        url: `${this.config.baseUrl}/mod/assign/view.php?id=${cmId}`,
        allowSubmissionsFromAt: v.allowSubmissionsFromAt,
        dueAt: v.dueAt,
        cutoffAt: v.cutoffAt,
        submissionStatusText: v.submissionStatusText,
        submissionState: v.submissionState,
        gradingStatusText: v.gradingStatusText,
        gradeText: v.gradeText,
        lateAllowed,
        source: 'lms_page',
        descriptionText: v.descriptionText,
        attachments: v.attachments,
        submittedFiles: v.submittedFiles,
        timeRemainingText: v.timeRemainingText,
        extra: v.statusTable,
      };
      return { assignment, analysis: analyzeAssignment(assignment) };
    });
  }

  // ---------- 마감 ----------

  async getUpcomingDeadlines(options: { days?: number; includeOverdue?: boolean; overdueDays?: number; includeSubmitted?: boolean; courseId?: number } = {}): Promise<{ deadlines: Deadline[]; notes: Note[] }> {
    return this.withAuth(async () => {
      const days = Math.min(Math.max(options.days ?? 7, 1), 120);
      const overdueDays = options.includeOverdue === false ? 0 : Math.min(options.overdueDays ?? 14, 90);
      const now = nowSeoul();
      const from = now.minus({ days: overdueDays });
      const to = now.plus({ days });
      const map = await this.courseMap();
      const notes: Note[] = [];
      const collected: Deadline[] = [];
      try {
        const events = await this.deps.ajax.getActionEvents(from.toSeconds(), to.toSeconds(), 100);
        collected.push(...this.eventsToDeadlines(events, map));
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
        notes.push({ level: 'warn', text: `캘린더 일정을 읽지 못해 과제 목록만으로 계산했습니다 (${err.toUserFacing().title}).` });
      }
      const { assignments, notes: an } = await this.getAssignments({ courseId: options.courseId });
      notes.push(...an);
      for (const a of assignments) {
        const due = fromIso(a.dueAt);
        if (!due || due < from || due > to) continue;
        collected.push({
          id: a.cmId ? `assign:${a.cmId}` : a.id,
          type: 'assignment',
          moduleName: 'assign',
          title: a.title,
          courseId: a.courseId,
          courseName: a.courseName,
          dueAt: a.dueAt!,
          url: a.url,
          actionText: null,
          overdue: due < now,
          submissionState: a.submissionState,
          lateAllowed: a.lateAllowed,
          source: a.source,
        });
      }
      let deadlines = dedupeBy(collected, (d) => [d.id, normalizeKey('dl', d.courseId, d.title, d.dueAt.slice(0, 16))]);
      if (options.courseId) deadlines = deadlines.filter((d) => d.courseId === options.courseId);
      if (options.includeSubmitted !== true) deadlines = deadlines.filter((d) => d.submissionState !== 'submitted');
      deadlines.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      return { deadlines, notes };
    });
  }

  // ---------- 자료 ----------

  async getCourseMaterials(options: { courseId: number; week?: number; query?: string; kinds?: MaterialKind[] }): Promise<{ materials: Material[]; sections: string[]; notes: Note[] }> {
    return this.withAuth(async () => {
      const ov = await this.getCourseOverview(options.courseId);
      const notes: Note[] = [];
      const materials: Material[] = [];
      for (const s of ov.sections) {
        const week = s.title.match(/(\d+)\s*주\s*차?/)?.[1];
        const weekNum = week ? Number(week) : s.number ?? null;
        for (const m of s.modules) {
          if (NON_MATERIAL.has(m.modName)) continue;
          const kind = MATERIAL_KIND[m.modName] ?? 'other';
          materials.push({
            cmId: m.cmId,
            courseId: options.courseId,
            courseName: ov.course.fullName,
            sectionTitle: s.title,
            sectionNumber: s.number,
            week: weekNum,
            name: m.name,
            modName: m.modName,
            kind,
            url: m.url,
            files: m.files,
            visible: m.visible && s.visible,
            availabilityText: m.availabilityText,
            source: ov.source,
          });
        }
      }
      let out = materials;
      if (options.week !== undefined) out = out.filter((m) => m.week === options.week);
      if (options.kinds?.length) out = out.filter((m) => options.kinds!.includes(m.kind));
      if (options.query) {
        const q = options.query.toLowerCase();
        out = out.filter((m) => m.name.toLowerCase().includes(q) || m.sectionTitle.toLowerCase().includes(q) || m.files.some((f) => f.name.toLowerCase().includes(q)));
      }
      if (!materials.length) notes.push({ level: 'info', text: '이 강좌에는 표시할 수업자료 모듈이 없습니다. 숨김 처리되었거나 아직 공개되지 않았을 수 있습니다.' });
      return { materials: out, sections: ov.sections.map((s) => s.title), notes };
    });
  }

  async downloadMaterial(options: { cmId?: number; fileUrl?: string; courseId?: number; targetDir?: string; maxBytes?: number }): Promise<{ path: string; bytes: number; contentType: string | null; sourceUrl: string; fileName: string; courseName: string | null; note?: string }> {
    return this.withAuth(async () => {
      const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
      let courseName: string | null = null;
      let file;
      if (options.fileUrl) {
        file = await this.deps.session.downloadFile(options.fileUrl);
      } else if (options.cmId) {
        let modName: string | null = null;
        if (options.courseId) {
          const ov = await this.getCourseOverview(options.courseId);
          courseName = ov.course.fullName;
          const m = ov.sections.flatMap((s) => s.modules).find((x) => x.cmId === options.cmId);
          modName = m?.modName ?? null;
          if (m?.files.length === 1 && m.modName !== 'folder') {
            file = await this.deps.session.downloadFile(m.files[0].url);
          }
        }
        if (!file) {
          const tries = modName ? [modName] : ['resource', 'folder', 'ubfile', 'url'];
          let found: Awaited<ReturnType<JbnuSessionAdapter['getModuleFiles']>> | null = null;
          for (const mod of tries) {
            try {
              found = await this.deps.session.getModuleFiles(mod, options.cmId);
              if (found.directFile || found.files.length) break;
            } catch (e) {
              const err = toLmsError(e);
              if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
            }
          }
          if (!found) throw new LmsError('NOT_FOUND', '모듈 화면을 열지 못했습니다');
          if (found.directFile) file = found.directFile;
          else if (found.files.length === 1) file = await this.deps.session.downloadFile(found.files[0].url);
          else if (found.files.length > 1) throw new LmsError('INVALID_INPUT', `파일이 ${found.files.length}개 있습니다. file_url 로 하나를 지정해 주세요: ${found.files.map((f) => f.name).join(', ')}`);
          else throw new LmsError('NOT_FOUND', '이 모듈에서 내려받을 파일을 찾지 못했습니다');
        }
      } else {
        throw new LmsError('INVALID_INPUT', 'cm_id 또는 file_url 이 필요합니다');
      }
      if (file.buffer.length > maxBytes) throw new LmsError('INVALID_INPUT', `파일이 너무 큽니다 (${Math.round(file.buffer.length / 1024 / 1024)}MB)`);
      const dir = options.targetDir ?? path.join(this.config.downloadDir, courseName ? safeFileName(courseName) : options.courseId ? `course-${options.courseId}` : 'files');
      await fs.mkdir(dir, { recursive: true });
      let target = path.join(dir, file.fileName);
      let n = 1;
      while (await fs.stat(target).then(() => true).catch(() => false)) {
        const ext = path.extname(file.fileName);
        target = path.join(dir, `${path.basename(file.fileName, ext)} (${n})${ext}`);
        n += 1;
      }
      await fs.writeFile(target, file.buffer);
      return { path: target, bytes: file.buffer.length, contentType: file.contentType, sourceUrl: file.url, fileName: path.basename(target), courseName };
    });
  }

  // ---------- 변경 사항 ----------

  async collectForSnapshot(courseId?: number): Promise<{ announcements: Announcement[]; assignments: Assignment[]; materials: Material[]; courseIds: number[]; notes: Note[] }> {
    const courses = await this.resolveCourses(courseId);
    const { announcements, notes } = await this.getAnnouncements({ courseId, limit: 500 });
    const { assignments, notes: n2 } = await this.getAssignments({ courseId });
    const materials: Material[] = [];
    for (const c of courses) {
      try {
        materials.push(...(await this.getCourseMaterials({ courseId: c.id })).materials);
      } catch (e) {
        const err = toLmsError(e);
        if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
        notes.push({ level: 'warn', text: `${c.fullName}: 자료 목록을 읽지 못했습니다.` });
      }
    }
    return { announcements, assignments, materials, courseIds: courses.map((c) => c.id), notes: [...notes, ...n2] };
  }

  async getRecentChanges(options: { since?: string; courseId?: number; updateSnapshot?: boolean } = {}): Promise<{ changes: ChangeSet; moduleUpdates: Array<{ courseId: number; courseName: string | null; cmId: number; name: string; updates: string[]; url: string | null }>; notes: Note[]; snapshotSavedAt: string | null }> {
    return this.withAuth(async () => {
      const prev = await this.deps.snapshots.load();
      const current = await this.collectForSnapshot(options.courseId);
      const changes = diffSnapshot(prev, current);
      const sinceIso = options.since ?? prev.savedAt;
      if (options.since) {
        const since = fromIso(options.since);
        if (since) {
          const extra = current.announcements.filter((a) => a.createdAt && fromIso(a.createdAt)! >= since && !changes.newAnnouncements.includes(a));
          changes.newAnnouncements.push(...extra);
          changes.since = options.since;
        }
      }
      const moduleUpdates: Array<{ courseId: number; courseName: string | null; cmId: number; name: string; updates: string[]; url: string | null }> = [];
      const sinceDt = fromIso(sinceIso);
      if (sinceDt) {
        for (const cid of current.courseIds) {
          try {
            const ups = await this.deps.ajax.getUpdatesSince(cid, sinceDt.toSeconds());
            if (!ups.length) continue;
            const ov = await this.getCourseOverview(cid);
            const mods = new Map(ov.sections.flatMap((s) => s.modules).map((m) => [m.cmId, m]));
            for (const u of ups) {
              const m = mods.get(u.id);
              moduleUpdates.push({ courseId: cid, courseName: ov.course.fullName, cmId: u.id, name: m?.name ?? `모듈 ${u.id}`, updates: u.updates.map((x) => x.name), url: m?.url ?? null });
            }
          } catch (e) {
            const err = toLmsError(e);
            if (err.kind === 'AUTH_EXPIRED' || err.kind === 'AUTH_REQUIRED') throw err;
            this.deps.logger.debug('updates_since 실패', { courseId: cid, kind: err.kind });
          }
        }
      }
      let snapshotSavedAt = prev.savedAt;
      if (options.updateSnapshot !== false) {
        await this.deps.snapshots.save(applyToSnapshot(prev, current, current.courseIds));
        snapshotSavedAt = new Date().toISOString();
      }
      return { changes, moduleUpdates, notes: current.notes, snapshotSavedAt };
    });
  }

  // ---------- 브리핑 ----------

  async getDailyBriefing(options: { days?: number } = {}): Promise<DailyBriefing & { notes: Note[] }> {
    return this.withAuth(async () => {
      const { deadlines, notes } = await this.getUpcomingDeadlines({ days: options.days ?? 7, overdueDays: 14 });
      const { announcements, notes: n2 } = await this.getAnnouncements({ limit: 60 });
      const prev = await this.deps.snapshots.load();
      const threeDaysAgo = nowSeoul().minus({ days: 3 });
      const fresh = announcements.filter((a) => a.isNew || (a.createdAt && fromIso(a.createdAt)! >= threeDaysAgo));
      let changes: ChangeSet | null = null;
      if (prev.savedAt) {
        const { assignments } = await this.getAssignments();
        changes = diffSnapshot(prev, { announcements, assignments, materials: [] });
        changes.newMaterials = [];
      }
      const briefing = buildDailyBriefing({ deadlines, announcements: fresh, changes });
      return { ...briefing, notes: [...notes, ...n2] };
    });
  }

  async getWeeklyStudyPlan(): Promise<WeeklyPlan & { notes: Note[] }> {
    return this.withAuth(async () => {
      const { deadlines, notes } = await this.getUpcomingDeadlines({ days: 14, overdueDays: 7, includeSubmitted: true });
      const plan = buildWeeklyPlan({ deadlines: deadlines.filter((d) => d.submissionState !== 'submitted') });
      return { ...plan, notes };
    });
  }
}
