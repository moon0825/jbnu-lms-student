import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLoginBrowserArgs, classifyLoginHistoryEntry, classifyLoginWindowTitle, prepareProfile, PROFILE_MARKER, removeDedicatedLoginProfile, scrubReusableBrowserProfile, validateLmsSourceUrl } from '../../src/auth/browser-login.js';
import { decryptChromiumCookieValue, hasLmsSessionCookie } from '../../src/auth/chrome-cookies.js';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function encryptedV10(value: string, key: Buffer, withDomainHash = true): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = withDomainHash
    ? Buffer.concat([crypto.createHash('sha256').update('lms.jbnu.ac.kr').digest(), Buffer.from(value)])
    : Buffer.from(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), iv, ciphertext, cipher.getAuthTag()]);
}

describe('Chrome cookie extraction primitives', () => {
  it('decrypts a v10 AES-GCM cookie and removes the Chromium domain hash', () => {
    const key = crypto.randomBytes(32);
    expect(decryptChromiumCookieValue(encryptedV10('session-value', key), key)).toBe('session-value');
  });

  it('rejects unsupported app-bound cookie versions instead of guessing', () => {
    expect(decryptChromiumCookieValue(Buffer.from('v20-not-supported'), crypto.randomBytes(32))).toBeNull();
  });

  it('recognizes Moodle session cookie variants only by name', () => {
    expect(hasLmsSessionCookie({ MoodleSession: 'x' })).toBe(true);
    expect(hasLmsSessionCookie({ MoodleSessionjbnu: 'x' })).toBe(true);
    expect(hasLmsSessionCookie({ WMONID: 'x' })).toBe(false);
  });

  it('disables credential storage and removes stale autofill databases', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-profile-'));
    temporary.push(profile);
    const defaultDir = path.join(profile, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'Login Data'), 'stale');
    fs.writeFileSync(path.join(defaultDir, 'Web Data'), 'stale');
    fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify({ custom: { keep: true } }));

    prepareProfile(profile);

    expect(fs.existsSync(path.join(defaultDir, 'Login Data'))).toBe(false);
    expect(fs.existsSync(path.join(defaultDir, 'Web Data'))).toBe(false);
    const prefs = JSON.parse(fs.readFileSync(path.join(defaultDir, 'Preferences'), 'utf8'));
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile.password_manager_enabled).toBe(false);
    expect(prefs.custom.keep).toBe(true);
  });

  it('keeps only the browser state needed for LMS source viewing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-profile-root-'));
    temporary.push(root);
    const profile = path.join(root, 'browser-profile');
    prepareProfile(profile);
    const defaultDir = path.join(profile, 'Default');
    const networkDir = path.join(defaultDir, 'Network');
    fs.mkdirSync(path.join(defaultDir, 'Cache'), { recursive: true });
    fs.mkdirSync(networkDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'History'), 'visited pages');
    fs.writeFileSync(path.join(defaultDir, 'Login Data'), 'credential artifact');
    fs.writeFileSync(path.join(defaultDir, 'Cache', 'entry'), 'cached page');
    fs.writeFileSync(path.join(networkDir, 'Cookies'), 'encrypted LMS cookies');

    scrubReusableBrowserProfile(profile);

    expect(fs.existsSync(path.join(defaultDir, 'History'))).toBe(false);
    expect(fs.existsSync(path.join(defaultDir, 'Login Data'))).toBe(false);
    expect(fs.existsSync(path.join(defaultDir, 'Cache'))).toBe(false);
    expect(fs.readFileSync(path.join(networkDir, 'Cookies'), 'utf8')).toBe('encrypted LMS cookies');
    expect(fs.existsSync(path.join(profile, PROFILE_MARKER))).toBe(true);
  });

  it('allows only sanitized read-only LMS source URLs', () => {
    const url = validateLmsSourceUrl(
      'https://lms.jbnu.ac.kr',
      'https://lms.jbnu.ac.kr/mod/ubboard/article.php?keyfield&keyword=private&id=84728&bwid=34745&page=1#reply',
    );
    expect(url).toBe('https://lms.jbnu.ac.kr/mod/ubboard/article.php?id=84728&bwid=34745&page=1');
    expect(() => validateLmsSourceUrl('https://lms.jbnu.ac.kr', 'https://example.com/mod/assign/view.php?id=1')).toThrow(/동일한 출처/);
    expect(() => validateLmsSourceUrl('https://lms.jbnu.ac.kr', 'https://lms.jbnu.ac.kr/login/logout.php?sesskey=secret')).toThrow();
    expect(() => validateLmsSourceUrl('https://lms.jbnu.ac.kr', 'https://lms.jbnu.ac.kr/mod/assign/view.php?id=1&action=delete')).toThrow(/민감하거나 상태를 변경/);
    expect(() => validateLmsSourceUrl('https://lms.jbnu.ac.kr', 'https://lms.jbnu.ac.kr/mod/lti/view.php?id=1')).toThrow(/읽기 화면/);
    expect(validateLmsSourceUrl('https://lms.jbnu.ac.kr', 'https://lms.jbnu.ac.kr/my/?redirect=https://example.com')).toBe('https://lms.jbnu.ac.kr/my/');
  });

  it('marks and securely removes only the disposable login profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-profile-root-'));
    temporary.push(root);
    const profile = path.join(root, 'browser-profile');
    prepareProfile(profile);

    expect(fs.existsSync(path.join(profile, PROFILE_MARKER))).toBe(true);
    expect(removeDedicatedLoginProfile(profile)).toBe(true);
    expect(fs.existsSync(profile)).toBe(false);
  });

  it('refuses to recursively remove an unmarked directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-profile-root-'));
    temporary.push(root);
    const profile = path.join(root, 'browser-profile');
    fs.mkdirSync(profile);

    expect(() => removeDedicatedLoginProfile(profile)).toThrow(/표식/);
    expect(fs.existsSync(profile)).toBe(true);
  });

  it('allows the passkey popup without enabling browser automation', () => {
    const args = buildLoginBrowserArgs('C:\\app\\browser-profile', 'https://lms.jbnu.ac.kr/my/');
    expect(args).toContain('--disable-popup-blocking');
    expect(args).toContain('--restore-last-session');
    expect(args.some((arg) => arg.includes('remote-debugging'))).toBe(false);
    expect(args.at(-1)).toBe('https://lms.jbnu.ac.kr/my/');
  });

  it('classifies only the real JBNU LXP screen as authenticated', () => {
    expect(classifyLoginWindowTitle('사이트에 로그인 | JBNU LXP - Chrome')).toBe('authentication');
    expect(classifyLoginWindowTitle('전북대학교 로그인 - Chrome')).toBe('authentication');
    expect(classifyLoginWindowTitle('패스키 인증 로그인 - Chrome')).toBe('authentication');
    expect(classifyLoginWindowTitle('대시보드 | JBNU LXP - Chrome')).toBe('authenticated-lms');
    expect(classifyLoginWindowTitle('홈 | JBNU LXP - Chrome')).toBe('lms-home');
    expect(classifyLoginWindowTitle('전북대학교 포털시스템 - Chrome')).toBe('authenticated-portal');
    expect(classifyLoginWindowTitle('')).toBe('unknown');
  });

  it('classifies only host and path from dedicated-profile history', () => {
    expect(classifyLoginHistoryEntry('https://portal.jbnu.ac.kr/index.jsp', '전북대학교 포털시스템')).toBe('authenticated-portal');
    expect(classifyLoginHistoryEntry('https://sso.jbnu.ac.kr/jbnu/PasskeyLoginAuthPage.eps', '패스키 인증 로그인')).toBe('authentication');
    expect(classifyLoginHistoryEntry('https://lms.jbnu.ac.kr/login/index.php', '사이트에 로그인 | JBNU LXP')).toBe('authentication');
    expect(classifyLoginHistoryEntry('https://lms.jbnu.ac.kr/my/?redirect=0', '대시보드 | JBNU LXP')).toBe('authenticated-lms');
  });
});
