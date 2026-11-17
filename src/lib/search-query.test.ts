import { describe, expect, it } from 'vitest';
import {
  collectImplicitTerms,
  evaluateSearchAst,
  extractUpstreamPlans,
  parseSearchQuery,
} from './search-query';

function evalTitle(title: string, query: string): boolean {
  const { ast } = parseSearchQuery(query);
  if (!ast) return true;
  const lower = title.toLowerCase();
  return evaluateSearchAst(ast, (term) => lower.includes(term.toLowerCase()));
}

describe('search-query 布林語法解析與求值', () => {
  it('空白字元視為 AND', () => {
    expect(evalTitle('周處除三害 2023 HD', '周處 2023')).toBe(true);
    expect(evalTitle('周處除三害 2024', '周處 2023')).toBe(false);
  });

  it('支援 & / && / ＆ / AND', () => {
    expect(evalTitle('進擊的巨人 最終季', '進擊 & 巨人')).toBe(true);
    expect(evalTitle('進擊的巨人 最終季', '進擊 && 最終季')).toBe(true);
    expect(evalTitle('進擊的巨人 最終季', '進擊 ＆ 巨人')).toBe(true);
    expect(evalTitle('進擊的巨人 最終季', '進擊 AND 巨人')).toBe(true);
    expect(evalTitle('進擊的小孩', '進擊 & 巨人')).toBe(false);
  });

  it('支援 | / || / ｜ / OR', () => {
    expect(evalTitle('黑暗榮耀', '黑暗榮耀 | 魷魚遊戲')).toBe(true);
    expect(evalTitle('魷魚遊戲', '黑暗榮耀 | 魷魚遊戲')).toBe(true);
    expect(evalTitle('魷魚遊戲', '黑暗榮耀 || 魷魚遊戲')).toBe(true);
    expect(evalTitle('魷魚遊戲', '黑暗榮耀｜魷魚遊戲')).toBe(true);
    expect(evalTitle('魷魚遊戲', '黑暗榮耀 OR 魷魚遊戲')).toBe(true);
    expect(evalTitle('繁花', '黑暗榮耀 | 魷魚遊戲')).toBe(false);
  });

  it('支援運算子優先級（AND 優先於 OR）與括號群組', () => {
    // 民視 & 新聞 | 三立 & 財經 => (民視 & 新聞) | (三立 & 財經)
    expect(evalTitle('民視新聞台', '民視 & 新聞 | 三立 & 財經')).toBe(true);
    expect(evalTitle('三立財經台', '民視 & 新聞 | 三立 & 財經')).toBe(true);
    expect(evalTitle('民視財經台', '民視 & 新聞 | 三立 & 財經')).toBe(false);

    // 括號：(民視 | 三立) & 新聞
    expect(evalTitle('民視新聞台', '(民視 | 三立) & 新聞')).toBe(true);
    expect(evalTitle('三立新聞台', '（民視｜三立）新聞')).toBe(true);
    expect(evalTitle('三立都會台', '(民視 | 三立) & 新聞')).toBe(false);
  });

  it('支援排除邏輯（- / ! / ！ / NOT），且不誤傷詞中標點', () => {
    expect(evalTitle('慶餘年第二季', '慶餘年 -解說')).toBe(true);
    expect(evalTitle('慶餘年第二季【影視解說】', '慶餘年 -解說')).toBe(false);
    expect(evalTitle('慶餘年第二季【影視解說】', '慶餘年 !解說')).toBe(false);
    expect(evalTitle('慶餘年第二季【影視解說】', '慶餘年 ！解說')).toBe(false);
    expect(evalTitle('慶餘年第二季【影視解說】', '慶餘年 NOT 解說')).toBe(false);
    expect(evalTitle('慶餘年第二季【預告】', '慶餘年 -(解說 | 預告)')).toBe(false);

    // 詞中連字號與驚嘆號維持字面詞彙
    expect(evalTitle('CCTV-1 綜合', 'CCTV-1')).toBe(true);
    expect(evalTitle('摔跤吧！爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(evalTitle('Fast and Furious 9', 'Fast and Furious')).toBe(true);
  });

  it('支援雙引號字面詞組，保留空白與符號', () => {
    expect(evalTitle('Fast & Furious 9', '"Fast & Furious"')).toBe(true);
    expect(evalTitle('Fast Furious 9', '"Fast & Furious"')).toBe(false);
  });

  it('異常/殘缺運算子不拋錯，維持寬鬆容錯', () => {
    expect(evalTitle('周處除三害', '周處 &')).toBe(true);
    expect(evalTitle('周處除三害', '| 周處 |')).toBe(true);
    expect(evalTitle('周處除三害', '((周處')).toBe(true);
    expect(parseSearchQuery('   ').ast).toBeUndefined();
  });

  it('collectImplicitTerms 僅對純空白 AND 詞組回傳詞列', () => {
    const plain = parseSearchQuery('賽博朋克：邊緣行者 2').ast!;
    expect(collectImplicitTerms(plain)).toEqual(['賽博朋克：邊緣行者', '2']);

    const explicitAnd = parseSearchQuery('賽博朋克 & 2').ast!;
    expect(collectImplicitTerms(explicitAnd)).toBeUndefined();

    const negated = parseSearchQuery('慶餘年 -解說').ast!;
    expect(collectImplicitTerms(negated)).toBeUndefined();
  });
});

describe('extractUpstreamPlans 上游查詢計畫', () => {
  it('單一關鍵字不額外拆分', () => {
    expect(extractUpstreamPlans('周處除三害')).toEqual([{ primary: '周處除三害', fallback: undefined }]);
  });

  it('空白 AND 先查完整詞組並提供核心詞備援', () => {
    expect(extractUpstreamPlans('周處 2023')).toEqual([{ primary: '周處 2023', fallback: '周處' }]);
  });

  it('明確 AND / NOT 僅取正向最長詞彙', () => {
    expect(extractUpstreamPlans('慶餘年 -解說')).toEqual([{ primary: '慶餘年', fallback: undefined }]);
    expect(extractUpstreamPlans('進擊 & 2023')).toEqual([{ primary: '進擊', fallback: undefined }]);
  });

  it('OR 與括號展開多分支，並受數量上限保護', () => {
    expect(extractUpstreamPlans('黑暗榮耀 | 魷魚遊戲')).toEqual([
      { primary: '黑暗榮耀', fallback: undefined },
      { primary: '魷魚遊戲', fallback: undefined },
    ]);
    expect(extractUpstreamPlans('(民視 | 三立) & 新聞')).toEqual([
      { primary: '民視', fallback: undefined },
      { primary: '三立', fallback: undefined },
    ]);
    expect(extractUpstreamPlans('a | b | c | d | e | f', 3)).toHaveLength(3);
  });

  it('純否定查詢沒有正向關鍵字時回傳空陣列', () => {
    expect(extractUpstreamPlans('-解說')).toEqual([]);
  });
});
