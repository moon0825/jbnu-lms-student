# MCP 도구 명세

모든 LMS 도구는 조회 전용이며 `content[0].text`(한국어 마크다운)와 `structuredContent`(JSON)를 함께 돌려준다. 피드백 도구만 사용자 승인 후 로컬 보고서 저장과 선택적 HTTPS 전송을 수행한다.
오류는 `isError: true`와 함께 제목, 설명, 실패 작업, 영향 범위, 자동 복구, 해결 방법, 다음 행동, 문제 신고 안내, 진단 ID를 텍스트로 돌려준다. `structuredContent.error`에는 `kind, severity, title, message, hint, operation, impact, automaticRecovery, retryable, retryAfterSeconds, recoveryAction, reportAction, diagnosticId, occurredAt`가 들어간다. 자세한 계약은 `docs/11-error-ux.md`를 따른다.
시각은 모두 ISO 8601(+09:00) 이며 텍스트에는 `2026-09-05(토) 23:59 (1일 13시간 남음)` 형식으로 표시한다.

공통 헤더: `기준 시각 · 로그인 상태(이름) · 마지막 동기화 · 출처(Moodle 공식 API / Moodle 웹 AJAX API / LMS 화면 해석 / 로컬 스냅샷 / AI 추정)`

## 인증

### connect_lms
| 입력 | 타입 | 설명 |
|---|---|---|
| wait_seconds | 0~600 (선택) | 완료 대기. 0 이면 창만 열고 즉시 반환 |

출력: `status`(AuthStatus) 또는 `{pending:true, browser, mode}`. 비밀번호·패스키·OTP 를 절대 입력하지 않는다.

### get_auth_status
| verify | boolean (기본 true) | LMS 에 실제 요청해 세션 유효성 확인 |

출력 `status`: `connected, mode(none|session|token|session+token), displayName, userId, connectedAt, lastVerifiedAt, lastSyncAt, storageBackend(dpapi|plain|memory), storageLocation, profileDir, browser, pendingLogin, warnings[], message`.
로그인 브라우저를 닫은 직후 호출하면 검증·저장을 자동으로 마무리한다.

### open_lms_source

| 입력 | 타입 | 설명 |
|---|---|---|
| url | URL | 다른 LMS 도구가 반환한 강좌·공지·과제·자료·달력 원문 주소 |

채팅 내부 브라우저와 LMS 세션이 분리되어 있을 때 자동화 없는 전용 Chrome/Edge로 원문을 연다. `baseUrl`과 동일한 origin의 읽기 화면만 허용하고 `sesskey`, 토큰, 상태 변경 쿼리를 차단한다. 불필요한 검색어와 fragment는 제거한다. 최초 1회 또는 세션 만료 시에만 사용자가 공식 로그인 화면에서 직접 인증한다.

### disconnect_lms
| delete_browser_profile | boolean | 원문 보기용 전용 브라우저 프로필(LMS 쿠키) 삭제 |
| delete_snapshot | boolean | 변경 감지 스냅샷 삭제 |

## 강좌

### list_courses
| include_all | boolean | 종료·예정 강좌 포함 |

출력 `courses[]`: `id, fullName, shortName, url, startDate, endDate, progress, category, hidden, inProgress, source`.

### get_course_overview
| course_id | number (필수) |

출력 `overview`: `course, sections[{id, number, title, visible, summaryText, modules[{cmId, modName, name, url, visible, availabilityText, descriptionText, files[], dates[]}]}], noticeBoard{cmId,url}|null, source, fetchedAt`.

## 공지

### get_announcements
| course_id | number | 특정 강좌만 |
| limit | 1~200 (기본 20) | |
| pages | 1~5 (기본 1) | 강좌당 게시판 페이지 수 |
| only_new | boolean | 지난 확인 이후 새 글만 |

출력 `announcements[]`: `id("ubboard:<cmid>:<bwid>"), courseId, courseName, boardCmId, title, author, createdAt, modifiedAt, isPinned, isNew, hasAttachment, views, url, source`. 텍스트에서 📌 고정, 🆕 새 글, 📎 첨부.

