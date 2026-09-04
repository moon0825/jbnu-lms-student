/**
 * 실제 전북대 LMS 에 대한 스모크 테스트. 저장된 세션(jbnu-lms-mcp login)이 필요하다.
 * 실행: JBNU_LIVE=1 npx vitest run tests/live
 * 개인정보 보호를 위해 개수와 성공 여부만 출력한다.
 */
import { describe, expect, it } from 'vitest';
import { buildRuntime } from '../../src/server.js';
import { Logger } from '../../src/logging.js';

const LIVE = process.env.JBNU_LIVE === '1';

describe.runIf(LIVE)('실제 LMS 스모크', () => {
  const runtime = buildRuntime({ logger: new Logger('warn'), env: { ...process.env, JBNU_LMS_AUTO_LOGIN: '0' } });
  const s = runtime.service;
  const report: Record<string, unknown> = {};

  it('세션이 유효하다', async () => {
    const st = await runtime.sessionManager.getStatus({ verify: true });
    report.connected = st.connected;
    expect(st.connected).toBe(true);
  }, 60_000);

  it('강좌 목록', async () => {
    const { courses } = await s.listCourses();
    report.courses = courses.length;
    expect(courses.length).toBeGreaterThan(0);
  }, 60_000);

  it('공지·과제·마감·자료', async () => {
    const { courses } = await s.listCourses();
    const first = courses[0];
    const ann = await s.getAnnouncements({ limit: 50 });
    report.announcements = ann.announcements.length;
    report.announcementNotes = ann.notes.map((n) => n.text.replace(/^[^:]+:/, '강좌:'));
    const asg = await s.getAssignments();
    report.assignments = asg.assignments.length;
    const dl = await s.getUpcomingDeadlines({ days: 60 });
    report.deadlines = dl.deadlines.length;
    const mat = await s.getCourseMaterials({ courseId: first.id });
    report.materials = mat.materials.length;
    report.sections = mat.sections.length;
    if (ann.announcements[0]) {
      const a = ann.announcements[0];
      const bwid = Number(a.id.split(':')[2]);
      const detail = await s.getAnnouncementDetail(a.boardCmId!, bwid);
      report.announcementDetailChars = detail.bodyText?.length ?? 0;
    }
    if (asg.assignments[0]?.cmId) {
      const d = await s.getAssignmentDetail(asg.assignments[0].cmId);
      report.assignmentDetailHasDue = Boolean(d.assignment.dueAt);
      report.assignmentDescChars = d.assignment.descriptionText?.length ?? 0;
    }
    process.stderr.write(`LIVE REPORT ${JSON.stringify(report)}\n`);
    expect(report.sections as number).toBeGreaterThan(0);
  }, 180_000);
});
