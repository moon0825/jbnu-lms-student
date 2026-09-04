/**
 * stderr 전용 로거. stdout 은 MCP STDIO 전송 채널이므로 절대 사용하지 않는다.
 * 토큰, 쿠키, 비밀번호, sesskey 형태의 값은 기록 전에 마스킹한다.
 * 과제 본문, 공지 본문, 첨부파일 내용은 로그에 남기지 않는다(필드 이름 기준 차단).
 */
import type { LogLevel } from './config.js';

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(MoodleSession\w*=)[^;\s"']+/gi, '$1<redacted>'],
  [/(MOODLEID\w*=)[^;\s"']+/gi, '$1<redacted>'],
  [/(PHPSESSID=)[^;\s"']+/gi, '$1<redacted>'],
  [/(wstoken=)[^&\s"']+/gi, '$1<redacted>'],
  [/(privatetoken["']?\s*[:=]\s*["']?)[^",\s]+/gi, '$1<redacted>'],
  [/(\btoken["']?\s*[:=]\s*["']?)[^",\s]+/gi, '$1<redacted>'],
  [/(sesskey["']?\s*[:=]\s*["']?)[^",&\s]+/gi, '$1<redacted>'],
  [/(password["']?\s*[:=]\s*["']?)[^",\s]+/gi, '$1<redacted>'],
  [/(cookie["']?\s*[:=]\s*["']?)[^"\n]+/gi, '$1<redacted>'],
  [/(authorization["']?\s*[:=]\s*["']?)[^"\n]+/gi, '$1<redacted>'],
  // 32자 16진수(Moodle 토큰 형태)
  [/\b[a-f0-9]{32}\b/gi, '<redacted-hex32>'],
];

const SENSITIVE_KEYS = /token|cookie|password|sesskey|secret|authorization|studentid|학번|body|html|content|description|intro/i;

export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '<depth>';
  if (typeof value === 'string') return redactText(value.length > 400 ? `${value.slice(0, 400)}…` : value);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '<redacted>' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private level: number;
  private readonly sink: (line: string) => void;

  constructor(level: LogLevel = 'warn', sink?: (line: string) => void) {
    this.level = LEVELS[level] ?? LEVELS.warn;
    this.sink = sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level] ?? this.level;
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] > this.level) return;
    const ts = new Date().toISOString();
    const safeMsg = redactText(msg);
    const safeFields = fields ? ` ${JSON.stringify(redactValue(fields))}` : '';
    this.sink(`[${ts}] ${level.toUpperCase()} ${safeMsg}${safeFields}`);
  }

  error(msg: string, fields?: Record<string, unknown>): void { this.emit('error', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.emit('warn', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.emit('info', msg, fields); }
  debug(msg: string, fields?: Record<string, unknown>): void { this.emit('debug', msg, fields); }
}

export const defaultLogger = new Logger((process.env.JBNU_LMS_LOG_LEVEL as LogLevel) || 'warn');