### get_announcement_detail
| board_cm_id + bwid | number | 또는 |
| url | string | `/mod/ubboard/article.php?id=..&bwid=..` |
| max_chars | 200~20000 (기본 6000) | 본문 길이 |

출력 `announcement`: 위 필드 + `bodyText, attachments[{name,url}]`. 본문은 "원문" 블록으로 표시한다.

## 과제

### get_assignments
| course_id | number | |
| include_submitted | boolean (기본 true) | |

출력 `assignments[]`: `id, cmId, courseId, courseName, title, url, allowSubmissionsFromAt, dueAt, cutoffAt, submissionStatusText, submissionState(submitted|not_submitted|draft|no_submission_required|unknown), gradingStatusText, gradeText, lateAllowed(true|false|null), source, extra`.

### get_assignment_detail
| cm_id | number | 또는 |
| url | string | `/mod/assign/view.php?id=..` |

출력 `assignment`(위 필드 + `descriptionText, attachments, submittedFiles, timeRemainingText`) 와 `analysis`(source `estimate`): `requirementLines, deliverableFormats, lengthHints, dateMentions, teamWork, submissionMethodHints, attachmentsToRead, cautions`.

### check_assignment_submission
| cm_id | number | 또는 |
| url | string | `/mod/assign/view.php?id=..` |

목록 캐시가 아니라 과제 상세 화면을 다시 읽는다. 출력 `submissionCheck`: `assignmentId, cmId, title, courseId, courseName, sourceUrl, verifiedAt, verdict(confirmed_submitted|draft_not_submitted|not_submitted|no_submission_required|unknown), risk, finalSubmissionConfirmed, schoolIssuedReceipt(false), dueAt, cutoffAt, submittedFiles[], evidence[], warnings[], nextAction, verificationFingerprint`.
확인 지문은 상태 비교용 SHA-256이며 학교가 발급한 공식 영수증이나 제출 증명서를 대신하지 않는다.

### get_upcoming_deadlines
| days | 1~120 (기본 7) | |
| include_overdue | boolean (기본 true, 최근 14일) | |
| include_submitted | boolean (기본 false) | |
| course_id | number | |

출력 `deadlines[]`: `id, type(assignment|quiz|forum|attendance|other), moduleName, title, courseId, courseName, dueAt, url, actionText, overdue, submissionState, lateAllowed, source`. 텍스트는 기한 초과/오늘/내일/이번 주/다음 주/그 이후로 묶는다.

### get_calendar_sync_candidates
| days | 1~120 (기본 30) | |
| course_id | number | |
| include_overdue | boolean (기본 false) | 지난 마감을 검토 후보로 포함 |

출력 `candidates[]`: `fingerprint, sourceKey, sourceKind, title, courseId, courseName, dueAt, timezone, sourceUrl, confidence(exact), disposition(auto_ready|review_required), dispositionReason, suggestedReminderMinutes`. `writePerformed`는 항상 `false`다. 이 도구는 LMS의 구조화된 마감만 정규화하며 캘린더 조회·생성·수정은 하지 않는다.

## 자료

### get_course_materials
| course_id | number (필수) | |
| week | 0~30 | 섹션 제목의 "N주차" 또는 섹션 번호 |
| query | string | 이름·섹션·파일명 검색 |
| kinds | (`file`,`folder`,`link`,`video`,`page`,`other`)[] | |

출력 `materials[]`: `cmId, courseId, courseName, sectionTitle, sectionNumber, week, name, modName, kind, url, files[], visible, availabilityText, source`, `sections[]`.

### get_activity_completion
| course_id | number (필수) | |
| only_incomplete | boolean (기본 true) | false 면 완료 항목도 포함 |

완료(이수) 추적이 켜진 활동만 판정한다(미시청 영상·미이수 활동 확인용). 추가 네트워크 없이 `get_course_overview` 결과의 `completionState`(0=미완료, 1/2/3=완료 계열, null=추적 없음)를 사용한다. 추적이 없는 활동은 미이수로 단정하지 않는다. 출력 `completion`: `courseId, courseName, courseUrl, trackedTotal, incompleteTotal, activities[]{cmId,name,modName,kind,url,sectionTitle,week,complete,completionState}, source, notes`.

