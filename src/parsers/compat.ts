/**
 * LMS 화면 변경 내성에 사용하는 공통 계약.
 * 파서는 특정 CSS 하나에 의존하지 않고 알려진 레이아웃 프로필과 의미 기반 폴백을 구분한다.
 */
export type ParserConfidence = 'high' | 'fallback';

export interface ParserCompatibility {
  /** 파서 계약 버전. 구조가 바뀌면 숫자를 올려 진단 로그를 비교한다. */
  contractVersion: 1;
  /** 실제로 일치한 레이아웃 프로필. 사용자·강좌 정보는 포함하지 않는다. */
  layout: string;
  /** fallback이면 결과는 반환하되 운영 로그에서 구조 변경 후보로 관찰한다. */
  confidence: ParserConfidence;
  warnings: string[];
}

export function parserCompatibility(layout: string, confidence: ParserConfidence = 'high', warnings: string[] = []): ParserCompatibility {
  return { contractVersion: 1, layout, confidence, warnings };
}

/** 선택자 배열을 중복 없이 하나의 Cheerio 선택자로 만든다. */
export function selectorUnion(selectors: readonly string[]): string {
  return Array.from(new Set(selectors.map((s) => s.trim()).filter(Boolean))).join(', ');
}

/** 정상적인 빈 화면을 구조 변경과 구분한다. */
export function hasKnownEmptyState(text: string, extra: RegExp[] = []): boolean {
  const patterns = [
    /등록(?:된|되어 있는)?\s*(?:게시글|자료|과제|항목)(?:이|가)?\s*(?:없|존재하지 않)/i,
    /표시할\s*(?:게시글|자료|과제|항목)(?:이|가)?\s*없/i,
    /아직\s*(?:게시글|자료|과제|항목)(?:이|가)?\s*없/i,
    /no\s+(?:posts?|items?|assignments?|activities?)\s+(?:found|available|yet)/i,
    /nothing\s+to\s+display/i,
    ...extra,
  ];
  return patterns.some((re) => re.test(text));
}

/** 표·목록의 제목 비교용. 공백과 끝의 콜론을 제거한다. */
export function normalizeLabel(value: string): string {
  return value.replace(/[：:]\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
