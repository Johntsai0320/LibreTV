import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, filterAdultResults, filterRelevantResults, normalizeTitle, parseSearchList } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { extractUpstreamPlans } from '@/lib/search-query';
import { isValidProxyUrl } from '@/lib/ssrf';
import { getSearchVariants } from '@/lib/zh-conv-server';
import type { SearchResponse, SearchResultItem, SearchStreamEvent, SourceConfig, SourceSearchOutcome } from '@/lib/types';

export const runtime = 'nodejs';

interface SearchBody {
  wd: string;
  sources: SourceConfig[];
  filterAdult?: boolean;
}

/** 搜索结果短缓存：同一关键词 + 同一组源在 TTL 内直接返回（播放页返回搜索页等场景） */
const SEARCH_CACHE_TTL = 60 * 1000;

/** 单次搜索最多接受的源数量（preset 源库已超过 50 个，放宽至 100） */
const MAX_SEARCH_SOURCES = 100;

/**
 * 服务端同时请求的源数量上限。
 * 此前一次把 50 个源 × 5 个分页 = 250 条请求同时打出，直接打爆 Node 默认 4 线程的
 * DNS 解析池（UV_THREADPOOL_SIZE）与 TLS 握手，导致所有源集体超时。
 * 环境变量 SEARCH_CONCURRENCY 可配，默认 12。
 */
const SEARCH_CONCURRENCY = (() => {
  const n = parseInt(process.env.SEARCH_CONCURRENCY || '12', 10);
  if (!Number.isFinite(n)) return 12;
  return Math.min(30, Math.max(1, n));
})();

/** 每个源后续分页的并发上限（避免单源突发 4~5 条连接触发源站限流） */
const PAGE_CONCURRENCY = 2;

/** 缓存键：wd + 成人过滤 + 排序后的源地址集合（直接用完整字符串，避免哈希碰撞串缓存） */
function searchCacheKey(wd: string, sources: SourceConfig[], filterAdult: boolean): string {
  const urls = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  return `search:${wd}\n${filterAdult ? 1 : 0}\n${urls}`;
}

/**
 * 每个源最多抓取的页数。
 * 第一页响应会带回 pagecount（源站真实总页数），实际抓取页数 = min(pagecount, 该值)。
 * 默认 5；后续页受控并发请求，单页失败只丢弃该页，不影响首页已拿到的结果。
 */
const SEARCH_MAX_PAGES = (() => {
  const n = parseInt(process.env.SEARCH_MAX_PAGES || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, n));
})();

/**
 * 单源总死线（毫秒）：从 worker 实际开始抓取该源起算（排队等待不消耗死线）。
 * 环境变量 SEARCH_SOURCE_TIMEOUT_MS 可配，默认 12s。
 */
const SEARCH_SOURCE_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SEARCH_SOURCE_TIMEOUT_MS || '12000', 10);
  if (!Number.isFinite(n)) return 12000;
  return Math.min(60000, Math.max(3000, n));
})();

/** AbortSignal.timeout / 源级死线中断均以 TimeoutError 语义呈现（直接抛出或挂在 cause 上） */
function isTimeoutError(err: unknown): boolean {
  const candidates: unknown[] = [err, err instanceof Error ? err.cause : undefined];
  return candidates.some((e) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

function dedupeByVodId(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.vodId)) return false;
    seen.add(item.vodId);
    return true;
  });
}

/** 定长并发池：每个任务按索引回填，且尊重外部取消信号 */
async function runWithConcurrency<T>(
  count: number,
  limit: number,
  signal: AbortSignal | undefined,
  worker: (index: number) => Promise<T>
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= count) return;
      await worker(index);
    }
  });
  await Promise.all(lanes);
}

/**
 * 服务端聚合搜索（单源执行器）：
 * - 先同步校检 URL 合法性（内网字面量直接拒绝，零 DNS 开销），后续由 fetchUpstream 内部逐跳做 DNS/SSRF 校验，
 *   省去额外一次重复 DNS lookup；
 * - 任一分页成功即记录 partialResults 与 anyHttpSuccess：即使后续分页或繁简备援变体触发死线，
 *   也保留已拿到的第一页结果并将该源标记为 ok: true，避免正常源被误判「超时」进而被自动停用。
 */
