# 배포 체크리스트

릴리스 담당자가 태그를 붙이기 전에 아래를 모두 확인한다.

## 코드·빌드

- [ ] `npm ci` 가 깨끗한 환경(새 폴더)에서 성공한다
- [ ] `npm run build` 가 경고 없이 성공하고 `dist/cli.js` 가 생성된다
- [ ] `npm run typecheck` 통과
- [ ] `package.json` 의 `version` 과 `src/config.ts` 의 `APP_VERSION` 이 같다
- [ ] `CHANGELOG` 항목(README 하단 또는 docs) 갱신

## 테스트

- [ ] `npm test` 전부 통과 (단위·통합·보안)
- [ ] `npm run test:security` 통과
- [ ] `npm run check:secrets` 가 "비밀값 없음"
- [ ] `JBNU_LIVE=1 npx vitest run tests/live` 를 실제 계정으로 1회 실행하고 결과(개수만)를 `docs/09-live-verification.md` 에 기록
- [ ] 실제 LMS 에서 `get_daily_briefing`, `get_announcements`, `get_assignment_detail`, `get_course_materials`, `download_course_material` 를 각각 1회 수동 확인

## 보안·개인정보

- [ ] `git status` 에 `session.dpapi`, `browser-profile/`, `state/`, 다운로드 파일이 없다
- [ ] `tests/fixtures` 에 실제 학생·강좌·교수 정보가 없다(익명화 확인)
- [ ] 로그 레벨 debug 로 한 번 실행해 stderr 에 쿠키·토큰·본문이 없는지 눈으로 확인
- [ ] 새로 추가한 도구가 읽기 전용인지 확인 (POST 는 AJAX 조회와 REST 조회뿐)
- [ ] 외부 호스트로 나가는 요청이 없는지 `http/client.ts` 의 호스트 고정이 유지되는지 확인

## 설치 경험 (새 Windows 사용자 관점)

- [ ] README 만 보고 `install.ps1 -RegisterClaude` 로 설치 → Claude 재시작 → 첫 질문에서 로그인 창이 뜨는지 확인
- [ ] `node dist\cli.js doctor` 가 모두 ✅
- [ ] Chrome 없이 Edge 만 있는 PC 에서 로그인 확인
- [ ] 로그인 창을 닫아 버린 경우(plain) `get_auth_status` 가 상황을 설명하는지 확인
- [ ] 세션 만료 상황을 만들어(`disconnect_lms` 후 질문) 자동 로그인 창이 뜨는지 확인

## 문서

- [ ] `docs/03-auth-decision-record.md` 의 조사 결과가 현재 LMS 설정과 일치한다(`doctor` 의 `typeoflogin`, 웹서비스 상태)
- [ ] `docs/05-tool-spec.md` 가 실제 도구 스키마와 일치한다 (`listTools` 출력과 대조)
- [ ] `docs/07-troubleshooting.md` 에 이번 릴리스에서 발견한 문제를 추가

## 배포

- [ ] `git tag v<version>` 및 릴리스 노트
- [ ] 배포 아카이브에 `node_modules`, `dist`, 개인 데이터가 포함되지 않았는지 확인(사용자가 `npm ci` 로 설치)
- [ ] 이전 버전 사용자용 업그레이드 절차(`git pull && npm ci && npm run build`) 안내
