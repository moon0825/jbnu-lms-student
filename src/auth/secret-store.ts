/**
 * 로컬 인증 정보 저장소.
 * - Windows: DPAPI(CurrentUser 범위)로 암호화한 파일. 같은 Windows 계정에서만 복호화된다.
 * - 그 외 플랫폼: 사용자 전용 권한(0600)의 파일. 평문이므로 status 에 경고를 표시한다.
 * 어떤 경우에도 비밀값을 로그나 명령행 인자에 넣지 않는다(DPAPI 입력은 stdin 으로 전달).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LmsError } from '../errors.js';

export type SecretBackend = 'dpapi' | 'plain' | 'memory';

export interface SecretStore {
  readonly backend: SecretBackend;
  readonly location: string;
  save(data: unknown): Promise<void>;
  load<T>(): Promise<T | null>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
}

const ENTROPY = 'jbnu-lms-mcp:session:v1';

function runPowerShellDpapi(op: 'Protect' | 'Unprotect', inputBase64: string): Promise<string> {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$raw=[Console]::In.ReadToEnd().Trim()',
    '$inb=[Convert]::FromBase64String($raw)',
    `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out=[Security.Cryptography.ProtectedData]::${op}($inb,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => reject(new LmsError('STORAGE', 'PowerShell 실행 실패', { cause: e })));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new LmsError('STORAGE', `DPAPI ${op === 'Protect' ? '암호화' : '복호화'} 실패`, { cause: err.slice(0, 200) }));
    });
    child.stdin.end(inputBase64, 'utf8');
  });
}

interface StoredEnvelope {
  version: 1;
  backend: SecretBackend;
  createdAt: string;
  /** dpapi: base64(DPAPI blob) / plain: base64(json) */
  payload: string;
}

export class DpapiFileStore implements SecretStore {
  readonly backend: SecretBackend = 'dpapi';
  constructor(readonly location: string) {}

  async save(data: unknown): Promise<void> {
    const json = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    const payload = await runPowerShellDpapi('Protect', json);
    await writeEnvelope(this.location, { version: 1, backend: 'dpapi', createdAt: new Date().toISOString(), payload });
  }

  async load<T>(): Promise<T | null> {
    const env = await readEnvelope(this.location);
    if (!env) return null;
    if (env.backend !== 'dpapi') throw new LmsError('STORAGE', '저장 형식이 DPAPI 가 아닙니다. disconnect_lms 후 다시 연결해 주세요.');
    const json = await runPowerShellDpapi('Unprotect', env.payload);
    return JSON.parse(Buffer.from(json, 'base64').toString('utf8')) as T;
  }

  async delete(): Promise<void> { await removeFile(this.location); }
  async exists(): Promise<boolean> { return fileExists(this.location); }
}

export class PlainFileStore implements SecretStore {
  readonly backend: SecretBackend = 'plain';
  constructor(readonly location: string) {}

  async save(data: unknown): Promise<void> {
    const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
    await writeEnvelope(this.location, { version: 1, backend: 'plain', createdAt: new Date().toISOString(), payload });
  }

  async load<T>(): Promise<T | null> {
    const env = await readEnvelope(this.location);
    if (!env) return null;
    if (env.backend !== 'plain') throw new LmsError('STORAGE', '저장 형식이 맞지 않습니다. disconnect_lms 후 다시 연결해 주세요.');
    return JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as T;
  }

  async delete(): Promise<void> { await removeFile(this.location); }
  async exists(): Promise<boolean> { return fileExists(this.location); }
}

export class MemorySecretStore implements SecretStore {
  readonly backend: SecretBackend = 'memory';
  readonly location = '(memory)';
  private data: unknown = null;
  async save(data: unknown): Promise<void> { this.data = JSON.parse(JSON.stringify(data)); }
  async load<T>(): Promise<T | null> { return (this.data as T) ?? null; }
  async delete(): Promise<void> { this.data = null; }
  async exists(): Promise<boolean> { return this.data !== null; }
}

async function writeEnvelope(file: string, env: StoredEnvelope): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(env), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    throw new LmsError('STORAGE', '인증 정보 파일을 쓰지 못했습니다', { cause: e });
  }
}

async function readEnvelope(file: string): Promise<StoredEnvelope | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const env = JSON.parse(raw) as StoredEnvelope;
    if (env.version !== 1 || typeof env.payload !== 'string') throw new Error('bad envelope');
    return env;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LmsError('STORAGE', '인증 정보 파일을 읽지 못했습니다', { cause: e });
  }
}

async function removeFile(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch (e) {
    throw new LmsError('STORAGE', '인증 정보 파일을 삭제하지 못했습니다', { cause: e });
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function createSecretStore(location: string, platform: NodeJS.Platform = process.platform): SecretStore {
  return platform === 'win32' ? new DpapiFileStore(location) : new PlainFileStore(location);
}
