// 验证 SPA fallback 的 MIME 类型是否正确
async function main() {
  const BASE = 'http://localhost:9400';

  const panel = await fetch(BASE + '/');
  const html = await panel.text();

  // CSS
  const cssMatch = html.match(/href="(\/assets\/[^"]+\.css)"/);
  if (cssMatch) {
    const r = await fetch(BASE + cssMatch[1]);
    const ct = r.headers.get('content-type') || 'none';
    console.log(`CSS: ${r.status} | ${ct} | ${ct.includes('css') ? 'OK' : 'FAIL'}`);
  }

  // JS
  const jsMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
  if (jsMatch) {
    const r = await fetch(BASE + jsMatch[1]);
    const ct = r.headers.get('content-type') || 'none';
    console.log(`JS:  ${r.status} | ${ct} | ${ct.includes('javascript') ? 'OK' : 'FAIL'}`);
  }

  // SPA route
  const route = await fetch(BASE + '/sessions/1');
  const routeHtml = await route.text();
  console.log(`SPA: ${route.status} | ${routeHtml.includes('LLM Monitor') ? 'OK' : 'FAIL'}`);

  // Missing asset should return 404, not HTML
  const missing = await fetch(BASE + '/assets/nonexistent.xyz');
  const missingText = await missing.text();
  console.log(`404: ${missing.status} | html? ${missingText.includes('<!DOCTYPE') ? 'FAIL (got HTML)' : 'OK (plain 404)'}`);
}

main();
