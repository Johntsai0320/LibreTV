import { Converter } from 'opencc-js/cn2t';
import { toSimplified } from './zh-conv';

let s2tConverter: ((text: string) => string) | undefined;

function getS2tConverter(): (text: string) => string {
  if (!s2tConverter) {
    s2tConverter = Converter({ from: 'cn', to: 't' });
  }
  return s2tConverter;
}

/**
 * 簡體轉繁體（僅限伺服器端匯入，避免將簡轉繁大型字典打進客戶端 bundle）。
 */
export function toTraditional(text: string): string {
  if (!text || /^[\x00-\x7f]*$/.test(text)) return text;
  return getS2tConverter()(text);
}

/**
 * 產生向上游資源站查詢的關鍵字變體列表（自動去重）：
 * 1. 簡體正規化版本優先（絕大多數蘋果 CMS 源站以簡體建立索引）
 * 2. 使用者原始輸入（保留臺灣慣用「台」字寫法等混合情況）
 * 3. 繁體轉換版本（覆蓋繁體片庫源站，當主查詢回傳 0 筆時作為備援）
 */
export function getSearchVariants(wd: string): string[] {
  const trimmed = wd.trim();
  if (!trimmed) return [];

  const simplified = toSimplified(trimmed);
  const traditional = toTraditional(simplified);

  const seen = new Set<string>();
  const variants: string[] = [];
  for (const candidate of [simplified, trimmed, traditional]) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      variants.push(candidate);
    }
  }
  return variants;
}

export { toSimplified };
