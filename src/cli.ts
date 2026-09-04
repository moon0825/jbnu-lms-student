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
import { APP_NAME, APP_VERSION } from './config.js';
import { formatUserError } from './errors.js';
import { buildRuntime, serveStdio } from './server.js';
import { fmtStatus } from './tools/format.js';

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

function configSnippets(): { claude: Record<string, unknown>; codex: string; json: Record<string, unknown> } {
  const entry = distEntry();
  const serverDef = { command: 'node', args: [entry, 'serve'], env: { JBNU_LMS_LOG_LEVEL: 'warn' } };
  const claude = { mcpServers: { 'jbnu-lms': serverDef } };
  const codex = ['[mcp_servers.jbnu-lms]', 'command = "node"', `args = [${JSON.stringify(entry)}, "serve"]`, '', '[mcp_servers.jbnu-lms.env]', 'JBNU_LMS_LOG_LEVEL = "warn"'].join('\n');
  return { claude, codex, json: claude };
}

async function cmdLogin(): Promise<number> {
  const rt = buildRuntime();
  const mode = flag('--plain') ? 'plain' : flag('--assisted') ? 'assisted' : rt.loginMode;
  const waitSec = Number.parseInt(opt('--wait') ?? '', 10) || 300;
  out(`전북대 LMS 로그인용 브라우저를 엽니다 (${mode === 'assisted' ? '완료 자동 감지' : '창을 닫으면 완료'} 방식).`);
  out('열린 창에서 통합인증(패스키 또는 2차 인증)을 직접 완료해 주세요. 이 프로그램은 어떤 인증 정보도 읽지 않습니다.');
  try {
    const st = await rt.sessionManager.loginFlow(mode, waitSec * 1000);
    out();
    out(fmtStatus(st));
    return st.connected ? 0 : 2;
  } catch (e) {
    out(formatUserError(e));
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
    out(formatUserError(e));
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
    out(formatUserError(e));
    return 1;
  }
}

async function cmdDoctor(): Promise<number> {
  const rt = buildRuntime();
  const checks: Array<[string, boolean | null, string]> = [];
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  checks.push(['Node.js 20 이상', nodeOk, process.versions.node]);
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
  checks.push(['데이터 폴더', fs.existsSync(rt.config.dataDir) || true, rt.config.dataDir]);
  for (const [name, okv, detail] of checks) out(`${okv === true ? '✅' : okv === null ? '➖' : '❌'} ${name}: ${detail}`);
  return checks.some(([, v]) => v === false) ? 1 : 0;
}

async function cmdConfig(): Promise<number> {
  const client = opt('--client') ?? 'claude';
  const s = configSnippets();
  if (client === 'codex') {
    out(s.codex);
    if (flag('--write')) {
      const file = path.join(os.homedir(), '.codex', 'config.toml');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (/\[mcp_servers\.jbnu-lms\]/.test(existing)) {
        out(`\n이미 ${file} 에 jbnu-lms 항목이 있습니다. 수동으로 확인해 주세요.`);
        return 0;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (existing) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
      fs.writeFileSync(file, `${existing.trimEnd()}\n\n${s.codex}\n`, 'utf8');
      out(`\n${file} 에 추가했습니다 (백업 생성). Codex 를 재시작하세요.`);
    }
    return 0;
  }
  out(JSON.stringify(s.claude, null, 2));
  if (flag('--write')) {
    const file = process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json') : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    let json: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    }
    const servers = (json.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers['jbnu-lms'] = (s.claude.mcpServers as Record<string, unknown>)['jbnu-lms'];
    json.mcpServers = servers;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
    out(`\n${file} 에 jbnu-lms 서버를 등록했습니다 (백업 생성). Claude Desktop 을 완전히 종료 후 다시 실행하세요.`);
  }
  return 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'serve';
  if (flag('--version') || cmd === 'version') {
    out(`${APP_NAME} ${APP_VERSION}`);
    return;
  }
  if (cmd === 'help' || flag('--help')) {
    out(`${APP_NAME} ${APP_VERSION}\n\n사용법:\n  jbnu-lms-mcp serve                     MCP STDIO 서버 실행 (기본)\n  jbnu-lms-mcp login [--plain] [--wait N]  브라우저로 LMS 로그인\n  jbnu-lms-mcp status [--verify]           연결 상태\n  jbnu-lms-mcp logout [--delete-profile]   연결 해제\n  jbnu-lms-mcp doctor                      환경 점검\n  jbnu-lms-mcp config [--client claude|codex] [--write]  MCP 클라이언트 설정`);
    return;
  }
  let code = 0;
  switch (cmd) {
    case 'serve':
      await serveStdio();
      return;
    case 'login':
      code = await cmdLogin();
      break;
    case 'status':
      code = await cmdStatus();
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
  process.stderr.write(`${formatUserError(e)}\n`);
  process.exit(1);
});
