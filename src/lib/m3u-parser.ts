import type { LiveChannel } from './types';
import { parseYouTubeLiveTarget } from './youtube';

/**
 * M3U / M3U8 直播播放列表解析。
 *
 * 兼容两种常见写法：
 * - 标准：`#EXTINF:-1 tvg-id="cctv1" tvg-logo="..." group-title="央视",CCTV-1`
 * - 非标准（属性写在标题后）：`#EXTINF:-1,CCTV-1 tvg-id="cctv1"`
 * 另支持 `#EXTGRP:分组名` 补充分组，以及 `#EXTVLCOPT:http-referrer=...` /
 * `#EXTVLCOPT:http-user-agent=...` 與 `http-referrer` / `http-user-agent` 屬性。
 *
 * 解析为单趟扫描（O(n)），频道按 URL 去重，仅保留 http(s) 流地址
 * （rtp:// udp:// rtsp:// 等浏览器无法播放的协议直接丢弃）。
 */

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const ATTR_STRIP_RE = /[a-zA-Z0-9_-]+="[^"]*"/g;

/** 由任意字符串生成稳定的短 id（djb2 变体，与 store.ts subKeyPrefix 同风格） */
function stableId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 清理 User-Agent 字串：去除換行與控制字元並限制長度 */
function sanitizeUserAgent(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\r\n\0]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 512) : undefined;
}

/** 相对地址按订阅 URL 解析为绝对地址；仅放行 http(s) */
export function normalizeStreamUrl(raw: string, baseUrl?: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || /^\[.*\]$/.test(trimmed) || /\s/.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
}

/** URL 无名时的兜底名称：取路径末段，decode 后仍空则用主机名 */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) {
      const decoded = decodeURIComponent(last).replace(/\.(m3u8?|flv|ts|mp4)$/i, '');
      if (decoded) return decoded;
    }
    return u.hostname;
  } catch {
    return '未命名频道';
  }
}

interface ExtinfContext {
  attrs: Record<string, string>;
  title: string;
  /** #EXTGRP 补充的分组（EXTINF 自身带 group-title 时忽略） */
  extGroup: string;
  /** #EXTVLCOPT:http-referrer= 指定的來源頁 */
  extReferrer?: string;
  /** #EXTVLCOPT:http-user-agent= 指定的 User-Agent */
  extUserAgent?: string;
}

export function parseM3u(content: string, baseUrl?: string): LiveChannel[] {
  const channels: LiveChannel[] = [];
  if (!content) return channels;

  const seen = new Set<string>();
  let ctx: ExtinfContext | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(line))) attrs[m[1].toLowerCase()] = m[2].trim();

      // 移除属性片段后取首个逗号之后的文本为显示名
      const stripped = line.replace(ATTR_STRIP_RE, '').replace(/^#EXTINF\s*:\s*/i, '');
      const commaIdx = stripped.indexOf(',');
      const title = (commaIdx >= 0 ? stripped.slice(commaIdx + 1) : stripped)
        .trim()
        .replace(/^"+|"+$/g, '');

      ctx = { attrs, title, extGroup: '' };
      continue;
    }

    if (line.toUpperCase().startsWith('#EXTGRP:')) {
      const g = line.slice('#EXTGRP:'.length).trim();
      if (ctx && g && !ctx.attrs['group-title']) ctx.extGroup = g;
      continue;
    }

    if (line.toUpperCase().startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      const eqIdx = opt.indexOf('=');
      if (ctx && eqIdx > 0) {
        const key = opt.slice(0, eqIdx).trim().toLowerCase();
        const val = opt.slice(eqIdx + 1).trim();
        if (key === 'http-referrer' || key === 'http-referer') {
          ctx.extReferrer = normalizeStreamUrl(val, baseUrl);
        } else if (key === 'http-user-agent') {
          ctx.extUserAgent = sanitizeUserAgent(val);
        }
      }
      continue;
    }

    if (line.startsWith('#')) continue; // 其余注释与指令忽略

    // 非注释行即流地址
    const url = normalizeStreamUrl(line, baseUrl);
    const cur = ctx;
    ctx = null;
    if (!url || seen.has(url)) continue;
    const yt = parseYouTubeLiveTarget(url);
    if (yt?.kind === 'invalid') continue;
    seen.add(url);

    const attrs = cur?.attrs ?? {};
    const tvgId = attrs['tvg-id'] || undefined;
    const logo = attrs['tvg-logo'] ? normalizeStreamUrl(attrs['tvg-logo'], baseUrl) : undefined;
    const referrer = cur?.extReferrer || (attrs['http-referrer'] ? normalizeStreamUrl(attrs['http-referrer'], baseUrl) : undefined);
    const userAgent = cur?.extUserAgent || sanitizeUserAgent(attrs['http-user-agent']);
    const name = cur?.title || nameFromUrl(url);
    channels.push({
      id: tvgId || stableId(url),
      name,
      url,
      logo,
      group: attrs['group-title'] || cur?.extGroup || undefined,
      tvgId,
      rawName: attrs['tvg-name'] || undefined,
      ...(referrer ? { referrer } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
  }

  return channels;
}
