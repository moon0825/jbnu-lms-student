# 멀티플랫폼 배포 준비

버전 0.6.0 · 2026-09-04

## 배포 원칙

MCP 코어는 하나로 유지하고 플랫폼별 포장만 분리한다.

| 대상 | 산출물 | 설치 경험 |
|---|---|---|
| Claude Desktop | `jbnu-lms-student-<version>.mcpb` | Extensions에서 파일 선택 |
| Codex | `.codex-plugin`과 `.mcp.json`을 포함한 플러그인 | 개인/공개 플러그인 설치 |
| 기타 MCP 클라이언트 | `jbnu-lms-mcp-<version>.tgz` 또는 향후 npm 공개 패키지 | STDIO 서버 등록 |
| 개발·감사 | GitHub 저장소와 Release | 소스·해시·변경 기록 확인 |

세션, 브라우저 프로필, 다운로드, 실제 LMS HTML은 어떤 배포물에도 포함하지 않는다. 런타임 데이터는 설치 후 각 사용자 PC의 `%LOCALAPPDATA%\jbnu-lms-mcp`에 생성된다.

중앙 피드백 수집을 운영하는 배포자는 HTTPS webhook과 보존·삭제·연락 정책을 먼저 준비한 뒤 `JBNU_LMS_FEEDBACK_URL`을 설정한다. 수집 주소가 없는 배포본도 정상 동작하며 신고·제안은 해당 사용자 PC에만 접수된다. 인증용 `JBNU_LMS_FEEDBACK_TOKEN`은 배포 아카이브나 저장소에 넣지 않는다.

## 로컬 릴리스 생성

```powershell
npm ci
npm run release:check
npm pack --pack-destination release
npm run release:mcpb
```

`release:mcpb`는 임시 폴더에 실행 의존성만 새로 설치하고, 비밀정보 검사를 실행한 뒤 MCPB manifest를 검증·패키징한다. 임시 폴더는 성공 후 삭제한다.

## npm과 공식 MCP Registry

현재 패키지 이름 `jbnu-lms-mcp`은 2026-09-04 확인 시 npm에 등록되어 있지 않았다. 실제 게시 직전에 다시 확인해야 한다.

MCP Registry 게시 전에는 게시자의 GitHub 사용자명 또는 소유 도메인이 필요하다. 이 값이 확정되면 다음 메타데이터를 추가한다.

- `package.json.repository.url`
- `package.json.mcpName` (`io.github.<owner>/jbnu-lms-student`)
- 동일한 `name`과 npm 패키지 위치를 가진 `server.json`

그 다음 `npm publish` 후 `mcp-publisher login github`, `mcp-publisher publish` 순서로 게시한다. 외부 게시와 계정 인증은 릴리스 담당자의 명시적 승인 후 실행한다.

## 신뢰 확보

- GitHub에서 전체 소스와 재현 가능한 빌드 절차 공개
- npm/MCPB 파일 목록을 릴리스 로그에 첨부
- SHA-256 체크섬 제공
- Git 태그와 `CHANGELOG.md`의 버전 일치
- 실제 사용자 계정으로 만든 HTML·로그를 공개 저장소에 올리지 않음
- 설치 화면에서 `lms.jbnu.ac.kr` 접근과 로컬 저장 위치를 명확히 고지

## 아직 필요한 게시자 정보

- GitHub 사용자 또는 조직명
- 저장소 공개 URL
- 지원/이슈 URL
- 공개 디렉터리 제출 시 사용할 게시자 표시명

이 정보는 코드나 테스트 fixture에 개인 계정 ID를 넣는 것과 다르다. 저장소 메타데이터에는 공개하기로 결정한 게시자 정보만 사용한다.
