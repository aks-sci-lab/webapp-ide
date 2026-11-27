import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { APP_TEMPLATES, THEME_PRESETS, buildThemeBaseCss } from '../public/templates.js';
import { buildElementPrompt, upsertElementStyleRule } from '../public/inspect-edit.js';

// 1x1 투명 PNG (멀티모달 이미지 첨부 시뮬레이션용)
const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// OpenAI 호환 스트리밍 모의 AI 서버
function startMockAiServer() {
  const calls = [];
  let headerAttempt = 0;

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer sim-secret-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'sim-designer-v1' }, { id: 'text-embedding-3-small' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const userMsg = body.messages.find((m) => m.role === 'user');
      const hasImage = Array.isArray(userMsg?.content) && userMsg.content.some((p) => p.type === 'image_url');
      const promptText = Array.isArray(userMsg?.content)
        ? userMsg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : String(userMsg?.content || '');
      calls.push({ model: body.model, hasImage, promptText });

      let reply = '';
      if (promptText.includes('# 프로젝트 전체 요청')) {
        // 프로젝트 플래너 응답
        reply = JSON.stringify({
          summary: '참고 이미지를 바탕으로 헤더와 메인 작업공간을 구성하고 알림 패널을 추가합니다.',
          newRegions: [{ id: 'alerts', title: '알림 센터', purpose: '실시간 알림 표시' }],
          featureMoves: [],
          removeRegions: [],
          steps: [
            { target: 'header', prompt: '검색창과 로고 구현, header:search 이벤트 발행' },
            { target: 'main', prompt: 'header:search 이벤트를 받아 필터링되는 카드 목록 구현' },
          ],
          layout: {
            fill: true,
            rows: [
              { height: 1, cells: [{ id: 'header', width: 12 }] },
              { height: 11, cells: [{ id: 'sidebar', width: 2 }, { id: 'kpi', width: 10 }] },
            ],
          },
        });
      } else if (promptText.includes('ID: header')) {
        headerAttempt++;
        if (headerAttempt === 1) {
          // 1차 시도: 의도적으로 JS 문법 오류를 내서 자동 검사·재시도 루프 검증!
          reply = [
            '헤더를 생성합니다.',
            '```html',
            '<div class="hdr"><h1 id="logo">SimApp</h1><input id="searchBox" placeholder="검색"></div>',
            '```',
            '```css',
            ':scope { display: flex; align-items: center; padding: 0 12px; background: var(--surface); }',
            '```',
            '```js',
            'const box = root.querySelector("#searchBox"; // 의도적 문법 오류',
            '```',
          ].join('\n');
        } else {
          // 2차 시도: 정상 코드 + 결정 메모 제안
          reply = [
            '문법 오류를 수정해 헤더를 완성했습니다. 이벤트: emit header:search',
            '```html',
            '<div class="hdr"><h1 id="logo">SimApp</h1><input id="searchBox" placeholder="검색"></div>',
            '```',
            '```css',
            ':scope { display: flex; align-items: center; gap: 12px; padding: 0 12px; background: var(--surface); }',
            '#logo { font-size: 16px; margin: 0; color: var(--primary); }',
            '```',
            '```js',
            'const box = root.querySelector("#searchBox");',
            'box.addEventListener("input", () => app.emit("header:search", box.value));',
            '```',
            '```memo',
            '- 모든 입력창은 둥근 모서리(--radius)를 사용한다',
            '```',
          ].join('\n');
        }
      } else {
        // main 영역 응답 (이미지 첨부 + header:search 이벤트 수신)
        reply = [
          '참고 이미지 스타일을 반영해 메인 카드 목록을 구현했습니다.',
          '```html',
          '<div class="cards" id="cardList"><article class="card">항목 A</article><article class="card">항목 B</article></div>',
          '```',
          '```css',
          ':scope { padding: 12px; background: var(--bg); }',
          '.card { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }',
          '```',
          '```js',
          'const list = root.querySelector("#cardList");',
          'app.on("header:search", (q) => {',
          '  list.querySelectorAll(".card").forEach((c) => { c.hidden = q && !c.textContent.includes(q); });',
          '});',
          '```',
        ].join('\n');
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const mid = Math.floor(reply.length / 2);
      res.write(sseChunk({ choices: [{ delta: { reasoning_content: '영역 구조를 분석 중...' } }] }));
      res.write(sseChunk({ choices: [{ delta: { content: reply.slice(0, mid) } }] }));
      res.write(sseChunk({ choices: [{ delta: { content: reply.slice(mid) }, finish_reason: 'stop' }] }));
      res.write(sseChunk({ choices: [], usage: { prompt_tokens: 320, completion_tokens: 180 } }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, calls });
    });
  });
}

async function waitForServer(baseUrl) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/settings`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('테스트용 webapp-ide 서버가 시간 내에 시작되지 않았습니다');
}

async function apiJson(baseUrl, method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  assert.equal(res.ok, true, `${method} ${p} failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

