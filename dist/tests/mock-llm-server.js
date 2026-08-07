/** Mock LLM API 服务器 — 模拟四家 provider 的 API 响应，用于测试 */
import Fastify from 'fastify';
export async function createMockServer() {
    const app = Fastify({ logger: false });
    // ── 上游路径（API 实际路径，不含 provider 前缀）──
    // Anthropic 上游路径
    app.post('/v1/messages', async (req, reply) => {
        const error = (req.url || '').includes('error=429') ? 429 : (req.url || '').includes('error=500') ? 500 : 0;
        if (error === 429)
            return reply.status(429).send({ error: { message: 'rate_limited' } });
        if (error === 500)
            return reply.status(500).send('Internal Server Error');
        const body = req.body;
        return {
            id: 'msg_abc123', type: 'message', role: 'assistant', model: body?.model || 'claude-sonnet-5',
            content: [{ type: 'text', text: '这是 Claude 的模拟响应。' }], stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
        };
    });
    app.get('/v1/models', async () => ({ object: 'list', data: [] }));
    // OpenAI 上游路径
    app.post('/v1/chat/completions', async (req, reply) => {
        const body = req.body;
        const model = body?.model || 'gpt-4o';
        // 根据 model 前缀判断 provider 格式
        if (model.startsWith('deepseek')) {
            return {
                id: 'ds_abc', object: 'chat.completion', model,
                choices: [{ index: 0, message: { role: 'assistant', content: '这是 DeepSeek 的模拟响应。' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1200, completion_tokens: 500, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 400 },
            };
        }
        if (model.startsWith('qwen')) {
            return {
                id: 'qwen_abc', object: 'chat.completion', model,
                choices: [{ index: 0, message: { role: 'assistant', content: '这是 Qwen 的模拟响应。' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 800, completion_tokens: 350, prompt_tokens_details: { cached_tokens: 400, cache_creation_input_tokens: 200 } },
            };
        }
        // OpenAI
        return {
            id: 'chatcmpl_abc', object: 'chat.completion', model,
            choices: [{ index: 0, message: { role: 'assistant', content: '这是 GPT 的模拟响应。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 600, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 300 } },
        };
    });
    // Qwen DashScope（独立上游路径）
    app.post('/compatible-mode/v1/chat/completions', async (req, reply) => {
        const body = req.body;
        return {
            id: 'qwen_abc', object: 'chat.completion', model: body?.model || 'qwen-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: '这是 Qwen 的模拟响应。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 800, completion_tokens: 350, prompt_tokens_details: { cached_tokens: 400, cache_creation_input_tokens: 200 } },
        };
    });
    // 启动到随机端口
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { app, url: `http://127.0.0.1:${port}` };
}
//# sourceMappingURL=mock-llm-server.js.map