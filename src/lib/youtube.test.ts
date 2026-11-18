import { describe, expect, it } from 'vitest';
import { isYouTubeUrl, parseYouTubeLiveTarget } from './youtube';

describe('parseYouTubeLiveTarget', () => {
  it('解析標準 watch?v= 連結為 nocookie 嵌入網址', () => {
    const parsed = parseYouTubeLiveTarget('https://www.youtube.com/watch?v=m_dhMSvUCIc');
    expect(parsed).toEqual({
      kind: 'video',
      id: 'm_dhMSvUCIc',
      embedUrl: 'https://www.youtube-nocookie.com/embed/m_dhMSvUCIc?autoplay=1&rel=0&playsinline=1',
      watchUrl: 'https://www.youtube.com/watch?v=m_dhMSvUCIc',
    });
  });

  it('解析 youtu.be 與 /live/ 短連結', () => {
    expect(parseYouTubeLiveTarget('https://youtu.be/dZp87qnWelE')).toMatchObject({
      kind: 'video',
      id: 'dZp87qnWelE',
    });
    expect(parseYouTubeLiveTarget('https://www.youtube.com/live/TCnaIE_SAtM')).toMatchObject({
      kind: 'video',
      id: 'TCnaIE_SAtM',
    });
  });

  it('解析 /channel/UC.../live 為 live_stream 嵌入網址', () => {
    const parsed = parseYouTubeLiveTarget('https://www.youtube.com/channel/UCXgIO9jJVsX5_2ideiSkfvA/live');
    expect(parsed).toEqual({
      kind: 'channel',
      channelId: 'UCXgIO9jJVsX5_2ideiSkfvA',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/live_stream?channel=UCXgIO9jJVsX5_2ideiSkfvA&autoplay=1&rel=0&playsinline=1',
      watchUrl: 'https://www.youtube.com/channel/UCXgIO9jJVsX5_2ideiSkfvA/live',
    });
  });

  it('識別 /c/ 與 /@handle 形式並標記缺少 video id 的 watch?v= 為 invalid', () => {
    expect(parseYouTubeLiveTarget('https://www.youtube.com/@TTV_NEWS/live')).toMatchObject({ kind: 'handle' });
    expect(parseYouTubeLiveTarget('https://www.youtube.com/c/twctvnews/live')).toMatchObject({ kind: 'handle' });
    expect(parseYouTubeLiveTarget('https://www.youtube.com/watch?v=')).toMatchObject({ kind: 'invalid' });
  });

  it('非 YouTube 網址返回 null 且 isYouTubeUrl 為 false', () => {
    expect(parseYouTubeLiveTarget('https://example.com/live.m3u8')).toBeNull();
    expect(isYouTubeUrl('https://example.com/live.m3u8')).toBe(false);
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=123456')).toBe(true);
  });
});
