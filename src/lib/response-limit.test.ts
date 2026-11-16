import { describe, expect, it, vi } from 'vitest';
import { PayloadTooLargeError, readBufferWithLimit, readTextWithLimit } from './response-limit';

function chunkedResponse(chunks: Uint8Array[], headers?: HeadersInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe('response-limit', () => {
  it('正常大小的分块文本可完整读取并自动去除 UTF-8 BOM', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const part1 = new TextEncoder().encode('hello ');
    const part2 = new TextEncoder().encode('world');
    const res = chunkedResponse([bom, part1, part2]);

    const text = await readTextWithLimit(res, 1024, '测试文本');
    expect(text).toBe('hello world');
  });

  it('刚好等于 maxBytes 边界时允许通过', async () => {
    const data = new Uint8Array(64).fill(0x41);
    const res = chunkedResponse([data]);

    const buf = await readBufferWithLimit(res, 64, '边界数据');
    expect(buf.byteLength).toBe(64);
  });

  it('Content-Length 超过上限时立即拒绝并取消流', async () => {
    const cancelSpy = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      cancel: cancelSpy,
    });
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-length': '2048' },
    });

    await expect(readBufferWithLimit(res, 1024, '超大内容')).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('无 Content-Length 时在分块累积超限的瞬间中断並抛错', async () => {
    let pulled = 0;
    const cancelSpy = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(600).fill(0x61));
      },
      cancel: cancelSpy,
    });
    const res = new Response(stream, { status: 200 });

    await expect(readTextWithLimit(res, 1000, '分块流')).rejects.toThrow(/体积超出限制/);
    expect(pulled).toBe(2);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
