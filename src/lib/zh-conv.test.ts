import { describe, expect, it } from 'vitest';
import { toSimplified } from './zh-conv';
import { getSearchVariants, toTraditional } from './zh-conv-server';

describe('zh-conv 繁簡轉換單元測試', () => {
  it('繁體轉簡體：涵蓋常見影視片名與臺灣/香港異體字', () => {
    expect(toSimplified('周處除三害')).toBe('周处除三害');
    expect(toSimplified('黑暗榮耀')).toBe('黑暗荣耀');
    expect(toSimplified('進擊的巨人')).toBe('进击的巨人');
    expect(toSimplified('葬送的芙莉蓮')).toBe('葬送的芙莉莲');
    expect(toSimplified('慶餘年 第兩季')).toBe('庆余年 第两季');
    expect(toSimplified('魷魚遊戲')).toBe('鱿鱼游戏');
    expect(toSimplified('奧術')).toBe('奥术');
    expect(toSimplified('我們與惡的距離')).toBe('我们与恶的距离');
    expect(toSimplified('不夠善良的我們')).toBe('不够善良的我们');
    expect(toSimplified('臺北市 / 台灣')).toBe('台北市 / 台湾');
    expect(toSimplified('裏程 / 後天 / 皇后')).toBe('里程 / 后天 / 皇后');
    expect(toSimplified('新聞台 / 衛視中文台')).toBe('新闻台 / 卫视中文台');
  });

  it('簡體轉繁體：準確還原常見繁體片名', () => {
    expect(toTraditional('周处除三害')).toBe('周處除三害');
    expect(toTraditional('黑暗荣耀')).toBe('黑暗榮耀');
    expect(toTraditional('进击的巨人')).toBe('進擊的巨人');
    expect(toTraditional('庆余年')).toBe('慶餘年');
    expect(toTraditional('我们与恶的距离')).toBe('我們與惡的距離');
    expect(toTraditional('不够善良的我们')).toBe('不夠善良的我們');
  });

  it('純英文、數字、空字串與繁簡同形詞直接保持原樣', () => {
    expect(toSimplified('')).toBe('');
    expect(toTraditional('')).toBe('');
    expect(toSimplified('Avatar 2022')).toBe('Avatar 2022');
    expect(toTraditional('Avatar 2022')).toBe('Avatar 2022');
    expect(toSimplified('繁花')).toBe('繁花');
    expect(toTraditional('繁花')).toBe('繁花');
  });

  it('支援繁簡夾雜與中英數字混合字串', () => {
    expect(toSimplified('慶余年 Season 2')).toBe('庆余年 Season 2');
    expect(toTraditional('庆餘年 Season 2')).toBe('慶餘年 Season 2');
  });
});

describe('getSearchVariants 上游查詢變體', () => {
  it('繁體輸入優先轉簡體查詢，並保留繁體作為無結果備援', () => {
    expect(getSearchVariants('周處除三害')).toEqual(['周处除三害', '周處除三害']);
  });

  it('簡體輸入以簡體為主，繁體為備援', () => {
    expect(getSearchVariants('周处除三害')).toEqual(['周处除三害', '周處除三害']);
  });

  it('俗體「台」與正體「臺」均能覆蓋且不重複', () => {
    expect(getSearchVariants('台灣故事')).toEqual(['台湾故事', '台灣故事', '臺灣故事']);
  });

  it('繁簡同形或純英文不產生多餘請求變體', () => {
    expect(getSearchVariants('繁花')).toEqual(['繁花']);
    expect(getSearchVariants('Inception 2010')).toEqual(['Inception 2010']);
    expect(getSearchVariants('   ')).toEqual([]);
  });
});
