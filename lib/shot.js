// 영역 하나의 화면을 그림으로 찍는다 (AI 에게 보여 줄 때만, 설정에서 켠 경우).
// 따로 프로그램을 설치하지 않도록 컴퓨터에 있는 Edge/Chrome 을 화면 없이(headless) 실행해 찍는다.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.IDE_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

let found;
export async function findBrowser() {
  if (found !== undefined) return found;
  found = null;
  for (const p of CANDIDATES) {
    try {
      await fs.access(p);
      found = p;
      break;
    } catch {}
  }
  return found;
}

// 긴 변이 MAX 를 넘지 않게 줄여 찍는다 (그림 토큰 ≈ 가로×세로/750)
const MAX = 800;

export async function shoot(url, width, height) {
  const browser = await findBrowser();
  if (!browser) throw new Error('화면을 찍을 브라우저(Edge/Chrome)를 찾지 못했습니다');
  const w = Math.max(80, Math.min(2000, Math.round(width)));
  const h = Math.max(60, Math.min(2000, Math.round(height)));
  const scale = Math.min(1, MAX / Math.max(w, h));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ide-shot-'));
  const out = path.join(dir, 'shot.png');
  try {
    await new Promise((resolve, reject) => {
      execFile(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(dir, 'profile')}`,
        `--window-size=${w},${h}`,
        `--force-device-scale-factor=${scale.toFixed(3)}`,
        '--virtual-time-budget=4000',
        `--screenshot=${out}`,
        url,
      ], { timeout: 30000 }, (err) => (err && err.killed ? reject(new Error('화면 찍기 시간 초과')) : resolve()));
    });
    // Windows 의 Edge 는 실행기가 먼저 끝나고 그림은 조금 뒤에 써진다: 파일이 생기고 크기가 멈출 때까지 기다린다
    let last = -1;
    for (let i = 0; i < 100; i++) {
      const size = (await fs.stat(out).catch(() => null))?.size ?? -1;
      if (size > 0 && size === last) break;
      last = size;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (last <= 0) throw new Error('브라우저가 화면 그림을 만들지 못했습니다');
    const data = await fs.readFile(out);
    return { mime: 'image/png', data: data.toString('base64'), width: Math.round(w * scale), height: Math.round(h * scale), bytes: data.length };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 미리보기에서 영역 하나만 보이게 하는 스타일 (찍을 때 쓰는 ?only=)
export function onlyRegionStyle(id, width, height) {
  const sel = `section[data-region="${String(id).replace(/["\\]/g, '')}"]`;
  return `<style>
html, body { overflow: hidden !important; }
body * { visibility: hidden !important; }
${sel}, ${sel} * { visibility: visible !important; }
${sel} { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; z-index: 2147483647 !important;
  width: ${Math.round(width)}px !important; height: ${Math.round(height)}px !important; }
</style>`;
}
