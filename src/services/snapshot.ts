/**
 * "지난번 확인 이후 변경된 내용" 을 계산하기 위한 로컬 스냅샷.
 * 제목·마감·상태 같은 메타데이터만 저장하고 본문이나 첨부 내용은 저장하지 않는다.
 * 파일 위치: <dataDir>/state/snapshot.json (사용자 PC 내부, 삭제해도 무방)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Announcement, Assignment, Material } from '../adapters/types.js';

export interface SnapshotAnnouncement { title: string; courseId: number | null; courseName: string | null; createdAt: string | null; modifiedAt: string | null; url: string }
export interface SnapshotAssignment { title: string; courseId: number; courseName: string | null; dueAt: string | null; cutoffAt: string | null; submissionState: string; url: string }
export interface SnapshotMaterial { name: string; courseId: number; courseName: string | null; sectionTitle: string; modName: string; url: string | null; fileCount: number }

export interface Snapshot {
  version: 1;
  savedAt: string | null;
  announcements: Record<string, SnapshotAnnouncement>;
  assignments: Record<string, SnapshotAssignment>;
  materials: Record<string, SnapshotMaterial>;
  /** 강좌별 마지막으로 완전히 조회한 시각 */
  courseCheckedAt: Record<string, string>;
}

export interface ChangeSet {
  since: string | null;
  newAnnouncements: Announcement[];
  updatedAnnouncements: Announcement[];
  newAssignments: Assignment[];
  changedAssignments: Array<{ assignment: Assignment; changes: string[] }>;
  newMaterials: Material[];
  removedAssignments: SnapshotAssignment[];
  firstRun: boolean;
}

export function emptySnapshot(): Snapshot {
  return { version: 1, savedAt: null, announcements: {}, assignments: {}, materials: {}, courseCheckedAt: {} };
}

export class SnapshotStore {
  constructor(private readonly file: string) {}

  get location(): string {
    return this.file;
  }

  async load(): Promise<Snapshot> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Snapshot;
      if (raw.version !== 1) return emptySnapshot();
      return { ...emptySnapshot(), ...raw };
    } catch {
      return emptySnapshot();
    }
  }

  async save(s: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...s, savedAt: new Date().toISOString() }, null, 1), 'utf8');
    await fs.rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

export function diffSnapshot(prev: Snapshot, current: { announcements: Announcement[]; assignments: Assignment[]; materials: Material[] }): ChangeSet {
  const firstRun = prev.savedAt === null;
  const newAnnouncements: Announcement[] = [];
  const updatedAnnouncements: Announcement[] = [];
  for (const a of current.announcements) {
    const old = prev.announcements[a.id];
    if (!old) newAnnouncements.push(a);
    else if (a.modifiedAt && old.modifiedAt && a.modifiedAt !== old.modifiedAt) updatedAnnouncements.push(a);
    else if (old.title !== a.title) updatedAnnouncements.push(a);
  }
  const newAssignments: Assignment[] = [];
  const changedAssignments: ChangeSet['changedAssignments'] = [];
  const seenAssign = new Set<string>();
  for (const a of current.assignments) {
    seenAssign.add(a.id);
    const old = prev.assignments[a.id];
    if (!old) {
      newAssignments.push(a);
      continue;
    }
    const changes: string[] = [];
    if (old.dueAt !== a.dueAt) changes.push(`마감 변경: ${old.dueAt ?? '없음'} → ${a.dueAt ?? '없음'}`);
    if (old.cutoffAt !== a.cutoffAt) changes.push('최종 마감(제출 차단) 변경');
    if (old.submissionState !== a.submissionState && a.submissionState !== 'unknown') changes.push(`제출 상태: ${old.submissionState} → ${a.submissionState}`);
    if (old.title !== a.title) changes.push(`제목 변경: ${old.title} → ${a.title}`);
    if (changes.length) changedAssignments.push({ assignment: a, changes });
  }
  const removedAssignments = Object.entries(prev.assignments)
    .filter(([id, v]) => !seenAssign.has(id) && current.assignments.some((c) => c.courseId === v.courseId))
    .map(([, v]) => v);
  const newMaterials = current.materials.filter((m) => !prev.materials[String(m.cmId)]);
  return { since: prev.savedAt, newAnnouncements, updatedAnnouncements, newAssignments, changedAssignments, newMaterials, removedAssignments, firstRun };
}

export function applyToSnapshot(prev: Snapshot, current: { announcements: Announcement[]; assignments: Assignment[]; materials: Material[] }, checkedCourseIds: number[]): Snapshot {
  const next: Snapshot = { ...prev, announcements: { ...prev.announcements }, assignments: { ...prev.assignments }, materials: { ...prev.materials }, courseCheckedAt: { ...prev.courseCheckedAt } };
  for (const a of current.announcements) {
    next.announcements[a.id] = { title: a.title, courseId: a.courseId, courseName: a.courseName, createdAt: a.createdAt, modifiedAt: a.modifiedAt, url: a.url };
  }
  for (const a of current.assignments) {
    next.assignments[a.id] = { title: a.title, courseId: a.courseId, courseName: a.courseName, dueAt: a.dueAt, cutoffAt: a.cutoffAt, submissionState: a.submissionState, url: a.url };
  }
  for (const m of current.materials) {
    next.materials[String(m.cmId)] = { name: m.name, courseId: m.courseId, courseName: m.courseName, sectionTitle: m.sectionTitle, modName: m.modName, url: m.url, fileCount: m.files.length };
  }
  const now = new Date().toISOString();
  for (const id of checkedCourseIds) next.courseCheckedAt[String(id)] = now;
  return next;
}
