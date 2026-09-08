#!/usr/bin/env node
/**
 * 명령행 진입점.
 *   jbnu-lms-mcp serve            MCP STDIO 서버 (기본)
 *   jbnu-lms-mcp login [--plain] [--wait 300]
 *   jbnu-lms-mcp status [--verify]
 *   jbnu-lms-mcp logout [--delete-profile]
 *   jbnu-lms-mcp doctor
 *   jbnu-lms-mcp config [--client claude|codex|json] [--write]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './auth/browser-login.js';
import { clientConfigSnippets, localServerDefinition, packageServerDefinition, upsertCodexMcpServer, type ClientName } from './client-config.js';
import { APP_NAME, APP_VERSION } from './config.js';
import { formatUserError, toLmsError } from './errors.js';
import { buildRuntime, serveStdio } from './server.js';
import { fmtStatus } from './tools/format.js';
import { fromIso, nowSeoul, relativeKo } from './time.js';

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function distEntry(): string {
  const here = fileURLToPath(import.meta.url);
  // src/cli.ts (tsx) 또는 dist/cli.js
  const root = path.resolve(path.dirname(here), '..');
  return path.join(root, 'dist', 'cli.js');
}

function configSnippets(runtime: 'local' | 'package' = 'local'): { claude: Record<string, unknown>; codex: string; json: Record<string, unknown> } {
  const entry = distEntry();
  const serverDef = runtime === 'package'
    ? packageServerDefinition(APP_NAME, APP_VERSION)
    : localServerDefinition(entry);
  const { claude, codex } = clientConfigSnippets(serverDef);
  return { claude, codex, json: claude };
}

/** node:sqlite(쿠키 복구용)가 없으면 --experimental-sqlite 를 붙여 한 번만 재실행한다. */
async function ensureSqlite(): Promise<void> {
  if (process.env.__JBNU_REEXEC === '1') return;
  if (process.execArgv.includes('--experimental-sqlite')) return;
  const { spawnSync } = await import('node:child_process');
  const here = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-sqlite', here, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, __JBNU_REEXEC: '1' },
  });
  process.exit(r.status ?? 0);
}

async function cmdLogin(): Promise<number> {
  const rt = buildRuntime();
  const mode = flag('--plain') ? 'plain' : flag('--assisted') ? 'assisted' : rt.loginMode;
  const waitSec = Number.parseInt(opt('--wait') ?? '', 10) || 300;
  out(`전북대 LMS 로그인용 브라우저를 엽니다 (${mode === 'assisted' ? '완료 자동 감지' : '일반 브라우저'} 방식).`);
  if (mode === 'plain') out('로그인이 끝나 LMS 홈이 보이면 창을 닫지 말고 잠시 기다려 주세요. 세션을 보존해 저장한 뒤 전용 창이 자동으로 닫힙니다.');
  out('중요: 통합로그인의 세 번째 "아이디 로그인" 탭을 선택해 아이디·비밀번호로 1차 인증하세요.');
  out('그 다음 2차 인증 화면에서 "패스키"를 선택해 완료하세요. 두 번째 "패스키 인증 로그인" 탭을 누르는 경로와는 다릅니다.');
  out('실제 LMS 홈 또는 강좌 화면이 뜨면 그대로 두세요. 연결 저장 뒤 전용 창이 자동으로 닫힙니다. 이 프로그램은 입력한 인증 정보를 읽거나 저장하지 않습니다.');
  try {
    const st = await rt.sessionManager.loginFlow(mode, waitSec * 1000);
    out();
    out(fmtStatus(st));
    return st.connected ? 0 : 2;
  } catch (e) {
    out(formatUserError(e, { operation: 'LMS 로그인' }));
    return 1;
  }
}

/** 이미 로그인된 전용 프로필에서 세션만 검증·저장한다 (브라우저를 새로 열지 않음). */
async function cmdVerify(): Promise<number> {
  const rt = buildRuntime();
  try {
    const st = await rt.sessionManager.completeLogin();
    out(fmtStatus(st));
    return st.connected ? 0 : 2;
  } catch (e) {
    out(formatUserError(e, { operation: '로그인 세션 저장' }));
    return 1;
  }
}

