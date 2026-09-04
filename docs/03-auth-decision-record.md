# 인증 방식 결정 기록 (ADR-001)

작성일: 2026-09-04 · 상태: 채택

## 1. 배경

전북대학교 LMS(`https://lms.jbnu.ac.kr`, "JBNU LXP")는 Moodle 4.5 계열 위에 유비온 Coursemos 테마·플러그인을 얹은 시스템이다.
학생이 로컬 MCP 로 자기 학습 데이터를 읽으려면 어떤 인증 수단을 재사용할 수 있는지 실제 네트워크로 조사했다.

## 2. 조사 결과 (2026-09-04, 비인증 상태에서 확인)

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| 웹서비스 활성화 | `POST /lib/ajax/service.php?info=tool_mobile_get_public_config` | `enablewebservices: 1`, `enablemobilewebservice: 1`, `sitename: "JBNU LMS 3.0"` |
| 모바일 로그인 유형 | 같은 응답의 `typeoflogin` | `1` = 앱 내 로그인(LOGIN_VIA_APP). 브라우저 로그인(2·3)이 아님 |
| `login/token.php` (아이디·비밀번호 → 토큰) | GET/POST 요청 | 응답 없이 연결이 끊김(HTTP 000, 타임아웃). 방화벽/WAF 차단으로 판단 |
| `admin/tool/mobile/launch.php` (브라우저 로그인 → 토큰) | GET 요청 | HTTP 404 + Moodle 오류 화면 "플러그인이 활성화되지 않았거나 구성되지 않았습니다"(`pluginnotenabledorconfigured`) |
| LMS 로그인 화면 | `/login/index.php` | 아이디·비밀번호 입력란이 없고 통합인증 버튼만 있음 → `/exsignon/sso/sso_index.php` → `https://sso.jbnu.ac.kr/svc/tk/Auth.eps` 로 POST 리다이렉트 |
| SSO 페이지 | `sso.jbnu.ac.kr` | `Content-Security-Policy` 로 외부 스크립트 차단, 별도 세션(`WMONID`, `PHPSESSID`) |
| 공지 게시판 | `/mod/ubboard/view.php?id=…` | 로그인 필요(303 → 로그인). 전북대 전용 플러그인 `mod_ubboard`(Coursemos) |
| 코스모스 자체 API | `M.cfg.apibase = /r.php/api` | 비인증 404. 공개 문서 없음 → 사용하지 않음 |

Moodle 소스(MOODLE_405_STABLE)로 확인한 근거:

- `admin/tool/mobile/launch.php` 70~75행: `$SESSION->justloggedin` 이 비어 있고 OAuth2 가 아니며 `typeoflogin` 이 브라우저 방식이 아니면 `pluginnotenabledorconfigured` 예외. `justloggedin` 은 로그인 직후 첫 페이지 렌더링 때 `core_renderer` 에서 제거되므로, 이미 로그인된 세션으로는 launch.php 를 쓸 수 없다.
- `lib/db/access.php`: `moodle/webservice:createtoken` 은 manager 전용, `moodle/webservice:createmobiletoken` 은 user 아키타입 허용. 즉 학생이 직접 토큰을 만들 수 있는 공식 경로는 `token.php` 와 `launch.php` 뿐인데 둘 다 전북대에서 막혀 있다.
- `user/managetoken.php`: `moodle/webservice:createtoken` 이 없으면 새 토큰을 만들지 않는다. 다만 이미 발급된 토큰이 있으면 표시되므로 로그인 후 한 번 확인한다.
- `lib/db/services.php` 에서 `'ajax' => true` 인 함수는 브라우저 세션 쿠키 + `sesskey` 로 `lib/ajax/service.php` 를 통해 호출할 수 있다. 확인된 유용한 함수: `core_course_get_enrolled_courses_by_timeline_classification`, `core_calendar_get_action_events_by_timesort`, `core_courseformat_get_state`, `core_course_get_updates_since`, `core_user_get_users_by_field`, `core_course_get_recent_courses`. 반대로 `mod_assign_*`, `core_course_get_contents`, `mod_forum_get_forum_discussions` 는 AJAX 불가(토큰 전용).

## 3. 선택지

