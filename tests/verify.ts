// 快速验证：代理 + 面板可用性
async function main() {
  const BASE = 'http://localhost:9400';

  const health = await fetch(`${BASE}/api/health`);
  console.log('Health:', (await health.json()).status);

  const providers = await fetch(`${BASE}/api/providers`);
  const pList: any[] = await providers.json();
  console.log(`Providers: ${pList.length} 个`);
  pList.forEach((p: any) => console.log(`  ${p.provider} | base_url="${p.base_url || '(官方)'}" | enabled=${p.enabled}`));

  const panel = await fetch(`${BASE}/`);
  const html = await panel.text();
  console.log(`Panel: ${panel.status} | HTML ${html.length} bytes | title="${html.match(/<title>(.*?)<\/title>/)?.[1]}"`);
}

main();
