import { toSimplified } from './zh-conv';

export type VideoCategory =
  | 'movie'
  | 'tv'
  | 'anime'
  | 'variety'
  | 'documentary'
  | 'short'
  | 'sports'
  | 'other';

export const CATEGORY_ORDER: ReadonlyArray<VideoCategory> = [
  'movie',
  'tv',
  'anime',
  'variety',
  'documentary',
  'short',
  'sports',
  'other',
];

export const CATEGORY_LABELS: Record<VideoCategory, string> = {
  movie: '电影',
  tv: '电视剧',
  anime: '动漫',
  variety: '综艺',
  documentary: '纪录片',
  short: '短剧',
  sports: '体育',
  other: '其他',
};

export interface CategoryOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

export interface CategorizableGroup {
  typeName?: string;
  items: ReadonlyArray<{ typeName?: string }>;
}

/** 归一化 CMS 分类名称（简繁统一、去多余空白） */
export function normalizeTypeName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return toSimplified(trimmed);
}

/** 将采集站细分 type_name 归类为标准大类 */
export function classifyCategory(typeName?: string): VideoCategory {
  const s = normalizeTypeName(typeName);
  if (!s) return 'other';

  if (/(?:短剧|微短剧|爽剧|擦边|女频|男频|反转|脑洞|都市日常|现代言情|古装仙侠)/.test(s)) {
    return 'short';
  }
  if (/(?:纪录|记录)/.test(s)) {
    return 'documentary';
  }
  if (/(?:体育|赛事|足球|篮球|网球|羽毛球|乒乓球|斯诺克|台球|赛车|f1|nba|cba|英超|西甲|意甲|德甲|欧冠|中超|电竞)/i.test(s)) {
    return 'sports';
  }
  if (/(?:综艺|真人秀|脱口秀|晚会|演唱会|音乐会|相声|小品)/.test(s)) {
    return 'variety';
  }
  if (/(?:动画电影|动漫电影)/.test(s)) {
    return 'movie';
  }
  if (/(?:动漫|番剧|国漫|日漫|美漫|里番|动画)/.test(s)) {
    return 'anime';
  }
  if (/(?:电视剧|连续剧|剧集|电视|泰剧|韩剧|日剧|美剧|英剧|港剧|台剧|国产剧|大陆剧|内地剧|港台剧|欧美剧|日韩剧|海外剧|新马剧|剧$)/.test(s)) {
    return 'tv';
  }
  if (/(?:电影|影片|院线|微电影|解说|伦理|福利|片$)/.test(s)) {
    return 'movie';
  }
  return 'other';
}

/** 计算聚合分组的主类别（按来源投票，忽略缺失与「其他」，平票取先出现者） */
export function groupPrimaryCategory(group: CategorizableGroup): VideoCategory {
  const counts = new Map<VideoCategory, number>();
  for (const item of group.items) {
    const cat = classifyCategory(item.typeName);
    if (cat === 'other') continue;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best: VideoCategory | undefined;
  let bestCount = 0;
  for (const [cat, count] of counts) {
    if (count > bestCount) {
      best = cat;
      bestCount = count;
    }
  }
  return best ?? classifyCategory(group.typeName);
}

/** 统计搜索结果中存在的大类选项（按标准顺序排列，计数等于点击后命中的影片分组数） */
export function buildCategoryOptions(
  groups: ReadonlyArray<CategorizableGroup>
): CategoryOption<VideoCategory>[] {
  const counts = new Map<VideoCategory, number>();
  for (const group of groups) {
    const cat = groupPrimaryCategory(group);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const out: CategoryOption<VideoCategory>[] = [];
  for (const cat of CATEGORY_ORDER) {
    const count = counts.get(cat) ?? 0;
    if (count > 0) out.push({ value: cat, label: CATEGORY_LABELS[cat], count });
  }
  return out;
}

/** 提取指定大类（或全部结果）下的 CMS 细分类型选项，每个分组至多计入一次 */
export function buildSubTypeOptions(
  groups: ReadonlyArray<CategorizableGroup>,
  categoryFilter: VideoCategory | 'all'
): CategoryOption<string>[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    if (categoryFilter !== 'all' && groupPrimaryCategory(group) !== categoryFilter) continue;
    const seenInGroup = new Set<string>();
    for (const item of group.items) {
      const normalized = normalizeTypeName(item.typeName);
      if (normalized) seenInGroup.add(normalized);
    }
    if (seenInGroup.size === 0) {
      const fallback = normalizeTypeName(group.typeName);
      if (fallback) seenInGroup.add(fallback);
    }
    for (const label of seenInGroup) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([value, count]) => ({ value, label: value, count }));
}

/** 判断影片分组是否满足当前大类与细分类型筛选 */
export function matchesCategoryFilter(
  group: CategorizableGroup,
  categoryFilter: VideoCategory | 'all',
  subTypeFilter: string | 'all'
): boolean {
  if (categoryFilter !== 'all' && groupPrimaryCategory(group) !== categoryFilter) {
    return false;
  }
  if (subTypeFilter !== 'all') {
    const matchesItem = group.items.some((item) => normalizeTypeName(item.typeName) === subTypeFilter);
    if (!matchesItem && normalizeTypeName(group.typeName) !== subTypeFilter) {
      return false;
    }
  }
  return true;
}
