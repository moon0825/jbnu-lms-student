/**
 * MCP 도구 등록. LMS 기능은 조회 전용이다. 피드백 도구만 사용자 확인 후 로컬 저장·외부 전송을 수행한다.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthStatus, DataSource } from '../adapters/types.js';
import type { SessionManager } from '../auth/session-manager.js';
import { formatPresentedError, presentUserError, toLmsError } from '../errors.js';
import type { Logger } from '../logging.js';
import { bucketLabel } from '../services/briefing.js';
import type { AttentionItem, CalendarCandidate } from '../services/attention.js';
import type { FeedbackReceipt, FeedbackService } from '../services/feedback-service.js';
import type { LmsService } from '../services/lms-service.js';
import type { SnapshotStore } from '../services/snapshot.js';
import { formatKo, fromIso, nowSeoul, relativeKo } from '../time.js';
import { parseIntSafe, queryParam, truncate } from '../text.js';
import { emptyState, fmtAnnouncement, fmtAssignment, fmtCourse, fmtDeadline, fmtMaterial, fmtStatus, header, lateLabel, notesBlock, STATE_LABEL } from './format.js';

export interface ToolDeps {
  service: LmsService;
  sessionManager: SessionManager;
  snapshots: SnapshotStore;
  feedback: FeedbackService;
  logger: Logger;
  defaultLoginMode: 'plain' | 'assisted';
  defaultLoginWaitSec: number;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

const OPERATIONS: Record<string, { label: string; impact?: string }> = {
  connect_lms: { label: 'LMS 연결', impact: '연결 완료 여부를 확정하지 못했습니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  get_auth_status: { label: '연결 상태 확인' },
  open_lms_source: { label: 'LMS 원문 열기', impact: '브라우저 창을 열지 못했습니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  disconnect_lms: { label: 'LMS 연결 해제', impact: '로컬 연결 정보가 일부 정리되었을 수 있습니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  list_courses: { label: '수강 강좌 조회' },
  get_course_overview: { label: '강좌 개요 조회' },
  get_announcements: { label: '공지사항 조회' },
  get_announcement_detail: { label: '공지 본문 조회' },
  get_assignments: { label: '과제 목록 조회' },
  get_assignment_detail: { label: '과제 상세 조회' },
  check_assignment_submission: { label: '과제 제출 상태 재확인' },
  get_upcoming_deadlines: { label: '다가오는 마감 조회' },
  get_calendar_sync_candidates: { label: '캘린더 동기화 후보 생성' },
  get_course_materials: { label: '수업자료 조회' },
  download_course_material: { label: '수업자료 다운로드', impact: '완성된 다운로드 파일을 만들지 못했습니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  get_recent_changes: { label: '최근 변경 사항 조회', impact: '결과 표시를 완료하지 못했습니다. LMS 원본은 변경되지 않았지만 로컬 비교 스냅샷은 갱신되었을 수 있습니다.' },
  get_attention_inbox: { label: '학생 확인함 생성', impact: '결과 표시를 완료하지 못했습니다. LMS 원본은 변경되지 않았지만 로컬 비교 스냅샷은 갱신되었을 수 있습니다.' },
  get_daily_briefing: { label: '오늘의 학업 브리핑 생성' },
  get_weekly_study_plan: { label: '주간 학습 계획 생성' },
  report_lms_problem: { label: '문제 신고 접수', impact: '신고가 수집 서버에 전달되지 않았을 수 있지만 로컬 보관함에는 먼저 저장됩니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  suggest_lms_feature: { label: '기능 제안 접수', impact: '제안이 수집 서버에 전달되지 않았을 수 있지만 로컬 보관함에는 먼저 저장됩니다. LMS 원본 데이터는 변경되지 않았습니다.' },
  get_feedback_status: { label: '피드백 접수 상태 확인' },
  retry_feedback_delivery: { label: '피드백 재전송' },
  discard_local_feedback: { label: '로컬 피드백 삭제', impact: '로컬 보고서 삭제가 끝나지 않았을 수 있습니다. 이미 원격 전송된 사본에는 영향을 주지 않습니다.' },
};

function fail(err: unknown, logger: Logger, tool: string): ToolResult {
  const e = toLmsError(err);
  const operation = OPERATIONS[tool] ?? { label: tool };
  const uf = presentUserError(e, { operation: operation.label, impact: operation.impact, tool });
  logger.warn(`도구 실패: ${tool}`, { kind: e.kind, detail: e.detail, diagnosticId: uf.diagnosticId });
  return { content: [{ type: 'text', text: formatPresentedError(uf) }], structuredContent: { error: uf }, isError: true };
}

function withDetailFromUrl(url: string | undefined): { id: number | null; bwid: number | null } {
  return { id: parseIntSafe(queryParam(url, 'id')), bwid: parseIntSafe(queryParam(url, 'bwid')) };
}

function feedbackReceiptText(receipt: FeedbackReceipt): string {
  const state = receipt.delivery === 'sent'
    ? '✅ 수집 서버로 전송 완료'
    : receipt.delivery === 'queued_retry'
      ? '⚠️ 로컬 접수 완료 · 원격 전송 재시도 대기'
      : '✅ 로컬 접수 완료 · 원격 수집 주소 미설정';
  return [
    `## ${receipt.kind === 'problem' ? '문제 신고' : '기능 제안'} 접수`,
    state,
    `- 접수 번호: ${receipt.reportId}`,
    `- 접수 시각: ${receipt.createdAt}`,
    `- 수집 방식: ${receipt.collectorMode === 'remote' ? `원격 전송(${receipt.collectorOrigin})` : '이 PC의 로컬 보관함'}`,
    `- 개인정보 보호: ${receipt.privacy}`,
    receipt.retryAvailable ? '- 다음 행동: retry_feedback_delivery로 다시 전송할 수 있습니다.' : '',
  ].filter(Boolean).join('\n');
}

function fmtAttention(item: AttentionItem): string {
  const mark = { critical: '🔴', high: '🟠', normal: '🔵', low: '⚪' }[item.priority];
  const bits = [`${mark} **${item.title}**`];
  if (item.courseName) bits.push(item.courseName);
  if (item.dueAt) bits.push(`마감 ${formatKo(fromIso(item.dueAt))} (${relativeKo(fromIso(item.dueAt))})`);
  const lines = [`- ${bits.join(' · ')}`, `  - 이유: ${item.signals.join('; ')}`, `  - 다음 행동: ${item.recommendedAction}`];
  if (item.sourceUrl) lines.push(`  - 원문: ${item.sourceUrl}`);
  if (item.calendarCandidate) lines.push(`  - 캘린더: ${item.calendarCandidate.disposition === 'auto_ready' ? '확정 일정 후보' : '검토 필요'}`);
  return lines.join('\n');
}

function fmtCalendarCandidate(c: CalendarCandidate): string {
  const state = c.disposition === 'auto_ready' ? '✅ 확정 후보' : '⚠️ 검토 필요';
  return `- ${state} · **${c.title}** · ${formatKo(fromIso(c.dueAt))} · ${c.sourceUrl}`;
}

const feedbackInputSchema = {
  summary: z.string().min(5).max(160).describe('사용자가 확인한 한 줄 요약 (5~160자)'),
  details: z.string().min(10).max(4000).describe('사용자가 확인한 상세 설명 (10~4000자). 개인정보와 LMS 본문은 넣지 않음'),
  diagnostic_id: z.string().regex(/^JBNU-\d{8}-[A-F0-9]{6}$/).optional().describe('오류 응답의 진단 ID'),
  affected_tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional().describe('문제가 발생했거나 개선할 MCP 도구 이름'),
  steps_to_reproduce: z.string().max(2000).optional().describe('재현 단계. 강좌명·과제명·공지 본문은 익명화'),
  expected_behavior: z.string().max(2000).optional().describe('기대한 동작 또는 원하는 개선 결과'),
  include_technical_context: z.boolean().optional().describe('앱 버전, OS 종류, CPU 아키텍처, Node 주버전 포함. 기본 true'),
  confirm_submit: z.literal(true).describe('사용자가 위 내용을 확인하고 접수·전송을 명시적으로 승인했을 때만 true'),
};

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { service, sessionManager, logger } = deps;
  const status = (): Promise<AuthStatus> => sessionManager.getStatus();
  const mac = process.platform === 'darwin';
  const completionGuide = mac
    ? '실제 수강 과목이 보이는 LMS 화면에 도착하면 로그인용 Chrome/Edge 창만 닫아 주세요. 세션 확인 뒤 macOS Keychain에 저장됩니다.'
    : '실제 수강 과목이 보이는 LMS 화면에 도착하면 창을 닫지 말고 기다려 주세요. 저장 뒤 전용 창이 자동으로 닫힙니다.';

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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        '전북대 LMS 로그인용 일반 브라우저(자동화 없음)를 LMS /my/에서 엽니다. 사용자는 통합로그인의 세 번째 "아이디 로그인" 탭에서 1차 로그인한 뒤 2차 인증으로 패스키를 선택합니다. ' +
        (mac
          ? 'macOS에서는 LMS 홈 도착 후 사용자가 로그인용 창만 닫으면 세션을 검증해 Keychain에 저장합니다. '
          : 'Windows에서는 LMS 홈을 감지하면 전용 Chrome만 세션 보존 종료하고, LMS 세션을 DPAPI로 저장합니다. ') +
        '아이디·비밀번호·패스키를 이 도구에 넣지 마세요. ' +
        'wait_seconds 동안 완료를 기다리며, 0 이면 창만 열고 바로 돌아옵니다(이후 get_auth_status 를 호출하면 자동으로 마무리).',
      inputSchema: {
        wait_seconds: z.number().int().min(0).max(600).optional().describe('LMS 화면 감지와 세션 저장을 기다리는 시간(초). 기본 120'),
      },
    },
    async (args) =>
      run('connect_lms', async () => {
        const mode = deps.defaultLoginMode;
        const wait = (args.wait_seconds ?? deps.defaultLoginWaitSec) * 1000;
        const guide = [
          '1. 통합로그인의 세 번째 "아이디 로그인" 탭을 선택해 아이디·비밀번호로 1차 인증해 주세요.',
          '2. 다음 2차 인증 화면에서 "패스키"를 선택해 완료해 주세요.',
          `3. ${completionGuide}`,
          '',
          '주의: 두 번째 "패스키 인증 로그인" 탭의 비밀번호 없는 단독 로그인과는 다른 경로입니다.',
          '이 도구는 아이디·비밀번호·패스키를 읽거나 저장하지 않으며, 로그인 화면에 어떤 자동화도 연결하지 않습니다.',
        ];
        if (wait === 0) {
          const start = await sessionManager.startLogin();
          const text = start.profileLocked
            ? mac
              ? '이미 로그인용 브라우저 창이 열려 있습니다. LMS 홈에 수강 과목이 보이면 이 전용 창만 닫은 뒤 get_auth_status 를 실행해 주세요.'
              : '이미 로그인용 브라우저 창이 열려 있습니다. LMS 홈이 보이면 창을 닫지 말고 get_auth_status 를 실행해 주세요.'
            : [`🔐 ${start.browser} 창을 열었습니다.`, '', ...guide, '', 'LMS 홈이 보인 상태에서 get_auth_status 를 호출해도 연결을 마무리할 수 있습니다.'].join('\n');
          return ok(text, { pending: true, browser: start.browser, mode });
        }
        const st = await sessionManager.loginFlow(mode, wait);
        if (st.connected) return ok(`✅ LMS 연결 완료\n\n${fmtStatus(st)}`, { status: st });
        return ok([`⏳ 아직 연결되지 않았습니다.`, '', ...guide, '', fmtStatus(st), '', mac ? 'LMS 홈에 수강 과목이 보이면 로그인용 창만 닫은 뒤 get_auth_status 를 실행해 주세요.' : 'LMS 홈이 보인다면 창을 닫지 말고 get_auth_status 를 실행해 주세요.'].join('\n'), { status: st });
      }),
  );

  server.registerTool(
    'get_auth_status',
    {
      title: '연결 상태 확인',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    'open_lms_source',
    {
      title: '로그인된 브라우저로 LMS 원문 열기',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        '공지·과제·강좌·자료·달력의 LMS 원문을 자동화 없는 전용 Chrome/Edge에서 엽니다. 채팅 링크가 로그인되지 않은 내부 브라우저로 열릴 때 사용하세요. ' +
        '같은 LMS의 읽기 화면만 허용하고 민감한 URL 매개변수는 차단합니다. 쿠키·토큰은 URL이나 명령행에 넣지 않으며, 첫 이용 또는 세션 만료 때만 공식 로그인 화면에서 사용자가 직접 인증합니다.',
      inputSchema: {
        url: z.string().url().describe('목록·상세 도구가 반환한 lms.jbnu.ac.kr 원문 URL'),
      },
    },
    async (args) =>
      run('open_lms_source', async () => {
        const opened = await sessionManager.openSource(args.url);
        const lines = [
          `✅ ${opened.browser}의 LMS 전용 ${opened.existingWindow ? '창에 새 탭으로' : '창으로'} 원문을 열었습니다.`,
          `- 열린 주소: ${opened.url}`,
          opened.loginMayBeRequired
            ? '- 최초 원문 보기입니다. 로그인 화면이 나오면 이 전용 창에서 한 번만 공식 통합인증을 완료해 주세요. 이후에는 로그인 상태를 재사용합니다.'
            : '- 저장된 전용 브라우저 로그인 상태를 재사용했습니다. 만료된 경우에만 공식 로그인 화면이 표시됩니다.',
          '- 보안: LMS 읽기 주소만 허용하며 비밀번호·패스키·쿠키·토큰을 전달하지 않습니다.',
          '- 창을 닫으면 비밀번호·자동완성·방문 기록·SSO 쿠키·캐시를 정리하고 LMS 세션만 사용자 계정으로 암호화해 유지합니다.',
        ];
        return ok(lines.join('\n'), { opened });
      }),
  );

  server.registerTool(
    'disconnect_lms',
    {
      title: 'LMS 연결 해제',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: '저장된 LMS 세션(쿠키·토큰)을 삭제합니다. delete_browser_profile=true 면 원문 보기용 전용 브라우저 로그인도 함께 삭제합니다. delete_snapshot=true 면 변경 감지용 로컬 스냅샷도 지웁니다.',
      inputSchema: {
        delete_browser_profile: z.boolean().optional().describe('브라우저 프로필까지 삭제 (기본 false)'),
        delete_snapshot: z.boolean().optional().describe('변경 감지 스냅샷 삭제 (기본 false)'),
      },
    },
    async (args) =>
      run('disconnect_lms', async () => {
        const r = await sessionManager.disconnect({ deleteProfile: args.delete_browser_profile });
        if (args.delete_snapshot) await deps.snapshots.clear();
        const lines = ['🔓 LMS 연결을 해제했습니다.', `- 세션 정보 삭제: ${r.removedSession ? '완료' : '저장된 세션 없음'}`, `- 원문 보기용 브라우저 로그인: ${r.removedProfile ? '삭제 완료' : '유지 또는 저장된 프로필 없음'}`, `- 변경 감지 스냅샷 삭제: ${args.delete_snapshot ? '완료' : '유지'}`];
        return ok(lines.join('\n'), { ...r, removedSnapshot: Boolean(args.delete_snapshot) });
      }),
  );

  // ---------------- 강좌 ----------------

  server.registerTool(
    'list_courses',
    {
      title: '수강 강좌 목록',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: '현재 수강 중인 강좌 목록(ID, 이름, 진행률, URL)을 보여 줍니다. include_all=true 면 종료된 강좌도 포함합니다.',
      inputSchema: { include_all: z.boolean().optional().describe('종료/예정 강좌 포함 여부 (기본 false)') },
    },
    async (args) =>
      run('list_courses', async () => {
        const { courses, notes } = await service.listCourses({ includeAll: args.include_all });
        const st = await status();
        const text = header(st, `수강 강좌 ${courses.length}개`, courses.map((c) => c.source)) + (courses.length ? courses.map(fmtCourse).join('\n') : emptyState(notes, '현재 표시할 강좌가 없습니다. 종료·예정 강좌는 include_all=true로 확인할 수 있습니다.')) + notesBlock(notes);
        return ok(text, { courses, notes });
      }),
  );

  server.registerTool(
    'get_course_overview',
    {
      title: '강좌 개요',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        const body = announcements.length ? announcements.map(fmtAnnouncement).join('\n') : emptyState(notes, args.only_new ? '새로 올라온 공지가 없습니다.' : '표시할 공지가 없습니다.');
        return ok(header(st, `공지사항 ${announcements.length}건`, ['lms_page']) + body + notesBlock(notes) + '\n\n본문을 보려면 get_announcement_detail(board_cm_id, bwid) 를 사용하세요.', { announcements, notes });
      }),
  );

  server.registerTool(
    'get_announcement_detail',
    {
      title: '공지 본문',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        const body = assignments.length ? assignments.map((a) => fmtAssignment(a, now)).join('\n') : emptyState(notes, '표시할 과제가 없습니다.');
        return ok(header(st, `과제 ${assignments.length}건`, assignments.map((a) => a.source)) + body + notesBlock(notes) + '\n\n요구사항 분석은 get_assignment_detail(cm_id) 를 사용하세요.', { assignments, notes });
      }),
  );

  server.registerTool(
    'get_assignment_detail',
    {
      title: '과제 상세·요구사항 분석',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    'check_assignment_submission',
    {
      title: '과제 제출 안심 확인',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: '과제 상세 화면을 다시 읽어 최종 제출·초안·미제출 상태, 제출 파일, 마감 위험을 근거와 함께 확인합니다. LMS를 변경하지 않으며 학교가 발급한 공식 제출 영수증은 아닙니다.',
      inputSchema: {
        cm_id: z.number().int().positive().optional().describe('과제 모듈 ID (URL 의 id=)'),
        url: z.string().url().optional().describe('과제 URL (/mod/assign/view.php?id=..)'),
      },
    },
    async (args) =>
      run('check_assignment_submission', async () => {
        const cmId = args.cm_id ?? withDetailFromUrl(args.url).id;
        if (!cmId) return fail(new (await import('../errors.js')).LmsError('INVALID_INPUT', 'cm_id 또는 url 이 필요합니다'), logger, 'check_assignment_submission');
        const check = await service.checkAssignmentSubmission(cmId);
        const st = await status();
        const verdict = {
          confirmed_submitted: '제출 완료로 확인됨 ✅',
          draft_not_submitted: '초안 상태 — 최종 제출 아님 ❗',
          not_submitted: '미제출 ❗',
          no_submission_required: '별도 제출 불필요',
          unknown: '제출 상태 확인 필요 ⚠️',
        }[check.verdict];
        const lines = [
          `### ${check.title}`,
          `${check.courseName ?? ''} · ${check.sourceUrl}`,
          `- 판정: **${verdict}**`,
          `- 확인 시각: ${formatKo(fromIso(check.verifiedAt))}`,
          `- 마감: ${check.dueAt ? formatKo(fromIso(check.dueAt)) : '설정 없음'} · 최종 차단: ${check.cutoffAt ? formatKo(fromIso(check.cutoffAt)) : '설정 없음'}`,
          `- 제출 파일: ${check.submittedFiles.length ? check.submittedFiles.join(', ') : '표시 없음'}`,
          '',
          '#### 확인 근거',
          ...check.evidence.map((e) => `- ${e}`),
        ];
        if (check.warnings.length) lines.push('', '#### 주의', ...check.warnings.map((w) => `- ${w}`));
        lines.push('', `#### 다음 행동\n${check.nextAction}`, '', `확인 지문: ${check.verificationFingerprint}`, '※ 이 기록은 방금 읽은 LMS 화면의 확인 결과이며 학교가 발급한 공식 제출 영수증은 아닙니다.');
        return ok(header(st, '과제 제출 안심 확인', ['lms_page']) + lines.join('\n'), { submissionCheck: check });
      }),
  );

  server.registerTool(
    'get_upcoming_deadlines',
    {
      title: '다가오는 마감',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        const body = deadlines.length ? order.filter((k) => groups.has(k)).map((k) => `### ${k} (${groups.get(k)!.length})\n${groups.get(k)!.join('\n')}`).join('\n\n') : emptyState(notes, '해당 기간에 확인된 마감이 없습니다.');
        return ok(header(st, `마감 ${deadlines.length}건`, deadlines.map((d) => d.source)) + body + notesBlock(notes), { deadlines, notes });
      }),
  );

  server.registerTool(
    'get_calendar_sync_candidates',
    {
      title: '캘린더 동기화 후보',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'LMS의 구조화된 과제·퀴즈 마감을 캘린더 후보로 정규화합니다. 캘린더에는 아무것도 쓰지 않으며, 연결된 캘린더에서 fingerprint와 제목·시각·원문 URL로 중복을 먼저 확인해야 합니다.',
      inputSchema: {
        days: z.number().int().min(1).max(120).optional().describe('앞으로 며칠까지 후보를 만들지 (기본 30)'),
        course_id: z.number().int().positive().optional().describe('특정 강좌만'),
        include_overdue: z.boolean().optional().describe('지난 마감을 검토 후보로 포함 (기본 false)'),
      },
    },
    async (args) =>
      run('get_calendar_sync_candidates', async () => {
        const { candidates, notes } = await service.getCalendarSyncCandidates({ days: args.days, courseId: args.course_id, includeOverdue: args.include_overdue });
        const st = await status();
        const ready = candidates.filter((c) => c.disposition === 'auto_ready');
        const review = candidates.filter((c) => c.disposition === 'review_required');
        const lines = ['**아직 캘린더에 쓰지 않았습니다.** 연결된 캘린더를 먼저 검색한 뒤 사용자의 현재 요청 또는 저장된 상시 동의 범위에서만 반영하세요.'];
        lines.push('', `### 확정 후보 (${ready.length})`, ...(ready.length ? ready.map(fmtCalendarCandidate) : [emptyState(notes, '자동 반영 가능한 확정 후보가 없습니다.')])) ;
        if (review.length) lines.push('', `### 검토 필요 (${review.length})`, ...review.map(fmtCalendarCandidate));
        lines.push('', '공지 본문에서 추론한 상대 날짜는 이 목록에 자동 포함하지 않습니다.');
        return ok(header(st, `캘린더 후보 ${candidates.length}건`, ['moodle_ajax', 'lms_page']) + lines.join('\n') + notesBlock(notes), { candidates, notes, writePerformed: false });
      }),
  );

  // ---------------- 자료 ----------------

  server.registerTool(
    'get_course_materials',
    {
      title: '수업자료 목록',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        const body = materials.length ? materials.map(fmtMaterial).join('\n') : emptyState(notes, `조건에 맞는 자료가 없습니다. 확인한 섹션: ${sections.join(' / ') || '없음'}`);
        return ok(header(st, `수업자료 ${materials.length}건`, materials.map((m) => m.source)) + body + notesBlock(notes) + '\n\n파일을 받으려면 download_course_material(cm_id 또는 file_url) 을 사용하세요.', { materials, sections, notes });
      }),
  );

  server.registerTool(
    'get_activity_completion',
    {
      title: '활동 이수(완료) 현황',
      description:
        '강좌에서 완료(이수) 추적이 켜진 활동의 이수 여부를 보여 줍니다. 미시청 온라인 강의·미완료 활동을 찾을 때 사용하세요. ' +
        '기본은 미완료만 보여 주며(only_incomplete=false 면 전체), 완료 추적이 설정되지 않은 활동은 제외합니다(미완료로 단정하지 않음). 조회 전용이며 추가 요청 없이 강좌 상태를 재사용합니다.',
      inputSchema: {
        course_id: z.number().int().positive().describe('강좌 ID (get_course_overview·list_courses 로 확인)'),
        only_incomplete: z.boolean().optional().describe('미완료만 보기 (기본 true). false 면 완료 항목도 포함'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run('get_activity_completion', async () => {
        const r = await service.getActivityCompletion({ courseId: args.course_id, onlyIncomplete: args.only_incomplete });
        const st = await status();
        const kindLabel: Record<string, string> = { video: '🎬 영상', file: '📄 자료', folder: '📁 폴더', link: '🔗 링크', page: '📃 페이지', other: '· 활동' };
        const body = r.activities.length
          ? r.activities
              .map((a) => `- ${a.complete ? '✅' : '⬜'} ${kindLabel[a.kind] ?? '· 활동'} **${a.name}** — ${a.sectionTitle}${a.url ? `\n  - 원문: ${a.url}` : ''}`)
              .join('\n')
          : emptyState(r.notes, r.trackedTotal > 0 ? '이수 추적 활동을 모두 완료했습니다. 🎉' : '완료 추적이 설정된 활동이 없습니다.');
        const summary = r.trackedTotal > 0 ? `미완료 ${r.incompleteTotal}건 / 이수추적 ${r.trackedTotal}건` : '이수추적 활동 없음';
        return ok(header(st, `${r.courseName} · ${summary}`, [r.source]) + body + notesBlock(r.notes), { completion: r });
      }),
  );

  server.registerTool(
    'download_course_material',
    {
      title: '수업자료 다운로드',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: '수업자료 파일을 내 PC 의 다운로드 폴더(기본 ~/Downloads/jbnu-lms/<강좌명>/)에 저장하고 경로를 알려 줍니다. cm_id(모듈) 또는 file_url(pluginfile 링크) 중 하나가 필요합니다.',
      inputSchema: {
        cm_id: z.number().int().positive().optional().describe('모듈 ID'),
        file_url: z.string().url().optional().describe('파일 URL (lms.jbnu.ac.kr 의 pluginfile.php 링크)'),
        course_id: z.number().int().positive().optional().describe('강좌 ID (폴더 이름과 모듈 종류 판별에 사용)'),
        target_dir: z.string().optional().describe('저장 하위 폴더 (기본 다운로드 폴더 하위로만 허용, 폴더 밖 경로는 거부)'),
      },
    },
    async (args) =>
      run('download_course_material', async () => {
        const r = await service.downloadMaterial({ cmId: args.cm_id, fileUrl: args.file_url, courseId: args.course_id, targetDir: args.target_dir });
        const st = await status();
        const kb = Math.round(r.bytes / 1024);
        return ok(header(st, r.reusedExisting ? '기존 파일 확인' : '다운로드 완료', ['lms_page']) + [`- 파일: ${r.fileName}`, `- 저장 위치: ${r.path}`, `- 처리: ${r.reusedExisting ? '동일 파일 재사용 — 중복 복사본을 만들지 않음' : '새 파일 저장 완료'}`, `- 크기: ${kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`} · 형식: ${r.contentType ?? '알 수 없음'}`, `- SHA-256: ${r.sha256}`, `- 원본: ${r.sourceUrl}`].join('\n'), { download: r });
      }),
  );

  // ---------------- 변경·브리핑 ----------------

  server.registerTool(
    'get_recent_changes',
    {
      title: '지난 확인 이후 변경 사항',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        if (!c.firstRun && lines.length === 1 && !r.moduleUpdates.length) lines.push('', emptyState(r.notes, '변경 사항이 없습니다.'));
        lines.push('', `스냅샷 저장 시각: ${r.snapshotSavedAt ? formatKo(fromIso(r.snapshotSavedAt)) : '없음'}`);
        return ok(header(st, '변경 사항', ['lms_page', 'moodle_ajax', 'local_snapshot']) + lines.join('\n') + notesBlock(r.notes), { changes: c, moduleUpdates: r.moduleUpdates, snapshotSavedAt: r.snapshotSavedAt, notes: r.notes });
      }),
  );

  server.registerTool(
    'get_attention_inbox',
    {
      title: '놓치면 안 되는 것 확인',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: '마감, 새·수정 공지, 과제 변경, 새 자료와 LMS 변경 기록을 하나의 학생 확인함으로 합쳐 가장 중요한 행동 3개를 먼저 보여 줍니다. 조회 후 로컬 비교 기준만 갱신하며 LMS는 변경하지 않습니다.',
      inputSchema: {
        days: z.number().int().min(1).max(120).optional().describe('마감을 볼 기간 (기본 14일)'),
        course_id: z.number().int().positive().optional().describe('특정 강좌만'),
        update_snapshot: z.boolean().optional().describe('조회 후 로컬 비교 기준 갱신 (기본 true)'),
      },
    },
    async (args) =>
      run('get_attention_inbox', async () => {
        const { inbox, notes, snapshotSavedAt } = await service.getAttentionInbox({ days: args.days, courseId: args.course_id, updateSnapshot: args.update_snapshot });
        const st = await status();
        const lines = [
          `전체 ${inbox.counts.total}건 · 긴급 ${inbox.counts.critical} · 중요 ${inbox.counts.high} · 검토 필요 ${inbox.counts.reviewRequired}`,
          ...(inbox.firstRun ? ['처음 실행이라 변경 비교 기준을 만들었습니다. 현재 마감은 바로 표시하고, 새 공지·자료 비교는 다음 확인부터 정확해집니다.'] : []),
          '',
          `### 지금 할 일 (${inbox.topItems.length})`,
          ...(inbox.topItems.length ? inbox.topItems.map(fmtAttention) : [emptyState(notes, '지금 확인이 필요한 항목이 없습니다.')]),
        ];
        if (inbox.remainingItems.length) lines.push('', `### 나머지 (${inbox.remainingItems.length})`, ...inbox.remainingItems.map(fmtAttention));
        lines.push('', `비교 기준 저장 시각: ${snapshotSavedAt ? formatKo(fromIso(snapshotSavedAt)) : '저장 안 함'}`);
        return ok(header(st, '학생 확인함', ['moodle_ajax', 'lms_page', 'local_snapshot']) + lines.join('\n') + notesBlock(notes), { inbox, notes, snapshotSavedAt });
      }),
  );

  server.registerTool(
    'get_daily_briefing',
    {
      title: '오늘 해야 할 일 브리핑',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        if (!any) lines.push('', emptyState(b.notes, '확인된 마감이 없습니다.'));
        lines.push('', `### 새 공지 (${b.newAnnouncements.length})`, ...(b.newAnnouncements.length ? b.newAnnouncements.map(fmtAnnouncement) : [emptyState(b.notes, '새 공지가 없습니다.')])) ;
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
          if (!d.deadlines.length && !d.suggestedTasks.length) lines.push(`- ${p.notes.some((n) => n.level === 'warn') ? '일부 조회 실패로 마감 미확인' : '확인된 마감 없음'}`);
        }
        if (p.overdue.length) lines.push('', `### 기한 초과 (${p.overdue.length})`, ...p.overdue.map((x) => fmtDeadline(x, now)));
        if (p.nextWeekPreview.length) lines.push('', `### 다음 주 미리보기 (${p.nextWeekPreview.length})`, ...p.nextWeekPreview.map((x) => fmtDeadline(x, now)));
        lines.push('', '### 제안 (AI 추정)', ...(p.suggestions.items.length ? p.suggestions.items.map((s) => `- ${s}`) : ['- 특별한 제안 없음']));
        return ok(header(st, '이번 주 학습 계획', ['moodle_ajax', 'lms_page']) + lines.join('\n') + notesBlock(p.notes), { plan: p });
      }),
  );

  // ---------------- 문제 신고·기능 제안 ----------------

  server.registerTool(
    'report_lms_problem',
    {
      title: 'LMS MCP 문제 신고',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: '이 MCP의 오류나 잘못된 결과를 접수합니다. 호출 전 사용자에게 전송할 요약·상세·진단 ID·기술 정보를 보여 주고 명시적 승인을 받아야 합니다. LMS 로그인정보, 학번, 강좌명, 공지·과제 본문은 보내지 않습니다. 원격 수집 주소가 설정되면 즉시 전송하고 실패하면 로컬에 재시도 대기 상태로 보관합니다.',
      inputSchema: feedbackInputSchema,
    },
    async (args) =>
      run('report_lms_problem', async () => {
        const receipt = await deps.feedback.submit({
          kind: 'problem',
          summary: args.summary,
          details: args.details,
          diagnosticId: args.diagnostic_id,
          affectedTool: args.affected_tool,
          stepsToReproduce: args.steps_to_reproduce,
          expectedBehavior: args.expected_behavior,
          includeTechnicalContext: args.include_technical_context,
        });
        return ok(feedbackReceiptText(receipt), { receipt });
      }),
  );

  server.registerTool(
    'suggest_lms_feature',
    {
      title: 'LMS MCP 기능 제안',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: '새 기능이나 UX 개선 의견을 접수합니다. 호출 전 사용자에게 전송할 내용을 보여 주고 명시적 승인을 받아야 합니다. 개인정보와 LMS 학업 내용은 수집하지 않습니다. 원격 수집 주소가 설정되면 즉시 전송하고 실패하면 로컬에 재시도 대기 상태로 보관합니다.',
      inputSchema: feedbackInputSchema,
    },
    async (args) =>
      run('suggest_lms_feature', async () => {
        const receipt = await deps.feedback.submit({
          kind: 'feature',
          summary: args.summary,
          details: args.details,
          diagnosticId: args.diagnostic_id,
          affectedTool: args.affected_tool,
          stepsToReproduce: args.steps_to_reproduce,
          expectedBehavior: args.expected_behavior,
          includeTechnicalContext: args.include_technical_context,
        });
        return ok(feedbackReceiptText(receipt), { receipt });
      }),
  );

  server.registerTool(
    'get_feedback_status',
    {
      title: '피드백 접수 상태',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: '이 PC에 접수된 문제 신고·기능 제안의 접수 번호와 전송 상태만 보여 줍니다. 신고 본문은 응답에 다시 노출하지 않습니다.',
      inputSchema: {},
    },
    async () =>
      run('get_feedback_status', async () => {
        const feedbackStatus = await deps.feedback.status();
        const lines = [
          '## 피드백 접수 상태',
          `- 수집 방식: ${feedbackStatus.collectorMode === 'remote' ? `원격(${feedbackStatus.collectorOrigin})` : '로컬 보관'}`,
          `- 전체 ${feedbackStatus.total}건 · 전송 완료 ${feedbackStatus.sent}건 · 재시도 대기 ${feedbackStatus.queuedRetry}건 · 로컬 전용 ${feedbackStatus.storedLocal}건`,
          `- 로컬 보관 위치: ${feedbackStatus.storageLocation}`,
          `- 개인정보 보호: ${feedbackStatus.privacy}`,
        ];
        if (feedbackStatus.configurationWarning) lines.push(`- ⚠️ 설정: ${feedbackStatus.configurationWarning}`);
        if (feedbackStatus.reportIds.length) lines.push('', '### 최근 접수', ...feedbackStatus.reportIds.map((r) => `- ${r.reportId} · ${r.kind === 'problem' ? '문제 신고' : '기능 제안'} · ${r.delivery} · ${r.createdAt}`));
        return ok(lines.join('\n'), { status: feedbackStatus });
      }),
  );

  server.registerTool(
    'retry_feedback_delivery',
    {
      title: '피드백 전송 재시도',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: '수집 서버 장애로 로컬 대기 중인 문제 신고·기능 제안을 다시 전송합니다. 새 내용을 만들지 않으며 이미 전송된 보고서는 중복 전송하지 않습니다.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('이번에 재시도할 최대 건수. 기본 20') },
    },
    async (args) =>
      run('retry_feedback_delivery', async () => {
        const result = await deps.feedback.retryQueued(args.limit);
        const text = result.endpointConfigured
          ? `## 피드백 재전송\n- 시도 ${result.attempted}건 · 성공 ${result.sent}건 · 남은 대기 ${result.remaining}건`
          : '## 피드백 재전송\n원격 수집 주소가 설정되지 않아 전송하지 않았습니다. 로컬 접수 내용은 그대로 보관됩니다.';
        return ok(text, { retry: result });
      }),
  );

  server.registerTool(
    'discard_local_feedback',
    {
      title: '로컬 피드백 삭제',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: '접수 번호에 해당하는 이 PC의 피드백 사본을 삭제합니다. 이미 원격 전송된 사본은 삭제되지 않습니다. 실행 전 사용자에게 이 차이를 알리고 명시적으로 확인받아야 합니다.',
      inputSchema: {
        report_id: z.string().regex(/^FB-\d{8}-[A-F0-9]{8}$/).describe('get_feedback_status의 접수 번호'),
        confirm_discard: z.literal(true).describe('로컬 사본 삭제를 사용자가 명시적으로 확인했을 때만 true'),
      },
    },
    async (args) =>
      run('discard_local_feedback', async () => {
        const result = await deps.feedback.discard(args.report_id);
        const lines = [
          result.removed ? `✅ ${args.report_id} 로컬 사본을 삭제했습니다.` : `ℹ️ ${args.report_id} 로컬 사본이 없습니다.`,
          result.remoteCopyMayRemain ? '⚠️ 이 보고서는 이미 원격 전송되어 수집 서버의 사본은 남아 있을 수 있습니다.' : '원격 전송되지 않은 로컬 사본만 처리했습니다.',
        ];
        return ok(lines.join('\n'), { reportId: args.report_id, ...result });
      }),
  );
}
