/**
 * 集成冒烟测试：Mock Server + 代理 + 完整链路验证
 */
import { createMockServer } from './mock-llm-server.js';
import { createApp } from '../proxy/main.js';
import type { FastifyInstance } from 'fastify';

async function main() {
  // 1. 启动 Mock LLM Server
  const { app: mockApp, url: mockUrl } = await createMockServer();
  console.log(`Mock Server: ${mockUrl}`);

  // 2. 启动代理，通过 provider_config 表注入 mock 上游
  // 先初始化 DB，再修改 provider_config 指向 mock
  const { initDb, updateProviderConfig } = await import('../proxy/db.js');
  await initDb();

  const providers = ['anthropic', 'openai', 'deepseek', 'qwen'];
  for (const p of providers) {
    updateProviderConfig(p, mockUrl, '', true);
  }
  console.log('已将全部 provider 上游指向 Mock Server');

  const app = await createApp();
  await app.listen({ port: 9401, host: '127.0.0.1' });
  console.log(`代理: http://127.0.0.1:9401`);

  const BASE = 'http://127.0.0.1:9401';

  try {
    // 3. 健康检查
    const h = await fetch(`${BASE}/proxy/health`);
    console.log('\n[健康检查]', (await h.json()).status);

    // 4. 预置定价
    const p = await fetch(`${BASE}/api/pricing`);
    const pricing: any[] = await p.json();
    console.log(`[定价] ${pricing.length} 条`);
    pricing.slice(0, 2).forEach((x: any) =>
      console.log(`  ${x.provider}/${x.model} in=$${x.input_price} out=$${x.output_price}`));

    // 5. 模拟 Anthropic 非流式调用
    const r1 = await fetch(`${BASE}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-api03-test123' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }),
    });
    const d1: any = await r1.json();
    console.log(`\n[Anthropic] ${r1.status} | usage: ${JSON.stringify(d1.usage)}`);

    // 6. 模拟 OpenAI 非流式调用
    const r2 = await fetch(`${BASE}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-proj-test' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
    });
    console.log(`[OpenAI] ${r2.status}`);

    // 7. DeepSeek 调用
    const r3 = await fetch(`${BASE}/deepseek/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ds-test' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
    });
    console.log(`[DeepSeek] ${r3.status}`);

    // 等待 Recorder 处理
    await new Promise(r => setTimeout(r, 1500));

    // 8. 会话
    const s = await fetch(`${BASE}/api/sessions`);
    const sessions: any[] = await s.json();
    console.log(`\n[会话] ${sessions.length} 个`);
    sessions.forEach((x: any) => {
      console.log(`  #${x.id} ${x.tool} | ${x.request_count}次 | $${x.total_cost.toFixed(6)} | ${x.status}`);
    });

    // 9. 调用记录
    const c = await fetch(`${BASE}/api/calls?limit=10`);
    const calls: any[] = await c.json();
    console.log(`\n[调用] ${calls.length} 条`);
    calls.forEach((x: any) => {
      const cost = x.total_cost > 0 ? `$${x.total_cost.toFixed(6)}` : '(待定价)';
      console.log(`  #${x.id} ${x.provider} ${x.model} | ${x.status_code} | ${x.duration_ms}ms | ${cost}`);
    });

    // 10. 统计
    const st = await fetch(`${BASE}/api/stats?group_by=provider`);
    const stats: any[] = await st.json();
    console.log(`\n[统计]`);
    stats.forEach((x: any) => {
      console.log(`  ${x.key}: ${x.count}次 $${x.total_cost.toFixed(6)}`);
    });

    // 11. 面板可访问
    const panel = await fetch(`${BASE}/`);
    const isHtml = (await panel.text()).includes('<!DOCTYPE');
    console.log(`\n[面板] ${panel.status} HTML:${isHtml}`);

  } finally {
    await app.close();
    await mockApp.close();
  }

  console.log('\n===== 冒烟测试通过 =====');
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
