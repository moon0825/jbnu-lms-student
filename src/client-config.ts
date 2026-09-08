/**
 * Codex TOML에서 특정 MCP 서버 블록을 안전하게 교체한다.
 * 해당 서버의 하위 테이블까지 제거하고 다른 설정은 그대로 보존한다.
 */
export function upsertCodexMcpServer(existing: string, serverName: string, snippet: string): string {
  const normalized = existing.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const rootHeader = `[mcp_servers.${serverName}]`;
  const childPrefix = `[mcp_servers.${serverName}.`;
  const start = lines.findIndex((line) => line.trim() === rootHeader);

  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line.startsWith('[') && line.endsWith(']') && line !== rootHeader && !line.startsWith(childPrefix)) {
        end = i;
        break;
      }
    }
    lines.splice(start, end - start);
  }

  const kept = lines.join('\n').trimEnd();
  return `${kept ? `${kept}\n\n` : ''}${snippet.trim()}\n`;
}

export type ClientName = 'claude' | 'codex';

export type ServerDefinition = {
  command: string;
  args: string[];
  env: { JBNU_LMS_LOG_LEVEL: string };
};

/**
 * npm으로 설치한 서버는 npx 캐시의 절대 경로를 설정에 남기지 않는다.
 * 현재 실행 중인 버전을 고정해, 캐시 정리 후에도 같은 검증본을 다시 받을 수 있게 한다.
 */
export function packageServerDefinition(packageName: string, version: string): ServerDefinition {
  return {
    command: 'npx',
    args: ['-y', `${packageName}@${version}`, 'serve'],
    env: { JBNU_LMS_LOG_LEVEL: 'warn' },
  };
}

export function localServerDefinition(entry: string): ServerDefinition {
  return {
    command: 'node',
    args: ['--disable-warning=ExperimentalWarning', '--experimental-sqlite', entry, 'serve'],
    env: { JBNU_LMS_LOG_LEVEL: 'warn' },
  };
}

export function clientConfigSnippets(serverDef: ServerDefinition): {
  claude: { mcpServers: { 'jbnu-lms': ServerDefinition } };
  codex: string;
} {
  const args = serverDef.args.map((arg) => JSON.stringify(arg)).join(', ');
  return {
    claude: { mcpServers: { 'jbnu-lms': serverDef } },
    codex: [
      '[mcp_servers.jbnu-lms]',
      `command = ${JSON.stringify(serverDef.command)}`,
      `args = [${args}]`,
      '',
      '[mcp_servers.jbnu-lms.env]',
      `JBNU_LMS_LOG_LEVEL = ${JSON.stringify(serverDef.env.JBNU_LMS_LOG_LEVEL)}`,
    ].join('\n'),
  };
}
