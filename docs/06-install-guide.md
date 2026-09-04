# 설치 및 실행 안내서 (Windows)

## 0. 준비물

| 항목 | 확인 방법 | 비고 |
|---|---|---|
| Windows 10/11 | — | DPAPI 로 세션을 암호화한다 |
| Node.js 20 이상 | `node --version` | https://nodejs.org LTS |
| Google Chrome 또는 Microsoft Edge | 시작 메뉴 | 로그인 창과 세션 검증에 사용. Edge 는 Windows 11 기본 포함 |
| Claude Desktop 또는 Codex | — | MCP 클라이언트 |
| 전북대 통합인증 계정(패스키 또는 2차 인증) | — | 로그인은 본인이 직접 |

## 1. 폴더 준비

이 저장소를 짧은 로컬 경로에 둔다. 예: `C:\Users\<이름>\Documents\jbnu-lms-mcp`.
OneDrive 동기화 폴더나 아주 긴 경로에서는 npm 설치가 실패할 수 있다.

## 2. 설치 스크립트

```powershell
cd "$HOME\Documents\jbnu-lms-mcp"
.\scripts\install.ps1 -RegisterClaude
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

## 3. 수동 설치 (스크립트를 쓰지 않을 때)

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
      "args": ["C:\\Users\\<이름>\\Documents\\jbnu-lms-mcp\\dist\\cli.js", "serve"],
      "env": { "JBNU_LMS_LOG_LEVEL": "warn" }
    }
  }
}
```

Codex: `~/.codex/config.toml`

```toml
[mcp_servers.jbnu-lms]
command = "node"
args = ["C:\\Users\\<이름>\\Documents\\jbnu-lms-mcp\\dist\\cli.js", "serve"]
```

## 4. 첫 로그인

두 가지 중 하나.

**A. 대화에서 자동**: Claude Desktop 을 재시작하고 "오늘 해야 할 일 알려줘" 라고 묻는다. 로그인 창이 열리면 통합인증을 완료한다. 창은 LMS 홈이 뜨면 자동으로 닫힌다.

**B. 명령행에서 미리**:

```powershell
node dist\cli.js login
```

로그인 뒤 상태 확인:

```powershell
node dist\cli.js status --verify
```

`✅ 연결됨` 과 이름이 보이면 끝. 세션은 `%LOCALAPPDATA%\jbnu-lms-mcp\session.dpapi` 에 암호화되어 저장된다.

## 5. 업데이트

```powershell
git pull
npm ci
npm run build
```

설정 파일의 경로는 그대로이므로 다시 등록할 필요가 없다. Claude Desktop 은 재시작한다.

## 6. 제거

```powershell
node dist\cli.js logout --delete-profile --delete-snapshot
```

그 다음 Claude/Codex 설정 파일에서 `jbnu-lms` 항목을 지우고 폴더를 삭제한다. 남는 개인 데이터: `%LOCALAPPDATA%\jbnu-lms-mcp`(위 명령으로 비워짐), `~/Downloads/jbnu-lms`(다운로드 자료).
