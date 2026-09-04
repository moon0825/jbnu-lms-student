/**
 * 로그인용 전용 브라우저 프로필에서 LMS 호스트 쿠키를 읽는다 (Windows, Chromium 계열).
 *
 * 왜 필요한가: 전북대 LMS 의 MoodleSession 은 만료일 없는 "세션 쿠키"라, Chrome/Edge 를 다시 실행하면
 * 시작 시점에 메모리에서 지워진다. 그래서 로그인 후 브라우저를 headless 로 다시 열어 세션을 확인하는 방식은
 * 세션 쿠키를 잃는다. 대신 브라우저가 닫힌 뒤 프로필의 쿠키 DB(디스크에 남아 있음)에서 값을 직접 읽는다.
 *
 * 범위와 안전장치:
 * - 오직 이 도구가 만든 전용 프로필(config.profileDir)만 읽는다. 사용자의 기본 Chrome 프로필은 건드리지 않는다.
 * - LMS 호스트(config.lmsHost)의 쿠키만 반환한다. 다른 사이트 쿠키는 무시한다.
 * - 복호화한 값은 메모리에서만 쓰고 즉시 DPAPI 로 다시 암호화해 저장한다. 로그에 남기지 않는다.
 * - DPAPI 방식(Local State os_crypt.encrypted_key 접두사 "DPAPI") 만 지원한다. 앱 바운드 암호화(APPB)면
 *   지원하지 않음(UNSUPPORTED)을 던져 호출자가 브라우저 재검증 폴백을 쓰도록 한다.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LmsError } from '../errors.js';

/** node:sqlite 는 Node 22 에서 --experimental-sqlite 플래그가 필요하다. 없으면 UNSUPPORTED 로 폴백. */
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
};
let cachedCtor: DatabaseSyncCtor | null = null;
async function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  if (cachedCtor) return cachedCtor;
  try {
    const mod = (await import('node:sqlite')) as { DatabaseSync: DatabaseSyncCtor };
    cachedCtor = mod.DatabaseSync;
    return cachedCtor;
  } catch (e) {
    throw new LmsError('UNSUPPORTED', 'node:sqlite 를 사용할 수 없습니다(--experimental-sqlite 필요)', { cause: e });
  }
}

function dpapiUnprotect(dataB64: string): Promise<string> {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($d))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => reject(new LmsError('STORAGE', 'DPAPI 복호화 실행 실패', { cause: e })));
    child.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new LmsError('STORAGE', 'DPAPI 복호화 실패', { cause: err.slice(0, 200) }))));
    child.stdin.end(dataB64, 'utf8');
  });
}

async function readAesKey(profileDir: string): Promise<Buffer> {
  const localState = path.join(profileDir, 'Local State');
  let json: { os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string } };
  try {
    json = JSON.parse(fs.readFileSync(localState, 'utf8'));
  } catch (e) {
    throw new LmsError('STORAGE', '브라우저 Local State 를 읽지 못했습니다', { cause: e });
  }
  const encKeyB64 = json.os_crypt?.encrypted_key;
  if (!encKeyB64) throw new LmsError('UNSUPPORTED', '브라우저 쿠키 암호화 키를 찾지 못했습니다');
  const raw = Buffer.from(encKeyB64, 'base64');
  const prefix = raw.slice(0, 5).toString('latin1');
  if (prefix !== 'DPAPI') throw new LmsError('UNSUPPORTED', `지원하지 않는 쿠키 암호화 방식(${prefix})`);
  const keyB64 = await dpapiUnprotect(raw.slice(5).toString('base64'));
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new LmsError('STORAGE', '쿠키 암호화 키 길이가 올바르지 않습니다');
  return key;
}

export function decryptChromiumCookieValue(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length === 0) return null;
  const prefix = encrypted.slice(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    const iv = encrypted.slice(3, 15);
    const tag = encrypted.slice(encrypted.length - 16);
    const ct = encrypted.slice(15, encrypted.length - 16);
    try {
      const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(tag);
      let pt = Buffer.concat([dec.update(ct), dec.final()]);
      // Chrome M24+ 는 평문 앞에 32바이트 도메인 해시를 붙인다. 남은 부분이 인쇄 가능하면 벗겨낸다.
      if (pt.length > 32) {
        const rest = pt.slice(32);
        if (/^[\x20-\x7e]*$/.test(rest.toString('latin1'))) pt = rest;
      }
      return pt.toString('utf8');
    } catch {
      return null;
    }
  }
  // 접두사가 없으면 예전 DPAPI 직접 암호화 형식일 수 있으나, 최신 Chromium 에서는 드물다.
  return null;
}

export interface ExtractedCookies {
  cookies: Record<string, string>;
  scheme: 'dpapi';
}

/**
 * 프로필의 쿠키 DB 를 임시 위치로 복사(브라우저가 잠갔을 수 있으므로)한 뒤 LMS 호스트 쿠키를 복호화한다.
 */
export async function extractLmsCookies(profileDir: string, lmsHost: string): Promise<ExtractedCookies> {
  if (process.platform !== 'win32') throw new LmsError('UNSUPPORTED', '쿠키 직접 읽기는 Windows 에서만 지원합니다');
  const dbPath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(dbPath)) throw new LmsError('AUTH_REQUIRED', '브라우저 쿠키 파일이 없습니다');
  const key = await readAesKey(profileDir);
  const domain = lmsHost.split(':')[0];
  const DatabaseSync = await loadDatabaseSync();
  const tmp = path.join(os.tmpdir(), `jbnu-cookies-${process.pid}-${crypto.randomUUID()}.db`);
  const copies = [
    [dbPath, tmp],
    [`${dbPath}-wal`, `${tmp}-wal`],
    [`${dbPath}-shm`, `${tmp}-shm`],
  ] as const;
  for (const [source, destination] of copies) {
    if (fs.existsSync(source)) fs.copyFileSync(source, destination);
  }
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    const stmt = db.prepare('SELECT host_key AS host, name, encrypted_value AS ev FROM cookies WHERE host_key = ? OR host_key = ?');
    const rows = stmt.all(domain, `.${domain}`) as Array<{ host: string; name: string; ev: Uint8Array }>;
    db.close();
    const cookies: Record<string, string> = {};
    for (const r of rows) {
      const val = decryptChromiumCookieValue(Buffer.from(r.ev), key);
      if (val) cookies[r.name] = val;
    }
    return { cookies, scheme: 'dpapi' };
  } finally {
    for (const [, destination] of copies) fs.rmSync(destination, { force: true });
  }
}

export function hasLmsSessionCookie(cookies: Record<string, string>): boolean {
  return Object.keys(cookies).some((n) => /^MoodleSession/.test(n));
}

/**
 * 로그인 완료 뒤 전용 프로필에서 LMS 이외 쿠키를 안전 삭제한다.
 * SSO access cookie와 아이디 기억 쿠키가 디스크에 남지 않도록 secure_delete와 VACUUM을 사용한다.
 */
export async function purgeNonLmsCookies(profileDir: string, lmsHost: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const dbPath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(dbPath)) return 0;
  const domain = lmsHost.split(':')[0];
  const DatabaseSync = await loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA secure_delete = ON');
    const result = db.prepare('DELETE FROM cookies WHERE host_key <> ? AND host_key <> ?').run(domain, `.${domain}`);
    db.exec('VACUUM');
    return Number(result.changes);
  } finally {
    db.close();
  }
}
