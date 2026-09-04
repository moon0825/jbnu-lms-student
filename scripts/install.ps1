<#
.SYNOPSIS
  jbnu-lms-mcp 를 설치하고 MCP 클라이언트에 등록한다.
.DESCRIPTION
  1) Node.js 22+ 확인  2) npm ci  3) 빌드  4) 테스트(옵션)  5) 환경 점검  6) Claude Desktop / Codex 등록(옵션)
.EXAMPLE
  .\scripts\install.ps1 -RegisterClaude
  .\scripts\install.ps1 -RegisterClaude -RegisterCodex -SkipTests
#>
param(
  [switch]$RegisterClaude,
  [switch]$RegisterCodex,
  [switch]$SkipTests,
  [switch]$Login
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== jbnu-lms-mcp 설치 ==" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 가 없습니다. https://nodejs.org 에서 Node.js 22 이상을 설치한 뒤 다시 실행하세요." }
$ver = (node --version).TrimStart('v').Split('.')[0]
if ([int]$ver -lt 22) { throw "Node.js 22 이상이 필요합니다. 현재: $(node --version)" }

Write-Host "[1/5] 의존성 설치" -ForegroundColor Yellow
if (Test-Path package-lock.json) { npm ci --no-audit --no-fund } else { npm install --no-audit --no-fund }
if ($LASTEXITCODE -ne 0) { throw "npm 설치 실패" }

Write-Host "[2/5] 빌드" -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "빌드 실패" }

if (-not $SkipTests) {
  Write-Host "[3/5] 테스트" -ForegroundColor Yellow
  npm test
  if ($LASTEXITCODE -ne 0) { throw "테스트 실패. 로그를 확인하세요." }
} else { Write-Host "[3/5] 테스트 건너뜀" }

Write-Host "[4/5] 환경 점검" -ForegroundColor Yellow
node dist/cli.js doctor

Write-Host "[5/5] MCP 클라이언트 등록" -ForegroundColor Yellow
if ($RegisterClaude) { node dist/cli.js config --client claude --write }
if ($RegisterCodex) { node dist/cli.js config --client codex --write }
if (-not $RegisterClaude -and -not $RegisterCodex) {
  Write-Host "등록하지 않았습니다. 아래 설정을 클라이언트에 직접 추가하거나 -RegisterClaude / -RegisterCodex 로 다시 실행하세요."
  node dist/cli.js config --client claude
}

if ($Login) {
  Write-Host "`n브라우저로 LMS 로그인을 시작합니다..." -ForegroundColor Yellow
  node dist/cli.js login
}

Write-Host "`n완료. MCP 클라이언트(Claude Desktop/Codex)를 완전히 종료한 뒤 다시 실행하세요." -ForegroundColor Green
Write-Host "첫 대화에서 '오늘 해야 할 일 알려줘' 라고 물으면 로그인 창이 자동으로 열립니다."
