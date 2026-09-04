# MCP 도구 명세

모든 도구는 읽기 전용이며 `content[0].text`(한국어 마크다운)와 `structuredContent`(JSON)를 함께 돌려준다.
오류는 `isError: true` 와 함께 `⚠️ 제목 / 설명 / 해결 방법` 형식의 텍스트, `structuredContent.error = {kind, title, message, hint}` 로 돌려준다.
시각은 모두 ISO 8601(+09:00) 이며 텍스트에는 `2026-09-05(토) 23:59 (1일 13시간 남음)` 형식으로 표시한다.

공통 헤더: `기준 시각 · 로그인 상태(이름) · 마지막 동기화 · 출처(Moodle 공식 API / Moodle 웹 AJAX API / LMS 화면 해석 / 로컬 스냅샷 / AI 추정)`

## 인증

### connect_lms
| 입력 | 타입 | 설명 |
|---|---|---|
| mode | `"assisted"` \| `"plain"` (선택) | 기본 `assisted`. 완료 자동 감지 / 일반 브라우저 |
| wait_seconds | 0~600 (선택) | 완료 대기. 0 이면 창만 열고 즉시 반환 |

출력: `status`(AuthStatus) 또는 `{pending:true, browser, mode}`. 비밀번호·패스키·OTP 를 절대 입력하지 않는다.

### get_auth_status
| verify | boolean (기본 true) | LMS 에 실제 요청해 세션 유효성 확인 |

출력 `status`: `connected, mode(none|session|token|session+token), displayName, userId, connectedAt, lastVerifiedAt, lastSyncAt, storageBackend(dpapi|plain|memory), storageLocation, profileDir, browser, pendingLogin, warnings[], message`.
로그인 브라우저를 닫은 직후 호출하면 검증·저장을 자동으로 마무리한다.

### disconnect_lms
| delete_browser_profile | boolean | 브라우저 프로필(SSO 쿠키) 삭제 |
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

### get_upcoming_deadlines
| days | 1~120 (기본 7) | |
| include_overdue | boolean (기본 true, 최근 14일) | |
| include_submitted | boolean (기본 false) | |
| course_id | number | |

출력 `deadlines[]`: `id, type(assignment|quiz|forum|attendance|other), moduleName, title, courseId, courseName, dueAt, url, actionText, overdue, submissionState, lateAllowed, source`. 텍스트는 기한 초과/오늘/내일/이번 주/다음 주/그 이후로 묶는다.

## 자료

### get_course_materials
| course_id | number (필수) | |
| week | 0~30 | 섹션 제목의 "N주차" 또는 섹션 번호 |
| query | string | 이름·섹션·파일명 검색 |
| kinds | (`file`,`folder`,`link`,`video`,`page`,`other`)[] | |

출력 `materials[]`: `cmId, courseId, courseName, sectionTitle, sectionNumber, week, name, modName, kind, url, files[], visible, availabilityText, source`, `sections[]`.

### download_course_material
| cm_id | number | 모듈(파일 1개일 때) |
| file_url | string | `pluginfile.php` 링크(여러 파일일 때) |
| course_id | number | 폴더 이름·모듈 종류 판별 |
| target_dir | string | 저장 폴더 |

출력 `download`: `path, bytes, contentType, sourceUrl, fileName, courseName`. 200MB 초과는 거부. 파일이 여러 개면 목록과 함께 `file_url` 지정을 요청한다.

## 변경·브리핑

### get_recent_changes
| since | ISO 8601 | 기준 시각(생략 시 스냅샷 시각) |
| course_id | number | |
| update_snapshot | boolean (기본 true) | |

출력 `changes`: `since, firstRun, newAnnouncements, updatedAnnouncements, newAssignments, changedAssignments[{assignment, changes[]}], removedAssignments, newMaterials`, `moduleUpdates[]`(Moodle `core_course_get_updates_since`), `snapshotSavedAt`.

### get_daily_briefing
| days | 1~30 (기본 7) |

출력 `briefing`: `generatedAt, todayLabel, buckets{overdue,today,tomorrow,this_week,next_week,later,no_date}, newAnnouncements, changes, suggestions{source:'estimate', items[]}, notes`.

### get_weekly_study_plan
입력 없음. 출력 `plan`: `weekStart, weekEnd, days[{date,label,isToday,deadlines[],suggestedTasks[]}], nextWeekPreview, overdue, suggestions{estimate}, notes`.

## 오류 종류 → 사용자 메시지

| kind | 제목 | 대표 원인 |
|---|---|---|
| AUTH_REQUIRED | LMS 로그인이 필요합니다 | 세션 없음 |
| AUTH_EXPIRED | LMS 세션이 만료되었습니다 | 로그인 리다이렉트, invalidsesskey |
| AUTH_PENDING | 로그인 진행 중 | 자동 로그인 창이 열렸으나 미완료 |
| BROWSER_BUSY | 브라우저 창이 아직 열려 있습니다 | 프로필 잠금 |
| FORBIDDEN | 접근 권한이 없습니다 | 403, nopermissions |
| NOT_FOUND | 항목을 찾을 수 없습니다 | 404, invalidrecord |
| TIMEOUT / NETWORK / SERVER / RATE_LIMITED | 연결·서버 문제 | 재시도 후에도 실패 |
| PARSE | 화면 형식을 해석하지 못했습니다 | 화면 구조 변경 |
| UNSUPPORTED | 지원되지 않는 기능입니다 | 토큰 없음, 외부 호스트 |
