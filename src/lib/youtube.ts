/**
 * YouTube 直播網址解析工具：
 * 許多公開台灣／國際新聞台 M3U（如 ChiSheng9、Free-TV）收錄的是官方 YouTube 24 小時直播頁，
 * 無法由 hls.js 直接當成 m3u8 播放，須轉為嵌入式播放器或顯示明確提示。
 */

export type YouTubeLiveTarget =
  | { kind: 'video'; id: string; embedUrl: string; watchUrl: string }
  | { kind: 'channel'; channelId: string; embedUrl: string; watchUrl: string }
  | { kind: 'handle'; watchUrl: string }
  | { kind: 'invalid'; watchUrl: string };

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{10,48}$/;

function buildVideoEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`;
}

function buildChannelEmbed(channelId: string): string {
  return `https://www.youtube-nocookie.com/embed/live_stream?channel=${encodeURIComponent(channelId)}&autoplay=1&rel=0&playsinline=1`;
}

export function isYouTubeUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return (u.protocol === 'http:' || u.protocol === 'https:') && YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseYouTubeLiveTarget(urlString: string): YouTubeLiveTarget | null {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0] || '';
    if (VIDEO_ID_RE.test(id)) {
      return {
        kind: 'video',
        id,
        embedUrl: buildVideoEmbed(id),
        watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      };
    }
    return { kind: 'invalid', watchUrl: u.href };
  }

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'watch') {
    const v = (u.searchParams.get('v') || '').trim();
    if (VIDEO_ID_RE.test(v)) {
      return {
        kind: 'video',
        id: v,
        embedUrl: buildVideoEmbed(v),
        watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`,
      };
    }
    return { kind: 'invalid', watchUrl: u.href };
  }

  if ((parts[0] === 'live' || parts[0] === 'embed') && parts[1]) {
    if (parts[1] === 'live_stream') {
      const ch = (u.searchParams.get('channel') || '').trim();
      if (CHANNEL_ID_RE.test(ch)) {
        return {
          kind: 'channel',
          channelId: ch,
          embedUrl: buildChannelEmbed(ch),
          watchUrl: `https://www.youtube.com/channel/${encodeURIComponent(ch)}/live`,
        };
      }
      return { kind: 'invalid', watchUrl: u.href };
    }
    if (VIDEO_ID_RE.test(parts[1])) {
      return {
        kind: 'video',
        id: parts[1],
        embedUrl: buildVideoEmbed(parts[1]),
        watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(parts[1])}`,
      };
    }
  }

  if (parts[0] === 'channel' && parts[1] && CHANNEL_ID_RE.test(parts[1])) {
    return {
      kind: 'channel',
      channelId: parts[1],
      embedUrl: buildChannelEmbed(parts[1]),
      watchUrl: `https://www.youtube.com/channel/${encodeURIComponent(parts[1])}/live`,
    };
  }

  if (parts[0]?.startsWith('@') || parts[0] === 'c' || parts[0] === 'user') {
    return { kind: 'handle', watchUrl: u.href };
  }

  return { kind: 'invalid', watchUrl: u.href };
}
