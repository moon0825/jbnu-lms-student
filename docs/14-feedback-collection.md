# 문제 신고·기능 제안 수집 계약

버전 0.7.0 · 2026-09-04

## 동작 원칙

오류가 발생했다는 이유만으로 보고서를 만들거나 전송하지 않는다. AI 클라이언트는 먼저 `get_feedback_status`로 수집 위치를 확인하고, 사용자에게 보낼 요약·상세·진단 ID·관련 도구·기술 정보 포함 여부를 보여 준다. 사용자가 그 내용과 목적지를 명시적으로 승인한 경우에만 `confirm_submit=true`로 접수한다.

모든 보고서는 원격 전송 전에 `%LOCALAPPDATA%\jbnu-lms-mcp\feedback\FB-*.json`에 원자적으로 저장된다. 따라서 수집 서버가 중단되어도 사용자는 접수 번호를 받고 나중에 같은 번호로 재전송할 수 있다.

## 수집 모드

| 모드 | 조건 | 결과 |
|---|---|---|
| 로컬 | `JBNU_LMS_FEEDBACK_URL` 없음 또는 안전하지 않은 설정 | `stored_local`; 이 PC에 즉시 접수, 외부 전송 없음 |
| 원격 성공 | 설정된 HTTPS 수집기가 2xx 응답 | `sent`; 로컬 사본도 사용자가 삭제할 때까지 유지 |
| 원격 실패 | 타임아웃, 네트워크 오류, 비-2xx | `queued_retry`; `retry_feedback_delivery`로 재전송 |

외부 주소는 HTTPS만 허용한다. 개발용으로 `localhost`, `127.0.0.1`, `::1`에는 HTTP를 허용한다. 리다이렉트는 따라가지 않아 선택적 Bearer 토큰이 다른 호스트로 전달되지 않는다.

## 환경 설정

```text
JBNU_LMS_FEEDBACK_URL=https://feedback.example.org/v1/reports
JBNU_LMS_FEEDBACK_TOKEN=<optional bearer token>
JBNU_LMS_FEEDBACK_TIMEOUT_MS=8000
```

토큰은 환경 변수로만 전달하며 보고서, 응답, 로그, 배포물에 기록하지 않는다. 중앙 수집기가 없으면 URL과 토큰을 모두 생략한다.

## 전송 JSON

```json
{
  "schemaVersion": 1,
  "reportId": "FB-20260904-12AB34CD",
  "kind": "problem",
  "summary": "공지 목록 조회가 실패합니다",
  "details": "재로그인 뒤에도 같은 현상이 반복됩니다.",
  "diagnosticId": "JBNU-20260904-ABC123",
  "affectedTool": "get_announcements",
  "stepsToReproduce": "연결 확인 후 공지 목록 조회",
  "expectedBehavior": "최신 공지 목록 표시",
  "technicalContext": {
    "appVersion": "0.7.0",
    "platform": "win32",
    "arch": "x64",
    "nodeMajor": 22
  },
  "createdAt": "2026-09-04T05:00:00.000Z"
}
```

요청 헤더는 `Content-Type: application/json`, `Idempotency-Key: <reportId>`, `X-JBNU-LMS-Feedback-Schema: 1`이다. 토큰을 설정한 경우에만 `Authorization: Bearer ...`를 추가한다. 수집기는 같은 `Idempotency-Key`를 여러 번 받아도 보고서를 하나만 생성해야 하며, 정상 접수 시 아무 2xx 응답이나 반환할 수 있다. 응답 본문은 클라이언트가 저장하거나 표시하지 않는다.

## 수집하지 않는 정보

- LMS 쿠키, `sesskey`, Moodle 토큰
- 통합로그인 아이디·비밀번호·패스키·OTP
- 학번, 이메일, 전화번호
- 강좌명과 교수자명
- 공지·과제·수업자료의 제목 또는 본문
- JBNU LMS/SSO 상세 URL과 쿼리
- Windows 사용자명·홈 디렉터리·호스트명

입력 문자열은 저장 전에 비밀값 패턴, 학번·연락처, JBNU URL, `C:\Users\<이름>` 경로를 제거하고 길이를 제한한다. 기술 정보는 앱 버전, 운영체제 종류, CPU 아키텍처, Node 주버전만 선택적으로 포함한다. 자유 서술에 우회적으로 적힌 강좌명 같은 고유명사를 완벽하게 판별할 수는 없으므로, 저장 전 사용자 미리보기와 명시적 승인이 최종 통제다.

## 사용자 권리와 운영자 책임

`get_feedback_status`는 보고서 본문을 다시 노출하지 않고 접수 번호·종류·상태·시각만 보여 준다. `discard_local_feedback`은 로컬 사본을 삭제하지만 이미 원격 전송된 사본을 철회하지 않는다.

중앙 수집기를 운영할 때는 공개 배포 전에 다음을 확정해야 한다.

- 수집기 운영 주체와 연락처
- 보존 기간과 삭제 요청 처리 방법
- 장애 알림과 백업 정책
- 수집 URL의 TLS, 인증, 요청 크기 제한, 속도 제한
- `reportId` 기준 멱등 처리와 감사 로그 정책

현재 저장소에는 특정 사업자의 수집 URL이나 토큰을 하드코딩하지 않는다. 따라서 별도 설정이 없는 배포본은 즉시 로컬 접수까지 완료하며 중앙 전송은 하지 않는다.
