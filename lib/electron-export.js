// 일렉트론(Electron) 데스크톱 앱 내보내기 모듈
// 프로젝트의 빌드된 HTML 을 감싸는 완전한 Electron 앱(dist/electron/)을 생성하고,
// 필요 시 electron-builder 로 Windows 단일 .exe(portable) 파일까지 자동 빌드한다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function sanitizePkgName(name) {
  const ascii = String(name || 'webapp')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'webapp-desktop';
}

function buildMainCjs({ title, width = 1280, height = 840 }) {
  return `// Electron 메인 프로세스 — 내장 로컬 HTTP 서버로 앱을 열어 file:// 제약을 없앤다
const { app, BrowserWindow, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const APP_HTML = path.join(__dirname, 'app', 'index.html');
let server = null;
let mainWindow = null;

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const html = fs.readFileSync(APP_HTML, 'utf8');
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(\`http://127.0.0.1:\${addr.port}/\`);
    });
  });
}

async function createWindow() {
  const url = await startLocalServer();
  mainWindow = new BrowserWindow({
    width: ${width},
    height: ${height},
    minWidth: 900,
    minHeight: 600,
    title: ${JSON.stringify(title)},
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\\/\\//i.test(target) && !target.startsWith('http://127.0.0.1')) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  await mainWindow.loadURL(url);
}

app.whenReady().then(() => {
  createWindow().catch((err) => {
    console.error('Electron 창 생성 실패:', err);
    app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { server?.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
`;
}

function buildPreloadCjs(version) {
  return `const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronApp', {
  isElectron: true,
  platform: process.platform,
  version: ${JSON.stringify(version)},
});
`;
}

