import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../helpers/runtime.js';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('MCP 서버 (mock LMS)', () => {
  it('15개 도구를 등록한다', async () => {
    const tools = await h.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'connect_lms', 'disconnect_lms', 'download_course_material', 'get_announcement_detail', 'get_announcements', 'get_assignment_detail', 'get_assignments',
        'get_auth_status', 'get_course_materials', 'get_course_overview', 'get_daily_briefing', 'get_recent_changes', 'get_upcoming_deadlines', 'get_weekly_study_plan', 'list_courses',
      ].sort(),
    );
    for (const t of tools.tools) expect(t.description).toMatch(/[가-힣]/);
  });

  it('get_auth_status 는 연결 상태를 한국어로 알려준다', async () => {
    const r = await h.callText('get_auth_status', { verify: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('✅ 연결됨');
    expect(r.text).toContain('홍길동');
    expect(r.text).toContain('브라우저 세션 재사용');
  });

  it('list_courses 는 진행 중 강좌만 기본으로 보여준다', async () => {
    const r = await h.callText('list_courses');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('테스트 강좌 A');
    expect(r.text).toContain('테스트 강좌 B');
    expect(r.text).not.toContain('지난 학기 강좌');
    expect(r.text).toContain('Moodle 웹 AJAX API');
    const all = await h.callText('list_courses', { include_all: true });
    expect(all.text).toContain('지난 학기 강좌');
  });

  it('get_course_overview 는 주차별 모듈과 공지 게시판을 보여준다', async () => {
    const r = await h.callText('get_course_overview', { course_id: 101 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('board_cm_id 3001');
    expect(r.text).toContain('### 2주차');
    expect(r.text).toContain('[folder] 2주차 실습 자료');
    expect(r.text).toContain('cm_id 4003');
    expect(r.text).toContain('파일 2개');
    expect(r.text).toContain('숨김/제한');
  });

  it('get_announcements 는 모든 강좌의 공지를 모으고 게시판 없는 강좌를 안내한다', async () => {
    const r = await h.callText('get_announcements');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('📌');
    expect(r.text).toContain('[필독] 중간고사');
    expect(r.text).toContain('bwid 90001');
    expect(r.text).toContain('테스트 강좌 B: 공지사항 게시판(ubboard)을 찾지 못했습니다');
    const s = r.structured as { announcements: Array<{ id: string }> };
    expect(s.announcements.length).toBe(4);
    expect(new Set(s.announcements.map((a) => a.id)).size).toBe(4);
  });

  it('get_announcement_detail 은 본문과 첨부를 보여준다 (url 입력)', async () => {
    const r = await h.callText('get_announcement_detail', { url: `${h.mock.baseUrl}/mod/ubboard/article.php?id=3001&bwid=90001` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('10월 20일(월) 오전 10시');
    expect(r.text).toContain('중간고사_안내.pdf');
    expect(r.text).toContain('테스트 강좌 A');
  });

  it('get_assignments 는 마감·상태·지각 정보를 보여주고 중복을 제거한다', async () => {
    const r = await h.callText('get_assignments');
    expect(r.isError).toBe(false);
    const s = r.structured as { assignments: Array<{ id: string; submissionState: string; title: string }> };
    const ids = s.assignments.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('assign:5001');
    expect(ids).toContain('assign:5000'); // 타임라인에서만 발견된 지난 과제
    expect(s.assignments.find((a) => a.id === 'assign:5002')?.submissionState).toBe('submitted');
    expect(r.text).toContain('제출 완료 ✅');
    expect(r.text).toContain('미제출 ❗');
    expect(r.text).toContain('2026-09-05(토) 23:59');
    const onlyOpen = await h.callText('get_assignments', { include_submitted: false });
    expect(onlyOpen.text).not.toContain('과제 2: 코드 리뷰');
  });

  it('get_assignment_detail 은 원문과 AI 추정을 구분한다', async () => {
    const r = await h.callText('get_assignment_detail', { cm_id: 5001 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('과제 설명(원문)');
    expect(r.text).toContain('AI 추정');
    expect(r.text).toContain('최종 마감(제출 차단): 2026-09-07(월) 23:59 · 지각 제출 가능');
    expect(r.text).toContain('report-template.docx');
    expect(r.text).toContain('개인 과제로 보임');
  });

  it('get_upcoming_deadlines 는 기간별로 나누고 과제·퀴즈를 합친다', async () => {
    const r = await h.callText('get_upcoming_deadlines', { days: 120, include_overdue: true });
    expect(r.isError).toBe(false);
    const s = r.structured as { deadlines: Array<{ id: string; type: string }> };
    expect(s.deadlines.map((d) => d.id)).toContain('quiz:5101');
    expect(s.deadlines.filter((d) => d.id === 'assign:5001')).toHaveLength(1);
    expect(r.text).toMatch(/### (기한 초과|오늘|내일|이번 주|다음 주|그 이후)/);
  });

  it('get_course_materials 는 주차·검색 필터를 지원한다', async () => {
    const r = await h.callText('get_course_materials', { course_id: 101, week: 2 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('2주차 실습 자료');
    expect(r.text).not.toContain('1주차 강의자료');
    expect(r.text).not.toContain('과제 1');
    const q = await h.callText('get_course_materials', { course_id: 101, query: 'lab2' });
    expect(q.text).toContain('lab2.zip');
  });

  it('download_course_material 은 파일을 저장한다', async () => {
    const r = await h.callText('download_course_material', { cm_id: 4001, course_id: 101 });
    expect(r.isError).toBe(false);
    const s = r.structured as { download: { path: string; bytes: number } };
    expect(fs.existsSync(s.download.path)).toBe(true);
    expect(s.download.path).toContain('테스트 강좌 A');
    expect(r.text).toContain('강의자료.pdf');
    const multi = await h.callText('download_course_material', { cm_id: 4003, course_id: 101 });
    expect(multi.isError).toBe(true);
    expect(multi.text).toContain('file_url');
    const byUrl = await h.callText('download_course_material', { file_url: `${h.mock.baseUrl}/pluginfile.php/2003/mod_folder/content/0/lab2.zip`, course_id: 101 });
    expect(byUrl.isError).toBe(false);
  });

  it('get_recent_changes 는 첫 실행에 스냅샷을 만들고 이후 변경을 보고한다', async () => {
    const first = await h.callText('get_recent_changes');
    expect(first.isError).toBe(false);
    expect(first.text).toContain('기준 스냅샷');
    const second = await h.callText('get_recent_changes');
    expect(second.isError).toBe(false);
    expect(second.text).toContain('변경 사항이 없습니다');
    const since = await h.callText('get_recent_changes', { since: '2026-09-02T00:00:00+09:00', update_snapshot: false });
    expect(since.text).toContain('3주차 발표 조 편성 안내');
    expect(since.text).toContain('모듈 업데이트');
  });

  it('get_daily_briefing 과 get_weekly_study_plan 이 동작한다', async () => {
    const d = await h.callText('get_daily_briefing');
    expect(d.isError).toBe(false);
    expect(d.text).toContain('오늘의 브리핑');
    expect(d.text).toContain('제안 (AI 추정)');
    const w = await h.callText('get_weekly_study_plan');
    expect(w.isError).toBe(false);
    expect(w.text).toContain('이번 주 학습 계획');
    expect(w.text).toContain('← 오늘');
  });

  it('세션이 만료되면 자연스러운 한국어 안내를 돌려준다', async () => {
    h.mock.sessionValid = false;
    h.runtime.cache.clear();
    const r = await h.callText('list_courses');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('세션이 만료');
    expect(r.text).toContain('해결 방법');
    expect(r.text).not.toMatch(/AUTH_EXPIRED|invalidsesskey|servicerequireslogin/);
    const st = await h.callText('get_auth_status', { verify: true });
    expect(st.text).toMatch(/만료/);
    h.mock.sessionValid = true;
  });

  it('disconnect_lms 는 세션을 지우고 이후 로그인 안내를 준다', async () => {
    const r = await h.callText('disconnect_lms', { delete_snapshot: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('연결을 해제');
    const list = await h.callText('list_courses');
    expect(list.isError).toBe(true);
    expect(list.text).toContain('로그인이 필요');
    expect(list.text).toContain('connect_lms');
  });
});

describe('로그인되지 않은 상태', () => {
  let h2: TestHarness;
  beforeAll(async () => {
    h2 = await createHarness({ loggedIn: false });
  });
  afterAll(async () => {
    await h2.close();
  });
  it('상태와 도구가 로그인 안내를 준다', async () => {
    const st = await h2.callText('get_auth_status');
    expect(st.text).toContain('❌ 연결 안 됨');
    expect(st.text).toContain('connect_lms');
    const r = await h2.callText('get_daily_briefing');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('LMS 로그인이 필요합니다');
  });
});
