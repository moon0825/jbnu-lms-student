#!/usr/bin/env node
/** 이전 버전의 빌드 파일이 배포물에 남지 않도록 dist만 안전하게 정리한다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== root || path.basename(target) !== 'dist') {
  throw new Error(`안전하지 않은 정리 경로: ${target}`);
}
fs.rmSync(target, { recursive: true, force: true });
