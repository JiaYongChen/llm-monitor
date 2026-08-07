import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { initDb, closeDb, listPricing, upsertPricing } from './db.js';
import { registerProxyRoutes, setEnqueueRef } from './router.js';
import { startRecorder, stopRecorder, enqueueRecord } from './recorder.js';
import { PORT } from './config.js';
import { readFileSync } from 'node:fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
async function importDefaultPricingIfEmpty() {
    const existing = listPricing();
    if (existing.length === 0) {
        try {
            const file = join(__dirname, '..', 'data', 'default-pricing.json');
            const data = JSON.parse(readFileSync(file, 'utf-8'));
            for (const item of data) {
                upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price);
            }
            console.log(`已导入 ${data.length} 条预置定价`);
        }
        catch (err) {
            console.warn('导入预置定价失败:', err);
        }
    }
}
export async function createApp() {
    await initDb();
    await importDefaultPricingIfEmpty();
    startRecorder();
    setEnqueueRef(enqueueRecord);
    const app = Fastify({ logger: false });
    // 健康检查
    app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
    // 代理路由 + 查询 API
    await registerProxyRoutes(app);
    // 生产模式：托管前端静态文件
    const staticDir = join(__dirname, '..', 'dist', 'web');
    if (existsSync(staticDir)) {
        await app.register(fastifyStatic, {
            root: staticDir,
            prefix: '/',
            wildcard: false,
            decorateReply: true,
        });
        // SPA fallback：仅对无扩展名的路由返回 index.html
        // JS/CSS/图片等带扩展名的请求返回 404
        app.setNotFoundHandler((req, reply) => {
            const url = req.url || '';
            // 有文件扩展名 → 真正的 404
            if (/\/[^/]+\.[a-zA-Z0-9]{1,6}$/.test(url) && !url.startsWith('/api/')) {
                return reply.status(404).type('text/plain').send('Not found');
            }
            // 前端路由 → SPA fallback
            return reply.sendFile('index.html', staticDir);
        });
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
    const app = await createApp();
    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`LLM Monitor: http://localhost:${PORT}`);
}
//# sourceMappingURL=main.js.map