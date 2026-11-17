import { Converter } from 'opencc-js/t2cn';

let t2sConverter: ((text: string) => string) | undefined;

function getT2sConverter(): (text: string) => string {
  if (!t2sConverter) {
    t2sConverter = Converter({ from: 't', to: 'cn' });
  }
  return t2sConverter;
}

/**
 * 繁體（含臺灣/香港異體字）轉簡體，供搜尋匹配、結果去重聚合、頻道篩選正規化使用。
 * 僅匯入 opencc-js/t2cn（約 109 KB），避免將 1.1 MB 的簡轉繁字典打包進瀏覽器端。
 */
export function toSimplified(text: string): string {
  if (!text || /^[\x00-\x7f]*$/.test(text)) return text;
  return getT2sConverter()(text);
}
