/** 响应体体积超出上限时抛出，防止上游返回超大报文导致服务端 OOM */
export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(label: string, maxBytes: number) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
    super(`${label}体积超出限制（上限 ${mb} MB）`);
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * 带体积上限的二进制读取：
 * 1. 先检查 Content-Length，提前拦截明显超限的响应；
 * 2. 再通过 ReadableStream 逐块累加字节数，一旦超限立即 cancel() 中断连接并抛错，
 *    避免攻击性或异常上游用分块传输（无 Content-Length）撑爆内存。
 */
export type ReadableHttpMessage = Pick<Response, 'headers' | 'body' | 'arrayBuffer'>;

export async function readBufferWithLimit(
  res: ReadableHttpMessage,
  maxBytes: number,
  label = '上游响应'
): Promise<Buffer> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new PayloadTooLargeError(label, maxBytes);
    }
  }

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new PayloadTooLargeError(label, maxBytes);
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        throw new PayloadTooLargeError(label, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    if (exceeded) {
      await reader.cancel().catch(() => {});
    }
  }
  return Buffer.concat(chunks, total);
}

/** 带体积上限的 UTF-8 文本读取（自动剥离 UTF-8 BOM，与 Response.text() 语义一致） */
export async function readTextWithLimit(
  res: ReadableHttpMessage,
  maxBytes: number,
  label = '上游响应'
): Promise<string> {
  const buf = await readBufferWithLimit(res, maxBytes, label);
  return new TextDecoder('utf-8').decode(buf);
}
