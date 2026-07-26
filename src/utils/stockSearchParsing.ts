export interface StockSuggestion {
  code: string;
  name: string;
  typeName: string;
}

// 行情源可取数的 A 股代码段（registry 里的代码用它校验）。
export const SUPPORTED_STOCK_CODE = /^[036]\d{5}$/;

// 已知的非个股类型。A 股个股的 Classify 取值并不稳定（主板是 "AStock"、
// 科创板是 "23" 等），所以只能做黑名单兜底，不能做白名单。
const REJECTED_CLASSIFY = new Set(['Index', 'Fund', 'Bond', 'HK', 'NEEQ', 'UsStock', 'UK']);

/**
 * 结构化判断：市场编号与代码段必须匹配行情源支持的 A 股。
 * 深市(0)：000/001/002/003 主板 + 300/301 创业板（排除 399 指数段）；
 * 沪市(1)：600/601/603/605 主板 + 688/689 科创板。
 * 沪市指数(000xxx)、基金(5xxxxx)、债券(7xxxxx)、北交所(4/8/92 开头)天然不满足。
 */
export function isSupportedAShare(code: string, mktNum: string): boolean {
  if (mktNum === '0') return /^[03]\d{5}$/.test(code) && !code.startsWith('399');
  if (mktNum === '1') return /^6\d{5}$/.test(code);
  return false;
}

interface SuggestPayload {
  QuotationCodeTable?: {
    Data?: Array<{
      Code?: string;
      Name?: string;
      Classify?: string;
      SecurityTypeName?: string;
      MktNum?: string | number;
    }> | null;
  };
}

export function parseSuggestPayload(payload: unknown): StockSuggestion[] {
  const rows = (payload as SuggestPayload)?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const code = String(row?.Code ?? '');
    const name = String(row?.Name ?? '').trim();
    const classify = String(row?.Classify ?? '');
    const mktNum = String(row?.MktNum ?? '');
    if (
      REJECTED_CLASSIFY.has(classify) ||
      !isSupportedAShare(code, mktNum) ||
      !name ||
      seen.has(code)
    ) {
      return [];
    }
    seen.add(code);
    return [{ code, name, typeName: String(row?.SecurityTypeName ?? '') }];
  });
}

interface UlistPayload {
  data?: {
    diff?:
      | Array<{ f12?: string; f14?: string }>
      | Record<string, { f12?: string; f14?: string }>
      | null;
  } | null;
}

export function parseUlistPayload(payload: unknown): Map<string, string> {
  const diff = (payload as UlistPayload)?.data?.diff;
  const rows = Array.isArray(diff) ? diff : Object.values(diff ?? {});
  const names = new Map<string, string>();
  rows.forEach((row) => {
    const code = String(row?.f12 ?? '');
    const name = String(row?.f14 ?? '').trim();
    if (SUPPORTED_STOCK_CODE.test(code) && name && name !== '-') names.set(code, name);
  });
  return names;
}
