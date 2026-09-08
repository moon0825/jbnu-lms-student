import { describe, expect, it } from 'vitest';
import { clientConfigSnippets, packageServerDefinition, upsertCodexMcpServer } from '../../src/client-config.js';

const nextBlock = `[mcp_servers.jbnu-lms]
command = "node"
args = ["C:/new/dist/cli.js", "serve"]

[mcp_servers.jbnu-lms.env]
JBNU_LMS_LOG_LEVEL = "warn"`;

describe('Codex MCP 설정 갱신', () => {
  it('새 설정 파일에 서버 블록을 추가한다', () => {
    expect(upsertCodexMcpServer('', 'jbnu-lms', nextBlock)).toBe(`${nextBlock}\n`);
  });

  it('기존 서버와 하위 env 블록을 새 경로로 교체한다', () => {
    const existing = `[mcp_servers.jbnu-lms]
command = "node"
args = ["C:/old/dist/cli.js", "serve"]

[mcp_servers.jbnu-lms.env]
JBNU_LMS_LOG_LEVEL = "debug"

[projects.demo]
trust_level = "trusted"
`;
    const updated = upsertCodexMcpServer(existing, 'jbnu-lms', nextBlock);
    expect(updated).not.toContain('C:/old');
    expect(updated).toContain('C:/new');
    expect(updated).toContain('[projects.demo]');
    expect(updated.match(/\[mcp_servers\.jbnu-lms\]/g)).toHaveLength(1);
  });
});

describe('npm 한 줄 설치 설정', () => {
  it('npx 캐시 절대 경로 대신 게시된 버전을 고정한다', () => {
    const server = packageServerDefinition('jbnu-lms-mcp', '0.7.1');
    expect(server).toEqual({
      command: 'npx',
      args: ['-y', 'jbnu-lms-mcp@0.7.1', 'serve'],
      env: { JBNU_LMS_LOG_LEVEL: 'warn' },
    });

    const snippets = clientConfigSnippets(server);
    expect(snippets.codex).toContain('command = "npx"');
    expect(snippets.codex).toContain('"jbnu-lms-mcp@0.7.1"');
    expect(snippets.claude.mcpServers['jbnu-lms']).toEqual(server);
  });
});