async function searchSource(
  source: SourceConfig,
  wd: string,
  reqSignal?: AbortSignal
): Promise<SourceSearchOutcome> {
  const start = Date.now();
  const finish = (outcome: Omit<SourceSearchOutcome, 'ms'>): SourceSearchOutcome => ({
    ...outcome,
    ms: Date.now() - start,
  });

  if (!/^https?:\/\//.test(source.url || '')) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '无效的源地址' });
  }
  if (!isValidProxyUrl(source.url)) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '目标地址不在允许范围内（仅支持公网 http/https）' });
  }

  const plans = extractUpstreamPlans(wd);
  if (plans.length === 0) {
    return finish({ sourceKey: source.key, ok: true, list: [] });
  }

  const deadlineAt = start + SEARCH_SOURCE_TIMEOUT_MS;
  const remainingMs = () => deadlineAt - Date.now();

  // 死线到点或客户端断开均中断该源在途请求，避免后台继续空耗
  const controller = new AbortController();
  const onReqAbort = () => controller.abort(reqSignal?.reason ?? new DOMException('请求已取消', 'AbortError'));
  if (reqSignal) {
    if (reqSignal.aborted) {
      return finish({ sourceKey: source.key, ok: false, list: [], error: '请求已取消' });
    }
    reqSignal.addEventListener('abort', onReqAbort, { once: true });
  }

  let anyHttpSuccess = false;
  const partialResults: SearchResultItem[] = [];

  const partialOutcome = (): SourceSearchOutcome | null => {
    if (partialResults.length > 0) {
      return finish({ sourceKey: source.key, ok: true, list: dedupeByVodId(partialResults) });
    }
    if (anyHttpSuccess) {
      return finish({ sourceKey: source.key, ok: true, list: [] });
    }
    return null;
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SourceSearchOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new DOMException('源搜索超时', 'TimeoutError'));
      resolve(
        partialOutcome() ??
          finish({
            sourceKey: source.key,
            ok: false,
            list: [],
            error: `请求超时（>${Math.round(SEARCH_SOURCE_TIMEOUT_MS / 1000)}s）`,
            timedOut: true,
          })
      );
    }, SEARCH_SOURCE_TIMEOUT_MS);
  });

  const base = source.url.replace(/\/+$/, '');
  const fetchPage = async (queryWd: string, page: number) => {
    const budget = remainingMs();
    if (budget <= 0) {
      throw new DOMException('源搜索超时', 'TimeoutError');
    }
    const api = `${base}?ac=videolist&wd=${encodeURIComponent(queryWd)}&pg=${page}`;
    const res = await fetchUpstream(api, {
      timeoutMs: Math.max(1000, Math.min(8000, budget)),
      headers: cmsRequestHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    anyHttpSuccess = true;
    return data;
  };

  const fetchWithVariants = async (term: string): Promise<SearchResultItem[]> => {
    const variants = getSearchVariants(term);
    for (let vIdx = 0; vIdx < variants.length; vIdx++) {
      // 主查询已执行过且剩余预算不足时，不再硬发备援变体以免整源卡到死线
      if (vIdx > 0 && remainingMs() < 800) break;
      const queryWd = variants[vIdx];
      const first = await fetchPage(queryWd, 1);
      const list = parseSearchList(first, source);
      if (list.length === 0) continue;

      // 首页结果立即存入 partialResults：后续分页即使失败/超时也不丢已拿到的首页
      partialResults.push(...list);

      // 源站真实总页数与配置上限取较小者；pagecount 缺失或非法时视为 1 页
      const rawPageCount = parseInt(String((first as { pagecount?: unknown }).pagecount ?? '1'), 10);
      const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, SEARCH_MAX_PAGES);
      if (pageCount > 1 && remainingMs() >= 800) {
        const pages = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
        const pageChunks: SearchResultItem[][] = Array.from({ length: pages.length }, () => []);
        await runWithConcurrency(pages.length, PAGE_CONCURRENCY, controller.signal, async (idx) => {
          if (remainingMs() < 800) return;
          try {
            const items = parseSearchList(await fetchPage(queryWd, pages[idx]), source);
            pageChunks[idx] = items;
            partialResults.push(...items);
          } catch {
            // 单页失败仅丢弃该页，保留其余页结果
          }
        });
        list.push(...pageChunks.flat());
      }
      return list;
    }
    return [];
  };

  const fetchBranch = async (primary: string, fallback?: string): Promise<SearchResultItem[]> => {
    const primaryList = await fetchWithVariants(primary);
    if (primaryList.length > 0 || !fallback || remainingMs() < 800) return primaryList;
    return fetchWithVariants(fallback);
  };

  const run = async (): Promise<SourceSearchOutcome> => {
    if (plans.length === 1) {
      const list = await fetchBranch(plans[0].primary, plans[0].fallback);
      return { sourceKey: source.key, ok: true, list: dedupeByVodId(list) };
    }
    // 多个 OR 分支并发查询；部分分支失败时保留其余分支命中的结果，全失败才报错
    const settled = await Promise.allSettled(plans.map((p) => fetchBranch(p.primary, p.fallback)));
    const combined: SearchResultItem[] = [];
    let firstError: unknown;
    let anySucceeded = false;
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        anySucceeded = true;
        combined.push(...r.value);
      } else if (firstError === undefined) {
        firstError = r.reason;
      }
    }
    if (!anySucceeded && firstError !== undefined) {
      const recovered = partialOutcome();
      if (recovered) return recovered;
      throw firstError;
    }

    return { sourceKey: source.key, ok: true, list: dedupeByVodId(combined) };
  };

  try {
    // 死线先到时 run 仍会在后台被 abort 并 reject，必须先挂 catch 防未处理 rejection
    const runPromise = run()
      .then(finish)
      .catch((err: unknown): SourceSearchOutcome => {
        if (isTimeoutError(err) && !reqSignal?.aborted) {
          const recovered = partialOutcome();
          if (recovered) return recovered;
        }
        return finish({
          sourceKey: source.key,
          ok: false,
          list: [],
          error: err instanceof Error ? err.message : '请求失败',
          timedOut: isTimeoutError(err) && !reqSignal?.aborted,
        });
      });
    return await Promise.race([runPromise, deadline]);
  } catch (err) {
    return finish({
      sourceKey: source.key,
      ok: false,
      list: [],
      error: err instanceof Error ? err.message : '请求失败',
      timedOut: isTimeoutError(err) && !reqSignal?.aborted,
    });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (reqSignal) reqSignal.removeEventListener('abort', onReqAbort);
  }
}

