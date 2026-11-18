import { describe, expect, it } from 'vitest';
import {
  buildCategoryOptions,
  buildSubTypeOptions,
  classifyCategory,
  groupPrimaryCategory,
  matchesCategoryFilter,
  normalizeTypeName,
  type CategorizableGroup,
} from './category';

describe('normalizeTypeName', () => {
  it('简繁统一并清理首尾与多余空白', () => {
    expect(normalizeTypeName('  動作片  ')).toBe('动作片');
    expect(normalizeTypeName('電視劇')).toBe('电视剧');
    expect(normalizeTypeName('   ')).toBeUndefined();
    expect(normalizeTypeName(undefined)).toBeUndefined();
  });
});

describe('classifyCategory', () => {
  it('正确归类常见采集站分类与繁体别名', () => {
    expect(classifyCategory('电影')).toBe('movie');
    expect(classifyCategory('科幻片')).toBe('movie');
    expect(classifyCategory('動作片')).toBe('movie');
    expect(classifyCategory('动画电影')).toBe('movie');

    expect(classifyCategory('电视剧')).toBe('tv');
    expect(classifyCategory('国产剧')).toBe('tv');
    expect(classifyCategory('韓劇')).toBe('tv');
    expect(classifyCategory('欧美剧')).toBe('tv');

    expect(classifyCategory('动漫')).toBe('anime');
    expect(classifyCategory('日韓動漫')).toBe('anime');
    expect(classifyCategory('动画片')).toBe('anime');

    expect(classifyCategory('综艺')).toBe('variety');
    expect(classifyCategory('大陸綜藝')).toBe('variety');
    expect(classifyCategory('纪录片')).toBe('documentary');
    expect(classifyCategory('紀錄片')).toBe('documentary');
    expect(classifyCategory('爽文短剧')).toBe('short');
    expect(classifyCategory('体育赛事')).toBe('sports');
    expect(classifyCategory(undefined)).toBe('other');
    expect(classifyCategory('未知杂项')).toBe('other');
  });

  it('优先识别短剧与纪录片，避免被宽泛「剧/片」规则抢走', () => {
    expect(classifyCategory('微短剧')).toBe('short');
    expect(classifyCategory('记录片')).toBe('documentary');
  });
});

describe('groupPrimaryCategory 与聚合统计', () => {
  const groups: CategorizableGroup[] = [
    {
      typeName: '动作片',
      items: [{ typeName: '动作片' }, { typeName: '電影' }, { typeName: '科幻片' }],
    },
    {
      typeName: '国产剧',
      items: [{ typeName: '连续剧' }, { typeName: '国产剧' }],
    },
    {
      typeName: '日韩动漫',
      items: [{ typeName: '动漫' }, { typeName: '未知' }],
    },
    {
      typeName: undefined,
      items: [{ typeName: undefined }],
    },
  ];

  it('按多数非 other 来源归属主类别，忽略未知来源', () => {
    expect(groupPrimaryCategory(groups[0])).toBe('movie');
    expect(groupPrimaryCategory(groups[1])).toBe('tv');
    expect(groupPrimaryCategory(groups[2])).toBe('anime');
    expect(groupPrimaryCategory(groups[3])).toBe('other');
  });

  it('buildCategoryOptions 按固定顺序输出存在的大类计数', () => {
    expect(buildCategoryOptions(groups)).toEqual([
      { value: 'movie', label: '电影', count: 1 },
      { value: 'tv', label: '电视剧', count: 1 },
      { value: 'anime', label: '动漫', count: 1 },
      { value: 'other', label: '其他', count: 1 },
    ]);
  });

  it('buildSubTypeOptions 对同一分组内的重复细分类型只计一次', () => {
    const movieGroups: CategorizableGroup[] = [
      { typeName: '动作片', items: [{ typeName: '动作片' }, { typeName: '動作片' }, { typeName: '科幻片' }] },
      { typeName: '科幻片', items: [{ typeName: '科幻片' }] },
      { typeName: '国产剧', items: [{ typeName: '国产剧' }] },
    ];
    expect(buildSubTypeOptions(movieGroups, 'movie')).toEqual([
      { value: '科幻片', label: '科幻片', count: 2 },
      { value: '动作片', label: '动作片', count: 1 },
    ]);
  });

  it('matchesCategoryFilter 同时支持大类与细分类型组合过滤', () => {
    expect(matchesCategoryFilter(groups[0], 'all', 'all')).toBe(true);
    expect(matchesCategoryFilter(groups[0], 'movie', 'all')).toBe(true);
    expect(matchesCategoryFilter(groups[0], 'movie', '科幻片')).toBe(true);
    expect(matchesCategoryFilter(groups[0], 'movie', '喜剧片')).toBe(false);
    expect(matchesCategoryFilter(groups[0], 'tv', '动作片')).toBe(false);
  });
});
