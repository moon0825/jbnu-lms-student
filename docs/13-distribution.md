# 멀티플랫폼 배포 준비

버전 0.8.0 · 2026-09-08

## 배포 원칙

MCP 코어는 하나로 유지하고 플랫폼별 포장만 분리한다.

| 대상 | 산출물 | 설치 경험 |
|---|---|---|
| Claude Desktop | `jbnu-lms-student-<version>.mcpb` | Extensions에서 파일 선택 |
| Codex | `.codex-plugin`과 `.mcp.json`을 포함한 플러그인 | 개인/공개 플러그인 설치 |
| Windows/macOS 일반 사용자 | 공개 npm 패키지 | `npx ... setup` 한 줄로 등록·로그인 |
| 기타 MCP 클라이언트 | `jbnu-lms-mcp-<version>.tgz` 또는 npm 공개 패키지 | STDIO 서버 등록 |
| 개발·감사 | GitHub 저장소와 Release | 소스·해시·변경 기록 확인 |

세션, 브라우저 프로필, 다운로드, 실제 LMS HTML은 어떤 배포물에도 포함하지 않는다. 런타임 프로필·스냅샷은 Windows `%LOCALAPPDATA%\jbnu-lms-mcp`, Mac `~/.jbnu-lms-mcp`에 생성되며 세션 본문은 각각 DPAPI와 로그인 Keychain에 저장된다.

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

공개 npm 패키지는 `jbnu-lms-mcp`, 공식 MCP Registry 이름은 `io.github.moon0825/jbnu-lms-student`이다. 게시 메타데이터는 다음 파일에서 함께 버전을 올린다.

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

## 게시 상태

- GitHub: `moon0825/jbnu-lms-student`
- npm: `jbnu-lms-mcp`
- MCP Registry: `io.github.moon0825/jbnu-lms-student`
- 지원/오류 접수: GitHub Issues와 사용자가 승인한 MCP 피드백 도구