| 선택지 | 장점 | 단점 | 판정 |
|---|---|---|---|
| A. `token.php` 로 아이디·비밀번호 → 토큰 | 공식, 단순 | 전북대에서 차단됨. 비밀번호가 도구를 거침 | 불가 |
| B. `launch.php` 브라우저 로그인 → 토큰 | 공식, 비밀번호 불필요 | `typeoflogin=1` 이라 서버가 거부 | 불가 (관리자 설정 변경 시 자동 활성) |
| C. 로그인된 브라우저 세션 재사용 (쿠키 + sesskey) | 학생이 직접 SSO·패스키 완료. 추가 권한 불필요 | 세션 만료(8시간 유휴). 일부 기능은 화면 해석 필요 | **채택** |
| D. SSO 자동화(자격 증명 입력) | 편리 | 정책 위반, 패스키 우회 불가, 보안 위험 | 금지 |

## 4. 결정

1. **인증은 사용자가 직접**: 도구는 로그인용 브라우저 창만 열고, 통합인증·패스키·2차 인증은 사용자가 완료한다. 자격 증명은 읽지도 저장하지도 않는다.
2. **세션 재사용**: 로그인이 끝난 전용 브라우저 프로필에서 LMS 호스트의 쿠키(`MoodleSession*`)와 `sesskey` 만 추출해 DPAPI 로 암호화 저장한다. 이후 조회는 브라우저 없이 HTTP 로 수행한다.
3. **데이터 경로 우선순위**: 공식 REST 토큰(있을 때만) → Moodle AJAX API → LMS 화면 해석. 각 응답에 출처를 표시한다.
4. **전북대 전용 항목**: `mod_ubboard` 공지는 공식 API 가 없으므로 전용 화면 어댑터(`parsers/ubboard.ts`)로 구현한다.
5. **토큰 기회 확보**: 로그인 검증 시 `user/managetoken.php` 에 기존 모바일 토큰이 있으면 검증 후 사용하고, `launch.php` 도 한 번 시도한다(실패가 정상). 학교 정책이 바뀌면 코드 수정 없이 공식 API 경로가 살아난다.

## 5. 로그인 창 방식 (UX 우선 결정, 2026-09-04 사용자 요청)

| 방식 | 동작 | 장점 | 위험 |
|---|---|---|---|
| assisted (기본) | Playwright 가 전용 프로필로 실제 Chrome/Edge 창을 띄우고, 사용자가 SSO 를 끝내 LMS 홈이 뜨면 자동 감지 후 창을 닫음 | 창을 닫을 필요 없음, 즉시 연결 | 학교 SSO 가 자동화 브라우저를 탐지하면 실패 → 자동으로 plain 으로 전환 |
| plain | 자동화가 전혀 없는 일반 브라우저를 띄움. 사용자가 로그인 후 창을 닫으면 같은 프로필을 headless 로 열어 세션만 검증 | SSO 탐지 위험 없음 | 창을 닫아야 완료 |

assisted 모드는 SSO 화면의 내용을 읽거나 조작하지 않는다. 현재 탭의 URL 호스트만 확인하고, LMS 호스트로 돌아온 뒤에만 `M.cfg.userId` 를 읽는다. `--disable-blink-features=AutomationControlled` 는 창을 일반 브라우저처럼 보이게 할 뿐 인증 절차를 우회하지 않는다.

## 6. 편의 기능과 그 대가

- **자동 로그인 창**: 세션 만료를 감지하면 도구가 로그인 창을 스스로 띄우고 최대 90초(`JBNU_LMS_AUTO_LOGIN_WAIT_SEC`) 기다린 뒤 같은 요청을 이어서 처리한다.
- **keep-alive**: MCP 서버가 켜져 있는 동안 20분마다 `/my/` 를 읽어 세션을 연장한다(`JBNU_LMS_KEEPALIVE=0` 으로 끔). 세션이 더 오래 유지되므로 PC 를 잠그지 않은 채 자리를 비우면 위험이 커진다.
- **브라우저 프로필 유지**: `disconnect_lms` 는 기본적으로 브라우저 프로필(SSO 쿠키 포함)을 남겨 다음 로그인을 빠르게 한다. 완전 삭제는 `delete_browser_profile=true`.

## 7. 재검토 조건

- 학교가 `typeoflogin` 을 브라우저 방식으로 바꾸거나 `token.php` 를 열면 → 공식 토큰 경로가 자동 활성화되므로 README 의 "인증 방식" 절만 갱신.
- Coursemos 가 화면 구조를 바꾸면 → `parsers/` 와 `tests/fixtures/` 갱신.
- SSO 가 assisted 창을 차단하면 → 기본 모드를 plain 으로 전환(`JBNU_LMS_LOGIN_MODE=plain`).
