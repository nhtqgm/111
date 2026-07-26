export interface StockSuggestion {
  code: string;
  name: string;
  typeName: string;
}

// 仅接受行情源支持的 A 股代码：0/3 开头（深）与 6 开头（沪）。
export const SUPPORTED_STOCK_CODE = /^[036]\d{5}$/;

interface SuggestPayload {
  QuotationCodeTable?: {
    Data?: Array<{
      Code?: string;
      Name?: string;
      Classify?: string;
      SecurityTypeName?: string;
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
    if (row?.Classify !== 'AStock' || !SUPPORTED_STOCK_CODE.test(code) || !name || seen.has(code)) {
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
