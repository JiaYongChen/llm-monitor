/** LLM Monitor 应用入口 */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyMiddie from '@fastify/middie';
import { initDb, closeDb, listPricing, upsertPricing } from './db.js';
import { registerProxyRoutes, setEnqueueRef } from './router.js';
import { startRecorder, stopRecorder, enqueueRecord } from './recorder.js';
import { scheduleDailyRefresh } from './rates.js';
import { PORT } from './config.js';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function importDefaultPricing(): Promise<void> {
  try {
    const file = join(__dirname, 'data', 'default-pricing.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    for (const item of data) {
      upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price, item.currency || 'CNY', true);
    }
    console.log(`已同步 ${data.length} 条预置定价`);
  } catch (err) {
    console.warn('同步预置定价失败:', err);
  }
}

export async function createApp(): Promise<FastifyInstance> {
  await initDb();
  scheduleDailyRefresh();
  await importDefaultPricing();
  startRecorder();
  setEnqueueRef(enqueueRecord);

  const app = Fastify({ logger: false });

  // 健康检查
  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // 代理路由 + 查询 API
  await registerProxyRoutes(app);

  // 判断运行模式
  const isDev = process.argv.includes('--dev');

  if (isDev) {
    // ── 开发模式：Vite 中间件（HMR + 前端，单端口） ──
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: join(__dirname, '..', 'webui', 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server: app.server } },
      appType: 'custom',  // 不做 SPA fallback，由 Fastify 接管
    });

    await app.register(fastifyMiddie);
    app.use(vite.middlewares);

    // 读取 index.html 源码（缓存）
    const indexHtml = readFileSync(join(__dirname, '..', 'webui', 'index.html'), 'utf-8');

    // 注册精确的 / 路由（Vite custom 模式下不自动 fallback）
    app.get('/', async (_req, reply) => {
      const html = await vite.transformIndexHtml('/', indexHtml);
      return reply.type('text/html').send(html);
    });

    // SPA fallback：前端路由交给 Vite 转换 index.html
    app.setNotFoundHandler(async (req, reply) => {
      const url = req.url || '';
      if (/\/[^/]+\.[a-zA-Z0-9]{1,6}$/.test(url)) {
        return reply.status(404).type('text/plain').send('Not found');
      }
      const html = await vite.transformIndexHtml(url, indexHtml);
      return reply.type('text/html').send(html);
    });

    console.log(`开发模式 — Vite 中间件已挂载（面板: http://localhost:${PORT}）`);
  } else {
    // ── 生产模式：托管前端静态文件 ──
    const staticDir = join(__dirname, '..', 'dist', 'web');
    if (existsSync(staticDir)) {
      await app.register(fastifyStatic, {
        root: staticDir,
        prefix: '/',
        wildcard: false,
        decorateReply: true,
      });

      // SPA fallback：仅对无扩展名的路由返回 index.html
      app.setNotFoundHandler((req, reply) => {
        const url = req.url || '';
        if (/\/[^/]+\.[a-zA-Z0-9]{1,6}$/.test(url) && !url.startsWith('/api/')) {
          return reply.status(404).type('text/plain').send('Not found');
        }
        return reply.sendFile('index.html', staticDir);
      });
    }
  }

  app.addHook('onClose', async () => {
    stopRecorder();
    closeDb();
  });

  return app;
}

// 直接运行时启动服务器
const isMain = process.argv[1]?.includes('main.ts') || process.argv[1]?.includes('main.js');
if (isMain) {
  // 优雅关闭：收到 SIGTERM/SIGINT 时释放端口
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const app = await createApp();
  while (true) {
    try {
      await app.listen({ port: PORT, host: '127.0.0.1' });
      console.log(`后台代理已启动 → http://localhost:${PORT}`);
      break;
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 被占用，3 秒后重试…`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}
