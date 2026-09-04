# 장애 해결 안내서

먼저 `node dist\cli.js doctor` 를 실행해 Node, 브라우저, DPAPI, LMS 접속, 저장된 세션을 한 번에 점검하세요.

## 설치·실행

| 증상 | 원인 | 해결 |
|---|---|---|
| `install.ps1` 이 "스크립트를 실행할 수 없습니다" | PowerShell 실행 정책 | `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -RegisterClaude` |
| `Node.js 20 이상이 필요합니다` | 오래된 Node | https://nodejs.org LTS 설치 후 새 PowerShell 창에서 재실행 |
| `npm ci` 가 esbuild 설치에서 실패 | 경로가 너무 길거나 OneDrive 동기화 폴더 | 짧은 로컬 경로(예: `C:\Users\<이름>\Documents\jbnu-lms-mcp`)로 옮겨 재시도 |
| Claude Desktop 에 도구가 안 보임 | 설정 파일 미반영·앱 미재시작 | `node dist\cli.js config --client claude --write` 후 Claude 완전 종료(트레이) → 재실행. `%APPDATA%\Claude\claude_desktop_config.json` 에 `jbnu-lms` 항목 확인 |
| Claude 로그에 "server disconnected" | `dist/` 가 없거나 경로 오타 | `npm run build` 후 설정 파일의 `args` 경로가 실제 `dist\cli.js` 인지 확인 |
| Codex 에서 서버가 시작되지 않음 | TOML 문법 | `examples/codex-config.toml` 과 비교. 경로의 `\` 는 `\\` 로 |

## 로그인

| 증상 | 원인 | 해결 |
|---|---|---|
| 로그인 창이 열리지 않음 (`브라우저를 찾을 수 없습니다`) | Chrome/Edge 미설치 또는 비표준 경로 | `JBNU_LMS_BROWSER` 에 `chrome`, `msedge` 또는 실행 파일 절대 경로 지정 |
| 창은 열렸는데 SSO 화면이 오류를 표시 | 학교 SSO 가 자동화 브라우저를 차단(assisted 모드) | `JBNU_LMS_LOGIN_MODE=plain` 으로 바꾸고 다시 시도. plain 은 자동화가 전혀 없음 |
| 로그인했는데 "연결되지 않았습니다" (plain) | 브라우저 창을 닫지 않았거나 LMS 홈까지 가지 않음 | LMS 홈(대시보드)이 보인 뒤 창을 **모두** 닫고 `get_auth_status` 실행 |
| `브라우저 창이 아직 열려 있습니다` | 프로필 잠금 파일 남음 | 로그인용 창을 모두 닫기. 비정상 종료였다면 작업 관리자에서 chrome/msedge 종료 후 재시도 |
| 패스키(Windows Hello) 창이 뜨지 않음 | 브라우저 프로필에 패스키 관련 권한이 초기화됨 | 같은 창에서 "다른 방법으로 로그인"을 고르거나 SSO 안내에 따라 진행. 도구는 인증 방식에 관여하지 않음 |
| 로그인 직후에도 "세션이 만료되었습니다" | 쿠키 도메인 불일치 또는 SSO 가 LMS 로 돌아오지 않음 | LMS 홈이 실제로 보이는지 확인. `JBNU_LMS_LOG_LEVEL=debug` 로 재시도해 로그 확인 |
| 매일 다시 로그인해야 함 | 세션 8시간 만료, keep-alive 꺼짐 | `JBNU_LMS_KEEPALIVE` 를 켜 두고(기본) Claude Desktop 을 실행 상태로 유지. 브라우저 프로필을 지우지 않으면 SSO 세션이 남아 패스키 확인만으로 재로그인 |

## 조회

| 증상 | 원인 | 해결 |
|---|---|---|
| "공지사항 게시판(ubboard)을 찾지 못했습니다" | 강좌에 공지 게시판이 없거나 메뉴 링크가 다른 구조 | `get_course_overview` 로 `[ubboard]` 모듈이 있는지 확인. 있는데도 못 찾으면 이슈로 화면 구조(HTML)를 알려 주세요(개인정보 제외) |
| 과제는 보이는데 마감이 "설정 없음" | 교수자가 마감을 설정하지 않음, 또는 날짜 형식 미지원 | `get_assignment_detail` 의 원문 표(extra)에서 "마감" 항목 확인. 새 형식이면 `time.ts` 의 `parseKoreanDateTime` 보강 |
| 자료 목록이 비어 있음 | 숨김·접근 제한·다른 모듈 종류 | `get_course_overview` 에서 모듈 종류(`modName`) 확인. 새 종류는 `lms-service.ts` 의 `MATERIAL_KIND` 에 추가 |
| 다운로드가 "파일 대신 HTML 화면이 돌아왔습니다" | 뷰어 페이지(동영상, 외부 링크) | 해당 모듈은 다운로드 대상이 아님. `url` 로 브라우저에서 열기 |
| "요청이 너무 잦습니다" / 느림 | 속도 제한 | 정상. 강좌 수가 많으면 `course_id` 로 좁히기 |
| "화면 형식을 해석하지 못했습니다" | LMS 업데이트로 HTML 변경 | `tests/fixtures` 에 새 화면을 익명화해 추가하고 파서 수정 |

## 로그 보기

- 서버 로그는 stderr 로만 나갑니다. Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-jbnu-lms.log`
- 자세히 보려면 설정의 `env` 에 `"JBNU_LMS_LOG_LEVEL": "debug"` 추가. 로그에는 토큰·쿠키·본문이 마스킹됩니다.

## 완전 초기화

```powershell
node dist\cli.js logout --delete-profile --delete-snapshot
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\jbnu-lms-mcp"
```
