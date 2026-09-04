# 시스템 구조와 데이터 흐름

## 1. 구성 요소

```
MCP 클라이언트 (Claude Desktop / Codex)
        │ STDIO (JSON-RPC)
        ▼
src/cli.ts ─► src/server.ts (McpServer, 도구 등록, keep-alive)
                    │
                    ▼
            src/tools/register.ts ── 한국어 응답 포맷 (tools/format.ts)
                    │
                    ▼
            src/services/lms-service.ts   ← 인증 래퍼(자동 로그인), 중복 제거, 출처 표기
              ├─ services/briefing.ts     (일일/주간 계획)
              ├─ services/snapshot.ts     (변경 감지 스냅샷)
              ├─ services/assignment-analysis.ts (요구사항 추정)
              └─ services/cache.ts        (TTL 캐시)
                    │
     ┌──────────────┼─────────────────────┐
     ▼              ▼                     ▼
adapters/         adapters/            adapters/
moodle-api        moodle-ajax          jbnu-session
(REST, 토큰)       (lib/ajax, sesskey)   (HTML 화면) ── parsers/{ubboard,course-page,assign,misc,page-meta}.ts
     └──────────────┴─────────────────────┘
                    │
                    ▼
            src/http/client.ts  (호스트 고정, 타임아웃, 재시도, 속도 제한, 로그인 리다이렉트 감지)
                    │
                    ▼
            https://lms.jbnu.ac.kr

인증:  auth/session-manager.ts ─ auth/browser-login.ts (일반 브라우저)
                              ├─ auth/assisted-login.ts (Playwright 창, 완료 감지)
                              ├─ auth/session-verify.ts (headless 검증·쿠키 추출·토큰 시도)
                              └─ auth/secret-store.ts   (DPAPI / 평문 / 메모리)
```

## 2. 계층 규칙

- **parsers/** 는 순수 함수(HTML 문자열 → 객체)다. 네트워크·상태를 모르며 fixture 로 테스트한다. 화면이 바뀌면 여기만 고친다.
- **adapters/** 는 "어디서 어떻게 가져오는가"만 담당한다. API 어댑터와 화면 어댑터는 서로를 모른다.
- **services/lms-service.ts** 가 어댑터를 조합한다: 공식 API(토큰 있을 때) → AJAX → 화면 순으로 시도하고, 같은 항목을 `dedupeBy` 로 합치며 `source` 를 남긴다.
- **tools/** 는 zod 스키마 검증과 한국어 포맷만 한다. 비즈니스 규칙을 넣지 않는다.

## 3. 주요 데이터 흐름

### 3.1 로그인 (assisted 모드)

1. `connect_lms` → `SessionManager.loginFlow('assisted')`
2. `assistedLogin` 이 전용 프로필(`%LOCALAPPDATA%\jbnu-lms-mcp\browser-profile`)로 Chrome/Edge 창을 띄우고 `/exsignon/sso/sso_index.php` 로 이동
3. 사용자가 SSO·패스키를 완료 → LMS 홈 도착
4. 1초 간격으로 탭 URL 을 확인. 호스트가 `lms.jbnu.ac.kr` 이고 `M.cfg.userId > 0` 이면 완료
5. LMS 호스트 쿠키(`MoodleSession*` 등)와 `sesskey`, `userId`, 표시 이름을 추출 → 창 닫기
6. `SecretStore.save()` → DPAPI 암호화 파일

plain 모드는 2단계에서 자동화 없는 브라우저를 띄우고, 창이 닫힌 뒤 `verifyBrowserSession` 이 같은 프로필을 headless 로 열어 4~6단계를 수행한다. 이때 `managetoken.php` 와 `launch.php` 로 공식 토큰도 한 번 시도한다.

### 3.2 "오늘 해야 할 일" (`get_daily_briefing`)

```
withAuth ─┬─ getUpcomingDeadlines(7일, 초과 14일)
          │     ├─ AJAX core_calendar_get_action_events_by_timesort  (과제·퀴즈 이벤트)
          │     └─ getAssignments ─┬─ 강좌별 /mod/assign/index.php 화면 (마감·제출 상태)
          │                        └─ AJAX 이벤트로 미제출 보강 → dedupe(cmId)
          ├─ getAnnouncements(limit 60)
          │     └─ 강좌별 getCourseOverview → 공지 게시판 cmId → /mod/ubboard/view.php 화면
          ├─ snapshot.load → diffSnapshot (지난 확인 이후 변경)
          └─ buildDailyBriefing → 버킷(기한 초과/오늘/내일/이번 주) + AI 제안(estimate)
```

### 3.3 세션 만료 시 자동 복구

```
도구 호출 → withAuth(fn)
   fn 실행 중 AUTH_EXPIRED (로그인 리다이렉트/ invalidsesskey)
   → cache.clear(), markExpired()
   → autoLogin(): loginFlow(mode, 90초)
        성공 → fn 재실행 → 정상 응답
        미완료 → AUTH_PENDING (한국어 안내: 로그인 후 같은 질문 다시)
```

### 3.4 변경 감지 (`get_recent_changes`)

1. 현재 상태 수집: 공지(강좌별 1페이지), 과제, 자료
2. `snapshot.json` 과 비교 → 새 공지/수정 공지/새 과제/마감·상태 변경/새 자료
3. `since` 이후 시각이 있으면 AJAX `core_course_get_updates_since` 로 모듈 업데이트 이력 추가
4. 스냅샷 갱신(옵션)

## 4. 저장 위치

| 파일 | 내용 | 보호 |
|---|---|---|
| `%LOCALAPPDATA%\jbnu-lms-mcp\session.dpapi` | 쿠키, sesskey, 토큰, userId, 표시 이름, 시각 | DPAPI CurrentUser |
| `%LOCALAPPDATA%\jbnu-lms-mcp\browser-profile\` | 로그인용 브라우저 프로필 | 브라우저 자체 암호화 |
| `%LOCALAPPDATA%\jbnu-lms-mcp\login-pending.json` | 로그인 진행 표식(비밀 없음) | 없음 |
| `%LOCALAPPDATA%\jbnu-lms-mcp\state\snapshot.json` | 제목·마감·상태 메타데이터 | 없음(개인 PC) |
| `~/Downloads/jbnu-lms/<강좌>/` | 다운로드한 자료 | 없음 |

## 5. 오류 분류

`errors.ts` 의 `ErrorKind` 로 통일한다: `AUTH_REQUIRED`, `AUTH_EXPIRED`, `AUTH_PENDING`, `BROWSER_BUSY`, `BROWSER_NOT_FOUND`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `SERVER`, `PARSE`, `UNSUPPORTED`, `STORAGE`, `INVALID_INPUT`, `UNKNOWN`.
HTTP 상태, Moodle `errorcode`, 네트워크 예외를 각각 매핑하며 사용자에게는 제목·설명·해결 방법만 보여 준다. "자료 없음"(빈 목록 + ℹ️ 안내)과 "권한/로그인 문제"(⚠️ 오류)는 응답 형태 자체가 다르다.
