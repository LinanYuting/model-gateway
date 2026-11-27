// SSE（Server-Sent Events）流式转发的公共小工具。
//
// 任务书 1.1b 的硬要求是「上游分块返回的结果须逐块透传给调用方，不得收齐整包后再发」，
// 所以这里所有函数都只做「一块进、一块出」，不维护完整响应体，只用一个很小的滑动缓冲
// 顺路收集 usage 字段（用来给 call_logs 记账）。

const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

// 客户端是否要求流式：契约里写的是 body.stream === true，这里额外容忍字符串 "true"。
export function isStreamRequest(body) {
  return body?.stream === true || body?.stream === 'true';
}

// 逐块透传时用到的响应头。
// 注意 X-Accel-Buffering: no —— 反代（nginx）默认会攒包，这一行让它别攒。
export function setSseHeaders(res, extraHeaders = {}) {
  res.status(200);
  res.set('Content-Type', SSE_CONTENT_TYPE);
  res.set('Cache-Control', 'no-cache, no-transform');
  res.set('Connection', 'keep-alive');
  res.set('X-Accel-Buffering', 'no');
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) res.set(key, String(value));
  }
}

// 惰性 SSE 写入器：第一次真正写数据时才发响应头。
// 这样「首字节之前就失败」的情况还能干净地改成 500 JSON（响应头没发出去，来得及改）。
export function createSseWriter(res, extraHeaders = {}) {
  let opened = false;
  return {
    get opened() {
      return opened;
    },
    write(chunk) {
      if (res.writableEnded || res.destroyed) return false;
      if (!opened) {
        opened = true;
        setSseHeaders(res, extraHeaders);
      }
      return res.write(chunk);
    },
    writeEvent(payload) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return this.write(`data: ${text}\n\n`);
    },
    writeDone() {
      return this.write('data: [DONE]\n\n');
    },
    end() {
      if (res.writableEnded || res.destroyed) return;
      if (!opened) {
        opened = true;
        setSseHeaders(res, extraHeaders);
      }
      res.end();
    }
  };
}

// 一面镜子：原样把字节交给客户端，另一面顺路从 SSE 文本里捞 usage。
// 只保留 16KB 的滑动窗口，异常上游一直不发空行也不会把内存吃爆。
export function createUsageTap({ maxBufferedBytes = 128 * 1024 } = {}) {
  let buffer = '';
  let usage = null;
  let sawDone = false;

  function consume() {
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object' && parsed.usage) usage = parsed.usage;
        } catch {
          // 上游给的不是 JSON（或者被截断），忽略即可——反正这一块已经原样转出去了
        }
      }
    }
    if (buffer.length > maxBufferedBytes) buffer = buffer.slice(-16 * 1024);
  }

  return {
    write(chunk) {
      if (!chunk) return;
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      consume();
    },
    get usage() {
      return usage;
    },
    get sawDone() {
      return sawDone;
    }
  };
}

// 把上游流一字节不改地搬给客户端，同时统计「发了多少字节 / 有没有正常收尾 / 能不能解析出 usage」。
// 返回的 Promise 永 reject：失败也作为 { error } 返回，方便调用方决定「补一个 SSE error 事件」还是「换通道兜底」。
export function pipeUpstream(upstream, writer, res) {
  return new Promise((resolve) => {
    const tap = createUsageTap();
    let bytesWritten = 0;
    let clientClosed = false;
    let settled = false;

    const settle = (error) => {
      if (settled) return;
      settled = true;
      res.off('close', onClientClose);
      resolve({ bytesWritten, clientClosed, usage: tap.usage, sawDone: tap.sawDone, error: error || null });
    };

    // 客户端提前断开：别再往上游要数据了
    const onClientClose = () => {
      if (settled) return;
      clientClosed = true;
      if (typeof upstream.destroy === 'function') upstream.destroy();
      settle(null);
    };

    res.on('close', onClientClose);

    upstream.on('data', (chunk) => {
      if (clientClosed || settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      tap.write(buf);
      bytesWritten += buf.length;
      // 背压：客户端消费不过来时先把上游暂停，等 drain 再继续，避免内存里堆整包
      const flushed = writer.write(buf);
      if (flushed === false && typeof upstream.pause === 'function') {
        upstream.pause();
        res.once('drain', () => upstream.resume());
      }
    });

    upstream.on('end', () => settle(null));
    upstream.on('error', (error) => settle(error));
    upstream.on('aborted', () => settle(new Error('upstream stream aborted')));
  });
}

// 未实现流式的通道（当前是 free / aiping）承接 stream 请求时的降级写法：
// 整包拿到后一次性以「一个 data 事件 + [DONE]」送出。仍然保持 SSE 协议，前端不用改。
export function writeSingleShotSse(writer, data) {
  writer.writeEvent(data);
  writer.writeDone();
  writer.end();
}
