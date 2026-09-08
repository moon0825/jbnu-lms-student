# 장애 해결 안내서

먼저 `node dist\cli.js doctor` 를 실행해 Node, 브라우저, 보안 저장소(DPAPI/Keychain), LMS 접속, 저장된 세션을 한 번에 점검하세요.

## 설치·실행

| 증상 | 원인 | 해결 |
|---|---|---|
| 설치할 폴더가 없거나 경로를 모르겠음 | 예전 소스 설치 안내 사용 | 폴더 없이 `npx -y jbnu-lms-mcp@latest setup --client codex` 또는 `--client claude` 실행 |
| `npx`를 찾을 수 없음 | Node.js 22 미설치 | Node.js LTS 설치 후 새 PowerShell 창에서 같은 한 줄 명령 재실행 |
| `install.ps1` 이 "스크립트를 실행할 수 없습니다" | 개발자용 소스 설치를 선택함 | 일반 사용자는 npx 한 줄 설치 사용. 개발자는 `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -RegisterClaude` |
| `Node.js 22 이상이 필요합니다` | 오래된 Node | https://nodejs.org LTS 설치 후 새 PowerShell 창에서 재실행 |
| `npm ci` 가 esbuild 설치에서 실패 | 경로가 너무 길거나 OneDrive 동기화 폴더 | 짧은 로컬 경로(예: `C:\Users\<이름>\Documents\jbnu-lms-mcp`)로 옮겨 재시도 |
| Claude Desktop 에 도구가 안 보임 | 설정 파일 미반영·앱 미재시작 | `npx -y jbnu-lms-mcp@latest setup --client claude --skip-login` 후 Claude 완전 종료(트레이) → 재실행 |
| Claude 로그에 "server disconnected" | `dist/` 가 없거나 경로 오타 | `npm run build` 후 설정 파일의 `args` 경로가 실제 `dist\cli.js` 인지 확인 |
| Codex 에서 서버가 시작되지 않음 | TOML 문법 | `examples/codex-config.toml` 과 비교. 경로의 `\` 는 `\\` 로 |

## 로그인

| 증상 | 원인 | 해결 |
|---|---|---|
| 로그인 창이 열리지 않음 (`브라우저를 찾을 수 없습니다`) | Chrome/Edge 미설치 또는 비표준 경로 | `JBNU_LMS_BROWSER` 에 `chrome`, `msedge` 또는 실행 파일 절대 경로 지정 |
| 창은 열렸는데 SSO 화면이 오류를 표시 | 학교 SSO 가 자동화 브라우저를 차단(assisted 모드) | `JBNU_LMS_LOGIN_MODE=plain` 으로 바꾸고 다시 시도. plain 은 자동화가 전혀 없음 |
| 패스키 인증 후 로그인 화면으로 복귀하거나 `비정상 요청 감지` | 두 번째 `패스키 인증 로그인` 탭의 단독 경로를 사용함 | 세 번째 **아이디 로그인 → 아이디·비밀번호 → 2차 인증에서 패스키** 순서로 진행 |
| 패스키 인증 뒤 포털 홈으로 이동함 | 학교 SSO가 LMS 복귀 주소를 보존하지 못함 | 창을 닫지 않는다. 도구가 같은 SSO 세션으로 LMS `/my/`를 다시 열어 자동 복귀한다 |
| 패스키 인증 뒤 다시 로그인 화면으로 돌아옴 | SSO 주소를 직접 열었거나 SSO 세션이 완성되지 않음 | `node dist\cli.js login --plain`으로 시작. 도구가 LMS `/my/`에서 공식 로그인 리다이렉트를 생성함 |
| 로그인했는데 "연결되지 않았습니다" (plain) | LMS 완료 화면을 아직 확정하지 못함 | 수강 과목/강의 현황 화면이 보이면 Windows는 기다리고, Mac은 로그인용 창만 닫은 뒤 `get_auth_status` 실행. 실패한 전용 프로필은 다음 재시도에 재사용된다 |
| `브라우저 창이 아직 열려 있습니다` | 프로필 잠금 파일 남음 | 로그인용 창을 모두 닫기. 비정상 종료였다면 작업 관리자에서 chrome/msedge 종료 후 재시도 |
| 패스키(Windows Hello) 창이 뜨지 않음 | 브라우저 프로필에 패스키 관련 권한이 초기화됨 | 같은 창에서 "다른 방법으로 로그인"을 고르거나 SSO 안내에 따라 진행. 도구는 인증 방식에 관여하지 않음 |
| 패스키 팝업이 차단됨 | 이전 버전의 일회용 Chrome 설정 | 최신 빌드로 다시 실행. 로그인용 프로필에만 팝업 차단 해제 플래그가 적용됨 |
| 로그인 직후에도 "세션이 만료되었습니다" | 쿠키 도메인 불일치 또는 SSO 가 LMS 로 돌아오지 않음 | 창을 닫지 말고 `node dist\cli.js status --verify` 실행. `홈 | JBNU LXP`만 보이면 도구가 `/my/`로 재확인한다 |
| 매일 다시 로그인해야 함 | 저장된 LMS 세션 만료 또는 keep-alive 꺼짐 | `JBNU_LMS_KEEPALIVE` 를 켜 두고(기본) MCP 클라이언트를 실행 상태로 유지. 만료 시 전용 창에서 다시 인증 |
| 채팅의 LMS 링크를 누르면 다시 로그인하라고 함 | Codex/Claude 내부 브라우저가 LMS 쿠키를 공유하지 않음 | 링크를 직접 누르지 말고 “이 원문 열어줘”라고 요청해 `open_lms_source`로 전용 브라우저에서 열기. 최초 1회만 로그인할 수 있음 |

## 조회

| 증상 | 원인 | 해결 |
|---|---|---|
| "공지사항 게시판(ubboard)을 찾지 못했습니다" | 강좌에 공지 게시판이 없거나 메뉴 링크가 다른 구조 | `get_course_overview` 로 `[ubboard]` 모듈이 있는지 확인. 있는데도 못 찾으면 이슈로 화면 구조(HTML)를 알려 주세요(개인정보 제외) |
| 과제는 보이는데 마감이 "설정 없음" | 교수자가 마감을 설정하지 않음, 또는 날짜 형식 미지원 | `get_assignment_detail` 의 원문 표(extra)에서 "마감" 항목 확인. 새 형식이면 `time.ts` 의 `parseKoreanDateTime` 보강 |
| 자료 목록이 비어 있음 | 숨김·접근 제한·다른 모듈 종류 | `get_course_overview` 에서 모듈 종류(`modName`) 확인. 새 종류는 `lms-service.ts` 의 `MATERIAL_KIND` 에 추가 |
| 다운로드가 "파일 대신 HTML 화면이 돌아왔습니다" | 뷰어 페이지(동영상, 외부 링크) | 해당 모듈은 다운로드 대상이 아님. `url` 로 브라우저에서 열기 |
| "요청이 너무 잦습니다" / 느림 | 속도 제한 | 정상. 강좌 수가 많으면 `course_id` 로 좁히기 |
| "화면 형식을 해석하지 못했습니다" | LMS 업데이트로 HTML 변경 | `tests/fixtures` 에 새 화면을 익명화해 추가하고 파서 수정 |

## 문제 신고·기능 제안

| 증상 | 원인 | 해결 |
|---|---|---|
| 접수 상태가 `stored_local` | 원격 수집 주소 미설정 | 정상 로컬 접수다. 중앙 수집이 필요하면 운영자가 HTTPS `JBNU_LMS_FEEDBACK_URL`을 설정 |
| 접수 상태가 `queued_retry` | 수집기 타임아웃·네트워크·비-2xx 응답 | `get_feedback_status` 확인 후 `retry_feedback_delivery` 실행 |
| "외부 피드백 수집 주소는 HTTPS만 허용" | 외부 HTTP URL 설정 | HTTPS로 바꾸기. HTTP는 loopback 개발 환경만 허용 |
| 신고 내용을 지우고 싶음 | 로컬 JSON 보관 | `discard_local_feedback(report_id, confirm_discard=true)`. 이미 원격 전송된 사본은 수집기 운영자에게 별도 요청 |

## 로그 보기

- 서버 로그는 stderr 로만 나갑니다. Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-jbnu-lms.log`
- 자세히 보려면 설정의 `env` 에 `"JBNU_LMS_LOG_LEVEL": "debug"` 추가. 로그에는 토큰·쿠키·본문이 마스킹됩니다.

## 완전 초기화

```powershell
node dist\cli.js logout --delete-profile --delete-snapshot
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\jbnu-lms-mcp"
```
