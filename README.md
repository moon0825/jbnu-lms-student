# jbnu-lms-mcp — 전북대학교 LMS 학생용 MCP 서버

전북대학교 LMS(JBNU LXP, https://lms.jbnu.ac.kr)에 로그인한 학생이 Claude Desktop·Codex 같은 AI 클라이언트에서
"오늘 해야 할 일 알려줘", "이번 주 과제와 마감일 정리해줘", "새로 올라온 공지 알려줘" 처럼 물어볼 수 있게 해 주는
**로컬 STDIO MCP 서버**입니다. 모든 기능은 **읽기 전용**이며, 로그인은 사용자가 브라우저에서 직접(패스키·2차 인증 포함) 완료합니다.

- 비밀번호·패스키·인증 코드를 **절대 입력받지 않습니다.**
- LMS 세션은 Windows DPAPI 로 암호화해 내 PC 에만 보관합니다.
- 데이터는 `lms.jbnu.ac.kr` 로만 전송되며 다른 서버로 나가지 않습니다.

## 1. 설치 (Windows, 3분)

필요한 것: **Node.js 20 이상**(LTS 권장), **Google Chrome 또는 Microsoft Edge**, Claude Desktop 또는 Codex.

PowerShell 을 열고:

```powershell
cd "$HOME\Documents\jbnu-lms-mcp"
.\scripts\install.ps1 -RegisterClaude
```

이 명령이 하는 일: 의존성 설치 → 빌드 → 테스트 → 환경 점검(`doctor`) → Claude Desktop 설정 파일에 `jbnu-lms` 서버 등록(기존 파일은 백업).

- Codex 도 함께 등록: `.\scripts\install.ps1 -RegisterClaude -RegisterCodex`
- 테스트 생략: `-SkipTests`
- 설치 직후 바로 로그인: `-Login`
- 실행 정책 오류가 나면: `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -RegisterClaude`

설치가 끝나면 **Claude Desktop 을 완전히 종료 후 다시 실행**하세요(트레이 아이콘까지 종료).

수동 설정이 필요하면 [examples/claude_desktop_config.json](examples/claude_desktop_config.json) 또는 [examples/codex-config.toml](examples/codex-config.toml) 을 참고해 경로만 바꿔 넣으면 됩니다.

## 2. 첫 사용

Claude 에서 이렇게 물어보세요.

> 오늘 해야 할 일 알려줘

처음이면 도구가 **로그인용 브라우저 창을 자동으로 엽니다.** 창에서 전북대 통합인증(패스키 또는 2차 인증)을 직접 완료하면
LMS 홈이 뜨는 순간 자동으로 감지해 창을 닫고, 원래 질문에 바로 답합니다.
(창이 닫히지 않는 환경이면 로그인 후 창을 직접 닫고 "로그인 완료"라고 말하면 이어서 처리합니다.)

명령행에서 미리 로그인해 둘 수도 있습니다.

```powershell
node dist\cli.js login
```

## 3. 이런 질문에 답합니다

| 질문 | 사용하는 도구 |
|---|---|
| 오늘 해야 할 일 알려줘 | `get_daily_briefing` |
| 이번 주 과제와 마감일 정리해줘 | `get_weekly_study_plan`, `get_upcoming_deadlines` |
| 새로 올라온 공지사항 알려줘 | `get_announcements(only_new)`, `get_recent_changes` |
| 이 과제 요구사항과 제출물을 분석해줘 | `get_assignment_detail` |
| 이번 주차 수업자료를 찾아줘 | `get_course_materials(week)` |
| 지난번 확인 이후 변경된 내용만 보여줘 | `get_recent_changes` |
| 그 파일 내려받아 줘 | `download_course_material` |

전체 도구 15개의 입력·출력은 [docs/05-tool-spec.md](docs/05-tool-spec.md) 에 있습니다.

응답에는 항상 **기준 시각(Asia/Seoul)**, **로그인 상태**, **마지막 동기화 시각**, **데이터 출처**(Moodle API / 웹 AJAX / LMS 화면 해석 / AI 추정)와 **원문 URL** 이 붙습니다.
과제는 마감·남은 시간·제출 상태·지각 허용 여부를, 공지는 📌 고정(중요)·🆕 새 글·📎 첨부 여부를 표시합니다.

## 4. 인증 방식 요약

전북대 LMS 는 통합인증(SSO) 전용이고, 학생이 공식 Moodle 토큰을 발급받는 경로(`login/token.php`, 모바일 앱 `launch.php`)는 서버 설정으로 막혀 있습니다(조사 근거: [docs/03-auth-decision-record.md](docs/03-auth-decision-record.md)).
그래서 이 도구는 다음처럼 동작합니다.

1. 전용 브라우저 프로필로 Chrome/Edge 창을 열어 사용자가 직접 SSO·패스키를 완료
2. 로그인된 프로필에서 LMS 세션 쿠키와 `sesskey` 만 추출해 DPAPI 로 암호화 저장
3. 이후 조회는 브라우저 없이 Moodle 웹 AJAX API + LMS 화면 해석으로 수행
4. 공식 토큰이 확보되면(학교 정책 변경 시) 자동으로 공식 REST API 를 우선 사용

로그인 창 방식은 두 가지입니다.

| 모드 | 설명 | 설정 |
|---|---|---|
| `assisted` (기본) | 창을 띄우고 로그인 완료를 자동 감지해 닫음. 가장 편함 | `JBNU_LMS_LOGIN_MODE=assisted` |
| `plain` | 자동화가 전혀 없는 일반 브라우저. 로그인 후 창을 닫으면 완료 | `JBNU_LMS_LOGIN_MODE=plain` |

편의를 위해 서버가 켜져 있는 동안 20분마다 세션을 연장(keep-alive)합니다. 끄려면 `JBNU_LMS_KEEPALIVE=0`.

## 5. 명령행 도구

```powershell
node dist\cli.js login              # 브라우저 로그인 (--plain, --wait 300)
node dist\cli.js status --verify    # 연결 상태
node dist\cli.js logout             # 세션 삭제 (--delete-profile 로 브라우저 프로필까지)
node dist\cli.js doctor             # 환경 점검
node dist\cli.js config --client claude --write   # Claude Desktop 등록
node dist\cli.js config --client codex --write    # Codex 등록
```

## 6. 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `JBNU_LMS_BASE_URL` | `https://lms.jbnu.ac.kr` | LMS 주소 |
| `JBNU_LMS_DATA_DIR` | `%LOCALAPPDATA%\jbnu-lms-mcp` | 세션·프로필·스냅샷 폴더 |
| `JBNU_LMS_BROWSER` | 자동(Chrome→Edge) | `chrome`, `msedge`, 또는 실행 파일 경로 |
| `JBNU_LMS_LOGIN_MODE` | `assisted` | `assisted` 또는 `plain` |
| `JBNU_LMS_AUTO_LOGIN` | `1` | 세션 만료 시 자동으로 로그인 창 열기 |
| `JBNU_LMS_AUTO_LOGIN_WAIT_SEC` | `90` | 자동 로그인 대기 시간 |
| `JBNU_LMS_KEEPALIVE` / `JBNU_LMS_KEEPALIVE_MIN` | `1` / `20` | 세션 연장 사용 여부 / 간격(분) |
| `JBNU_LMS_DOWNLOAD_DIR` | `~/Downloads/jbnu-lms` | 자료 저장 폴더 |
| `JBNU_LMS_TIMEOUT_MS` | `20000` | 요청 제한 시간 |
| `JBNU_LMS_MIN_INTERVAL_MS` / `JBNU_LMS_MAX_CONCURRENCY` | `250` / `3` | 요청 속도 제한 |
| `JBNU_LMS_LOG_LEVEL` | `warn` | `silent` `error` `warn` `info` `debug` (stderr) |

## 7. 개발

```powershell
npm install
npm run build
npm test                 # 단위·통합·보안 테스트 (mock LMS)
npm run test:security    # 보안 테스트만
npm run check:secrets    # 저장소에 토큰·쿠키가 없는지 검사
JBNU_LIVE=1 npx vitest run tests/live   # 실제 LMS 스모크 (로그인 필요)
```

문서: [요구사항](docs/01-requirements.md) · [위협 모델](docs/02-threat-model-privacy.md) · [인증 결정 기록](docs/03-auth-decision-record.md) · [구조와 데이터 흐름](docs/04-architecture-dataflow.md) · [도구 명세](docs/05-tool-spec.md) · [설치 안내](docs/06-install-guide.md) · [장애 해결](docs/07-troubleshooting.md) · [배포 체크리스트](docs/08-release-checklist.md) · [실제 LMS 검증](docs/09-live-verification.md) · [확장 로드맵](docs/10-roadmap-extensions.md)

## 8. 보안상 알아 둘 것

- 이 PC 에 로그인할 수 있는 사람은 저장된 LMS 세션을 사용할 수 있습니다. 공용 PC 에서는 사용 후 `disconnect_lms` 를 실행하세요.
- 세션 파일(`session.dpapi`)과 브라우저 프로필은 `.gitignore` 로 제외되어 있으며 절대 공유하지 마세요.
- 로그(stderr)에는 토큰·쿠키·비밀번호·과제 본문이 기록되지 않도록 마스킹합니다.
- 상태를 바꾸는 기능(과제 제출, 글쓰기, 메시지)은 구현되어 있지 않습니다. 확장 계획은 [docs/10-roadmap-extensions.md](docs/10-roadmap-extensions.md) 를 보세요.

라이선스: MIT. 전북대학교·유비온과 무관한 비공식 도구이며 LMS 이용약관과 학교 정책을 준수해 사용하세요.
