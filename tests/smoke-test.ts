// 冒烟测试：验证代理 + API 完整链路

async function main() {
  const BASE = 'http://localhost:9400';

  // 1. 健康检查
  try {
    const res = await fetch(`${BASE}/proxy/health`);
    const health = await res.json();
    console.log('HEALTH:', JSON.stringify(health));
  } catch (e) {
    console.log('代理未就绪，请先启动: npx tsx proxy/main.ts');
    return;
  }

  // 2. 检查预置定价
  const pricingRes = await fetch(`${BASE}/api/pricing`);
  const pricing = await pricingRes.json();
  console.log(`\nPRICING: ${pricing.length} 条预置定价`);
  pricing.slice(0, 3).forEach((p: any) => {
    console.log(`  ${p.provider}/${p.model}: $${p.input_price}/$${p.cache_input_price}/$${p.output_price}`);
  });

  // 3. 模拟 Anthropic 调用（非流式）
  console.log('\n模拟 Anthropic 调用...');
  const res1 = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-test' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }),
  });
  console.log(`  状态: ${res1.status}`);

  // 4. 模拟 OpenAI 调用
  console.log('模拟 OpenAI 调用...');
  const res2 = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }),
  });
  console.log(`  状态: ${res2.status}`);

  // 等待后台处理
  await new Promise(r => setTimeout(r, 1000));

  // 5. 检查会话
  const sessionsRes = await fetch(`${BASE}/api/sessions`);
  const sessions = await sessionsRes.json();
  console.log(`\nSESSIONS: ${sessions.length} 个会话`);
  sessions.forEach((s: any) => {
    console.log(`  #${s.id} ${s.tool} | ${s.request_count}次 | $${s.total_cost.toFixed(4)} | ${s.status}`);
  });

  // 6. 检查调用记录
  const callsRes = await fetch(`${BASE}/api/calls?limit=5`);
  const calls = await callsRes.json();
  console.log(`\nCALLS: ${calls.length} 条（最新 5 条）`);
  calls.forEach((c: any) => {
    console.log(`  #${c.id} ${c.provider} ${c.model} | ${c.status_code} | ${Math.round(c.duration_ms)}ms | $${c.total_cost.toFixed(5)}`);
  });

  // 7. 检查统计
  const statsRes = await fetch(`${BASE}/api/stats?group_by=provider`);
  const stats = await statsRes.json();
  console.log(`\nSTATS:`);
  stats.forEach((s: any) => {
    console.log(`  ${s.key}: ${s.count}次 | $${s.total_cost.toFixed(4)}`);
  });

  // 8. 尝试打开面板
  const panelRes = await fetch(`${BASE}/`);
  console.log(`\nPANEL: ${panelRes.status} (${panelRes.headers.get('content-type')})`);
}

main().catch(e => console.error('错误:', e.message));
