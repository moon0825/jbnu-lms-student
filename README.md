<p align="center">
  <img src="assets/jbnu-signature.png" alt="전북대학교" width="620">
</p>

<h1 align="center">전북대 LMS 학업비서</h1>

<p align="center">
  공지부터 과제 마감, 제출 상태, 수업자료까지.<br>
  학생이 지금 해야 할 일을 먼저 보여 주는 비공식 로컬 MCP입니다.
</p>

<p align="center">
  <code>읽기 전용 LMS</code> · <code>패스키 지원</code> · <code>Windows + macOS</code> · <code>25개 도구</code> · <code>사용자 승인 피드백</code>
</p>

> **비공식 학생 도구:** 전북대학교가 운영하거나 보증하는 공식 서비스가 아닙니다. 학교 명칭과 UI 자산의 권리는 전북대학교에 있으며, 공개 배포 전에는 [공식 UI 사용 지침](https://www.jbnu.ac.kr/web/intro/university/sub05.do)을 확인해야 합니다.

전북대학교 LMS(JBNU LXP, https://lms.jbnu.ac.kr)에 로그인한 학생이 Claude Desktop·Codex 같은 AI 클라이언트에서
"오늘 해야 할 일 알려줘", "이번 주 과제와 마감일 정리해줘", "새로 올라온 공지 알려줘" 처럼 물어볼 수 있게 해 주는
**로컬 STDIO MCP 서버**입니다. 모든 **LMS 기능은 조회 전용**이며, 로그인은 사용자가 브라우저에서 직접(패스키·2차 인증 포함) 완료합니다.

## 한눈에 보는 경험

| 묻는 말 | 먼저 받는 답 |
|---|---|
| 오늘 뭐 해야 해? | 놓치면 안 되는 일 최대 3개와 근거 |
| 이번 주 일정 짜줘 | 제출 상태·남은 시간 기준 학습 계획 |
| 뭐가 새로 올라왔어? | 마지막 확인 이후 공지·과제·자료 변경점 |
| 이 과제 뭐 내야 해? | 요구사항·제출물·주의사항과 원문 링크 |
| 놓친 것 있나? | 마감·공지·과제 변경을 합친 학생 확인함과 상위 행동 3개 |
| 이거 최종 제출됐어? | 과제 상세 화면을 다시 읽은 제출 판정·근거·주의사항 |

- 비밀번호·패스키·인증 코드를 **절대 입력받지 않습니다.**
- LMS 세션은 Windows DPAPI 또는 macOS Keychain으로 내 PC에만 보관합니다.
- LMS 데이터와 인증정보는 `lms.jbnu.ac.kr` 이외로 전송하지 않습니다. 문제 신고·기능 제안은 사용자가 전송 내용을 확인하고 승인한 경우에만 로컬 보관함 또는 설정된 HTTPS 수집기로 접수합니다.

## 1. 가장 쉬운 설치 (Windows / macOS)

준비물은 [Node.js 22 이상](https://nodejs.org/)과 Chrome 또는 Edge입니다. 폴더를 만들거나 소스 코드를 내려받을 필요가 없습니다.

### Codex

Windows는 PowerShell, Mac은 터미널에 아래 한 줄을 붙여넣습니다.

```powershell
npx -y jbnu-lms-mcp@latest setup --client codex
```

### Claude Desktop

```powershell
npx -y jbnu-lms-mcp@latest setup --client claude
```

명령이 환경을 점검하고 기존 설정을 백업한 뒤 MCP를 등록하고 로그인 창을 엽니다. 전북대 아이디·비밀번호·패스키·2차 인증은 브라우저에서 직접 완료합니다. 실제 LMS 홈에 수강 과목이 보이면 Windows는 창을 그대로 두고, Mac은 방금 열린 로그인용 Chrome/Edge 창만 닫습니다. 완료 메시지가 나오면 Codex 또는 Claude Desktop을 완전히 종료했다가 다시 실행하면 됩니다.

Claude Desktop에서는 GitHub Release의 `.mcpb` 설치 파일도 사용할 수 있습니다. 개발자용 소스 설치와 수동 설정은 [설치 안내서](docs/06-install-guide.md)에 분리했습니다.

## 2. 첫 사용

Claude 에서 이렇게 물어보세요.

> 오늘 해야 할 일 알려줘

처음이면 도구가 **자동 제어가 없는 로그인용 일반 브라우저 창을 LMS `/my/`에서 엽니다.**
LMS 로그인 페이지가 만든 공식 리다이렉트로 통합로그인에 들어간 뒤,
세 번째 `아이디 로그인` 탭을 선택해 아이디·비밀번호로 1차 인증한 뒤, 다음 2차 인증 화면에서 `패스키`를 선택하세요.
실제 수강 과목이 보이는 LMS 화면에 도착하면 Windows는 창을 그대로 두고, Mac은 방금 열린 로그인용 Chrome/Edge 창만 닫습니다. 도구가 LMS 쿠키만 읽어
검증하고, 원래 질문을 이어서 처리합니다. 두 번째 `패스키 인증 로그인` 탭의 비밀번호 없는 단독 로그인과는
다른 경로입니다. 인증이 끝나면 LMS 세션은 Windows DPAPI 또는 macOS Keychain에 저장하고, 전용 브라우저에는 LMS 쿠키만 남겨 원문 보기에 재사용합니다.
비밀번호·자동완성·방문 기록·SSO 쿠키·사이트 저장소·캐시는 자동 정리합니다. 패스키 인증에 필요한 팝업은 이 전용 창에서만 허용됩니다.

로그인만 다시 할 수도 있습니다.

```powershell
npx -y jbnu-lms-mcp@latest login
```

## 3. 이런 질문에 답합니다

| 질문 | 사용하는 도구 |
|---|---|
| 오늘 해야 할 일 알려줘 | `get_daily_briefing` |
| 놓친 것 있나? 중요한 것만 보여줘 | `get_attention_inbox` |
| 이번 주 과제와 마감일 정리해줘 | `get_weekly_study_plan`, `get_upcoming_deadlines` |
| 새로 올라온 공지사항 알려줘 | `get_announcements(only_new)`, `get_recent_changes` |
| 이 공지/과제 원문 열어줘 | `open_lms_source` |
| 이 과제 요구사항과 제출물을 분석해줘 | `get_assignment_detail` |
| 이 과제가 최종 제출됐는지 다시 확인해줘 | `check_assignment_submission` |
| 캘린더에 넣을 확정 일정만 찾아줘 | `get_calendar_sync_candidates` |
| 이번 주차 수업자료를 찾아줘 | `get_course_materials(week)` |
| 지난번 확인 이후 변경된 내용만 보여줘 | `get_recent_changes` |
| 그 파일 내려받아 줘 | `download_course_material` |
| 이 오류를 개발자에게 신고해줘 | `get_feedback_status`, `report_lms_problem` |
| 이런 기능을 추가해달라고 제안해줘 | `get_feedback_status`, `suggest_lms_feature` |
| 전송 못 한 신고를 다시 보내줘 | `retry_feedback_delivery` |
| 내 로컬 신고 기록을 지워줘 | `discard_local_feedback` |

전체 도구 25개의 입력·출력은 [docs/05-tool-spec.md](docs/05-tool-spec.md) 에 있습니다.

응답에는 항상 **기준 시각(Asia/Seoul)**, **로그인 상태**, **마지막 동기화 시각**, **데이터 출처**(Moodle API / 웹 AJAX / LMS 화면 해석 / AI 추정)와 **원문 URL** 이 붙습니다. 실패하면 영향 범위·자동 복구·바로 실행할 다음 행동·비식별 진단 ID를 함께 안내하며, 일부 강좌만 실패한 결과는 완전한 빈 결과와 구분합니다.
과제는 마감·남은 시간·제출 상태·지각 허용 여부를, 공지는 📌 고정(중요)·🆕 새 글·📎 첨부 여부를 표시합니다. 자료를 다시 내려받으면 SHA-256으로 같은 파일인지 확인해 중복 복사본을 만들지 않습니다.

## 4. 인증 방식 요약

전북대 LMS 는 통합인증(SSO) 전용입니다. 모바일 웹서비스 자체는 켜져 있지만 로그인 유형이 앱 내 자격 증명 방식(`typeoflogin=1`)이고, 브라우저 SSO 토큰 발급 경로(`launch.php`)는 활성화되지 않았습니다. 2차 인증을 우회하거나 비밀번호를 도구에 전달하지 않기 위해 브라우저 세션 방식을 사용합니다(조사 근거: [docs/03-auth-decision-record.md](docs/03-auth-decision-record.md)).
그래서 이 도구는 다음처럼 동작합니다.

1. 앱 전용 브라우저 프로필로 Chrome/Edge 창을 열어 사용자가 직접 SSO·패스키를 완료
2. 로그인된 프로필에서 LMS 세션 쿠키와 `sesskey` 만 추출해 Windows DPAPI 또는 macOS Keychain에 저장
3. 성공하면 LMS 이외 쿠키와 비밀번호·자동완성·방문 기록·사이트 저장소·캐시를 지우고, Chrome이 사용자 계정으로 암호화한 LMS 쿠키만 원문 보기용으로 유지
4. 이후 조회는 브라우저 없이 Moodle 웹 AJAX API + LMS 화면 해석으로 수행
5. 공식 토큰이 확보되면(학교 정책 변경 시) 자동으로 공식 REST API 를 우선 사용

로그인 창 방식은 두 가지입니다.

| 모드 | 설명 | 설정 |
|---|---|---|
| `plain` (기본) | 자동화가 전혀 없는 일반 브라우저. Windows는 LMS 홈을 감지해 전용 창을 종료하고, Mac은 사용자가 로그인용 창만 닫으면 세션을 검증·저장 | `JBNU_LMS_LOGIN_MODE=plain` |
| `assisted` (실험적) | Playwright로 완료를 감지. SSO가 개발자도구로 판단할 수 있어 권장하지 않음 | `JBNU_LMS_LOGIN_MODE=assisted` |

편의를 위해 서버가 켜져 있는 동안 20분마다 세션을 연장(keep-alive)합니다. 끄려면 `JBNU_LMS_KEEPALIVE=0`.

## 5. 명령행 도구

```powershell
npx -y jbnu-lms-mcp@latest setup --client codex   # Codex 등록 + 로그인
npx -y jbnu-lms-mcp@latest setup --client claude  # Claude 등록 + 로그인
npx -y jbnu-lms-mcp@latest login                  # 브라우저 로그인
npx -y jbnu-lms-mcp@latest status --verify        # 연결 상태
npx -y jbnu-lms-mcp@latest logout                 # 세션 삭제
npx -y jbnu-lms-mcp@latest doctor                 # 환경 점검
```

## 6. 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `JBNU_LMS_BASE_URL` | `https://lms.jbnu.ac.kr` | LMS 주소 |
| `JBNU_LMS_DATA_DIR` | Windows: `%LOCALAPPDATA%\jbnu-lms-mcp` / Mac: `~/.jbnu-lms-mcp` | 프로필·스냅샷 폴더. Mac 세션 본문은 Keychain에 저장 |
| `JBNU_LMS_BROWSER` | 자동(Chrome→Edge) | `chrome`, `msedge`, 또는 실행 파일 경로 |
| `JBNU_LMS_RETAIN_BROWSER_PROFILE` | `1` | 원문 보기용 LMS 전용 프로필 유지. `0`이면 로그인 성공 후 즉시 폐기 |
| `JBNU_LMS_LOGIN_MODE` | `plain` | `plain` 권장, `assisted`는 실험적 |
| `JBNU_LMS_AUTO_LOGIN` | `1` | 세션 만료 시 자동으로 로그인 창 열기 |
| `JBNU_LMS_AUTO_LOGIN_WAIT_SEC` | `90` | 자동 로그인 대기 시간 |
| `JBNU_LMS_KEEPALIVE` / `JBNU_LMS_KEEPALIVE_MIN` | `1` / `20` | 세션 연장 사용 여부 / 간격(분) |
| `JBNU_LMS_DOWNLOAD_DIR` | `~/Downloads/jbnu-lms` | 자료 저장 폴더 |
| `JBNU_LMS_TIMEOUT_MS` | `20000` | 요청 제한 시간 |
| `JBNU_LMS_MIN_INTERVAL_MS` / `JBNU_LMS_MAX_CONCURRENCY` | `250` / `3` | 요청 속도 제한 |
| `JBNU_LMS_LOG_LEVEL` | `warn` | `silent` `error` `warn` `info` `debug` (stderr) |
| `JBNU_LMS_FEEDBACK_URL` | 없음 | 문제 신고·기능 제안을 즉시 보낼 HTTPS webhook. 미설정 시 로컬 접수 |
| `JBNU_LMS_FEEDBACK_TOKEN` | 없음 | 선택적 webhook Bearer 토큰. 응답·로그·보고서에 저장하지 않음 |
| `JBNU_LMS_FEEDBACK_TIMEOUT_MS` | `8000` | 피드백 원격 전송 제한 시간 |

## 7. 개발

```powershell
npm install
npm run build
npm test                 # 단위·통합·보안 테스트 (mock LMS)
npm run test:security    # 보안 테스트만
npm run check:secrets    # 저장소에 토큰·쿠키가 없는지 검사
JBNU_LIVE=1 npm run test:live           # 실제 LMS 스모크 (로그인 필요)
```

문서: [요구사항](docs/01-requirements.md) · [위협 모델](docs/02-threat-model-privacy.md) · [인증 결정 기록](docs/03-auth-decision-record.md) · [구조와 데이터 흐름](docs/04-architecture-dataflow.md) · [도구 명세](docs/05-tool-spec.md) · [설치 안내](docs/06-install-guide.md) · [장애 해결](docs/07-troubleshooting.md) · [배포 체크리스트](docs/08-release-checklist.md) · [실제 LMS 검증](docs/09-live-verification.md) · [확장 로드맵](docs/10-roadmap-extensions.md) · [오류·복구 UX 계약](docs/11-error-ux.md) · [파서 호환성](docs/12-parser-compatibility.md) · [멀티플랫폼 배포](docs/13-distribution.md) · [피드백 수집 계약](docs/14-feedback-collection.md) · [브랜드·표시 정책](docs/15-branding.md) · [캘린더 동기화 UX](docs/16-calendar-sync-ux-plan.md) · [학생 신뢰성 워크플로](docs/17-student-reliability-workflow.md)

## 8. 보안상 알아 둘 것

- 이 PC 에 로그인할 수 있는 사람은 저장된 LMS 세션을 사용할 수 있습니다. 공용 PC 에서는 사용 후 `disconnect_lms` 를 실행하세요.
- Windows 세션 파일(`session.dpapi`)과 원문 보기용 프로필은 `.gitignore` 로 제외되어 있으며 절대 공유하지 마세요. Mac 세션은 로그인 Keychain에 저장됩니다. 전용 프로필에는 LMS 쿠키만 남기고 방문 기록·SSO 쿠키·자격 증명 데이터는 자동 정리합니다.
- 로그(stderr)에는 토큰·쿠키·비밀번호·과제 본문이 기록되지 않도록 마스킹합니다.
- 문제 신고·기능 제안은 자동 전송하지 않습니다. 제출 내용과 수집 위치를 확인한 뒤 승인해야 하며, 원격 전송본의 삭제·보존 정책은 수집 서버 운영자에게 적용됩니다.
- 상태를 바꾸는 기능(과제 제출, 글쓰기, 메시지)은 구현되어 있지 않습니다. 확장 계획은 [docs/10-roadmap-extensions.md](docs/10-roadmap-extensions.md) 를 보세요.

라이선스: MIT. 전북대학교·유비온과 무관한 비공식 도구이며 LMS 이용약관과 학교 정책을 준수해 사용하세요.