function sanitizeFileBase(name, fallback = 'webapp') {
  const cleaned = String(name || '')
    .replace(/\.exe$|\.html?$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function buildPackageJson({ projectName, productName, fileName }) {
  const pkgName = sanitizePkgName(projectName);
  const safeProduct = sanitizeFileBase(fileName || productName || projectName, 'WebApp');
  return JSON.stringify({
    name: pkgName,
    productName: safeProduct,
    version: '1.0.0',
    author: '웹앱제작기',
    description: `${safeProduct} — 웹앱제작기 Electron 데스크톱 앱`,
    main: 'main.cjs',
    private: true,
    scripts: {
      start: 'electron .',
      'build:win': 'electron-builder --win portable --config.win.signAndEditExecutable=false',
      'build:win-setup': 'electron-builder --win nsis --config.win.signAndEditExecutable=false',
    },
    devDependencies: {
      electron: '^33.2.0',
      'electron-builder': '^25.1.8',
    },
    build: {
      appId: `com.webappide.${pkgName.replace(/[^a-z0-9]/g, '') || 'app'}`,
      productName: safeProduct,
      directories: {
        output: '../electron-dist',
      },
      files: ['main.cjs', 'preload.cjs', 'app/**/*'],
      win: {
        target: ['portable'],
        artifactName: `${safeProduct}.exe`,
        signAndEditExecutable: false,
      },
    },
  }, null, 2);
}

function buildRunBat() {
  return `@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\\electron" (
  echo [Electron] 최초 실행 준비 중... npm install 을 진행합니다.
  call npm install
  if errorlevel 1 (
    echo npm install 실패. Node.js 설치 및 인터넷 연결을 확인하세요.
    pause
    exit /b 1
  )
)
echo [Electron] 데스크톱 앱을 실행합니다...
call npm start
`;
}

function buildExeBat() {
  return `@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\\electron-builder" (
  echo [Electron] 빌드 도구 설치 중... npm install 을 진행합니다.
  call npm install
  if errorlevel 1 (
    echo npm install 실패. Node.js 설치 및 인터넷 연결을 확인하세요.
    pause
    exit /b 1
  )
)
echo [Electron] Windows 단일 실행 파일(.exe)을 빌드합니다...
call npm run build:win
if errorlevel 1 (
  echo 빌드 실패. 위 오류 메시지를 확인하세요.
  pause
  exit /b 1
)
echo 완료! 상위 electron-dist 폴더에서 .exe 파일을 확인하세요.
explorer "..\\electron-dist"
`;
}

function buildReadme({ productName }) {
  return `${productName} — Electron 데스크톱 앱 내보내기 안내
==================================================

1. 바로 실행하기
   - "실행하기.bat" 를 더블클릭하면 Electron 창으로 앱이 열립니다.
   - (최초 1회만 npm install 로 Electron 패키지를 내려받습니다.)

2. Windows 단일 .exe 파일 만들기
   - "EXE 빌드하기.bat" 를 더블클릭하면 상위 "electron-dist" 폴더에
     설치 없이 바로 실행되는 portable .exe 파일이 생성됩니다.

3. 구성 파일
   - app/index.html : 빌드된 웹앱 전체 (모든 화면 포함)
   - main.cjs       : Electron 메인 프로세스 (내장 로컬 서버로 file:// 제약 해결)
   - preload.cjs    : 안전한 브리지 스크립트
   - package.json   : Electron 및 electron-builder 설정
`;
}

export async function exportElectronProject({ distDir, projectName, productName, fileName, html }) {
  const electronDir = path.join(distDir, 'electron');
  const appDir = path.join(electronDir, 'app');
  await fs.mkdir(appDir, { recursive: true });

  const title = sanitizeFileBase(fileName || productName || projectName, '웹앱');
  const files = [
    [path.join(appDir, 'index.html'), html],
    [path.join(electronDir, 'package.json'), buildPackageJson({ projectName, productName: title, fileName: title })],
    [path.join(electronDir, 'main.cjs'), buildMainCjs({ title })],
    [path.join(electronDir, 'preload.cjs'), buildPreloadCjs('1.0.0')],
    [path.join(electronDir, '실행하기.bat'), buildRunBat()],
    [path.join(electronDir, 'EXE 빌드하기.bat'), buildExeBat()],
    [path.join(electronDir, 'README.txt'), buildReadme({ productName: title })],
  ];

  for (const [fp, content] of files) {
    await fs.writeFile(fp, content, 'utf8');
  }

  return {
    electronDir,
    appHtmlPath: path.join(appDir, 'index.html'),
    exeOutDir: path.join(distDir, 'electron-dist'),
    bytes: Buffer.byteLength(html, 'utf8'),
    files: files.map(([fp]) => path.relative(electronDir, fp).replaceAll('\\', '/')),
  };
}

function runProc(cmd, args, { cwd, env = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...env },
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`시간 초과 (${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); });
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else {
        const combined = `${out}\n${err}`.trim();
        reject(new Error((combined || `종료 코드 ${code}`).slice(-800)));
      }
    });
  });
}

export async function buildElectronExe(electronDir) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const builderCli = path.join(electronDir, 'node_modules', 'electron-builder', 'cli.js');
  const hasBuilder = await fs.access(builderCli).then(() => true).catch(() => false);
  if (!hasBuilder) {
    await runProc(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: electronDir });
  }
  await runProc(process.execPath, [builderCli, '--win', 'portable', '--config.win.signAndEditExecutable=false'], { cwd: electronDir });
  const candidates = [
    path.resolve(electronDir, '..', 'electron-dist'),
    path.join(electronDir, 'dist'),
  ];
  for (const outDir of candidates) {
    const entries = await fs.readdir(outDir).catch(() => []);
    const exe = entries.find((f) => /\.exe$/i.test(f));
    if (exe) {
      const exePath = path.join(outDir, exe);
      const st = await fs.stat(exePath);
      return { exeName: exe, exePath, outDir, bytes: st.size };
    }
  }
  throw new Error('빌드는 완료되었으나 electron-dist 폴더에서 .exe 파일을 찾지 못했습니다');
}
