// 웹앱제작기 정적 웹(Firebase Hosting) 배포 번들 빌더 → dist-web/
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist-web');

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}

await fs.rm(outDir, { recursive: true, force: true });
await copyDir(path.join(root, 'public'), outDir);

// index.html 에 브라우저 단독 백엔드 부트스트랩 주입
const idxPath = path.join(outDir, 'index.html');
let html = await fs.readFile(idxPath, 'utf8');
const bootstrap = `<script type="module">
window.__WEB_STANDALONE__ = true;
import { installBrowserBackend } from './browser-backend.js';
installBrowserBackend();
import('./editor.js');
</script>`;
html = html.replace('<script src="editor.js" type="module"></script>', bootstrap);
await fs.writeFile(idxPath, html, 'utf8');

// CodeMirror 필수 파일만 dist-web/vendor/codemirror 로 복사
const cmFiles = [
  'lib/codemirror.css',
  'lib/codemirror.js',
  'theme/material-darker.css',
  'mode/xml/xml.js',
  'mode/javascript/javascript.js',
  'mode/css/css.js',
  'mode/htmlmixed/htmlmixed.js',
  'addon/edit/matchbrackets.js',
  'addon/edit/closebrackets.js',
  'addon/fold/xml-fold.js',
  'addon/edit/closetag.js',
  'addon/dialog/dialog.css',
  'addon/dialog/dialog.js',
  'addon/search/searchcursor.js',
  'addon/search/search.js',
  'addon/search/jump-to-line.js',
  'addon/hint/show-hint.css',
  'addon/hint/show-hint.js',
  'addon/hint/javascript-hint.js',
  'addon/hint/css-hint.js',
  'addon/hint/xml-hint.js',
  'addon/hint/html-hint.js',
  'addon/comment/comment.js',
  'addon/selection/active-line.js',
];

const cmSrc = path.join(root, 'node_modules', 'codemirror');
const cmDst = path.join(outDir, 'vendor', 'codemirror');
for (const rel of cmFiles) {
  const from = path.join(cmSrc, rel);
  const to = path.join(cmDst, rel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

console.log(`Built 웹앱제작기 standalone web bundle → ${outDir}`);
