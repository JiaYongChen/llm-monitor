/** 流式路径上游失败暴露测试 — 错误状态码按原样返回 + 中途断流传播失败 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDb, closeDb, updateProviderConfig } from '../proxy/db.js';
import { registerProxyRoutes } from '../proxy/router.js';
import { forwardStream } from '../proxy/forwarder.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
let upstream: FastifyInstance;
let upstreamUrl = '';
let app: FastifyInstance;

beforeAll(async () => {
  await initDb(tmp.dbPath);

  // 模拟上游：/anthropic/v1/messages 恒返回 500；/broken/v1/messages 发部分 SSE 后断开
  upstream = Fastify({ logger: false });
  upstream.post('/anthropic/v1/messages', async (_req, reply) => {
    return reply.status(500).send({ error: { type: 'api_error', message: 'upstream fault' } });
  });
  upstream.post('/broken/v1/messages', async (_req, reply) => {
    reply.hijack();
    // 声明 content-length 后提前断开 → 客户端读取必然报错（而非干净 EOF）
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '100000' });
    reply.raw.write('data: {"partial":1}\n\n');
    setTimeout(() => reply.raw.destroy(), 20);
  });
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const addr = upstream.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  upstreamUrl = `http://127.0.0.1:${port}`;

  // base_url 带 /anthropic 前缀 → detectFormatFromUrl 识别为 anthropic 格式 → claudecode 无需转换
  updateProviderConfig('Anthropic', { base_url: `${upstreamUrl}/anthropic` });
  app = Fastify();
  await registerProxyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await upstream?.close();
  closeDb();
  tmp.cleanup();
});

describe('流式路径暴露上游失败', () => {
  it('上游 500（stream=true）：按原状态码返回错误体，而非 200 + SSE 包装', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/claudecode/v1/messages',
      payload: { model: 'claude-sonnet-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(res.body).toContain('upstream fault');
  });

  it('上游中途断流：流向下游传播失败（非干净 EOF），collectResult 报 502 + streamError', async () => {
    const fwd = await forwardStream('POST', `${upstreamUrl}/broken/v1/messages`, { 'content-type': 'application/json' }, Buffer.from('{}'));
    expect(fwd.status).toBe(200);
    let errored = false;
    await fwd.stream.pipeTo(new WritableStream({ write() {} })).catch(() => { errored = true; });
    expect(errored).toBe(true);
    const result = await fwd.collectResult();
    expect(result.status).toBe(502);
    expect(result.streamError).toBeTruthy();
  });
});
