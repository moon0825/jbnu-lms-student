import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAssignIndex, parseAssignView, classifySubmissionText } from '../../src/parsers/assign.js';
import { parseCoursePage } from '../../src/parsers/course-page.js';
import { parseFileLinks, parseManageTokens, parseMyCourses } from '../../src/parsers/misc.js';
import { parsePageMeta } from '../../src/parsers/page-meta.js';
import { parseUbboardArticle, parseUbboardList } from '../../src/parsers/ubboard.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');
const BASE = 'http://localhost';

describe('page-meta', () => {
  it('로그인된 페이지에서 sesskey, userId, 이름을 읽는다', () => {
    const m = parsePageMeta(read('my-page.html'));
    expect(m.loggedIn).toBe(true);
    expect(m.sesskey).toBe('testsesskey');
    expect(m.userId).toBe(12345);
    expect(m.displayName).toBe('홍길동');
    expect(m.isLoginPage).toBe(false);
  });
  it('로그인 페이지를 구분한다', () => {
    const m = parsePageMeta(read('login-page.html'));
    expect(m.isLoginPage).toBe(true);
    expect(m.loggedIn).toBe(false);
  });
});

describe('ubboard list', () => {
  it('공지 목록의 고정글·새 글·첨부·날짜를 해석한다', () => {
    const page = parseUbboardList(read('ubboard-list.html'), BASE, `${BASE}/mod/ubboard/view.php?id=3001`);
    expect(page.cmId).toBe(3001);
    expect(page.boardTitle).toBe('공지사항');
    expect(page.items).toHaveLength(4);
    const pinned = page.items[0];
    expect(pinned.isPinned).toBe(true);
    expect(pinned.bwid).toBe(90001);
    expect(pinned.title).toContain('중간고사');
    expect(pinned.hasAttachment).toBe(true);
    expect(pinned.author).toBe('담당 교수');
    expect(pinned.createdAt).toMatch(/^2026-09-01T00:00:00\.000\+09:00$/);
    expect(pinned.modifiedAt).toMatch(/^2026-09-02/);
    expect(pinned.views).toBe(120);
    const fresh = page.items[1];
    expect(fresh.isNew).toBe(true);
    expect(fresh.isPinned).toBe(false);
    expect(fresh.number).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(page.currentPage).toBe(1);
  });
});

describe('ubboard article', () => {
  it('제목·작성자·본문·첨부를 해석하고 본문 이미지는 첨부로 세지 않는다', () => {
    const a = parseUbboardArticle(read('ubboard-article.html'), BASE, `${BASE}/mod/ubboard/article.php?id=3001&bwid=90001`);
    expect(a.title).toBe('[필독] 중간고사 일정 및 유의사항 안내');
    expect(a.author).toBe('담당 교수');
    expect(a.createdAt).toMatch(/^2026-09-01T14:05/);
    expect(a.views).toBe(120);
    expect(a.bodyText).toContain('10월 20일(월) 오전 10시');
    expect(a.bodyText).toContain('- 지참물: 신분증, 필기구');
    expect(a.attachments).toHaveLength(1);
    expect(a.attachments[0].name).toBe('중간고사_안내.pdf');
    expect(a.bwid).toBe(90001);
  });
});

describe('course page', () => {
  it('섹션·모듈·공지 게시판을 찾는다', () => {
    const c = parseCoursePage(read('course-view.html'), BASE);
    expect(c.courseId).toBe(101);
    expect(c.title).toBe('테스트 강좌 A');
    expect(c.noticeBoardCmId).toBe(3001);
    expect(c.sections.map((s) => s.title)).toEqual(['강좌 개요', '1주차 (9월 1일 - 9월 7일)', '2주차 (9월 8일 - 9월 14일)']);
    const week2 = c.sections[2];
    const folder = week2.modules.find((m) => m.cmId === 4003)!;
    expect(folder.modName).toBe('folder');
    expect(folder.files.map((f) => f.name)).toEqual(['lab2.zip', 'lab2-guide.pdf']);
    const assign = week2.modules.find((m) => m.cmId === 5001)!;
    expect(assign.modName).toBe('assign');
    expect(assign.dates[0]).toEqual({ label: '마감', at: '2026-09-05T23:59:00.000+09:00' });
    const link = week2.modules.find((m) => m.cmId === 4004)!;
    expect(link.visible).toBe(false);
    expect(link.availabilityText).toContain('9월 8일부터');
    expect(c.sections[1].modules[0].name).toBe('1주차 강의자료');
  });
});

describe('assign', () => {
  it('과제 목록 표를 해석한다', () => {
    const rows = parseAssignIndex(read('assign-index.html'), BASE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ cmId: 5001, title: '과제 1: 보고서', sectionTitle: '2주차', submissionStatusText: '제출 안 함' });
    expect(rows[0].dueAt).toBe('2026-09-05T23:59:00.000+09:00');
    expect(rows[1].sectionTitle).toBe('2주차');
    expect(rows[1].gradeText).toBe('95.00 / 100.00');
    expect(classifySubmissionText(rows[1].submissionStatusText)).toBe('submitted');
    expect(classifySubmissionText(rows[0].submissionStatusText)).toBe('not_submitted');
  });
  it('과제 상세 화면을 해석한다', () => {
    const v = parseAssignView(read('assign-view.html'), BASE, `${BASE}/mod/assign/view.php?id=5001`);
    expect(v.cmId).toBe(5001);
    expect(v.courseId).toBe(101);
    expect(v.title).toBe('과제 1: 보고서');
    expect(v.dueAt).toBe('2026-09-05T23:59:00.000+09:00');
    expect(v.cutoffAt).toBe('2026-09-07T23:59:00.000+09:00');
    expect(v.allowSubmissionsFromAt).toBe('2026-08-25T09:00:00.000+09:00');
    expect(v.submissionState).toBe('not_submitted');
    expect(v.gradingStatusText).toBe('채점되지 않음');
    expect(v.timeRemainingText).toBe('1일 13시간');
    expect(v.descriptionText).toContain('A4 5페이지 이내');
    expect(v.attachments.map((f) => f.name)).toEqual(['report-template.docx']);
    expect(v.submittedFiles).toHaveLength(0);
  });
});

describe('misc parsers', () => {
  it('폴더 화면의 파일 링크를 찾는다', () => {
    const files = parseFileLinks(read('folder-view.html'), BASE);
    expect(files.map((f) => f.name)).toEqual(['lab2.zip', 'lab2-guide.pdf']);
    expect(files[0].url).not.toMatch(/forcedownload/);
  });
  it('나의 강좌 링크를 찾는다', () => {
    const courses = parseMyCourses(read('my-page.html'), BASE);
    expect(courses.map((c) => c.id)).toEqual([101, 102]);
    expect(courses[0].fullName).toBe('테스트 강좌 A');
  });
  it('토큰 관리 화면에서 모바일 토큰을 찾는다', () => {
    const tokens = parseManageTokens(read('managetoken.html'));
    expect(tokens).toHaveLength(1);
    expect(tokens[0].service).toContain('moodle_mobile_app');
    expect(tokens[0].token).toHaveLength(32);
  });
});
