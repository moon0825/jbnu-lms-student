/**
 * MCP 도구 등록. 모든 도구는 읽기 전용이며 한국어 텍스트 + structuredContent 를 함께 돌려준다.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthStatus, DataSource } from '../adapters/types.js';
import type { SessionManager } from '../auth/session-manager.js';
import { formatUserError, toLmsError } from '../errors.js';
import type { Logger } from '../logging.js';
import { bucketLabel } from '../services/briefing.js';
import type { LmsService } from '../services/lms-service.js';
import type { SnapshotStore } from '../services/snapshot.js';
import { formatKo, fromIso, nowSeoul, relativeKo } from '../time.js';
import { parseIntSafe, queryParam, truncate } from '../text.js';
import { fmtAnnouncement, fmtAssignment, fmtCourse, fmtDeadline, fmtMaterial, fmtStatus, header, lateLabel, notesBlock, STATE_LABEL } from './format.js';

export interface ToolDeps {
  service: LmsService;
  sessionManager: SessionManager;
  snapshots: SnapshotStore;
  logger: Logger;
  defaultLoginMode: 'plain' | 'assisted';
  defaultLoginWaitSec: number;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(err: unknown, logger: Logger, tool: string): ToolResult {
  const e = toLmsError(err);
  logger.warn(`도구 실패: ${tool}`, { kind: e.kind, detail: e.detail });
  const uf = e.toUserFacing();
  return { content: [{ type: 'text', text: formatUserError(e) }], structuredContent: { error: uf }, isError: true };
}

function withDetailFromUrl(url: string | undefined): { id: number | null; bwid: number | null } {
  return { id: parseIntSafe(queryParam(url, 'id')), bwid: parseIntSafe(queryParam(url, 'bwid')) };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { service, sessionManager, logger } = deps;
  const status = (): Promise<AuthStatus> => sessionManager.getStatus();

  const run = async (tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (e) {
      return fail(e, logger, tool);
    }
  };

  // ---------------- 인증 ----------------

  server.registerTool(
    'connect_lms',
    {
      title: 'LMS 연결(로그인)',
      description:
        '전북대 LMS 로그인용 브라우저를 엽니다. 사용자가 브라우저에서 통합인증(패스키·2차 인증)을 직접 완료하면 세션을 안전하게 저장합니다. ' +
        '아이디·비밀번호·패스키를 이 도구에 넣지 마세요. mode=assisted 는 로그인 완료를 자동 감지해 창을 닫고, plain 은 사용자가 창을 닫으면 완료됩니다. ' +
        'wait_seconds 동안 완료를 기다리며, 0 이면 창만 열고 바로 돌아옵니다(이후 get_auth_status 로 마무리).',
      inputSchema: {
        mode: z.enum(['assisted', 'plain']).optional().describe('assisted: 완료 자동 감지(기본), plain: 일반 브라우저(창 닫으면 완료)'),
        wait_seconds: z.number().int().min(0).max(600).optional().describe('로그인 완료 대기 시간(초). 기본값은 설정값(보통 90초)'),
      },
    },
    async (args) =>
      run('connect_lms', async () => {
        const mode = args.mode ?? deps.defaultLoginMode;
        const wait = (args.wait_seconds ?? deps.defaultLoginWaitSec) * 1000;
        if (wait === 0) {
          const start = await sessionManager.startLogin();
          const text = start.profileLocked
            ? '이미 로그인용 브라우저 창이 열려 있습니다. 그 창에서 로그인을 마치고 창을 닫은 뒤 get_auth_status 를 실행해 주세요.'
            : [`🔐 ${start.browser} 창을 열었습니다.`, '', '1. 열린 창에서 전북대 통합인증(패스키 또는 2차 인증)을 직접 완료해 주세요.', '2. LMS 홈이 보이면 브라우저 창을 모두 닫아 주세요.', '3. 완료되면 "로그인 완료"라고 알려 주세요. get_auth_status 로 연결을 마무리합니다.', '', '이 도구는 아이디·비밀번호·패스키를 읽거나 저장하지 않습니다.'].join('\n');
          return ok(text, { pending: true, browser: start.browser, mode: 'plain' });
        }
        const st = await sessionManager.loginFlow(mode, wait);
        if (st.connected) return ok(`✅ LMS 연결 완료\n\n${fmtStatus(st)}`, { status: st });
        return ok(`⏳ 아직 연결되지 않았습니다.\n\n${fmtStatus(st)}\n\n로그인을 마쳤다면 브라우저 창을 닫고 get_auth_status 를 실행해 주세요.`, { status: st });
      }),
  );

  server.registerTool(
    'get_auth_status',
    {
      title: '연결 상태 확인',
      description: '로그인 상태, 인증 방식, 마지막 동기화 시각, 저장 방식을 보여 줍니다. 로그인 브라우저를 닫은 직후 호출하면 연결을 자동으로 마무리합니다. verify=true 면 LMS 에 실제로 요청해 세션 유효성을 확인합니다.',
      inputSchema: { verify: z.boolean().optional().describe('LMS 서버에 세션 유효성을 실제로 확인할지 (기본 true)') },
    },
    async (args) =>
      run('get_auth_status', async () => {
        const st = await sessionManager.getStatus({ verify: args.verify ?? true });
        return ok(`## 연결 상태\n${fmtStatus(st)}`, { status: st });
      }),
  );

  server.registerTool(
    'disconnect_lms',
    {
      title: 'LMS 연결 해제',
      description: '저장된 LMS 세션(쿠키·토큰)을 삭제합니다. delete_browser_profile=true 면 로그인용 브라우저 프로필(SSO 세션 포함)도 삭제하고, delete_snapshot=true 면 변경 감지용 로컬 스냅샷도 지웁니다.',
      inputSchema: {
        delete_browser_profile: z.boolean().optional().describe('브라우저 프로필까지 삭제 (기본 false)'),
        delete_snapshot: z.boolean().optional().describe('변경 감지 스냅샷 삭제 (기본 false)'),
      },
    },
    async (args) =>
      run('disconnect_lms', async () => {
        const r = await sessionManager.disconnect({ deleteProfile: args.delete_browser_profile });
        if (args.delete_snapshot) await deps.snapshots.clear();
        const lines = ['🔓 LMS 연결을 해제했습니다.', `- 세션 정보 삭제: ${r.removedSession ? '완료' : '저장된 세션 없음'}`, `- 브라우저 프로필 삭제: ${r.removedProfile ? '완료' : '유지(다음 로그인이 빨라집니다)'}`, `- 변경 감지 스냅샷 삭제: ${args.delete_snapshot ? '완료' : '유지'}`];
        return ok(lines.join('\n'), { ...r, removedSnapshot: Boolean(args.delete_snapshot) });
      }),
  );

  // ---------------- 강좌 ----------------

  server.registerTool(
    'list_courses',
    {
      title: '수강 강좌 목록',
      description: '현재 수강 중인 강좌 목록(ID, 이름, 진행률, URL)을 보여 줍니다. include_all=true 면 종료된 강좌도 포함합니다.',
      inputSchema: { include_all: z.boolean().optional().describe('종료/예정 강좌 포함 여부 (기본 false)') },
    },
    async (args) =>
      run('list_courses', async () => {
        const { courses, notes } = await service.listCourses({ includeAll: args.include_all });
        const st = await status();
        const text = header(st, `수강 강좌 ${courses.length}개`, courses.map((c) => c.source)) + (courses.length ? courses.map(fmtCourse).join('\n') : '표시할 강좌가 없습니다. include_all=true 로 다시 시도해 보세요.') + notesBlock(notes);
        return ok(text, { courses, notes });
      }),
  );

  server.registerTool(
    'get_course_overview',
    {
      title: '강좌 개요',
      description: '강좌의 주차(섹션)별 모듈 목록과 공지 게시판 위치를 보여 줍니다. 각 모듈의 cm_id 는 다른 도구(자료 다운로드, 과제 상세)에 그대로 사용할 수 있습니다.',
      inputSchema: { course_id: z.number().int().positive().describe('list_courses 의 강좌 ID') },
    },
    async (args) =>
      run('get_course_overview', async () => {
        const ov = await service.getCourseOverview(args.course_id);
        const st = await status();
        const lines: string[] = [];
        lines.push(`강좌: **${ov.course.fullName}** · ${ov.course.url}`);
        lines.push(`공지 게시판: ${ov.noticeBoard ? `board_cm_id ${ov.noticeBoard.cmId} · ${ov.noticeBoard.url}` : '찾지 못함'}`);
        for (const s of ov.sections) {
          lines.push('', `### ${s.title}${s.visible ? '' : ' (숨김)'}`);
          if (!s.modules.length) lines.push('- (모듈 없음)');
          for (const m of s.modules) {
            const bits = [`[${m.modName}] ${m.name}`, `cm_id ${m.cmId}`];
            if (!m.visible) bits.push('숨김/제한');
            if (m.availabilityText) bits.push(m.availabilityText);
            if (m.dates.length) bits.push(m.dates.map((d) => `${d.label} ${formatKo(fromIso(d.at))}`).join(', '));
            if (m.files.length) bits.push(`파일 ${m.files.length}개`);
            if (m.url) bits.push(m.url);
            lines.push(`- ${bits.join(' · ')}`);
          }
        }
        return ok(header(st, '강좌 개요', [ov.source, 'lms_page']) + lines.join('\n'), { overview: ov });
      }),
  );

  // ---------------- 공지 ----------------

  server.registerTool(
    'get_announcements',
    {
      title: '공지사항 목록',
      description: '강좌 공지사항(전북대 ubboard 게시판)을 최신순으로 보여 줍니다. 📌 는 상단 고정(중요) 공지, 🆕 는 새 글, 📎 는 첨부 있음입니다. only_new=true 면 지난 확인 이후 새로 올라온 공지만 보여 줍니다.',
      inputSchema: {
        course_id: z.number().int().positive().optional().describe('특정 강좌만 조회. 생략하면 수강 중인 모든 강좌'),
        limit: z.number().int().min(1).max(200).optional().describe('최대 개수 (기본 20)'),
        pages: z.number().int().min(1).max(5).optional().describe('강좌당 읽을 게시판 페이지 수 (기본 1)'),
        only_new: z.boolean().optional().describe('새 글만 (기본 false)'),
      },
    },
    async (args) =>
      run('get_announcements', async () => {
        const { announcements, notes } = await service.getAnnouncements({ courseId: args.course_id, limit: args.limit, pages: args.pages, onlyNew: args.only_new });
        const st = await status();
        const body = announcements.length ? announcements.map(fmtAnnouncement).join('\n') : args.only_new ? '새로 올라온 공지가 없습니다.' : '표시할 공지가 없습니다.';
        return ok(header(st, `공지사항 ${announcements.length}건`, ['lms_page']) + body + notesBlock(notes) + '\n\n본문을 보려면 get_announcement_detail(board_cm_id, bwid) 를 사용하세요.', { announcements, notes });
      }),
  );

  server.registerTool(
    'get_announcement_detail',
    {
      title: '공지 본문',
      description: '공지 게시글 본문과 첨부파일 목록을 보여 줍니다. get_announcements 결과의 board_cm_id 와 bwid, 또는 게시글 URL 을 넣으세요.',
      inputSchema: {
        board_cm_id: z.number().int().positive().optional().describe('게시판 모듈 ID (URL 의 id=)'),
        bwid: z.number().int().positive().optional().describe('게시글 ID (URL 의 bwid=)'),
        url: z.string().url().optional().describe('게시글 URL (/mod/ubboard/article.php?id=..&bwid=..)'),
        max_chars: z.number().int().min(200).max(20000).optional().describe('본문 최대 길이 (기본 6000)'),
      },
    },
    async (args) =>
      run('get_announcement_detail', async () => {
        const fromUrl = withDetailFromUrl(args.url);
        const boardCmId = args.board_cm_id ?? fromUrl.id;
        const bwid = args.bwid ?? fromUrl.bwid;
        if (!boardCmId || !bwid) return fail(new (await import('../errors.js')).LmsError('INVALID_INPUT', 'board_cm_id 와 bwid 또는 url 이 필요합니다'), logger, 'get_announcement_detail');
        const a = await service.getAnnouncementDetail(boardCmId, bwid);
        const st = await status();
        const lines = [`### ${a.title}`, `${a.courseName ?? ''} · ${a.author ?? '작성자 미상'} · ${a.createdAt ? formatKo(fromIso(a.createdAt)) : '날짜 없음'} · 조회 ${a.views ?? '-'} · ${a.url}`, ''];
        lines.push('#### 본문(원문)', truncate(a.bodyText ?? '', args.max_chars ?? 6000) || '(본문 없음)');
        if (a.attachments?.length) lines.push('', '#### 첨부파일', ...a.attachments.map((f) => `- ${f.name} · ${f.url}`));
        return ok(header(st, '공지 본문', ['lms_page']) + lines.join('\n'), { announcement: a });
      }),
  );

  // ---------------- 과제 ----------------

  server.registerTool(
    'get_assignments',
    {
      title: '과제 목록',
      description: '과제 목록을 마감 순으로 보여 줍니다. 마감일, 남은 시간, 제출 상태, 지각 허용 여부, 원문 URL 을 포함합니다.',
      inputSchema: {
        course_id: z.number().int().positive().optional().describe('특정 강좌만. 생략하면 수강 중인 모든 강좌'),
        include_submitted: z.boolean().optional().describe('제출 완료 과제 포함 (기본 true)'),
      },
    },
    async (args) =>
      run('get_assignments', async () => {
        const { assignments, notes } = await service.getAssignments({ courseId: args.course_id, includeSubmitted: args.include_submitted });
        const st = await status();
        const now = nowSeoul();
        const body = assignments.length ? assignments.map((a) => fmtAssignment(a, now)).join('\n') : '표시할 과제가 없습니다.';
        return ok(header(st, `과제 ${assignments.length}건`, assignments.map((a) => a.source)) + body + notesBlock(notes) + '\n\n요구사항 분석은 get_assignment_detail(cm_id) 를 사용하세요.', { assignments, notes });
      }),
  );

  server.registerTool(
    'get_assignment_detail',
    {
      title: '과제 상세·요구사항 분석',
      description: '과제 설명 원문, 마감/최종 마감, 제출 상태, 첨부파일, 제출한 파일을 보여 주고 요구사항·제출물 단서를 AI 추정으로 정리합니다(추정 부분은 별도 표시).',
      inputSchema: {
        cm_id: z.number().int().positive().optional().describe('과제 모듈 ID (URL 의 id=)'),
        url: z.string().url().optional().describe('과제 URL (/mod/assign/view.php?id=..)'),
      },
    },
    async (args) =>
      run('get_assignment_detail', async () => {
        const cmId = args.cm_id ?? withDetailFromUrl(args.url).id;
        if (!cmId) return fail(new (await import('../errors.js')).LmsError('INVALID_INPUT', 'cm_id 또는 url 이 필요합니다'), logger, 'get_assignment_detail');
        const { assignment: a, analysis } = await service.getAssignmentDetail(cmId);
        const st = await status();
        const now = nowSeoul();
        const due = fromIso(a.dueAt);
        const lines = [
          `### ${a.title}`,
          `${a.courseName ?? ''} · ${a.url}`,
          `- 마감: ${due ? `${formatKo(due)} (${relativeKo(due, now)})` : '설정 없음'}${a.timeRemainingText ? ` · 원문 "${a.timeRemainingText}"` : ''}`,
          `- 최종 마감(제출 차단): ${a.cutoffAt ? formatKo(fromIso(a.cutoffAt)) : '없음'} · ${lateLabel(a.lateAllowed)}`,
          `- 제출 허용 시작: ${a.allowSubmissionsFromAt ? formatKo(fromIso(a.allowSubmissionsFromAt)) : '제한 없음'}`,
          `- 제출 상태: ${STATE_LABEL[a.submissionState]}${a.submissionStatusText ? ` (원문 "${a.submissionStatusText}")` : ''}`,
          `- 채점 상태: ${a.gradingStatusText ?? '-'} · 성적: ${a.gradeText ?? '-'}`,
          '',
          '#### 과제 설명(원문)',
          truncate(a.descriptionText ?? '', 8000) || '(설명 없음)',
        ];
        if (a.attachments?.length) lines.push('', '#### 첨부파일(과제 안내)', ...a.attachments.map((f) => `- ${f.name} · ${f.url}`));
        if (a.submittedFiles?.length) lines.push('', '#### 내가 제출한 파일', ...a.submittedFiles.map((f) => `- ${f.name} · ${f.url}`));
        lines.push('', '#### 요구사항 분석 (AI 추정 — 원문과 다를 수 있음)');
        if (analysis.requirementLines.length) lines.push('요구사항 단서:', ...analysis.requirementLines.map((l) => `- ${l}`));
        if (analysis.deliverableFormats.length) lines.push(`제출물 형식 단서: ${analysis.deliverableFormats.join(', ')}`);
        if (analysis.lengthHints.length) lines.push(`분량 단서: ${analysis.lengthHints.join(', ')}`);
        if (analysis.dateMentions.length) lines.push(`본문 날짜 언급: ${analysis.dateMentions.join(', ')}`);
        lines.push(`팀/개인: ${{ team: '팀 과제로 보임', individual: '개인 과제로 보임', unknown: '판단 불가' }[analysis.teamWork]}`);
        if (analysis.submissionMethodHints.length) lines.push('제출 방법 단서:', ...analysis.submissionMethodHints.map((l) => `- ${l}`));
        if (analysis.cautions.length) lines.push('주의:', ...analysis.cautions.map((l) => `- ${l}`));
        return ok(header(st, '과제 상세', [a.source]) + lines.join('\n'), { assignment: a, analysis });
      }),
  );

  server.registerTool(
    'get_upcoming_deadlines',
    {
      title: '다가오는 마감',
      description: '오늘·내일·이번 주·기한 초과로 구분한 마감 목록(과제·퀴즈 등)을 보여 줍니다. 기본은 아직 제출하지 않은 항목만 포함합니다.',
      inputSchema: {
        days: z.number().int().min(1).max(120).optional().describe('앞으로 며칠까지 (기본 7)'),
        include_overdue: z.boolean().optional().describe('기한 초과 포함 (기본 true, 최근 14일)'),
        include_submitted: z.boolean().optional().describe('제출 완료 항목 포함 (기본 false)'),
        course_id: z.number().int().positive().optional().describe('특정 강좌만'),
      },
    },
    async (args) =>
      run('get_upcoming_deadlines', async () => {
        const { deadlines, notes } = await service.getUpcomingDeadlines({ days: args.days, includeOverdue: args.include_overdue, includeSubmitted: args.include_submitted, courseId: args.course_id });
        const st = await status();
        const now = nowSeoul();
        const groups = new Map<string, string[]>();
        for (const d of deadlines) {
          const label = bucketLabel((await import('../time.js')).bucketFor(fromIso(d.dueAt), now));
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label)!.push(fmtDeadline(d, now));
        }
        const order = ['기한 초과', '오늘', '내일', '이번 주', '다음 주', '그 이후', '기한 없음'];
        const body = deadlines.length ? order.filter((k) => groups.has(k)).map((k) => `### ${k} (${groups.get(k)!.length})\n${groups.get(k)!.join('\n')}`).join('\n\n') : '해당 기간에 확인된 마감이 없습니다.';
        return ok(header(st, `마감 ${deadlines.length}건`, deadlines.map((d) => d.source)) + body + notesBlock(notes), { deadlines, notes });
      }),
  );

  // ---------------- 자료 ----------------

  server.registerTool(
    'get_course_materials',
    {
      title: '수업자료 목록',
      description: '강좌의 주차별 수업자료(파일·폴더·링크·동영상·페이지)를 보여 줍니다. week 로 특정 주차만, query 로 이름 검색을 할 수 있습니다.',
      inputSchema: {
        course_id: z.number().int().positive().describe('강좌 ID'),
        week: z.number().int().min(0).max(30).optional().describe('주차 번호'),
        query: z.string().min(1).max(100).optional().describe('자료 이름·섹션 검색어'),
        kinds: z.array(z.enum(['file', 'folder', 'link', 'video', 'page', 'other'])).optional().describe('자료 종류 필터'),
      },
    },
    async (args) =>
      run('get_course_materials', async () => {
        const { materials, sections, notes } = await service.getCourseMaterials({ courseId: args.course_id, week: args.week, query: args.query, kinds: args.kinds });
        const st = await status();
        const body = materials.length ? materials.map(fmtMaterial).join('\n') : `조건에 맞는 자료가 없습니다. 섹션: ${sections.join(' / ') || '없음'}`;
        return ok(header(st, `수업자료 ${materials.length}건`, materials.map((m) => m.source)) + body + notesBlock(notes) + '\n\n파일을 받으려면 download_course_material(cm_id 또는 file_url) 을 사용하세요.', { materials, sections, notes });
      }),
  );

  server.registerTool(
    'download_course_material',
    {
      title: '수업자료 다운로드',
      description: '수업자료 파일을 내 PC 의 다운로드 폴더(기본 ~/Downloads/jbnu-lms/<강좌명>/)에 저장하고 경로를 알려 줍니다. cm_id(모듈) 또는 file_url(pluginfile 링크) 중 하나가 필요합니다.',
      inputSchema: {
        cm_id: z.number().int().positive().optional().describe('모듈 ID'),
        file_url: z.string().url().optional().describe('파일 URL (lms.jbnu.ac.kr 의 pluginfile.php 링크)'),
        course_id: z.number().int().positive().optional().describe('강좌 ID (폴더 이름과 모듈 종류 판별에 사용)'),
        target_dir: z.string().optional().describe('저장 폴더 절대 경로 (생략 시 기본 폴더)'),
      },
    },
    async (args) =>
      run('download_course_material', async () => {
        const r = await service.downloadMaterial({ cmId: args.cm_id, fileUrl: args.file_url, courseId: args.course_id, targetDir: args.target_dir });
        const st = await status();
        const kb = Math.round(r.bytes / 1024);
        return ok(header(st, '다운로드 완료', ['lms_page']) + [`- 파일: ${r.fileName}`, `- 저장 위치: ${r.path}`, `- 크기: ${kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`} · 형식: ${r.contentType ?? '알 수 없음'}`, `- 원본: ${r.sourceUrl}`].join('\n'), { download: r });
      }),
  );

  // ---------------- 변경·브리핑 ----------------

  server.registerTool(
    'get_recent_changes',
    {
      title: '지난 확인 이후 변경 사항',
      description: '지난번 확인(로컬 스냅샷) 이후 새 공지, 새 과제, 마감·제출 상태가 바뀐 과제, 새 수업자료를 보여 줍니다. 처음 실행하면 기준 스냅샷만 만듭니다. since 로 기준 시각을 직접 줄 수도 있습니다.',
      inputSchema: {
        since: z.string().optional().describe('기준 시각 ISO 8601 (예: 2026-09-01T00:00:00+09:00). 생략하면 스냅샷 시각'),
        course_id: z.number().int().positive().optional().describe('특정 강좌만'),
        update_snapshot: z.boolean().optional().describe('조회 후 스냅샷 갱신 (기본 true)'),
      },
    },
    async (args) =>
      run('get_recent_changes', async () => {
        const r = await service.getRecentChanges({ since: args.since, courseId: args.course_id, updateSnapshot: args.update_snapshot });
        const st = await status();
        const c = r.changes;
        const lines: string[] = [];
        if (c.firstRun) lines.push('처음 실행이라 기준 스냅샷을 만들었습니다. 다음 호출부터 변경 사항이 표시됩니다.');
        else lines.push(`기준: ${c.since ? formatKo(fromIso(c.since)) : '없음'} 이후`);
        const sec = (title: string, items: string[]) => {
          if (items.length) lines.push('', `### ${title} (${items.length})`, ...items);
        };
        const now = nowSeoul();
        sec('새 공지', c.newAnnouncements.map(fmtAnnouncement));
        sec('수정된 공지', c.updatedAnnouncements.map(fmtAnnouncement));
        sec('새 과제', c.newAssignments.map((a) => fmtAssignment(a, now)));
        sec('변경된 과제', c.changedAssignments.map((x) => `${fmtAssignment(x.assignment, now)}\n  - 변경: ${x.changes.join('; ')}`));
        sec('사라진 과제', c.removedAssignments.map((a) => `- ${a.title} · ${a.courseName ?? ''} · ${a.url}`));
        sec('새 수업자료', c.newMaterials.map(fmtMaterial));
        sec('모듈 업데이트(Moodle 기록)', r.moduleUpdates.map((u) => `- ${u.courseName ?? u.courseId}: ${u.name} (${u.updates.join(', ')})${u.url ? ` · ${u.url}` : ''}`));
        if (!c.firstRun && lines.length === 1 && !r.moduleUpdates.length) lines.push('', '변경 사항이 없습니다.');
        lines.push('', `스냅샷 저장 시각: ${r.snapshotSavedAt ? formatKo(fromIso(r.snapshotSavedAt)) : '없음'}`);
        return ok(header(st, '변경 사항', ['lms_page', 'moodle_ajax', 'local_snapshot']) + lines.join('\n') + notesBlock(r.notes), { changes: c, moduleUpdates: r.moduleUpdates, snapshotSavedAt: r.snapshotSavedAt, notes: r.notes });
      }),
  );

  server.registerTool(
    'get_daily_briefing',
    {
      title: '오늘 해야 할 일 브리핑',
      description: '"오늘 해야 할 일 알려줘"에 대한 한 번의 답: 기한 초과·오늘·내일·이번 주 마감, 새 공지, 지난 확인 이후 변경, AI 제안(별도 표시)을 정리합니다.',
      inputSchema: { days: z.number().int().min(1).max(30).optional().describe('마감을 볼 기간(일, 기본 7)') },
    },
    async (args) =>
      run('get_daily_briefing', async () => {
        const b = await service.getDailyBriefing({ days: args.days });
        const st = await status();
        const now = nowSeoul();
        const lines: string[] = [`오늘: ${b.todayLabel}`];
        const order: Array<keyof typeof b.buckets> = ['overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'later'];
        let any = false;
        for (const k of order) {
          const items = b.buckets[k];
          if (!items.length) continue;
          any = true;
          lines.push('', `### ${bucketLabel(k)} (${items.length})`, ...items.map((d) => fmtDeadline(d, now)));
        }
        if (!any) lines.push('', '확인된 마감이 없습니다.');
        lines.push('', `### 새 공지 (${b.newAnnouncements.length})`, ...(b.newAnnouncements.length ? b.newAnnouncements.map(fmtAnnouncement) : ['새 공지가 없습니다.']));
        if (b.changes && !b.changes.firstRun) {
          const ch = b.changes;
          const n = ch.newAnnouncements.length + ch.newAssignments.length + ch.changedAssignments.length;
          lines.push('', `### 지난 확인 이후 변경 (${n})`);
          if (ch.newAssignments.length) lines.push(...ch.newAssignments.map((a) => `- 새 과제: ${a.title} · ${a.courseName ?? ''}`));
          if (ch.changedAssignments.length) lines.push(...ch.changedAssignments.map((x) => `- 변경: ${x.assignment.title} — ${x.changes.join('; ')}`));
          if (!n) lines.push('- 변경 없음');
        }
        lines.push('', '### 제안 (AI 추정)', ...b.suggestions.items.map((s) => `- ${s}`));
        const sources: DataSource[] = ['moodle_ajax', 'lms_page'];
        return ok(header(st, '오늘의 브리핑', sources) + lines.join('\n') + notesBlock(b.notes), { briefing: b });
      }),
  );

  server.registerTool(
    'get_weekly_study_plan',
    {
      title: '이번 주 학습 계획',
      description: '이번 주(월~일) 요일별 마감과 AI 제안(초안·최종 점검 일정)을 정리합니다. 다음 주 미리보기와 기한 초과 항목도 포함합니다.',
      inputSchema: {},
    },
    async () =>
      run('get_weekly_study_plan', async () => {
        const p = await service.getWeeklyStudyPlan();
        const st = await status();
        const now = nowSeoul();
        const lines: string[] = [`기간: ${p.weekStart} ~ ${p.weekEnd}`];
        for (const d of p.days) {
          lines.push('', `### ${d.label}${d.isToday ? ' ← 오늘' : ''}`);
          if (d.deadlines.length) lines.push(...d.deadlines.map((x) => fmtDeadline(x, now)));
          if (d.suggestedTasks.length) lines.push(...d.suggestedTasks.map((t) => `- (제안) ${t}`));
          if (!d.deadlines.length && !d.suggestedTasks.length) lines.push('- 마감 없음');
        }
        if (p.overdue.length) lines.push('', `### 기한 초과 (${p.overdue.length})`, ...p.overdue.map((x) => fmtDeadline(x, now)));
        if (p.nextWeekPreview.length) lines.push('', `### 다음 주 미리보기 (${p.nextWeekPreview.length})`, ...p.nextWeekPreview.map((x) => fmtDeadline(x, now)));
        lines.push('', '### 제안 (AI 추정)', ...(p.suggestions.items.length ? p.suggestions.items.map((s) => `- ${s}`) : ['- 특별한 제안 없음']));
        return ok(header(st, '이번 주 학습 계획', ['moodle_ajax', 'lms_page']) + lines.join('\n') + notesBlock(p.notes), { plan: p });
      }),
  );
}
