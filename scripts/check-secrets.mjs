#!/usr/bin/env node
/**
 * 저장소 안에 토큰·쿠키·비밀번호·개인 키가 들어 있지 않은지 검사한다.
 * 사용: node scripts/check-secrets.mjs [경로]
 * 종료 코드 0: 없음, 1: 발견
 */
import fs from 'node:fs';
import path from 'node:path';

const cliArgs = process.argv.slice(2);
const includeDist = cliArgs.includes('--include-dist');
const root = path.resolve(cliArgs.find((arg) => !arg.startsWith('--')) ?? '.');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'browser-profile']);
const SKIP_FILES = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|pdf|dpapi|lock)$/i;
/** 테스트용으로 명백히 가짜인 값 */
const ALLOW = new Set(['0123456789abcdef0123456789abcdef', 'valid-cookie-value', 'testsesskey', 'fixture-login-token']);

const PATTERNS = [
  { name: 'MoodleSession 쿠키', re: /MoodleSession\w*=([A-Za-z0-9]{10,})/g },
  { name: 'PHPSESSID 쿠키', re: /PHPSESSID=([A-Za-z0-9]{10,})/g },
  { name: 'wstoken', re: /wstoken=([a-f0-9]{32})/gi },
  { name: 'Moodle 토큰(32자 hex)', re: /\b([a-f0-9]{32})\b/gi },
  { name: '비밀번호 리터럴', re: /password\s*[:=]\s*["']([^"']{4,})["']/gi },
  { name: '개인 키', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'Bearer 토큰', re: /Bearer\s+([A-Za-z0-9._-]{20,})/g },
  { name: '개인 이메일 의심값', re: /\b([A-Z0-9._%+-]+@(?:jbnu\.ac\.kr|gmail\.com|naver\.com|daum\.net|kakao\.com))\b/gi },
  { name: '한국 휴대전화 번호', re: /(?<!\d)(01[016789][- ]?\d{3,4}[- ]?\d{4})(?!\d)/g },
  { name: '고정 Windows 사용자 경로', re: /(C:\\Users\\(?!<)[A-Za-z0-9._-]+)/gi },
];

const findings = [];
function scan(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const value = m[1] ?? m[0];
      if (ALLOW.has(value)) continue;
      // 정규식 자체나 마스킹 문자열은 제외
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      if (/redacted|\[a-f0-9\]\{32\}|hex32|SECRET_PATTERNS|PATTERNS/.test(line)) continue;
      findings.push({ file: path.relative(root, file), name: p.name });
    }
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) || (includeDist && entry.name === 'dist')) walk(path.join(dir, entry.name));
    } else if (!SKIP_FILES.test(entry.name)) {
      try {
        scan(path.join(dir, entry.name));
      } catch {
        /* 이진 파일 등 무시 */
      }
    }
  }
}

walk(root);
if (findings.length) {
  console.log(`비밀값 의심 항목 ${findings.length}건:`);
  for (const f of findings) console.log(`- ${f.file}: ${f.name}`);
  process.exit(1);
}
console.log(`검사 완료: 비밀값 없음 (${root})`);
