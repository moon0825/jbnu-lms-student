/**
 * 여러 출처(API, AJAX, 화면)에서 같은 항목이 발견될 때 중복을 제거하고 빈 값을 보완한다.
 * 앞에 오는 항목이 우선순위가 높다(출처 신뢰도 순으로 정렬해서 넘길 것).
 */
export function normalizeKey(...parts: Array<string | number | null | undefined>): string {
  return parts
    .map((p) => (p === null || p === undefined ? '' : String(p)))
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function mergeFill<T extends object>(primary: T, secondary: T): T {
  const out: Record<string, unknown> = { ...(secondary as Record<string, unknown>) };
  for (const [k, v] of Object.entries(primary as Record<string, unknown>)) {
    const isEmpty = v === null || v === undefined || v === '' || v === 'unknown' || (Array.isArray(v) && v.length === 0);
    if (!isEmpty || out[k] === undefined) out[k] = v;
  }
  return out as T;
}

export function dedupeBy<T extends object>(items: T[], keys: (item: T) => Array<string | null>): T[] {
  const result: T[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const ks = keys(item).filter((k): k is string => Boolean(k));
    const existingIdx = ks.map((k) => index.get(k)).find((i) => i !== undefined);
    if (existingIdx === undefined) {
      const pos = result.push(item) - 1;
      for (const k of ks) index.set(k, pos);
    } else {
      result[existingIdx] = mergeFill(result[existingIdx], item);
      for (const k of ks) if (!index.has(k)) index.set(k, existingIdx);
    }
  }
  return result;
}
