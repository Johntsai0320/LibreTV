import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from './auth';
import { MAX_M3U8_BYTES, handleLiveStreamRequest, handleProxyRequest } from './proxy-handlers';

const state = vi.hoisted(() => ({
  responseFactory: (() => new Response('ok', { status: 200 })) as () => Response,
  finalUrl: 'https://cdn.example.com/live/index.m3u8',
}));

vi.mock('@/lib/ssrf', () => ({
  isValidProxyUrl: vi.fn(() => true),
  isBlockedByDNS: vi.fn(async () => false),
  checkLiveUrlAllowed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/fetch-utils', () => ({
  fetchWithSafeRedirects: vi.fn(async () => ({
    res: state.responseFactory(),
    finalUrl: state.finalUrl,
  })),
}));

function makeAuthedRequest(url = 'https://local.test/api/proxy'): Request {
  const { token } = signSession();
  return new Request(url, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password';
  delete process.env.PROXY_SECRET;
});

beforeEach(() => {
  state.finalUrl = 'https://cdn.example.com/live/index.m3u8';
  state.responseFactory = () => new Response('ok', { status: 200 });
});

describe('proxy-handlers 安全加固', () => {
  it('透传上游 HTML/SVG 时附带 sandbox CSP 与 nosniff，阻断同源 XSS', async () => {
    state.responseFactory = () =>
      new Response('<svg onload="alert(1)"></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      });

    const res = await handleProxyRequest(makeAuthedRequest(), 'https://cdn.example.com/evil.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('正常 m3u8 播放列表正常重写并附带安全响应头', async () => {
    state.responseFactory = () =>
      new Response('#EXTM3U\n#EXTINF:5.0,\nseg0.ts\n', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });

    const res = await handleProxyRequest(makeAuthedRequest(), 'https://cdn.example.com/live/index.m3u8');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    const body = await res.text();
    expect(body).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/seg0.ts'));
  });

  it('点播 m3u8 超过大小上限时返回 413 而非打爆内存', async () => {
    state.responseFactory = () =>
      new Response(new ReadableStream(), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(MAX_M3U8_BYTES + 1),
        },
      });

    const res = await handleProxyRequest(makeAuthedRequest(), 'https://cdn.example.com/live/huge.m3u8');
    expect(res.status).toBe(413);
  });

  it('直播 m3u8 超过大小上限时返回 413 JSON 错误', async () => {
    state.responseFactory = () =>
      new Response(new ReadableStream(), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(MAX_M3U8_BYTES + 1),
        },
      });

    const res = await handleLiveStreamRequest(makeAuthedRequest(), 'https://cdn.example.com/live/huge.m3u8');
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('体积超出限制');
  });
});
