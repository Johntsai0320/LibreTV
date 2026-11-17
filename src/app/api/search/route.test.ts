import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import type { SearchResponse, SearchStreamEvent, SourceConfig } from '@/lib/types';

vi.mock('@/lib/ssrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ssrf')>();
  return {
    ...actual,
    checkUpstreamAllowed: vi.fn(async (urlString: string) =>
      actual.isValidProxyUrl(urlString)
        ? { ok: true as const }
        : { ok: false as const, reason: '目标地址不在允许范围内（仅支持公网 http/https）' }
    ),
  };
});

/**
 * 聚合搜索接口单测：跨源聚合、同源去重、精确命中置顶、成人内容过滤、
 * 失败源不影响整体、SSRF 字面量拒绝。上游一律 mock fetch，无真实网络。
 */

function cmsList(items: Array<Record<string, unknown>>, pagecount = 1): string {
  return JSON.stringify({ code: 1, pagecount, list: items });
}

/** 按 URL 分发的上游 mock：cms-a 正常、cms-b 500、cms-c 与 a 有重叠条目 */
function mockUpstream(): void {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('cms-a.example')) {
      return new Response(
        cmsList([
          { vod_id: 1, vod_name: '测试剧', type_name: '国产剧' },
          { vod_id: 2, vod_name: '测试剧外传', type_name: '国产剧' },
          { vod_id: 3, vod_name: '福利速递', type_name: '福利视频' },
          // 同源同 vod_id 的重复条目：聚合时须按 sourceKey_vodId 去重
          { vod_id: 1, vod_name: '测试剧', type_name: '国产剧' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('cms-b.example')) {
      return new Response('server error', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
}

function makeRequest(body: unknown, stream = false): Request {
  const { token } = signSession();
  return new Request(`https://local.test/api/search${stream ? '?stream=1' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

const SOURCES = [
  { key: 'a', name: '源A', url: 'https://cms-a.example.com/api.php' },
  { key: 'b', name: '源B', url: 'https://cms-b.example.com/api.php' },
];

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/search', () => {
  it('聚合多源结果：同源去重、成人内容过滤、失败源进 failures', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ wd: '测试剧', sources: SOURCES, filterAdult: true }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      list: Array<{ sourceKey: string; vodId: string; name: string }>;
      failures: Array<{ sourceKey: string; error: string }>;
    };

    // 源A 的 4 条 → 去重后 2 条有效 + 成人条目被过滤
    const aItems = data.list.filter((i) => i.sourceKey === 'a');
    expect(aItems).toHaveLength(2);
    expect(aItems.map((i) => i.vodId).sort()).toEqual(['1', '2']);

    // 源B 500 → 记入 failures，不影响源A 的结果
    expect(data.failures).toHaveLength(1);
    expect(data.failures[0].sourceKey).toBe('b');
    expect(data.failures[0].error).toContain('500');
  });

  it('精确命中（忽略标点差异）排在最前', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ wd: '测试剧', sources: [SOURCES[0]], filterAdult: true }));
    const data = (await res.json()) as { list: Array<{ name: string }> };
    expect(data.list[0]?.name).toBe('测试剧');
  });

  it('内网字面量地址在发起请求前被 SSRF 校验拒绝', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await POST(
      makeRequest({
        wd: 'x',
        sources: [{ key: 'evil', name: '内网', url: 'http://192.168.1.100/api.php' }],
        filterAdult: false,
      })
    );
    const data = (await res.json()) as { failures: Array<{ sourceKey: string; error: string }> };
    expect(data.failures[0]?.sourceKey).toBe('evil');
    // 上游一次请求都不应发生
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stream=1 以 NDJSON 逐源推送并以 done 事件收尾', async () => {
    mockUpstream();
    // 用不同源地址避开同键短缓存，保留有实际匹配结果的关键词。
    const sourcesForStream = SOURCES.map((source) => ({ ...source, url: source.url + '/stream' }));
    const res = await POST(makeRequest({ wd: '测试剧', sources: sourcesForStream, filterAdult: true }, true));
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; sourceKey?: string });
    const sources = lines.filter((l) => l.type === 'source');
    const done = lines.filter((l) => l.type === 'done');
    // 每个源恰好一条 source 事件（含失败的源B），最后一条是 done
    expect(sources.map((l) => l.sourceKey).sort()).toEqual(['a', 'b']);
    expect(done).toHaveLength(1);
    expect(lines[lines.length - 1].type).toBe('done');
  });

  it.each([true, false])('逐源、最终与缓存结果使用相同过滤规则（成人过滤：%s）', async (filterAdult) => {
    const sources: SourceConfig[] = [
      { key: 'good', name: '有效源', url: `https://cms.example.com/consistent-${filterAdult}` },
      { key: 'bad', name: '失败源', url: `https://cms.example.com/failed-${filterAdult}` },
    ];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/failed-')) return new Response('unavailable', { status: 500 });
      return new Response(cmsList([
        { vod_id: 1, vod_name: '赛博朋克：边缘行者第二季', type_name: '动漫' },
        { vod_id: 1, vod_name: '赛博朋克：边缘行者第二季', type_name: '动漫' },
        { vod_id: 2, vod_name: '10月17日德甲联赛', type_name: '足球' },
        { vod_id: 3, vod_name: '', type_name: '动漫' },
        { vod_id: 4, vod_name: '赛博朋克：边缘行者第二季', type_name: '福利视频' },
      ]), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const body = { wd: '赛博朋克：边缘行者 2', sources, filterAdult };
    const stream = await POST(makeRequest(body, true));
    const events = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line) as SearchStreamEvent);
    const good = events.find((event) => event.type === 'source' && event.sourceKey === 'good');
    const failed = events.find((event) => event.type === 'source' && event.sourceKey === 'bad');
    const done = events.find((event) => event.type === 'done');
    const ids = filterAdult ? ['1'] : ['1', '4'];
    expect(good?.list.map((item) => item.vodId)).toEqual(ids);
    expect(good).toMatchObject({ type: 'source', sourceKey: 'good', ok: true, ms: expect.any(Number) });
    expect(failed).toMatchObject({ type: 'source', sourceKey: 'bad', ok: false, list: [], error: 'HTTP 500' });
    expect(done).toMatchObject({ type: 'done', list: good?.list, failures: [{ sourceKey: 'bad', error: 'HTTP 500' }] });

    // 同一缓存同时服务 JSON 和流式客户端，不能重新引入原始杂项。
    const calls = fetchSpy.mock.calls.length;
    const json = await POST(makeRequest(body));
    const cached = await json.json() as SearchResponse;
    expect(cached.list).toEqual(good?.list);
    expect(cached.failures).toEqual(done?.type === 'done' ? done.failures : undefined);
    const cachedStream = await POST(makeRequest(body, true));
    expect((await cachedStream.text()).trim().split('\n').map((line) => JSON.parse(line))).toEqual([done]);
    expect(fetchSpy).toHaveBeenCalledTimes(calls);

    // 新地址走非缓存 JSON 分支，仍须得到相同的筛选结果。
    const fresh = await POST(makeRequest({ ...body, sources: sources.map((source) => ({ ...source, url: source.url + '/fresh' })) }));
    const freshData = await fresh.json() as SearchResponse;
    expect(freshData.list.map((item) => item.vodId)).toEqual(ids);
    expect(freshData.failures).toEqual(cached.failures);
  });

  it('没有相关结果时，各响应模式均保留空列表', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(cmsList([
      { vod_id: 1, vod_name: '10月17日德甲联赛', type_name: '足球' },
      { vod_id: 2, vod_name: '', type_name: '动漫' },
    ]))));
    const body = {
      wd: '赛博朋克：边缘行者 2',
      sources: [{ key: 'empty', name: '不相关源', url: 'https://cms.example.com/no-relevant-results' }],
    };
    const res = await POST(makeRequest(body, true));
    const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as SearchStreamEvent);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.list).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'source', ok: true });
    expect(events[1]).toMatchObject({ type: 'done', failures: [] });
    const cached = await POST(makeRequest(body));
    expect(await cached.json()).toEqual({ list: [], failures: [] });
    const cachedStream = await POST(makeRequest(body, true));
    expect(JSON.parse((await cachedStream.text()).trim())).toEqual({ type: 'done', list: [], failures: [] });
    const fresh = await POST(makeRequest({ ...body, sources: [{ ...body.sources[0], url: body.sources[0].url + '/fresh' }] }));
    expect(await fresh.json()).toEqual({ list: [], failures: [] });
  });

  it('未登录返回 401，未配置密码返回 503', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const saved = process.env.PASSWORD;
    delete process.env.PASSWORD;
    try {
      const noPassword = await POST(makeRequest({ wd: 'x', sources: SOURCES }));
      expect(noPassword.status).toBe(503);
    } finally {
      process.env.PASSWORD = saved;
    }
    const noCookie = new Request('https://local.test/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wd: 'x', sources: SOURCES }),
    });
    const unauthorized = await POST(noCookie);
    expect(unauthorized.status).toBe(401);
  });

  it('繁体查询自动先查简体命中，未命中时回退繁体变体', async () => {
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const wd = url.searchParams.get('wd') || '';
      queries.push(wd);
      if (url.hostname === 'simp.example.com') {
        return new Response(
          wd === '周处除三害'
            ? cmsList([
                { vod_id: 1, vod_name: '周处除三害', type_name: '动作片' },
                { vod_id: 2, vod_name: '周处除三害【解说】', type_name: '动作片' },
              ])
            : cmsList([]),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      // 繁体源仅繁体关键字能命中
      return new Response(
        wd === '周處除三害'
          ? cmsList([{ vod_id: 9, vod_name: '周處除三害', type_name: '動作片' }])
          : cmsList([]),
        { headers: { 'content-type': 'application/json' } }
      );
    }));

    const res = await POST(
      makeRequest({
        wd: '周處除三害',
        sources: [
          { key: 'simp', name: '简体源', url: 'https://simp.example.com/api.php' },
          { key: 'trad', name: '繁体源', url: 'https://trad.example.com/api.php' },
        ],
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as SearchResponse;
    expect(data.list.map((i) => `${i.sourceKey}:${i.vodId}`)).toEqual(['simp:1', 'trad:9', 'simp:2']);
    expect(queries).toContain('周处除三害');
    expect(queries).toContain('周處除三害');
  });

  it('支持 | 多分支合并去重、- 排除过滤与空白 AND 回退', async () => {
    const requestedWds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const wd = new URL(String(input)).searchParams.get('wd') || '';
      requestedWds.push(wd);
      if (wd === '繁花') {
        return new Response(
          cmsList([
            { vod_id: 10, vod_name: '繁花', type_name: '国产剧' },
            { vod_id: 11, vod_name: '繁花【影视解说】', type_name: '解说' },
          ]),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (wd === '三体') {
        return new Response(
          cmsList([
            { vod_id: 20, vod_name: '三体', type_name: '科幻' },
            // 故意重复 id=10 验证同源跨分支去重
            { vod_id: 10, vod_name: '繁花', type_name: '国产剧' },
          ]),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (wd === '测试剧') {
        return new Response(
          cmsList([
            { vod_id: 30, vod_name: '测试剧 2024', type_name: '剧情' },
            { vod_id: 31, vod_name: '测试剧 2023', type_name: '剧情' },
          ]),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(cmsList([]), { headers: { 'content-type': 'application/json' } });
    }));

    // 1. (繁花 | 三體) -解說
    const orRes = await POST(
      makeRequest({
        wd: '(繁花 | 三體) -解說',
        sources: [{ key: 'logic', name: '逻辑源', url: 'https://logic.example.com/api.php' }],
      })
    );
    const orData = (await orRes.json()) as SearchResponse;
    expect(orData.list.map((i) => i.name)).toEqual(['繁花', '三体']);
    expect(requestedWds.some((q) => q.includes('-'))).toBe(false);

    // 2. 空白 AND「測試劇 2024」整体查无时自动回退核心词「测试剧」，并由本地过滤出 2024
    const spaceRes = await POST(
      makeRequest({
        wd: '測試劇 2024',
        sources: [{ key: 'space', name: '空白源', url: 'https://space.example.com/api.php' }],
      })
    );
    const spaceData = (await spaceRes.json()) as SearchResponse;
    expect(spaceData.list.map((i) => i.name)).toEqual(['测试剧 2024']);

    // 3. 纯否定词不请求上游
    const callsBeforePureNot = requestedWds.length;
    const notRes = await POST(
      makeRequest({
        wd: '-解說',
        sources: [{ key: 'purenot', name: '否定源', url: 'https://purenot.example.com/api.php' }],
      })
    );
    expect(await notRes.json()).toEqual({ list: [], failures: [] });
    expect(requestedWds.length).toBe(callsBeforePureNot);
  });

  it('超过 50 个源全部参与搜索且服务端并发受控（≤12）', async () => {
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, 15));
        const idx = new URL(String(input)).hostname.split('.')[0];
        active--;
        return new Response(
          cmsList([{ vod_id: idx, vod_name: `测试剧 ${idx}`, type_name: '国产剧' }]),
          { headers: { 'content-type': 'application/json' } }
        );
      })
    );

    const sources: SourceConfig[] = Array.from({ length: 55 }, (_, i) => ({
      key: `s${i}`,
      name: `源${i}`,
      url: `https://s${i}.pool.example.com/api.php`,
    }));

    const res = await POST(makeRequest({ wd: '测试剧', sources }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as SearchResponse;
    expect(data.failures).toEqual([]);
    expect(data.list).toHaveLength(55);
    expect(maxActive).toBeLessThanOrEqual(12);
  });

  it('后续分页超时时仍保留第一页结果，不把可用源误判为超时失败', async () => {
    vi.useFakeTimers();
    try {
      let pg2Started!: () => void;
      const onPg2Started = new Promise<void>((resolve) => {
        pg2Started = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          const pg = url.searchParams.get('pg');
          if (pg === '1') {
            return Promise.resolve(
              new Response(
                cmsList([{ vod_id: 1, vod_name: '测试剧', type_name: '国产剧' }], 2),
                { headers: { 'content-type': 'application/json' } }
              )
            );
          }
          if (init?.signal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
          }
          if (url.hostname === 'slowpg.example.com' && pg === '2') {
            pg2Started();
          }
          // 后续分页永远挂起，直到收到 abort signal
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        })
      );

      const promise = POST(
        makeRequest({
          wd: '测试剧',
          sources: [{ key: 'slowpg', name: '慢分页源', url: 'https://slowpg.example.com/api.php' }],
        })
      );
      await onPg2Started;
      await vi.advanceTimersByTimeAsync(13000);
      const res = await promise;
      const data = (await res.json()) as SearchResponse;
      expect(data.failures).toEqual([]);
      expect(data.list.map((i) => i.vodId)).toEqual(['1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('简体主查询已返回 200 空结果时，繁体备援超时不记入失败', async () => {
    vi.useFakeTimers();
    try {
      let tradStarted!: () => void;
      const onTradStarted = new Promise<void>((resolve) => {
        tradStarted = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          const wd = url.searchParams.get('wd');
          if (wd === '大陆') {
            return Promise.resolve(new Response(cmsList([]), { headers: { 'content-type': 'application/json' } }));
          }
          if (init?.signal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
          }
          if (url.hostname === 'varok.example.com' && wd === '大陸') {
            tradStarted();
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        })
      );

      const promise = POST(
        makeRequest({
          wd: '大陸',
          sources: [{ key: 'varok', name: '空结果源', url: 'https://varok.example.com/api.php' }],
        })
      );
      await onTradStarted;
      await vi.advanceTimersByTimeAsync(13000);
      const res = await promise;
      const data = (await res.json()) as SearchResponse;
      expect(data.failures).toEqual([]);
      expect(data.list).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