/** 合并 + 去重 + 过滤 + 排序，stream 与非 stream 两种模式共用 */
function aggregateOutcomes(outcomes: SourceSearchOutcome[], wd: string, filterAdult: boolean): SearchResponse {
  const seen = new Set<string>();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  list = filterAdultResults(list, filterAdult);
  // 部分源站做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），按关键词过滤
  list = filterRelevantResults(list, wd);

  // 精确命中（忽略标点、简繁差异）排在最前，其余按名称（与旧版一致），名称相同按源名
  const exactKeys = new Set(
    [wd, ...extractUpstreamPlans(wd).map((p) => p.primary)]
      .map(normalizeTitle)
      .filter(Boolean)
  );
  list.sort((a, b) => {
    const aExact = exactKeys.has(normalizeTitle(a.name || '')) ? 0 : 1;
    const bExact = exactKeys.has(normalizeTitle(b.name || '')) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut }));

  return { list, failures };
}

/**
 * 服务端聚合搜索：
 * - 默认返回完整 JSON（换源流程使用）；
 * - `?stream=1` 以 NDJSON 逐源推送（完成一个推一条，健康源的结果不再等坏源超时），
 *   最终推送聚合后的 done 事件并写入短缓存。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const wd = (body.wd || '').trim();
  if (!wd || wd.length > 100) {
    return NextResponse.json({ error: '搜索关键词无效' }, { status: 400 });
  }
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }
  const sources = body.sources.slice(0, MAX_SEARCH_SOURCES);
  const filterAdult = body.filterAdult !== false;

  const cacheKey = searchCacheKey(wd, sources, filterAdult);
  const cached = getCache<SearchResponse>(cacheKey);
  if (cached) {
    // 流式模式下缓存命中也要走 done 事件，客户端解析逻辑保持单一
    if (new URL(req.url).searchParams.get('stream') === '1') {
      const event: SearchStreamEvent = { type: 'done', list: cached.list, failures: cached.failures };
      return new Response(JSON.stringify(event) + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(cached);
  }

  const isStream = new URL(req.url).searchParams.get('stream') === '1';
  if (!isStream) {
    const outcomes: SourceSearchOutcome[] = new Array(sources.length);
    await runWithConcurrency(sources.length, SEARCH_CONCURRENCY, req.signal, async (i) => {
      outcomes[i] = await searchSource(sources[i], wd, req.signal);
    });
    const completed = outcomes.filter(Boolean);
    const payload = aggregateOutcomes(completed, wd, filterAdult);
    if (!req.signal.aborted) {
      setCache(cacheKey, payload, SEARCH_CACHE_TTL);
    }
    return NextResponse.json(payload);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: SearchStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true; // 客户端已断开
        }
      };

      // 逐源结算即推送；outcomes 按下标回填保证聚合顺序稳定
      const outcomes: SourceSearchOutcome[] = new Array(sources.length);
      await runWithConcurrency(sources.length, SEARCH_CONCURRENCY, req.signal, async (i) => {
        const outcome = await searchSource(sources[i], wd, req.signal);
        outcomes[i] = outcome;
        if (req.signal.aborted || closed) return;
        // 中间结果与最终结果共用去重和过滤规则，避免无关/成人条目短暂出现在页面上。
        const { list } = aggregateOutcomes([outcome], wd, filterAdult);
        send({ type: 'source', ...outcome, list });
      });

      if (!req.signal.aborted && !closed) {
        const completed = outcomes.filter(Boolean);
        const payload = aggregateOutcomes(completed, wd, filterAdult);
        setCache(cacheKey, payload, SEARCH_CACHE_TTL);
        send({ type: 'done', list: payload.list, failures: payload.failures });
      }
      closed = true;
      try {
        controller.close();
      } catch { /* 已断开 */ }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
