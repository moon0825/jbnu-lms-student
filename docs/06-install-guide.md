# 설치 및 실행 안내서 (Windows / macOS)

## 0. 일반 사용자에게 권장하는 설치

Node.js 22 이상을 설치한 뒤 Windows는 PowerShell, macOS는 터미널에 원하는 명령 한 줄을 붙여넣는다. 별도 폴더, ZIP 압축 해제, 소스 다운로드가 필요 없다.

```powershell
# Codex
npx -y jbnu-lms-mcp@latest setup --client codex

# Claude Desktop
npx -y jbnu-lms-mcp@latest setup --client claude
```

명령은 환경 점검 → 기존 설정 백업 → MCP 등록 → 전북대 로그인 창 실행을 순서대로 처리한다. 로그인과 패스키·2차 인증은 사용자가 브라우저에서 직접 완료한다. 완료 뒤 대상 앱을 완전히 종료했다가 다시 실행한다.

로그인을 나중에 할 때는 `--skip-login`을 붙이고, 이후 `npx -y jbnu-lms-mcp@latest login`을 실행한다. Claude Desktop에서는 GitHub Release의 `.mcpb` 파일도 선택할 수 있다.

## 1. 준비물

| 항목 | 확인 방법 | 비고 |
|---|---|---|
| Windows 10/11 또는 macOS | — | Windows는 DPAPI, Mac은 로그인 Keychain에 세션을 저장한다 |
| Node.js 22 이상 | `node --version` | `npx` 실행에 필요 |
| Google Chrome 또는 Microsoft Edge | 시작 메뉴 / 응용 프로그램 | 로그인 창과 세션 검증에 사용. Edge 는 Windows 11 기본 포함 |
| Claude Desktop 또는 Codex | — | MCP 클라이언트 |
| 전북대 통합인증 계정(패스키 또는 2차 인증) | — | 로그인은 본인이 직접 |

## 2. 개발자용 소스 설치

아래 과정은 소스 코드를 수정하거나 검증할 개발자만 사용한다. 일반 사용자는 위 간편 설치를 사용한다.

```powershell
git clone https://github.com/moon0825/jbnu-lms-student.git
cd jbnu-lms-student
.\scripts\install.ps1 -RegisterClaude -RegisterCodex
```

옵션:

- `-RegisterCodex` : `~/.codex/config.toml` 에도 등록
- `-SkipTests` : 테스트 생략(빠른 설치)
- `-Login` : 설치 후 바로 브라우저 로그인

실행 정책 때문에 막히면:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -RegisterClaude
```

스크립트는 설정 파일을 고치기 전에 `claude_desktop_config.json.bak-<시각>` 백업을 남긴다.

## 3. 완전 수동 설치

```powershell
npm ci
npm run build
npm test
node dist\cli.js doctor
node dist\cli.js config --client claude          # 설정 미리보기
node dist\cli.js config --client claude --write  # 등록
```

Claude Desktop 설정 파일 위치: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jbnu-lms": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "--experimental-sqlite", "C:\\Users\\<이름>\\Documents\\jbnu-lms-mcp\\dist\\cli.js", "serve"],
      "env": { "JBNU_LMS_LOG_LEVEL": "warn" }
    }
  }
}
```

Codex: `~/.codex/config.toml`

```toml
[mcp_servers.jbnu-lms]
command = "node"
args = ["--disable-warning=ExperimentalWarning", "--experimental-sqlite", "C:\\Users\\<이름>\\Documents\\jbnu-lms-mcp\\dist\\cli.js", "serve"]
```

## 4. 첫 로그인

두 가지 중 하나.

**A. 대화에서 자동**: Claude Desktop 또는 Codex 를 재시작하고 "오늘 해야 할 일 알려줘" 라고 묻는다.
로그인 창이 열리면 세 번째 `아이디 로그인` 탭에서 아이디·비밀번호로 1차 인증하고, 다음 2차 인증 화면에서
`패스키`를 선택한다. 두 번째 `패스키 인증 로그인` 탭과 혼동하지 않는다. 실제 수강 과목이 보이는 LMS 화면에 도착하면 Windows는 창을 그대로 두고, Mac은 방금 열린 로그인용 Chrome/Edge 창만 닫는다.
Windows는 도구가 전용 창을 자동 종료하고 DPAPI에 저장한다. Mac은 창이 닫힌 뒤 LMS 범위로 제한된 검증을 거쳐 로그인 Keychain에 저장한다.
전용 브라우저에는 원문 보기 재사용을 위해 Chrome이 암호화한 LMS 쿠키만 남고, 비밀번호·자동완성·방문 기록·SSO 쿠키·사이트 저장소·캐시는 정리된다. 프로필 유지가 싫으면 `JBNU_LMS_RETAIN_BROWSER_PROFILE=0`을 설정한다.

**B. 명령행에서 미리**:

```powershell
node dist\cli.js login --plain
```

로그인 뒤 상태 확인:

```powershell
node dist\cli.js status --verify
```

로그인 창을 이미 닫았다면 브라우저를 다시 열지 않고 세션만 저장할 수 있다.

```powershell
node dist\cli.js verify
```

`✅ 연결됨` 과 이름이 보이면 끝. 세션은 Windows에서 `%LOCALAPPDATA%\jbnu-lms-mcp\session.dpapi`, Mac에서 로그인 Keychain에 안전하게 저장된다.

## 5. 문제 신고·기능 제안 수집 설정(선택)

설정하지 않아도 `report_lms_problem`과 `suggest_lms_feature`는 이 PC의 `%LOCALAPPDATA%\jbnu-lms-mcp\feedback`에 즉시 접수된다. 중앙 수집 서버를 운영하는 경우에만 MCP 설정의 `env`에 다음을 추가한다.

```json
{
  "JBNU_LMS_FEEDBACK_URL": "https://feedback.example.org/v1/reports",
  "JBNU_LMS_FEEDBACK_TOKEN": "배포물과 분리된 선택적 토큰",
  "JBNU_LMS_FEEDBACK_TIMEOUT_MS": "8000"
}
```

외부 URL은 HTTPS만 허용한다. 토큰을 코드, `.mcp.json`, 설치 예제 또는 Git에 넣지 않는다. 실제 수집 JSON과 동의·재전송 계약은 `docs/14-feedback-collection.md`를 따른다.

## 6. 업데이트

```powershell
git pull
npm ci
npm run build
```

설정 파일의 경로는 그대로이므로 다시 등록할 필요가 없다. Claude Desktop 은 재시작한다.

## 7. 제거

```powershell
node dist\cli.js logout --delete-profile --delete-snapshot
```

그 다음 Claude/Codex 설정 파일에서 `jbnu-lms` 항목을 지우고 폴더를 삭제한다. 남는 개인 데이터: `%LOCALAPPDATA%\jbnu-lms-mcp`(위 명령으로 비워짐), `~/Downloads/jbnu-lms`(다운로드 자료).