### download_course_material
| cm_id | number | 모듈(파일 1개일 때) |
| file_url | string | `pluginfile.php` 링크(여러 파일일 때) |
| course_id | number | 폴더 이름·모듈 종류 판별 |
| target_dir | string | 저장 하위 폴더(기본 다운로드 폴더 하위만 허용, 폴더 밖 경로는 거부) |

출력 `download`: `path, bytes, contentType, sourceUrl, fileName, courseName, sha256, reusedExisting`. 200MB 초과는 거부. 파일이 여러 개면 목록과 함께 `file_url` 지정을 요청한다. 임시 파일에 쓴 뒤 같은 폴더 안에서 원자적으로 이름을 바꾸므로 실패한 다운로드가 완성 파일처럼 남지 않는다. 같은 이름 또는 번호가 붙은 기존 파일과 SHA-256이 같으면 그 경로를 재사용한다.

## 변경·브리핑

### get_recent_changes
| since | ISO 8601 | 기준 시각(생략 시 스냅샷 시각) |
| course_id | number | |
| update_snapshot | boolean (기본 true) | |

출력 `changes`: `since, firstRun, newAnnouncements, updatedAnnouncements, newAssignments, changedAssignments[{assignment, changes[]}], removedAssignments, newMaterials`, `moduleUpdates[]`(Moodle `core_course_get_updates_since`), `snapshotSavedAt`.

### get_attention_inbox
| days | 1~120 (기본 14) | 마감을 볼 기간 |
| course_id | number | 특정 강좌만 |
| update_snapshot | boolean (기본 true) | 로컬 비교 기준 갱신 |

현재 마감과 `get_recent_changes`의 결과를 같은 ID 체계로 합친다. 출력 `inbox`: `generatedAt, firstRun, since, topItems[], remainingItems[], counts`. 각 항목은 `id, kind, title, courseId, courseName, dueAt, sourceUrl, priority, status, signals[], recommendedAction, source, calendarCandidate`를 갖는다. 상위 3개는 긴급도와 마감순이며, 사라진 과제는 자동 삭제가 아니라 검토 대상으로 표시한다.

### get_daily_briefing
| days | 1~30 (기본 7) |

출력 `briefing`: `generatedAt, todayLabel, buckets{overdue,today,tomorrow,this_week,next_week,later,no_date}, newAnnouncements, changes, suggestions{source:'estimate', items[]}, notes`.

### get_weekly_study_plan
입력 없음. 출력 `plan`: `weekStart, weekEnd, days[{date,label,isToday,deadlines[],suggestedTasks[]}], nextWeekPreview, overdue, suggestions{estimate}, notes`.

## 문제 신고·기능 제안

### report_lms_problem / suggest_lms_feature

| 입력 | 타입 | 설명 |
|---|---|---|
| summary | string 5~160자 | 사용자가 확인한 요약 |
| details | string 10~4000자 | 상세 설명. 학업 원문·개인정보 제외 |
| diagnostic_id | `JBNU-YYYYMMDD-XXXXXX` | 오류 응답의 진단 ID |
| affected_tool | string | 관련 MCP 도구 이름 |
| steps_to_reproduce | string 최대 2000자 | 선택적 재현 단계 |
| expected_behavior | string 최대 2000자 | 기대 동작 또는 개선 결과 |
| include_technical_context | boolean, 기본 true | 앱 버전·OS·아키텍처·Node 주버전만 포함 |
| confirm_submit | `true` 필수 | 사용자가 정확한 내용과 수집 위치를 승인했음을 확인 |

출력 `receipt`: `reportId, kind, createdAt, delivery(stored_local|sent|queued_retry), collectorMode(local|remote), collectorOrigin, retryAvailable, privacy`. 인증정보·학번·연락처·JBNU URL·로컬 사용자 경로는 저장 전에 제거한다.

### get_feedback_status

