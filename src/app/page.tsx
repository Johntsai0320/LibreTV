'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { RecommendSection } from '@/components/douban-section';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { useBatchQualityProbe } from '@/components/use-quality-probe';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { api } from '@/lib/client-api';
import { db } from '@/lib/db';
import {
  bestGroupHeight,
  collectUnprobedTargets,
  matchesQualityFilter,
  QUALITY_FILTER_OPTIONS,
  type QualityFilterTier,
} from '@/lib/quality';
import {
  buildCategoryOptions,
  buildSubTypeOptions,
  CATEGORY_LABELS,
  matchesCategoryFilter,
  type VideoCategory,
} from '@/lib/category';
import type { QualityEntry, SearchResultItem, SourceSearchOutcome } from '@/lib/types';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn, formatDisableTtl, validateSourceUrl } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';

const EMPTY_QUALITY_MAP: Record<string, QualityEntry> = {};

/**
 * 首页：搜索（URL ?s= 驱动，可后退/分享）+ 豆瓣推荐。
 * 搜索状态由 React Query 管理，失败源在结果区顶部以非阻塞方式展示。
 */
/** 搜索结果分批渲染的批大小：一次挂载上千张卡片会明显掉帧 */
const RESULT_PAGE_SIZE = 60;
/** 触发筛选或质量排序时自动批量探测的条数上限，避免宽泛搜索一次性发出过多请求 */
const AUTO_BATCH_PROBE_LIMIT = 120;

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const urlQuery = searchParams.get('s') || '';
  // 精确订阅所需字段（对齐 live 页的做法）：搜索流式期间逐源写健康度、
  // 打开设置抽屉/历史面板等无关 store 变化，都不应触发首页整树重渲染
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  /** 流式搜索中已结算的源（data 就绪前用于增量渲染） */
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const favKeys = useLiveQuery(() => db.favorites.toCollection().primaryKeys(), [], [] as string[]);
  const favoriteIds = useMemo(() => new Set(favKeys.map(String)), [favKeys]);

  // URL 驱动搜索：?s= 变化时回填输入框
  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  // 源名回显：失败/停用提示里显示友好名称而非裸 key
  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ??
    envSources.find((a) => a.key === key)?.name ??
    key;

  const selectedSources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      // 自动停用期内的源不参与搜索（到期自动恢复）
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      // 所属订阅被整体停用的源同样跳过（无损：各源勾选状态保留，重新启用即恢复）
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);
  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );
  // 来自已关闭订阅的源：勾选状态还在，但本次搜索用不到，必须明确告知
  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) => !isSourceDisabled({ sourceHealth }, key) && isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );

  const restoreDisabledSources = (silent = false) => {
    if (disabledSources.length === 0) return 0;
    const count = disabledSources.length;
    useAppStore.getState().clearSourceHealthMany(disabledSources);
    if (!silent) toast(`已恢复 ${count} 个暂停的点播源`, 'success');
    return count;
  };

  const searchQuery = useQuery({
    queryKey: ['search', urlQuery, selectedKeys, yellowFilter],
    // 与 runSearch 的截断规则保持一致：顶栏搜索 / 手动构造长链接不会绕过上限
    queryFn: async ({ signal }) => {
      setStreamedOutcomes([]);
      const settledOutcomes: SourceSearchOutcome[] = [];
      const res = await api.search(urlQuery.slice(0, 100), selectedSources, yellowFilter, {
        signal,
        // 逐源结算即更新：结果边搜边渲染；健康度统一在整批结束后批量写入，
        // 以便防雪崩保护识别「整批全超时/全失败」场景并避免流式期间反复写盘
        onSource: (outcome) => {
          settledOutcomes.push(outcome);
          setStreamedOutcomes((prev) => [...prev, outcome]);
        },
      });
      if (!signal.aborted) {
        const failMap = new Map(res.failures.map((f) => [f.sourceKey, f]));
        const batchOutcomes: SourceSearchOutcome[] =
          settledOutcomes.length > 0
            ? settledOutcomes
            : selectedSources.map((s) => {
                const f = failMap.get(s.key);
                return f
                  ? { sourceKey: s.key, ok: false, error: f.error, timedOut: f.timedOut, list: [] }
                  : { sourceKey: s.key, ok: true, list: [] };
              });
        const events = useAppStore.getState().recordSourceHealth(batchOutcomes);
        if (events.length > 3) {
          toast(`${events.length} 个点播源因连续超时/失败已暂停参与搜索`, 'warning');
        } else {
          for (const ev of events) {
            toast(
              ev.permanent
                ? `「${sourceName(ev.key)}」多次失败，已停止参与搜索，可在设置中恢复`
                : `「${sourceName(ev.key)}」连续超时/失败，已停用 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        }
      }
      return res;
    },
    enabled: Boolean(urlQuery) && selectedSources.length > 0,
    // 5 分钟内从播放页返回时直接使用缓存，不重新搜索（服务端另有 60s 结果缓存兜底）
    staleTime: 300_000,
  });

  // 最近搜索改为搜索框下拉（聚焦展开、按输入过滤），不再常驻首屏
  const searchHistory = useSearchHistory(input);

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      if (disabledSources.length > 0) {
        toast(`已勾选的 ${disabledSources.length} 个点播源均因连续失败已暂停`, 'warning', {
          action: {
            label: '全部恢复并搜索',
            onClick: () => {
              restoreDisabledSources(true);
              router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
              searchHistory.record(query);
            },
          },
        });
        return;
      }
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;
  // 聚合数据未就绪时，用已结算源的结果增量渲染（健康源不再等坏源超时）
  const streamedList = useMemo(
    () => streamedOutcomes.flatMap((o) => o.list),
    [streamedOutcomes]
  );
  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedList : []),
    [searchQuery.data, isSearching, streamedList]
  );
  const failures =
    searchQuery.data?.failures ??
    streamedOutcomes
      .filter((o) => !o.ok)
      .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));
  // 跨源同名聚合：同名影片合并为一张卡片，展开后可选择具体来源
  const groups = useMemo(() => aggregateResults(list), [list]);

  const [categoryFilter, setCategoryFilter] = useState<VideoCategory | 'all'>('all');
  const [subTypeFilter, setSubTypeFilter] = useState<string | 'all'>('all');
  const [qualityFilter, setQualityFilter] = useState<QualityFilterTier>('all');
  const [qualitySort, setQualitySort] = useState<'default' | 'best'>('default');
  const [includeUnknownQuality, setIncludeUnknownQuality] = useState(false);
  const [qualityEpoch, setQualityEpoch] = useState(0);
  const batchProbe = useBatchQualityProbe(selectedSources);
  const trackQuality =
    qualityFilter !== 'all' || qualitySort === 'best' || batchProbe.running || qualityEpoch > 0;
  const qualityMap = useAppStore((s) => (trackQuality ? s.qualityMap : EMPTY_QUALITY_MAP));

  useEffect(() => {
    batchProbe.stop();
    setQualityEpoch(0);
    setCategoryFilter('all');
    setSubTypeFilter('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQuery]);

  const categoryOptions = useMemo(() => buildCategoryOptions(groups), [groups]);
  const showBroadCategories = categoryOptions.length >= 2;
  const subTypeOptions = useMemo(() => {
    // 存在多个大类时：选中某大类后展示其细分类型；仅有单一大类时：直接把细分类型升为主行展示
    if (showBroadCategories && categoryFilter === 'all' && subTypeFilter === 'all') return [];
    const opts = buildSubTypeOptions(groups, showBroadCategories ? categoryFilter : 'all');
    return opts.length >= 2 ? opts : [];
  }, [groups, showBroadCategories, categoryFilter, subTypeFilter]);
  const hasCategoryBar = showBroadCategories || subTypeOptions.length >= 2;

  const selectBroadCategory = (cat: VideoCategory | 'all') => {
    setCategoryFilter(cat);
    setSubTypeFilter('all');
  };

  const startBatchProbe = useCallback(
    (limit?: number) => {
      const unprobed = collectUnprobedTargets(groups, useAppStore.getState().qualityMap);
      const targets = typeof limit === 'number' ? unprobed.slice(0, limit) : unprobed;
      if (targets.length === 0) return;
      batchProbe.start(targets, () => setQualityEpoch((v) => v + 1));
    },
    [groups, batchProbe]
  );

  const selectQualityFilter = (tier: QualityFilterTier) => {
    setQualityFilter(tier);
    if (tier !== 'all' && !batchProbe.running) {
      startBatchProbe(AUTO_BATCH_PROBE_LIMIT);
    }
  };

  const toggleQualitySort = () => {
    const next = qualitySort === 'default' ? 'best' : 'default';
    setQualitySort(next);
    if (next === 'best' && !batchProbe.running) {
      startBatchProbe(AUTO_BATCH_PROBE_LIMIT);
    }
  };

  const hasCategoryFilter = categoryFilter !== 'all' || subTypeFilter !== 'all';
  const hasQualityFilter = qualityFilter !== 'all';

  const filteredGroups = useMemo(() => {
    let next = groups;
    if (hasCategoryFilter) {
      next = next.filter((g) => matchesCategoryFilter(g, categoryFilter, subTypeFilter));
    }
    if (qualityFilter !== 'all') {
      next = next.filter((g) =>
        matchesQualityFilter(bestGroupHeight(g.items, qualityMap), qualityFilter, includeUnknownQuality)
      );
    }
    if (qualitySort === 'best') {
      next = [...next].sort((a, b) => {
        const ha = bestGroupHeight(a.items, qualityMap) ?? -1;
        const hb = bestGroupHeight(b.items, qualityMap) ?? -1;
        return hb - ha;
      });
    }
    return next;
  }, [groups, hasCategoryFilter, categoryFilter, subTypeFilter, qualityFilter, qualitySort, includeUnknownQuality, qualityMap]);

  const unprobedCount = useMemo(
    () => collectUnprobedTargets(groups, qualityMap).length,
    [groups, qualityMap]
  );

  // 分批渲染：新一次搜索或筛选变化时重置回首批
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const visibleGroups = useMemo(
    () => filteredGroups.slice(0, visibleCount),
    [filteredGroups, visibleCount]
  );
  useEffect(
    () => setVisibleCount(RESULT_PAGE_SIZE),
    [groups, categoryFilter, subTypeFilter, qualityFilter, qualitySort, includeUnknownQuality]
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {/* 首屏氛围渐变 */}
        {!urlQuery && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10"
            style={{
              background:
                'radial-gradient(60% 60% at 50% 0%, rgba(35,173,229,0.10) 0%, rgba(35,173,229,0.03) 45%, transparent 75%)',
            }}
          />
        )}

        {/* 搜索区 */}
        <section className={cn('flex flex-col items-center', urlQuery ? 'mb-6' : 'mt-8 mb-8')}>
          {!urlQuery && (
            <header className="text-center mb-6">
              <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">LibreTV</h1>
            </header>
          )}
          {urlQuery && <h1 className="sr-only">LibreTV 视频搜索</h1>}
          {/* 定位容器比胶囊宽一圈：浮层按它的宽度对齐，接缝处不会与胶囊边框错位 1px */}
          <div ref={searchHistory.containerRef} className="relative w-full max-w-2xl">
            <form
              className="w-full"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(input);
              }}
            >
              {/* 输入框与搜索按钮合并为一个胶囊：内部无边框，焦点态由容器统一表达；
                  下拉展开时改为「上圆下直」并隐去底边，与下方浮层拼成同一个面板 */}
              <div
                className={cn(
                  // 12px 圆角矩形（非胶囊）：收起态与展开态共用同一组上圆角，
                  // 展开时输入框这部分形状完全不发生变化，上下圆角也与下拉保持一致；
                  // 右侧与上下不留内边距，由搜索按钮拉伸填满、与搜索框边缘贴合
                  'flex items-stretch min-h-12 pl-4 border',
                  'transition-[background-color,border-color,border-radius] duration-200',
                  searchHistory.visible
                    ? // 展开时：外框（含上圆角）沿用输入框的聚焦样式不变，只把底边改为内部分隔线，
                      // 使输入区在展开状态下仍是边界清晰的独立输入框，而非与列表糊成一片
                      'rounded-t-xl rounded-b-none border-accent border-b-line bg-surface-raised'
                    : 'rounded-xl border-line bg-chip focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40'
                )}
              >
                <input
                  ref={inputRef}
                  className="flex-1 min-w-0 pr-2 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                  placeholder="输入影片名称（支持繁简、空格/&、|、-排除）..."
                  title="支持简繁自动转换与逻辑搜寻：空格 / & (且)、| (或)、- (排除)、() 分组"
                  value={input}
                  maxLength={100}
                  onChange={(e) => {
                    setInput(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-label="搜索影片"
                  aria-expanded={searchHistory.visible}
                  aria-controls="home-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `home-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {input && (
                  <button
                    type="button"
                    className="shrink-0 self-center mr-1 p-1.5 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                    onClick={() => {
                      setInput('');
                      searchHistory.resetActive();
                      inputRef.current?.focus();
                    }}
                    aria-label="清空"
                  >
                    <Icon name="close" className="w-4 h-4" />
                  </button>
                )}
                {/* 主操作按钮：贴合搜索框右端——右侧圆角跟随容器、左侧直角，展开时右下角
                    跟着容器一起改直角；按压改用亮度反馈（缩放会让贴合边缘露出缝隙） */}
                <button
                  type="submit"
                  className={cn(
                    'btn-primary shrink-0 px-4 font-medium transition-[background-color,filter] active:brightness-90',
                    '!rounded-l-none',
                    searchHistory.visible ? '!rounded-tr-xl !rounded-br-none' : '!rounded-r-xl'
                  )}
                >
                  <Icon name="search" className="w-4 h-4" />
                  搜索
                </button>
              </div>
            </form>

            {/* 最近搜索：与输入框无缝拼接；浮层不占文档流，出现/消失不会顶动下方内容 */}
            {searchHistory.visible && (
              <SearchHistoryDropdown
                id="home-search-history"
                matches={searchHistory.matches}
                activeIndex={searchHistory.activeIndex}
                onPick={pickHistory}
                onRemove={searchHistory.remove}
                onClearAll={searchHistory.clearAll}
              />
            )}
          </div>
        </section>

        {/* 搜索结果 */}
        {urlQuery && (
          <section aria-label="搜索结果" className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm text-muted">
                “<span className="text-content">{urlQuery}</span>” 的搜索结果
                {isSearching ? (
                  <span className="text-faint">
                    （已就绪 {streamedOutcomes.length}/{selectedSources.length} 个源…）
                  </span>
                ) : (
                  searchQuery.data && (
                    <span className="text-faint">
                      （{groups.length} 部影片 · {list.length} 条结果
                      {(hasCategoryFilter || hasQualityFilter) && ` · 已筛选 ${filteredGroups.length} 部`}
                      {failures.length > 0 && `，${failures.length} 个源失败`}）
                    </span>
                  )
                )}
              </h2>
            </div>

            {failures.length > 0 && (
              <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-faint">{isSearching ? '以下源暂时无响应：' : '部分点播源请求失败：'}</span>
                {failures.map((f) => (
                  <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : 'text-faint'}>
                    {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                    {f.timedOut ? ' 超时' : ''}
                  </span>
                ))}
              </div>
            )}

            {disabledSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，
                  长期停用的需手动恢复）：{disabledSources.map((key) => sourceName(key)).join('、')}
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-sm shrink-0 !text-accent"
                  onClick={() => {
                    restoreDisabledSources();
                    setTimeout(() => void searchQuery.refetch(), 0);
                  }}
                >
                  全部恢复
                </button>
              </div>
            )}

            {offSubscriptionSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {selectedSources.length === 0 ? (
              disabledSources.length > 0 ? (
                <PausedSourcesGuide
                  count={disabledSources.length}
                  onRestore={() => {
                    restoreDisabledSources();
                    setTimeout(() => void searchQuery.refetch(), 0);
                  }}
                />
              ) : (
                <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
              )
            ) : list.length > 0 ? (
              <>
                {/* 影片类别筛选栏 */}
                {hasCategoryBar && (
                  <div className="mb-2.5 flex flex-col gap-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="影片类别筛选">
                      <span className="text-faint mr-1 shrink-0">类别</span>
                      <button
                        type="button"
                        aria-pressed={categoryFilter === 'all' && subTypeFilter === 'all'}
                        onClick={() => selectBroadCategory('all')}
                        className={cn(
                          'px-2.5 py-1 rounded-full border transition-colors',
                          categoryFilter === 'all' && subTypeFilter === 'all'
                            ? 'border-accent bg-accent/15 text-accent font-medium'
                            : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                        )}
                      >
                        全部 <span className="opacity-75 tabular-nums">{groups.length}</span>
                      </button>
                      {showBroadCategories
                        ? categoryOptions.map((opt) => {
                            const active = categoryFilter === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                aria-pressed={active}
                                onClick={() => selectBroadCategory(opt.value)}
                                className={cn(
                                  'px-2.5 py-1 rounded-full border transition-colors',
                                  active
                                    ? 'border-accent bg-accent/15 text-accent font-medium'
                                    : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                                )}
                              >
                                {opt.label} <span className="opacity-75 tabular-nums">{opt.count}</span>
                              </button>
                            );
                          })
                        : subTypeOptions.map((opt) => {
                            const active = subTypeFilter === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setSubTypeFilter(active ? 'all' : opt.value)}
                                className={cn(
                                  'px-2.5 py-1 rounded-full border transition-colors',
                                  active
                                    ? 'border-accent bg-accent/15 text-accent font-medium'
                                    : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                                )}
                              >
                                {opt.label} <span className="opacity-75 tabular-nums">{opt.count}</span>
                              </button>
                            );
                          })}
                    </div>

                    {showBroadCategories && subTypeOptions.length >= 2 && (
                      <div className="flex flex-wrap items-center gap-1 pl-8" role="group" aria-label="细分类型筛选">
                        <button
                          type="button"
                          aria-pressed={subTypeFilter === 'all'}
                          onClick={() => setSubTypeFilter('all')}
                          className={cn(
                            'px-2 py-0.5 rounded-full border text-[11px] transition-colors',
                            subTypeFilter === 'all'
                              ? 'border-accent bg-accent/15 text-accent font-medium'
                              : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                          )}
                        >
                          全部{categoryFilter === 'all' ? '类型' : CATEGORY_LABELS[categoryFilter]}
                        </button>
                        {subTypeOptions.map((opt) => {
                          const active = subTypeFilter === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setSubTypeFilter(active ? 'all' : opt.value)}
                              className={cn(
                                'px-2 py-0.5 rounded-full border text-[11px] transition-colors',
                                active
                                  ? 'border-accent bg-accent/15 text-accent font-medium'
                                  : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                              )}
                            >
                              {opt.label} <span className="opacity-75 tabular-nums">{opt.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 画质筛选与排序栏 */}
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label="画质筛选">
                    {QUALITY_FILTER_OPTIONS.map((opt) => {
                      const active = qualityFilter === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => selectQualityFilter(opt.value)}
                          className={cn(
                            'px-2.5 py-1 rounded-full border transition-colors',
                            active
                              ? 'border-accent bg-accent/15 text-accent font-medium'
                              : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {qualityFilter !== 'all' && (
                      <label className="flex items-center gap-1.5 text-muted cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-[#2563eb]"
                          checked={includeUnknownQuality}
                          onChange={(e) => setIncludeUnknownQuality(e.target.checked)}
                        />
                        包含未探测
                      </label>
                    )}

                    <button
                      type="button"
                      aria-pressed={qualitySort === 'best'}
                      onClick={toggleQualitySort}
                      className={cn(
                        'px-2.5 py-1 rounded-md border transition-colors',
                        qualitySort === 'best'
                          ? 'border-accent bg-accent/15 text-accent font-medium'
                          : 'border-line bg-chip text-muted hover:text-content hover:bg-hover'
                      )}
                    >
                      {qualitySort === 'best' ? '画质优先 ✓' : '按画质排序'}
                    </button>

                    {batchProbe.running ? (
                      <button
                        type="button"
                        onClick={batchProbe.stop}
                        className="px-2.5 py-1 rounded-md border border-line bg-chip text-muted hover:text-content hover:bg-hover tabular-nums"
                      >
                        探测画质中 {batchProbe.done}/{batchProbe.total} · 停止
                      </button>
                    ) : (
                      unprobedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => startBatchProbe()}
                          className="px-2.5 py-1 rounded-md border border-line bg-chip text-muted hover:text-content hover:bg-hover tabular-nums"
                          title="批量探测当前搜索结果各来源的最高画质"
                        >
                          探测画质（{unprobedCount}）
                        </button>
                      )
                    )}
                  </div>
                </div>

                {filteredGroups.length === 0 ? (
                  <div className="border border-dashed border-line rounded-xl p-8 text-center">
                    <p className="text-sm text-content font-medium mb-1">当前筛选条件下暂无匹配影片</p>
                    <p className="text-xs text-faint mb-4">
                      {hasQualityFilter && unprobedCount > 0
                        ? `还有 ${unprobedCount} 个片源未探测画质，可放宽类别或画质条件，或继续探测其余片源。`
                        : '可尝试放宽类别或画质筛选条件，查看全部搜索结果。'}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {hasCategoryFilter && (
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={() => selectBroadCategory('all')}
                        >
                          显示全部类别
                        </button>
                      )}
                      {hasQualityFilter && (
                        <button
                          type="button"
                          className={hasCategoryFilter ? 'btn-ghost btn-sm' : 'btn-primary btn-sm'}
                          onClick={() => setQualityFilter('all')}
                        >
                          显示全部画质
                        </button>
                      )}
                      {hasQualityFilter && !includeUnknownQuality && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setIncludeUnknownQuality(true)}
                        >
                          包含未探测影片
                        </button>
                      )}
                      {hasQualityFilter && unprobedCount > 0 && !batchProbe.running && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => startBatchProbe()}
                        >
                          探测其余画质（{unprobedCount}）
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                      {visibleGroups.map((group) => (
                        <AggregatedCard
                          key={group.key}
                          group={group}
                          sources={selectedSources}
                          favoriteIds={favoriteIds}
                          qualityEpoch={qualityEpoch}
                          onOpen={(item) => setDetailItem(item)}
                        />
                      ))}
                    </div>
                    {filteredGroups.length > visibleCount && (
                      <div className="flex justify-center mt-4">
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => setVisibleCount((v) => v + RESULT_PAGE_SIZE)}
                        >
                          加载更多（还有 {filteredGroups.length - visibleCount} 部）
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : (
              <EmptyState
                icon="search"
                title="没有找到匹配的结果"
                description="请尝试其他关键词或更换点播源"
                className="!py-16"
              />
            )}
          </section>
        )}

        {/* 首页推荐（有搜索时隐藏） */}
        {!urlQuery && (
          <RecommendSection
            onPick={(title) => {
              setInput(title);
              runSearch(title);
            }}
          />
        )}
      </main>

      <SiteFooter />

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        // 结构对齐真实结果卡（左侧缩略图 + 右侧文字块），避免占位与真实卡片形状不符
        <div key={i} className="card flex h-28 overflow-hidden">
          <div className="w-[105px] sm:w-[120px] shrink-0 bg-chip animate-pulse" />
          <div className="flex-1 p-2.5 space-y-2">
            <div className="h-4 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
            <div className="h-3 w-full rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 已勾选的点播源全部被健康机制暂停时的专属恢复引导 */
function PausedSourcesGuide({ count, onRestore }: { count: number; onRestore: () => void }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">已勾选的 {count} 个点播源均已暂停</h3>
      <p className="text-sm text-muted leading-relaxed mb-4">
        这些源因先前连续超时或失败被自动暂停参与搜索，并非未勾选。若网络已恢复，可点击下方按钮立即恢复并重新搜索。
      </p>
      <button type="button" className="btn-primary btn-sm" onClick={onRestore}>
        恢复全部暂停源并重搜
      </button>
    </div>
  );
}

/** 无点播源 / 未勾选点播源时的引导（替代旧版首屏静默空白） */
function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '先添加一个点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>点击右上角「设置」，勾选要参与搜索的点播源后重新搜索。</>
        ) : (
          <>
            LibreTV 不内置任何采集站。点击右上角「设置 → 添加 API」，填入一个
            Apple CMS 采集站地址（如 <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>），
            勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}
