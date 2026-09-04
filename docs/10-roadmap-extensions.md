# 확장 로드맵

## 1. 원칙

- 1차 버전은 **읽기 전용**이다. 상태를 바꾸는 기능은 별도 도구·별도 확인 절차·별도 문서 없이는 추가하지 않는다.
- 새 데이터 출처는 항상 `adapters/` 에 별도 어댑터로, 화면 해석은 `parsers/` 에 격리한다.
- 사용자 인증은 계속 브라우저 직접 로그인 방식을 유지한다.

## 2. 상태 변경 기능 (설계만, 미구현)

| 기능 | Moodle 경로 | 위험 | 필요한 안전장치 |
|---|---|---|---|
| 과제 파일 제출 | REST `mod_assign_save_submission` + `core_files_upload` (토큰 필요) 또는 화면 폼 POST | 잘못된 파일·중복 제출·마감 후 제출 | 제출 전 파일명·과제명·마감 확인 질문, dry-run 결과 표시, 제출 후 `get_assignment_detail` 로 검증, 실행 취소 불가 고지 |
| 게시글·댓글 작성 | ubboard 화면 폼 POST (공식 API 없음) | 오타·오게시 | 초안 미리보기 → 명시적 승인 |
| 메시지 전송 | REST `core_message_send_instant_messages` | 오발송 | 수신자 확인, 발송 전 승인 |
| 출석 체크 | Coursemos 전용 | 부정 출석 오해 소지 | **구현하지 않음** |

이들은 학교 정책과 이용약관 검토 후, 사용자가 명시적으로 켜는 옵션(`JBNU_LMS_ENABLE_WRITE=1`)과 매번 승인 절차를 갖춘 뒤에만 추가한다. 현재 코드에는 관련 POST 가 없다.

## 3. 성적 조회

`gradereport_user_get_grade_items`(토큰) 또는 `/grade/report/user/index.php?id=` 화면 해석. 개인정보 민감도가 높아 응답에 성적을 넣을지 사용자가 설정으로 선택하게 한다.

## 4. 전북대학교 포털·연구 정보 (사용자 요청 방향)

목표: LMS 외에 **전북대 포털 공지사항, 학사 일정, JUIC(연구 정보 관리)** 를 같은 MCP 로 조회·자동화.

| 대상 | 예상 인증 | 어댑터 설계 | 도구 후보 |
|---|---|---|---|
| 포털 공지 (`www.jbnu.ac.kr` 공지, 학과 공지) | 대부분 공개(비로그인) | `adapters/jbnu-portal-adapter.ts` + `parsers/portal-notice.ts`. RSS 가 있으면 우선 사용 | `get_portal_notices`, `search_portal_notices` |
| 학사 일정 | 공개 | 일정 페이지/ics 해석 → `Deadline` 모델 재사용 | `get_academic_calendar`, `get_daily_briefing` 에 통합 |
| 학생 포털(수강·성적·장학) | 통합인증 SSO (LMS 와 같은 `sso.jbnu.ac.kr`) | 서비스별 일회용 로그인 프로필과 DPAPI 세션을 분리. `SessionManager` 를 다중 호스트로 확장 | `get_enrollment_status`, `get_scholarship_notices` |
| JUIC 연구정보 | SSO 또는 별도 로그인 | 화면 구조 조사 후 결정. 연구비·과제 정보는 민감하므로 읽기 전용 + 응답 최소화 | `get_research_projects`, `get_research_deadlines` |

구현 순서 제안:

1. 공개 포털 공지·학사 일정 (인증 불필요, 위험 낮음) → 브리핑에 "학교 공지" 섹션 추가
2. `SessionManager` 다중 호스트화(호스트 고정 규칙도 호스트 목록으로 확장)
3. 학생 포털 읽기 전용 어댑터
4. JUIC 조사·설계 문서 → 별도 ADR

## 5. 알림·자동화

- Windows 작업 스케줄러로 `jbnu-lms-mcp brief --notify` 를 아침마다 실행해 토스트 알림(새 공지·오늘 마감) — 서버 없이 CLI 로 구현 가능
- Claude Desktop 예약 작업과 연동해 매일 브리핑을 생성
- 캘린더 연동은 [LMS 일정 동기화 UX·안전 설계](./16-calendar-sync-ux-plan.md)에 따라 단계적으로 구현한다. LMS MCP는 제공자 중립적인 일정 후보·동기화 계획만 만들고, Codex·Claude 등 호스트가 연결된 캘린더에 반영한다.
- 기본값은 `도움형 자동`: 구조화된 확정 일정만 1회 상시 동의 범위에서 생성·갱신하고, 애매한 공지·수동 중복·삭제 후보는 검토함에 제안한다.
- 변화가 없을 때는 조용히 유지하고 생성·변경·충돌·실패·사용자 판단 필요 상황만 알린다.

## 6. 품질

- 실제 화면 구조가 바뀔 때를 대비한 계약 테스트: `JBNU_LIVE=1` 스모크를 CI 가 아닌 수동 릴리스 절차로 유지
- 파서 셀렉터를 `parsers/selectors.json` 으로 분리해 코드 수정 없이 조정 가능하게
- 토큰 경로가 열리면 API 어댑터 우선 사용을 실제 데이터로 검증
