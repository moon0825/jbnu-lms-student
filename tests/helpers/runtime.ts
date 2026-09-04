import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MemorySecretStore } from '../../src/auth/secret-store.js';
import type { StoredSession } from '../../src/auth/session-manager.js';
import { loadConfig } from '../../src/config.js';
import { Logger } from '../../src/logging.js';
import { buildRuntime, createMcpServer, type Runtime } from '../../src/server.js';
import { startMockLms, VALID_COOKIE, VALID_SESSKEY, type MockLms } from './mock-lms.js';

export interface TestHarness {
  mock: MockLms;
  runtime: Runtime;
  client: Client;
  logLines: string[];
  dataDir: string;
  callText(name: string, args?: Record<string, unknown>): Promise<{ text: string; structured: Record<string, unknown> | undefined; isError: boolean }>;
  close(): Promise<void>;
}

export function sampleSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    version: 1,
    cookies: { MoodleSession: VALID_COOKIE },
    sesskey: VALID_SESSKEY,
    token: null,
    userId: 12345,
    displayName: '홍길동',
    browser: 'mock',
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastSyncAt: null,
    ...overrides,
  };
}

export async function createHarness(options: { loggedIn?: boolean; session?: Partial<StoredSession>; env?: Record<string, string> } = {}): Promise<TestHarness> {
  const mock = await startMockLms();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbnu-lms-test-'));
  const config = loadConfig({
    JBNU_LMS_BASE_URL: mock.baseUrl,
    JBNU_LMS_DATA_DIR: dataDir,
    JBNU_LMS_MIN_INTERVAL_MS: '1',
    JBNU_LMS_MAX_RETRIES: '1',
    JBNU_LMS_LOG_LEVEL: 'debug',
    JBNU_LMS_DOWNLOAD_DIR: path.join(dataDir, 'downloads'),
  });
  const logLines: string[] = [];
  const logger = new Logger('debug', (line) => logLines.push(line));
  const store = new MemorySecretStore();
  if (options.loggedIn !== false) await store.save(sampleSession(options.session));
  const runtime = buildRuntime({ config, logger, secretStore: store, env: { JBNU_LMS_AUTO_LOGIN: '0', JBNU_LMS_KEEPALIVE: '0', ...(options.env ?? {}) } });
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    mock,
    runtime,
    client,
    logLines,
    dataDir,
    async callText(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
      return { text, structured: res.structuredContent, isError: Boolean(res.isError) };
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await mock.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