async function cmdStatus(): Promise<number> {
  const rt = buildRuntime();
  try {
    const st = await rt.sessionManager.getStatus({ verify: flag('--verify') });
    out(fmtStatus(st));
    return st.connected ? 0 : 2;
  } catch (e) {
    out(formatUserError(e, { operation: 'LMS 연결 상태 확인' }));
    return 1;
  }
}

/**
 * 예약 실행용 브리핑. 세션이 만료돼도 로그인 창을 열지 않는다(background 모드).
 * Windows 작업 스케줄러 등에서 매일 아침 실행해 오늘 마감·새 공지를 요약한다.
 *   jbnu-lms-mcp brief [--weekly] [--days N] [--json] [--quiet-if-empty] [--out FILE]
 */
async function cmdBrief(): Promise<number> {
  const rt = buildRuntime();
  const weekly = flag('--weekly');
  const asJson = flag('--json');
  const quietIfEmpty = flag('--quiet-if-empty');
  const outFile = opt('--out');
  const days = Number.parseInt(opt('--days') ?? '', 10) || undefined;
  const now = nowSeoul();
  const emit = (text: string): void => {
    if (outFile) fs.writeFileSync(outFile, `${text}\n`, 'utf8');
    else out(text);
  };
  try {
    await rt.sessionManager.load();
    let text: string;
    let empty: boolean;
    let payload: unknown;
    if (weekly) {
      const p = await rt.service.getWeeklyStudyPlan({ background: true });
      const dueDays = p.days.filter((d) => d.deadlines.length);
      empty = dueDays.length === 0 && p.overdue.length === 0;
      const lines = [`📅 이번 주 학습 계획 (${p.weekStart} ~ ${p.weekEnd})`];
      if (p.overdue.length) lines.push(`❗ 기한 초과 ${p.overdue.length}건: ${p.overdue.map((d) => d.title).join(', ')}`);
      for (const d of dueDays) lines.push(`- ${d.label}: ${d.deadlines.map((x) => x.title).join(', ')}`);
      if (empty) lines.push('이번 주 확인된 마감이 없습니다.');
      text = lines.join('\n');
      payload = p;
    } else {
      const b = await rt.service.getDailyBriefing({ days, background: true });
      const order: Array<[keyof typeof b.buckets, string]> = [['overdue', '❗ 기한 초과'], ['today', '🔴 오늘'], ['tomorrow', '🟠 내일'], ['this_week', '🔵 이번 주']];
      const sections: string[] = [];
      for (const [k, label] of order) {
        const items = b.buckets[k];
        if (!items.length) continue;
        sections.push(`${label} (${items.length})`);
        for (const d of items) sections.push(`  - ${d.title}${d.courseName ? ` · ${d.courseName}` : ''} — ${relativeKo(fromIso(d.dueAt), now)}`);
      }
      const newCount = b.newAnnouncements.length;
      empty = sections.length === 0 && newCount === 0;
      const lines = [`🎓 전북대 LMS 브리핑 · ${b.todayLabel}`];
      if (sections.length) lines.push(...sections);
      if (newCount) lines.push(`🆕 새 공지 ${newCount}건: ${b.newAnnouncements.slice(0, 5).map((a) => a.title).join(', ')}`);
      if (empty) lines.push('오늘 처리할 마감·새 공지가 없습니다.');
      text = lines.join('\n');
      payload = b;
    }
    if (empty && quietIfEmpty) return 0;
    emit(asJson ? JSON.stringify(payload, null, 2) : text);
    return 0;
  } catch (e) {
    const err = toLmsError(e);
    if (err.kind === 'AUTH_REQUIRED' || err.kind === 'AUTH_EXPIRED') {
      if (!quietIfEmpty) emit('⚠️ LMS 세션이 없거나 만료되었습니다. 한 번 로그인해 주세요: jbnu-lms-mcp login --plain (예약 실행은 로그인 창을 열지 않습니다).');
      return 2;
    }
    emit(formatUserError(e, { operation: '브리핑 생성' }));
    return 1;
  }
}