입력 없음. 출력 `status`: 수집 방식, 원격 origin, 설정 경고, 상태별 개수, 최근 접수 번호·종류·상태·시각, 로컬 보관 위치. 보고서 본문은 반환하지 않는다.

### retry_feedback_delivery

| limit | 1~100, 기본 20 | `queued_retry` 보고서 최대 재전송 건수 |

출력 `retry`: `attempted, sent, remaining, endpointConfigured`. 같은 `reportId`를 `Idempotency-Key`로 재사용한다.

### discard_local_feedback

| report_id | `FB-YYYYMMDD-XXXXXXXX` | 삭제할 로컬 접수 번호 |
| confirm_discard | `true` 필수 | 로컬 사본 삭제 확인 |

로컬 JSON 사본만 삭제한다. `delivery=sent`였던 원격 사본은 철회하지 못하며 응답에서 이를 명시한다.

## 오류 종류 → 사용자 메시지

| kind | 제목 | 대표 원인 |
|---|---|---|
| AUTH_REQUIRED | LMS 로그인이 필요합니다 | 세션 없음 |
| AUTH_EXPIRED | LMS 세션이 만료되었습니다 | 로그인 리다이렉트, invalidsesskey |
| AUTH_PENDING | 로그인 진행 중 | 자동 로그인 창이 열렸으나 미완료 |
| BROWSER_BUSY | 브라우저 창이 아직 열려 있습니다 | 프로필 잠금 |
| FORBIDDEN | 접근 권한이 없습니다 | 403, nopermissions |
| NOT_FOUND | 항목을 찾을 수 없습니다 | 404, invalidrecord |
| TIMEOUT / NETWORK / SERVER / RATE_LIMITED | 연결·서버 문제 | 제한 재시도 후에도 실패 |
| MAINTENANCE | LMS 점검·일시 중단 | HTTP 503 |
| PARSE | 화면 형식을 해석하지 못했습니다 | 화면 구조 변경 |
| UNSUPPORTED | 지원되지 않는 기능입니다 | 토큰 없음, 외부 호스트 |
| STORAGE / DISK_FULL | 로컬 저장 실패 | 권한 또는 저장 공간 부족 |
| DOWNLOAD_TOO_LARGE | 다운로드 한도 초과 | 200MB 초과 |

여러 강좌 중 일부만 실패하면 성공한 데이터와 함께 `notes[] = {level, text, code?, scope?, retryable?, recoveryAction?}`를 반환한다. 경고가 있는 0건 결과는 완전한 빈 결과로 표현하지 않는다.

## 도구 주석(annotations)

각 도구는 MCP `annotations`로 부작용을 기계가독 형태로 알린다. 조회 전용 도구는 `readOnlyHint:true`, 로컬 상태를 바꾸는 도구(`get_recent_changes`, `get_attention_inbox`: 스냅샷 갱신)와 외부 전송(`report_lms_problem`, `suggest_lms_feature`, `retry_feedback_delivery`)은 `readOnlyHint:false`, 삭제성 도구(`disconnect_lms`, `discard_local_feedback`)는 `destructiveHint:true`, 파일 저장(`download_course_material`)·원문 열기(`open_lms_source`)·로그인(`connect_lms`)은 `readOnlyHint:false`로 표시한다. 호스트는 이를 근거로 자동 승인/확인 정책을 다르게 적용할 수 있다.

## CLI (예약·운영)

| 명령 | 설명 |
|---|---|
| `serve` | MCP STDIO 서버(기본) |
| `login [--plain] [--wait N]` | 일반 브라우저로 통합인증 로그인 |
| `verify` | 로그인한 프로필의 쿠키로 세션만 검증·저장 |
| `status [--verify]` / `doctor` | 연결 상태 / 환경 점검 |
| `brief [--weekly] [--days N] [--json] [--quiet-if-empty] [--out FILE]` | **예약용 브리핑.** background 모드라 세션 만료 시 로그인 창을 열지 않고 종료 코드 2로 끝난다. Windows 작업 스케줄러 등에서 매일 실행 |
| `logout [--delete-profile]` / `config [--client claude\|codex] [--write]` | 연결 해제 / MCP 클라이언트 설정 |
