/** LLM Monitor 应用入口 */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyMiddie from '@fastify/middie';
import { initDb, closeDb, listProviderConfigs } from './db.js';
import { UPSTREAMS } from './router.js';
import { registerProxyRoutes, registerApiRoutes, setEnqueueRef } from './router.js';
import { startRecorder, stopRecorder, enqueueRecord } from './recorder.js';
import { startBodyMigration, stopBodyMigration, reconcileOrphanBodies } from './db-body.js';
import { scheduleDailyRefresh, stopDailyRefresh } from './rates.js';
import { scheduleDailyModelSync, stopDailyModelSync } from './model-sync.js';
import { PORT, WEBUI_PORT } from './config.js';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  startBodyMigration();
  // 孤儿 body 文件对账（后台，延迟启动不阻塞服务）
  setTimeout(() => {
    try {
      const removed = reconcileOrphanBodies();
      if (removed > 0) console.log(`[db] 孤儿 body 对账：已清理 ${removed} 个文件`);
    } catch (err) {
      console.warn('[db] 孤儿 body 对账失败:', (err as Error).message);
    }
  }, 5000);
  scheduleDailyRefresh();
  scheduleDailyModelSync();
  // 注：预置定价种子导入由 Task 4 重写为 seedProviderModels，此处暂移除

  // 启动时校验所有已启用供应商的 base_url 有效，阻止无效配置启动
  const providers = listProviderConfigs() as any[];
  for (const p of providers) {
    if (p.enabled) {
      const urls = [p.base_url, p.base_url_anthropic].filter(Boolean) as string[];
      // 内置供应商（Anthropic/OpenAI）有 UPSTREAMS 硬编码默认值，空 URL 可接受
      // 自定义供应商空 URL 降级为警告（不阻止启动，允许通过面板修复）
      if (urls.length === 0 && !UPSTREAMS[p.provider.toLowerCase()]) {
        console.warn(`[启动校验] ⚠ 供应商 "${p.provider}" 未配置任何 Base URL，请求时将返回 500。请在面板中配置上游地址`);
      }
      for (const u of urls) {
        if (!/^https?:\/\/.+/.test(u)) {
          console.error(`[启动校验] 供应商 "${p.provider}" 的 base_url 无效: ${u || '(空)'}`);
          console.error('  请在 Web 面板设置中配置正确的上游地址后重试');
          process.exit(1);
        }
      }
    }
  }

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
    stopDailyModelSync();
    stopBodyMigration();
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
  const { proxy, webui } = await createApp();
  await Promise.all([
    listenWithRetry(proxy, PORT, '代理'),
    listenWithRetry(webui, WEBUI_PORT, '面板'),
  ]);

  // 信号处理放在服务器启动之后，确保 proxy/webui 引用可用
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在关闭...');
    // 1) 先立即保存数据（不依赖 onClose 钩子，防止活跃 SSE 连接使 close() 挂起）
    stopDailyRefresh();
    stopDailyModelSync();
    stopBodyMigration();
    stopRecorder();
    closeDb();
    // 2) 尝试优雅关闭服务器（最多等 3 秒，超时则强退）
    try {
      await Promise.race([
        Promise.all([proxy.close(), webui.close()]),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch {}
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