async function cmdLogout(): Promise<number> {
  const rt = buildRuntime();
  try {
    const r = await rt.sessionManager.disconnect({ deleteProfile: flag('--delete-profile') });
    if (flag('--delete-snapshot')) await rt.snapshots.clear();
    out(`세션 삭제: ${r.removedSession ? '완료' : '없음'} · 브라우저 프로필 삭제: ${r.removedProfile ? '완료' : '유지'}`);
    return 0;
  } catch (e) {
    out(formatUserError(e, { operation: 'LMS 연결 해제', impact: '로컬 연결 정보가 일부 정리되었을 수 있습니다. LMS 원본 데이터는 변경되지 않았습니다.' }));
    return 1;
  }
}

async function cmdDoctor(): Promise<number> {
  const rt = buildRuntime();
  const checks: Array<[string, boolean | null, string]> = [];
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  checks.push(['Node.js 22 이상', nodeOk, process.versions.node]);
  const browser = findBrowser(rt.config.browserPreference);
  checks.push(['Chrome/Edge 브라우저', Boolean(browser), browser ? `${browser.displayName} (${browser.path})` : 'JBNU_LMS_BROWSER 로 경로 지정 가능']);
  checks.push(['DPAPI 저장소', process.platform === 'win32', process.platform === 'win32' ? rt.config.sessionFile : '이 플랫폼은 평문 파일 저장(경고)']);
  try {
    const res = await fetch(`${rt.config.baseUrl}/lib/ajax/service.php?info=tool_mobile_get_public_config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as Array<{ error: boolean; data?: { sitename?: string; typeoflogin?: number; enablemobilewebservice?: number } }>;
    const d = body?.[0]?.data;
    checks.push(['LMS 접속', res.ok && Boolean(d), d ? `${d.sitename} · 모바일 웹서비스 ${d.enablemobilewebservice ? '켜짐' : '꺼짐'} · 로그인 유형 ${d.typeoflogin}` : `HTTP ${res.status}`]);
  } catch (e) {
    checks.push(['LMS 접속', false, (e as Error).message]);
  }
  await rt.sessionManager.load();
  const st = await rt.sessionManager.getStatus({ verify: false });
  checks.push(['저장된 세션', st.connected ? true : null, st.message]);
  const feedback = await rt.feedback.status();
  checks.push([
    '피드백 수집',
    feedback.configurationWarning ? false : feedback.collectorMode === 'remote' ? true : null,
    feedback.configurationWarning ?? (feedback.collectorMode === 'remote' ? `HTTPS 원격 수집기 ${feedback.collectorOrigin}` : '로컬 접수 모드(원격 URL 선택 사항)'),
  ]);
  checks.push(['데이터 폴더', fs.existsSync(rt.config.dataDir) || true, rt.config.dataDir]);
  for (const [name, okv, detail] of checks) out(`${okv === true ? '✅' : okv === null ? '➖' : '❌'} ${name}: ${detail}`);
  return checks.some(([, v]) => v === false) ? 1 : 0;
}

function isClientName(value: string): value is ClientName {
  return value === 'claude' || value === 'codex';
}

async function writeClientConfig(client: ClientName, runtime: 'local' | 'package'): Promise<void> {
  const s = configSnippets(runtime);
  if (client === 'codex') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existing) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    fs.writeFileSync(file, upsertCodexMcpServer(existing, 'jbnu-lms', s.codex), 'utf8');
    out(`✅ Codex 연결 설정 완료${existing ? ' (기존 설정 백업)' : ''}`);
    return;
  }

  const file = process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json') : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const existed = fs.existsSync(file);
  let json: Record<string, unknown> = {};
  if (existed) {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  }
  const servers = (json.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers['jbnu-lms'] = (s.claude.mcpServers as Record<string, unknown>)['jbnu-lms'];
  json.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
  out(`✅ Claude Desktop 연결 설정 완료${existed ? ' (기존 설정 백업)' : ''}`);
}

async function cmdConfig(): Promise<number> {
  const client = opt('--client') ?? 'claude';
  if (!isClientName(client)) {
    out('지원하는 클라이언트는 codex 또는 claude 입니다.');
    return 1;
  }
  const runtime = flag('--package') ? 'package' : 'local';
  const s = configSnippets(runtime);
  out(client === 'codex' ? s.codex : JSON.stringify(s.claude, null, 2));
  if (flag('--write')) await writeClientConfig(client, runtime);
  return 0;
}

async function cmdSetup(): Promise<number> {
  const client = opt('--client') ?? 'codex';
  if (!isClientName(client)) {
    out('설치 대상은 codex 또는 claude 중 하나를 선택해 주세요.');
    out(`예: npx -y ${APP_NAME}@latest setup --client codex`);
    return 1;
  }

  out(`\n🎓 전북대 LMS 학업비서 ${APP_VERSION}`);
  out('폴더 설치 없이 이 PC의 MCP 설정을 안전하게 연결합니다.');
  out('기존 설정 파일이 있으면 먼저 백업합니다.\n');

  const doctor = await cmdDoctor();
  if (doctor !== 0) {
    out('\n환경 점검을 먼저 해결한 뒤 같은 명령을 다시 실행해 주세요.');
    return doctor;
  }

  await writeClientConfig(client, 'package');
  if (flag('--skip-login')) {
    out(`\n설정이 끝났습니다. ${client === 'codex' ? 'Codex' : 'Claude Desktop'}를 완전히 종료한 뒤 다시 실행하세요.`);
    return 0;
  }

  out('\n이제 로그인 창이 열립니다. 비밀번호·패스키·2차 인증은 브라우저에서 직접 완료하세요.');
  const login = await cmdLogin();
  if (login === 0) {
    out(`\n✅ 설치와 로그인이 끝났습니다. ${client === 'codex' ? 'Codex' : 'Claude Desktop'}를 완전히 종료한 뒤 다시 실행하세요.`);
  }
  return login;
}

async function main(): Promise<void> {
  await ensureSqlite();
  const cmd = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'serve';
  if (flag('--version') || cmd === 'version') {
    out(`${APP_NAME} ${APP_VERSION}`);
    return;
  }
  if (cmd === 'help' || flag('--help')) {
    out(`${APP_NAME} ${APP_VERSION}\n\n사용법:\n  jbnu-lms-mcp setup --client codex|claude  한 번에 연결하고 로그인\n  jbnu-lms-mcp serve                     MCP STDIO 서버 실행 (기본)\n  jbnu-lms-mcp login [--plain] [--wait N]  브라우저로 LMS 로그인\n  jbnu-lms-mcp status [--verify]           연결 상태\n  jbnu-lms-mcp verify                      로그인한 브라우저 프로필에서 세션만 검증·저장\n  jbnu-lms-mcp brief [--weekly] [--days N] [--json] [--quiet-if-empty] [--out F]  예약용 브리핑(로그인 창 안 뜸)\n  jbnu-lms-mcp logout [--delete-profile]   연결 해제\n  jbnu-lms-mcp doctor                      환경 점검\n  jbnu-lms-mcp config [--client claude|codex] [--write] [--package]  MCP 클라이언트 설정`);
    return;
  }
  let code = 0;
  switch (cmd) {
    case 'setup':
      code = await cmdSetup();
      break;
    case 'serve':
      await serveStdio();
      return;
    case 'login':
      code = await cmdLogin();
      break;
    case 'status':
      code = await cmdStatus();
      break;
    case 'verify':
      code = await cmdVerify();
      break;
    case 'brief':
      code = await cmdBrief();
      break;
    case 'logout':
      code = await cmdLogout();
      break;
    case 'doctor':
      code = await cmdDoctor();
      break;
    case 'config':
      code = await cmdConfig();
      break;
    default:
      out(`알 수 없는 명령: ${cmd}. --help 를 참고하세요.`);
      code = 1;
  }
  process.exit(code);
}

main().catch((e) => {
  process.stderr.write(`${formatUserError(e, { operation: '명령 실행' })}\n`);
  process.exit(1);
});
