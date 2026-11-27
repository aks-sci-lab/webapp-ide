// 오프라인 내보내기: CDN 라이브러리·스타일·폰트를 내려받아 HTML 파일 하나에 모두 넣는다.
// 인터넷이 없는 교실 PC 에서도 그 파일 하나만 열면 동작하게.
//  - <script src="https://…">          → 내용을 그대로 <script> 안에
//  - <link rel="stylesheet" href="https://…"> → <style> 안에, CSS 의 url(…) 폰트·이미지는 data: URI 로
//  - 코드 속 문자열로 쓰인 CDN 주소 (예: pdf.js worker) → 내용을 숨은 블록에 넣고 실행 중에 blob: 주소로 바꿔 준다

const CDN = /(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|code\.jquery\.com|cdn\.tailwindcss\.com)/;
const MIME = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm',
};
const mimeOf = (url) => MIME[(new URL(url).pathname.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

async function download(url, cache, report) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'webapp-ide-offline-export' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    report.downloaded.push({ url, bytes: buf.length });
    return buf;
  })();
  cache.set(url, p);
  return p;
}

const escScript = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

// @font-face 의 src 에 woff2 가 있으면 그것만 남긴다 (모든 최신 브라우저가 woff2 를 써서 woff·ttf 는 안 쓰인다 — 파일 크기 절반)
function preferWoff2(css) {
  return css.replace(/(\bsrc\s*:\s*)([^;}]+)/g, (all, head, list) => {
    const parts = list.split(/,(?=\s*(?:url|local)\s*\()/);
    const woff2 = parts.filter((p) => /woff2/i.test(p));
    return woff2.length && woff2.length < parts.length ? head + woff2.join(',') : all;
  });
}

async function inlineCss(css, baseUrl, cache, report) {
  css = preferWoff2(css);
  const urls =[...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]).filter((u) => !u.startsWith('data:') && !u.startsWith('#')))];
  for (const u of urls) {
    try {
      const abs = new URL(u, baseUrl).href;
      const buf = await download(abs, cache, report);
      const data = `data:${mimeOf(abs)};base64,${buf.toString('base64')}`;
      css = css.split(u).join(data);
    } catch (e) {
      // 옛 브라우저용 예비 폰트(ttf·eot)는 CDN 에 없기도 하고 실제로 쓰이지 않는다
      if (/\.(ttf|eot|otf)(\?|#|$)/i.test(u)) report.skipped.push(u);
      else report.failed.push({ url: u, error: e.message });
    }
  }
  // @import 는 한 단계만 펼친다
  for (const m of [...css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g)]) {
    try {
      const abs = new URL(m[1], baseUrl).href;
      const inner = await inlineCss((await download(abs, cache, report)).toString('utf8'), abs, cache, report);
      css = css.replace(m[0], inner);
    } catch (e) {
      report.failed.push({ url: m[1], error: e.message });
    }
  }
  return css;
}

export async function makeOffline(html) {
  const cache = new Map();
  const report = { downloaded: [], failed: [], skipped: [], assets: [] };

  // 1) 외부 스크립트
  for (const m of [...html.matchAll(/<script\b([^>]*)\bsrc=["'](https?:\/\/[^"']+)["']([^>]*)><\/script>/gi)]) {
    try {
      const code = (await download(m[2], cache, report)).toString('utf8');
      const attrs = `${m[1]}${m[3]}`.replace(/\s+(defer|async|crossorigin(=["'][^"']*["'])?|integrity=["'][^"']*["'])/gi, '');
      html = html.replace(m[0], () => `<script${attrs}>/* ${m[2]} */\n${escScript(code)}\n</script>`);
    } catch (e) {
      report.failed.push({ url: m[2], error: e.message });
    }
  }

  // 2) 외부 스타일시트 (+ 그 안의 폰트·이미지)
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)]) {
    const href = m[0].match(/href=["'](https?:\/\/[^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const css = await inlineCss((await download(href, cache, report)).toString('utf8'), href, cache, report);
      html = html.replace(m[0], () => `<style>/* ${href} */\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
    } catch (e) {
      report.failed.push({ url: href, error: e.message });
    }
  }

  // 3) 코드 속 문자열로 쓰인 CDN 주소 → 실행 중에 blob: 주소로
  const literals = [...new Set([...html.matchAll(/(['"`])(https?:\/\/[^'"`\s]+)\1/g)].map((m) => m[2]).filter((u) => CDN.test(u)))];
  const blocks = [];
  for (const url of literals) {
    try {
      const buf = await download(url, cache, report);
      blocks.push(`<script type="text/plain" data-ide-asset="${url}" data-mime="${mimeOf(url)}">${buf.toString('base64')}</script>`);
      html = html.split(`'${url}'`).join(`__ideAsset(${JSON.stringify(url)})`).split(`"${url}"`).join(`__ideAsset(${JSON.stringify(url)})`).split(`\`${url}\``).join(`__ideAsset(${JSON.stringify(url)})`);
      report.assets.push(url);
    } catch (e) {
      report.failed.push({ url, error: e.message });
    }
  }
  if (blocks.length) {
    const helper = `<script>
// 오프라인 내보내기: 코드에 적힌 CDN 주소 대신 이 파일 안에 넣어 둔 내용을 blob: 주소로 돌려준다
window.__ideAsset = (url) => {
  const el = document.querySelector('script[data-ide-asset="' + url + '"]');
  if (!el) return url;
  const bin = atob(el.textContent.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: el.dataset.mime }));
};
</script>
${blocks.join('\n')}`;
    html = html.replace(/<head>/i, `<head>\n${helper}`);
  }
  return { html, report: { ...report, totalBytes: report.downloaded.reduce((s, d) => s + d.bytes, 0) } };
}
