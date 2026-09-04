#!/usr/bin/env node
/** Claude Desktop 등에서 한 번에 설치할 수 있는 개인정보 비포함 MCPB를 만든다. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const stage = path.join(releaseDir, '.mcpb-stage');
const serverDir = path.join(stage, 'server');
const output = path.join(releaseDir, `jbnu-lms-student-${pkg.version}.mcpb`);
const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
const npmCli = process.env.npm_execpath;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(serverDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging', 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(root, 'packaging', 'mcpb', '.mcpbignore'), path.join(stage, '.mcpbignore'));
fs.copyFileSync(path.join(root, 'assets', 'jbnu-emblem.png'), path.join(stage, 'icon.png'));
fs.cpSync(path.join(root, 'dist'), path.join(serverDir, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'assets'), path.join(serverDir, 'assets'), { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  fs.copyFileSync(path.join(root, file), path.join(serverDir, file));
}

// 고정 lockfile로 실행 의존성만 설치한다. 개발 도구와 사용자 데이터는 번들에 들어가지 않는다.
if (!npmCli) throw new Error('npm 스크립트로 실행해야 합니다: npm run release:mcpb');
run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], serverDir);
run(process.execPath, [path.join(root, 'scripts', 'check-secrets.mjs'), stage, '--include-dist'], root);
run(process.execPath, [path.join(serverDir, 'dist', 'cli.js'), 'version'], serverDir);
run(process.execPath, [mcpbCli, 'validate', path.join(stage, 'manifest.json')], root);
run(process.execPath, [mcpbCli, 'pack', stage, output], root);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`MCPB 생성 완료: ${output}`);
