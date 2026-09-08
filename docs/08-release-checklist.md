# 배포 체크리스트

릴리스 담당자가 태그를 붙이기 전에 아래를 모두 확인한다.

## 코드·빌드

- [ ] `npm ci` 가 깨끗한 환경(새 폴더)에서 성공한다
- [ ] `npm run build` 가 경고 없이 성공하고 `dist/cli.js` 가 생성된다
- [ ] `npm run typecheck` 통과
- [ ] `package.json` 의 `version` 과 `src/config.ts` 의 `APP_VERSION` 이 같다
- [ ] 클린 빌드 뒤 `src/**/*.ts`에 대응하지 않는 오래된 `dist/**/*.js`가 없다
- [ ] `CHANGELOG` 항목(README 하단 또는 docs) 갱신

## 테스트

- [ ] `npm test` 전부 통과 (단위·통합·보안)
- [ ] `npm run test:security` 통과
- [ ] `npm run check:secrets` 가 "비밀값 없음"
- [ ] 계정 ID, 실명, 실제 이메일·전화번호, 고정 `C:\Users\<사용자>` 경로가 코드·fixture·문서에 없다
- [ ] 대표 오류 응답에 작업명·영향 범위·자동 복구·다음 행동·진단 ID가 있고 텍스트에 내부 오류 코드가 없는지 확인
- [ ] 429/503의 `Retry-After`, 디스크 부족, 200MB 초과 다운로드가 각각 올바른 오류 종류와 복구 행동으로 분류되는지 확인
- [ ] 일부 강좌 실패 + 결과 0건을 정상 빈 결과와 다르게 표시하는지 확인
- [ ] 피드백 로컬 접수·HTTPS 성공·원격 실패 후 재전송·로컬 삭제 테스트 통과
- [ ] 피드백 입력에서 쿠키·토큰·학번·이메일·전화번호·JBNU URL·Windows 사용자 경로가 제거되는지 확인
- [ ] `open_lms_source`가 외부 origin, 로그인·로그아웃·관리 경로, 민감·상태 변경 쿼리를 브라우저 실행 전에 차단하는지 확인
- [ ] 원문 브라우저 종료 뒤 LMS 쿠키 DB는 유지되고 자격 증명·방문 기록·SSO 쿠키·사이트 저장소·캐시는 제거되는지 확인
- [ ] `JBNU_LIVE=1 npm run test:live` 를 실제 계정으로 1회 실행하고 결과(개수만)를 `docs/09-live-verification.md` 에 기록
- [ ] 실제 LMS 에서 `get_daily_briefing`, `get_announcements`, `get_assignment_detail`, `get_course_materials`, `download_course_material` 를 각각 1회 수동 확인

## 보안·개인정보

- [ ] `git status` 에 `session.dpapi`, `browser-profile/`, `state/`, 다운로드 파일이 없다
- [ ] `tests/fixtures` 에 실제 학생·강좌·교수 정보가 없다(익명화 확인)
- [ ] 로그 레벨 debug 로 한 번 실행해 stderr 에 쿠키·토큰·본문이 없는지 눈으로 확인
- [ ] LMS 도구가 조회 전용인지 확인 (LMS POST 는 AJAX 조회와 REST 조회뿐)
- [ ] LMS 인증 요청의 호스트 고정이 유지되고 피드백 전송은 사용자 승인 + 설정된 HTTPS 수집기로만 분리되는지 확인

## 설치 경험 (새 Windows/macOS 사용자 관점)

- [ ] README 만 보고 `install.ps1 -RegisterClaude` 로 설치 → Claude 재시작 → 첫 질문에서 로그인 창이 뜨는지 확인
- [ ] `node dist\cli.js doctor` 가 모두 ✅
- [ ] Chrome 없이 Edge 만 있는 PC 에서 로그인 확인
- [ ] 로그인 창을 닫아 버린 경우(plain) `get_auth_status` 가 상황을 설명하는지 확인
- [ ] 세션 만료 상황을 만들어(`disconnect_lms` 후 질문) 자동 로그인 창이 뜨는지 확인
- [ ] 채팅 링크 대신 `open_lms_source`로 공지 원문을 열고 두 번째 실행부터 재로그인 없이 열리는지 확인

## 문서

- [ ] `docs/03-auth-decision-record.md` 의 조사 결과가 현재 LMS 설정과 일치한다(`doctor` 의 `typeoflogin`, 웹서비스 상태)
- [ ] `docs/05-tool-spec.md` 가 실제 도구 스키마와 일치한다 (`listTools` 출력과 대조)
- [ ] `docs/11-error-ux.md`의 구조화 오류 필드와 실제 MCP 응답이 일치한다
- [ ] `docs/14-feedback-collection.md`와 실제 피드백 payload·동의·재시도 계약이 일치한다
- [ ] 플러그인 카드·MCPB 아이콘이 공식 UI 원본과 일치하고 비공식 도구 고지가 보이는지 확인
- [ ] 공개 배포라면 전북대학교 UI 사용 허가와 최신 지침을 확인하고 `docs/15-branding.md`에 근거를 기록
- [ ] `docs/07-troubleshooting.md` 에 이번 릴리스에서 발견한 문제를 추가

## 배포

- [ ] `git tag v<version>` 및 릴리스 노트
- [ ] 배포 아카이브에 `dist`가 포함되고 `node_modules`, 세션·쿠키·다운로드 파일 등 개인 데이터가 포함되지 않았는지 확인(사용자가 `npm ci` 로 의존성 설치)
- [ ] `npm pack --dry-run`의 파일 목록이 `package.json.files` 허용목록과 일치한다
- [ ] `npm run release:mcpb`가 manifest 검증과 비밀정보 검사를 통과한다
- [ ] npm/MCPB SHA-256을 릴리스 노트에 기록한다
- [ ] 이전 버전 사용자용 업그레이드 절차(`git pull && npm ci && npm run build`) 안내