test('E2E Vibe Coding Simulation: template → OpenAI API → self-healing retry → image review/apply → Inspect-to-Edit → connections → export', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-e2e-'));
  const projectsDir = path.join(tmp, 'projects');
  const logsDir = path.join(tmp, 'logs');
  const settingsPath = path.join(tmp, 'settings.json');
  const port = 5200 + Math.floor(Math.random() * 400);
  const baseUrl = `http://127.0.0.1:${port}`;

  const mockAi = await startMockAiServer();
  const child = spawn(process.execPath, ['server.js', '--port', String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PROJECTS_DIR: projectsDir, LOGS_DIR: logsDir, SETTINGS_PATH: settingsPath },
    stdio: 'pipe',
  });

  try {
    await waitForServer(baseUrl);

    // 1. OpenAI 호환 API 설정 + 모델 목록 조회 (Bearer 인증 + embedding 필터링 확인)
    const { models } = await apiJson(baseUrl, 'POST', '/api/local/models', { baseUrl: mockAi.url, apiKey: 'sim-secret-key' });
    assert.deepEqual(models, [{ id: 'sim-designer-v1', label: 'sim-designer-v1' }]);

    await apiJson(baseUrl, 'PUT', '/api/settings', {
      provider: 'local',
      localUrl: mockAi.url,
      localKey: 'sim-secret-key',
      localModel: 'sim-designer-v1',
      logging: true,
    });
    const settings = await apiJson(baseUrl, 'GET', '/api/settings');
    assert.equal(settings.provider, 'local');
    assert.equal(settings.localKeySource, 'settings');
    assert.equal(settings.hasKey, true);

    // 2. 템플릿 + 디자인 토큰 테마로 새 프로젝트 생성
    const dashTpl = APP_TEMPLATES.find((t) => t.id === 'dashboard');
    await apiJson(baseUrl, 'POST', '/api/projects', {
      name: 'sim-dashboard',
      template: { layout: dashTpl.layout, files: dashTpl.files, sharedCss: buildThemeBaseCss(THEME_PRESETS[1]) },
    });
    const layout = await apiJson(baseUrl, 'GET', '/api/layout');
    assert.equal(layout.name, 'sim-dashboard');
    assert.equal(layout.regions.length, 5);

    // 3. header 영역 바이브 코딩: 1차 문법 오류 → 자동 검사 실패 → 2차 자동 재시도 통과 + 결정 메모 제안
    const res1 = await fetch(`${baseUrl}/api/regions/header/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: '상단 검색 헤더 구현', review: false }),
    });
    const events1 = (await res1.text()).trim().split('\n').map((l) => JSON.parse(l));
    const done1 = events1.find((e) => e.type === 'done');
    assert.ok(done1, 'header generate should emit done');
    assert.equal(done1.attempt, 2, '1차 문법 오류 후 2차 시도에 통과해야 함');
    assert.ok(done1.memo.includes('모든 입력창은 둥근 모서리(--radius)를 사용한다'));
    assert.match(done1.files.js, /app\.emit\("header:search"/);

    // 4. main 영역 바이브 코딩: 참고 이미지 첨부 + 검토 후 적용(review: true) → 후보 미리보기 → 적용
    const res2 = await fetch(`${baseUrl}/api/regions/main/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: '참고 이미지처럼 깔끔한 카드 목록 구현',
        review: true,
        images: [{ mime: 'image/png', data: SAMPLE_PNG_BASE64, width: 1, height: 1, name: 'ref.png' }],
      }),
    });
    const events2 = (await res2.text()).trim().split('\n').map((l) => JSON.parse(l));
    const done2 = events2.find((e) => e.type === 'done');
    assert.equal(done2.pending, true);
    assert.equal(mockAi.calls.at(-1).hasImage, true, 'AI 서버로 멀티모달 이미지가 전달되어야 함');

    // 검토 대기 상태: 일반 /preview 에는 아직 없고 ?candidate=main 에는 반영됨
    const previewBefore = await (await fetch(`${baseUrl}/preview`)).text();
    const previewCandidate = await (await fetch(`${baseUrl}/preview?candidate=main`)).text();
    assert.doesNotMatch(previewBefore, /id="cardList"/);
    assert.match(previewCandidate, /id="cardList"/);

    // 적용
    await apiJson(baseUrl, 'POST', '/api/regions/main/pending/apply');
    const previewAfter = await (await fetch(`${baseUrl}/preview`)).text();
    assert.match(previewAfter, /id="cardList"/);

    // 5. Inspect-to-Edit: 요소 빠른 스타일 반영 + 타깃 프롬프트 생성 검증
    const hdrRegion = await apiJson(baseUrl, 'GET', '/api/regions/header');
    const styledCss = upsertElementStyleRule(hdrRegion.files.css, '#logo', { color: '#0d9488', 'font-size': '20px' });
    await apiJson(baseUrl, 'PUT', '/api/regions/header', { css: styledCss });
    const previewStyled = await (await fetch(`${baseUrl}/preview`)).text();
    assert.match(previewStyled, /@inspect:#logo/);
    assert.match(previewStyled, /toggle-inspect/);

    const targetedPrompt = buildElementPrompt({ region: 'header', selector: '#logo', tag: 'h1', text: 'SimApp', html: '<h1 id="logo">SimApp</h1>', rect: { w: 80, h: 24 }, styles: { color: 'rgb(13, 148, 136)' } }, '굵게 강조');
    assert.match(targetedPrompt, /#logo/);

    // 6. 프로젝트 전체 계획 (참고 이미지 포함)
    const plan = await apiJson(baseUrl, 'POST', '/api/project/plan', {
      request: '참고 이미지처럼 알림 센터를 추가하고 헤더·메인을 연결해 줘',
      images: [{ mime: 'image/png', data: SAMPLE_PNG_BASE64, width: 1, height: 1 }],
    });
    assert.equal(mockAi.calls.at(-1).hasImage, true);
    assert.equal(plan.newRegions[0].id, 'alerts');
    assert.equal(plan.steps.length, 2);

    // 7. 영역 간 연결 지도 분석 + 자동 테스트 생성 + 통합 검증 API 확인
    const conn = await apiJson(baseUrl, 'GET', '/api/analysis/connections');
    assert.equal(conn.issues.length, 0);
    assert.deepEqual(conn.events, [{ name: 'header:search', from: ['header'], to: ['main'] }]);

    const autoT = await apiJson(baseUrl, 'POST', '/api/tests/auto', { append: false });
    assert.ok(autoT.tests.length >= 2);
    const verified = await apiJson(baseUrl, 'POST', '/api/verify', { runBrowser: false });
    assert.equal(verified.ok, true);

    // 7-b. 3대 세션 저장소, /api/quota 및 프로젝트 복제/이름변경/삭제 API 검증
    const quota = await apiJson(baseUrl, 'GET', '/api/quota');
    assert.ok(quota.calls >= 3, '오늘 호출 횟수가 로그에서 집계되어야 함');
    const sess = await apiJson(baseUrl, 'GET', '/api/sessions');
    assert.ok(sess.sessions.integrated.count >= 1);
    assert.ok(sess.sessions['region:header'].count >= 1);
    assert.ok(sess.sessions.verify.count >= 1);

    await apiJson(baseUrl, 'POST', '/api/projects/clone', { newName: 'sim-clone' });
    // 프로젝트 목록 상세 정보 및 다른 프로젝트 직접 미리보기(?project=) 검증
    const projs = await apiJson(baseUrl, 'GET', '/api/projects');
    assert.ok(projs.details.some((d) => d.name === 'sim-dashboard' && d.regionsCount === 5));
    const directPrev = await (await fetch(`${baseUrl}/preview?project=sim-dashboard`)).text();
    assert.match(directPrev, /<title>sim-dashboard<\/title>/);

    await apiJson(baseUrl, 'POST', '/api/projects/rename', { newName: 'sim-renamed' });
    const delRes = await apiJson(baseUrl, 'DELETE', '/api/projects/sim-renamed');
    assert.equal(delRes.ok, true);
    await apiJson(baseUrl, 'POST', '/api/projects/open', { name: 'sim-dashboard' });

    // 7-c. 프롬프트 자동 저장 (영역 prompt.md 무백업 저장 · workflow.json 저장 · 기존 project-prompt.md 폴백)
    const histBefore = (await apiJson(baseUrl, 'GET', '/api/regions/header')).history.length;
    await apiJson(baseUrl, 'PUT', '/api/regions/header', { prompt: '자동 저장 테스트 프롬프트' });
    const hdrAfterPrompt = await apiJson(baseUrl, 'GET', '/api/regions/header');
    assert.equal(hdrAfterPrompt.files.prompt, '자동 저장 테스트 프롬프트');
    assert.equal(hdrAfterPrompt.history.length, histBefore, 'prompt.md 만 저장할 때는 히스토리 백업을 늘리지 않아야 함');

    const wfFallback = await apiJson(baseUrl, 'GET', '/api/workflow');
    assert.match(wfFallback.workload, /알림 센터/, 'workflow.json 이 비어 있으면 기존 project-prompt.md 요청을 워크로드로 표시해야 함');
    await apiJson(baseUrl, 'PUT', '/api/workflow', { workload: '새 7단계 워크로드 내용' });
    const wfSaved = await apiJson(baseUrl, 'GET', '/api/workflow');
    assert.equal(wfSaved.workload, '새 7단계 워크로드 내용');

    // 8. 스냅샷 & 단일 HTML 내보내기 검증
    const snap = await apiJson(baseUrl, 'POST', '/api/snapshots', { label: '시뮬레이션 완료' });
    assert.equal(snap.label, '시뮬레이션 완료');
    const exp = await apiJson(baseUrl, 'POST', '/api/export', { offline: false });
    const distHtml = await fs.readFile(exp.path, 'utf8');
    assert.match(distHtml, /<title>sim-dashboard<\/title>/);
    assert.match(distHtml, /@scope \(\[data-region="header"\]\)/);
    assert.match(distHtml, /@scope \(\[data-region="main"\]\)/);
    assert.match(distHtml, /--primary: #0d9488;/);
  } finally {
    child.kill('SIGTERM');
    mockAi.server.close();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
