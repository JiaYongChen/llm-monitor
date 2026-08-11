/** LLM Monitor 应用入口 */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyMiddie from '@fastify/middie';
import { initDb, closeDb, listPricing, upsertPricing } from './db.js';
import { registerProxyRoutes, registerApiRoutes, setEnqueueRef } from './router.js';
import { startRecorder, stopRecorder, enqueueRecord } from './recorder.js';
import { scheduleDailyRefresh, stopDailyRefresh } from './rates.js';
import { PORT, WEBUI_PORT } from './config.js';
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

/** 启动服务器，端口被占用则重试 */
async function listenWithRetry(app: FastifyInstance, port: number, label: string): Promise<void> {
  while (true) {
    try {
      await app.listen({ port, host: '127.0.0.1' });
      console.log(`${label} → http://localhost:${port}`);
      break;
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 被占用，3 秒后重试…`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw err;
      }
    }
  }
}

async function createApp(): Promise<{ proxy: FastifyInstance; webui: FastifyInstance }> {
  await initDb();
  scheduleDailyRefresh();
  await importDefaultPricing();
  startRecorder();
  setEnqueueRef(enqueueRecord);

  // ── 代理服务器（PORT）：只走代理转发，不提供面板 ──
  const proxy = Fastify({ logger: false });
  proxy.get('/proxy/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
  await registerProxyRoutes(proxy);

  // ── 面板服务器（WEBUI_PORT）：API 查询 + 前端 ──
  const webui = Fastify({ logger: false });
  registerApiRoutes(webui);

  const isDev = process.argv.includes('--dev');

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: join(__dirname, '..', 'webui', 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server: webui.server } },
      appType: 'custom',
    });

    await webui.register(fastifyMiddie);
    webui.use(vite.middlewares);

    const indexHtml = readFileSync(join(__dirname, '..', 'webui', 'index.html'), 'utf-8');

    webui.get('/', async (_req, reply) => {
      const html = await vite.transformIndexHtml('/', indexHtml);
      return reply.type('text/html').send(html);
    });

    webui.setNotFoundHandler(async (req, reply) => {
      const url = req.url || '';
      if (/\/[^/]+\.[a-zA-Z0-9]{1,6}$/.test(url)) {
        return reply.status(404).type('text/plain').send('Not found');
      }
      const html = await vite.transformIndexHtml(url, indexHtml);
      return reply.type('text/html').send(html);
    });

    console.log(`开发模式 — Vite HMR 已挂载`);
  } else {
    const staticDir = join(__dirname, '..', 'dist', 'web');
    if (existsSync(staticDir)) {
      await webui.register(fastifyStatic, {
        root: staticDir,
        prefix: '/',
        wildcard: false,
        decorateReply: true,
      });

      webui.setNotFoundHandler((req, reply) => {
        const url = req.url || '';
        if (/\/[^/]+\.[a-zA-Z0-9]{1,6}$/.test(url) && !url.startsWith('/api/')) {
          return reply.status(404).type('text/plain').send('Not found');
        }
        return reply.sendFile('index.html', staticDir);
      });
    }
  }

  proxy.addHook('onClose', async () => {
    stopDailyRefresh();
    stopRecorder();
    closeDb();
  });

  webui.addHook('onClose', async () => {
    // shared state cleanup handled by proxy's onClose
  });

  return { proxy, webui };
}

// 直接运行时启动服务器
const isMain = process.argv[1]?.includes('main.ts') || process.argv[1]?.includes('main.js');
if (isMain) {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const { proxy, webui } = await createApp();
  await Promise.all([
    listenWithRetry(proxy, PORT, '代理'),
    listenWithRetry(webui, WEBUI_PORT, '面板'),
  ]);
}
