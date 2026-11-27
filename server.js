import express from 'express';
import fs from 'node:fs/promises';
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, FILES, PROJECT_RE, ID_RE } from './lib/project.js';
import { buildApp, testRunnerScript } from './lib/build.js';
import { importHtml } from './lib/importer.js';
import { splitRegion, mergeRegions, unwrapRegion } from './lib/layout-ops.js';
import { find, flatten, ancestors, isContainer, getScreens } from './public/tree.js';
import { generate, parseFiles, parseMemo, normalizeFiles, buildPrompt, relatedCode, errorMessage, MODELS, SYSTEM } from './lib/ai.js';
import { analyze, isOverlayHtml, lostIds, withFeatureIds, featureIdsIn } from './lib/features.js';
import { featureDeps, planMove } from './lib/feature-deps.js';
import {
  PLAN_SYSTEM, buildPlanPrompt, parsePlan, validateLayoutPlan, normalizeLayoutPlan, buildLayoutFixPrompt, parseLayoutJson,
  SHARED_CSS_SYSTEM, buildSharedCssPrompt, addsLayoutCss, plannedLayout, fitLayoutTo, layoutFromRows,
} from './lib/planner.js';
import * as gemini from './lib/gemini.js';
import * as local from './lib/local.js';
import * as cli from './lib/cli.js';
import { Logger, requestContext, redact } from './lib/logger.js';
import { Snapshots } from './lib/snapshots.js';
import { checkRegionOutput, jsSyntaxError } from './lib/validate.js';
import { scanConnections, analyzeAppJs, extractFunction } from './lib/analysis.js';
import vm from 'node:vm';
import { makeOffline } from './lib/offline.js';
import { exportElectronProject, buildElectronExe } from './lib/electron-export.js';
import { shoot, onlyRegionStyle, findBrowser } from './lib/shot.js';
import { verifyProject, generateAutoTests, checkLocalCompatibility } from './lib/app-verify.js';
import { SessionStore } from './lib/sessions.js';
import { ChatMemoryStore } from './lib/chat-memory.js';
import { QuotaGuard, DEFAULT_FREE_MODE, normalizeFreeMode, isRateOrOverloadError, buildFallbackOrder } from './lib/quota-guard.js';
import { spawn } from 'node:child_process';
import { SKILLS, recommendSkills, skillsPromptSection, skillsRuntime, skillsProvides } from './public/skills.js';
import {
  WorkflowStore, PROPOSE_LAYOUT_SYSTEM, buildProposeLayoutPrompt, parseProposeResponse,
  DISTRIBUTE_PROMPTS_SYSTEM, buildDistributePrompt, parseDistributeResponse, reconcileChecklist,
  REFINE_WORKLOAD_SYSTEM, buildRefineWorkloadPrompt,
} from './lib/workflow.js';

const GENERATE_ATTEMPTS = 3;
const pick = (f) => ({ html: f.html, css: f.css, js: f.js });

const here = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT) || 5180;
const SETTINGS_PATH = path.resolve(process.env.SETTINGS_PATH || path.join(here, 'settings.json'));
const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || path.join(here, 'projects'));

const LOGS_DIR = path.resolve(process.env.LOGS_DIR || path.join(here, 'logs'));
const logger = new Logger(LOGS_DIR);
const quotaGuard = new QuotaGuard();

const app = express();

// 다른 사이트가 DNS 리바인딩으로 이 서버를 부르는 것을 막는다: Host 가 이 컴퓨터 주소일 때만 응답
const allowAnyHost = process.argv.includes('--host');
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (allowAnyHost || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return next();
  res.status(403).send('localhost 로만 접속할 수 있습니다');
});

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(here, 'public')));
// 코드 편집기(CodeMirror)는 인터넷 없이도 되도록 로컬 패키지에서 제공
app.use('/vendor/codemirror', express.static(path.join(here, 'node_modules', 'codemirror')));

// 요청 로그: 개발 단계 전체 분석을 위해 모든 API 요청을 기록 (로그 자체 조회/기록만 제외해 무한 루프 방지)
const SKIP_LOG = (via) => via === 'POST /api/log' || via.startsWith('GET /api/logs');
app.use('/api', (req, res, next) => {
  const via = `${req.method} ${req.baseUrl}${req.path}`;
  const projectName = project ? path.basename(project.root) : undefined;
  const started = Date.now();
  res.on('finish', () => {
    if (!SKIP_LOG(via) || res.statusCode >= 400) {
      logger.event('request', { via, project: projectName, status: res.statusCode, ms: Date.now() - started, body: summarize(req.body), error: res.locals.error });
    }
  });
  requestContext.run({ via, project: projectName }, next);
});

// 요청 본문 요약: 긴 문자열·배열은 줄여서
function summarize(v, depth = 0) {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}… (${v.length}자)` : v;
  if (Array.isArray(v)) return v.length > 20 ? `[${v.length}개]` : v.map((x) => summarize(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}';
    return Object.fromEntries(Object.entries(redact(v)).map(([k, x]) => [k, summarize(x, depth + 1)]));
  }
  return v;
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    res.locals.error = err.message;
    res.status(400).json({ error: err.message });
  });

// ── 설정 (settings.json, 또는 ANTHROPIC_API_KEY / GEMINI_API_KEY 환경변수) ──
const PROVIDERS = ['gemini', 'claude', 'local', 'cli'];
const DEFAULT_SETTINGS = {
  provider: 'gemini',
  model: MODELS[0],
  apiKey: '',
  geminiModel: '',
  geminiKey: '',
  localUrl: local.PRESETS.lmstudio,
  localModel: '',
  localKey: '',
  cliPreset: 'codex',
  cliCommand: '',
  cliArgs: '',
  cliModel: '',
  logging: true, // 작업·AI 로그 남기기
  logKeepDays: 30,
  // 미리보기를 다른 출처(127.0.0.1↔localhost)로 열어 저장소 분리. 기본은 끔: 켜면 그동안 미리보기에서 쓰던 데이터가 안 보이므로 사용자가 직접 켠다
  previewIsolation: false,
  // 영역 화면을 그림으로 AI 에게 보내기: off(안 보냄) | auto(모양·배치 요청이거나 칸 문제가 잰 값에 보일 때만) | always
  // 그림 한 장 ≈ 수백~천 토큰이라 기본은 끔. 칸 크기·넘침은 글(측정값)로 늘 보낸다
  visualMode: 'off',
  historyCount: 8, // 영역 프롬프트에 함께 보낼 최근 요청 수 (0 이면 보내지 않음)
  light: { provider: '', model: '' }, // 가벼운 작업용 모델
  routes: { describe: true }, // 가벼운 모델로 보낼 작업: region / fix / plan / css / describe
  sessionModels: {
    integrated: { provider: '', model: '' },
    region: { provider: '', model: '' },
    verify: { provider: '', model: '' },
  }, // 3대 세션별 전용 모델 (비어 있으면 주 모델 또는 가벼운 모델 설정을 따름)
  freeMode: { ...DEFAULT_FREE_MODE }, // 🍃 무료 API 한도 절약 모드 (RPM 쿨다운 · RPD 상한 · 자동 폴백)
  prices: {}, // 모델별 1백만 토큰당 가격(입력/출력, 달러) — 사용량 화면의 비용 추정용
};

async function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
async function saveSettings(s) {
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
}

// ── 프로젝트 (projects/<이름>/ 하나가 앱 하나) ──
let project;

async function listProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

function projectPath(name) {
  if (!PROJECT_RE.test(name || '')) throw new Error('프로젝트 이름은 글자/숫자/공백/-/_ 만 쓸 수 있습니다');
  return path.join(PROJECTS_DIR, name);
}

async function openProject(name, layout) {
  const p = new Project(projectPath(name));
  await p.init(layout);
  p.onChange = (e) => logger.event('change', { project: name, ...e });
  project = p;
  logger.event('project-open', { project: name });
  const s = await getSettings();
  s.currentProject = name;
  await saveSettings(s);
}

{
  // 예전 단일 프로젝트 폴더(project/)가 있으면 projects/my-app 으로 옮긴다
  const legacy = path.join(here, 'project');
  const names0 = await listProjects();
  try {
    await fs.access(path.join(legacy, 'layout.json'));
    if (!names0.includes('my-app')) await fs.rename(legacy, path.join(PROJECTS_DIR, 'my-app'));
  } catch {}
  const s = await getSettings();
  logger.enabled = s.logging !== false;
  await logger.prune(Number(s.logKeepDays) || 30);
  logger.event('server-start', { port: PORT, provider: s.provider, model: { gemini: s.geminiModel, local: s.localModel, claude: s.model }[s.provider] });
  const names = await listProjects();
  await openProject(names.includes(s.currentProject) ? s.currentProject : names[0] || 'my-app');
}

const claudeKey = (s) => s.apiKey || process.env.ANTHROPIC_API_KEY || '';
const geminiKey = (s) => s.geminiKey || process.env.GEMINI_API_KEY || '';
const localKey = (s) => s.localKey || process.env.OPENAI_API_KEY || '';
const keySource = (saved, envName) => (saved ? 'settings' : process.env[envName] ? 'env' : null);

app.get('/api/settings', wrap(async (req, res) => {
  const s = await getSettings();
  const hasKey = {
    gemini: Boolean(geminiKey(s) && s.geminiModel),
    claude: Boolean(claudeKey(s)),
    local: Boolean(s.localModel),
    cli: Boolean(s.cliCommand || cli.CLI_PRESETS[s.cliPreset]?.bin),
  }[s.provider];
  res.json({
    provider: s.provider,
    model: s.model,
    models: MODELS,
    geminiModel: s.geminiModel,
    localUrl: s.localUrl,
    localModel: s.localModel,
    localPresets: local.PRESETS,
    cliPreset: s.cliPreset || 'codex',
    cliCommand: s.cliCommand || '',
    cliArgs: s.cliArgs || '',
    cliModel: s.cliModel || '',
    cliPresets: cli.CLI_PRESETS,
    hasKey,
    keySource: keySource(s.apiKey, 'ANTHROPIC_API_KEY'),
    geminiKeySource: keySource(s.geminiKey, 'GEMINI_API_KEY'),
    localKeySource: keySource(s.localKey, 'OPENAI_API_KEY'),
    projectDir: project.root,
    logging: s.logging !== false,
    logKeepDays: s.logKeepDays,
    previewIsolation: s.previewIsolation === true,
    visualMode: s.visualMode || 'off',
    historyCount: s.historyCount ?? 8,
    browserFound: Boolean(await findBrowser()),
    light: s.light,
    routes: s.routes,
    sessionModels: s.sessionModels || DEFAULT_SETTINGS.sessionModels,
    freeMode: normalizeFreeMode(s.freeMode),
    prices: s.prices,
  });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const s = await getSettings();
  const b = req.body;
  if (PROVIDERS.includes(b.provider)) s.provider = b.provider;
  if (b.model && MODELS.includes(b.model)) s.model = b.model;
  for (const k of ['geminiModel', 'localUrl', 'localModel', 'cliPreset', 'cliCommand', 'cliArgs', 'cliModel']) {
    if (typeof b[k] === 'string') s[k] = b[k].trim();
  }
  if (typeof b.apiKey === 'string') s.apiKey = b.apiKey.trim();
  if (typeof b.geminiKey === 'string') s.geminiKey = b.geminiKey.trim();
  if (typeof b.localKey === 'string') s.localKey = b.localKey.trim();
  if (typeof b.logging === 'boolean') s.logging = b.logging;
  if (typeof b.previewIsolation === 'boolean') s.previewIsolation = b.previewIsolation;
  if (['off', 'auto', 'always'].includes(b.visualMode)) s.visualMode = b.visualMode;
  if (b.historyCount !== undefined && Number(b.historyCount) >= 0) s.historyCount = Math.min(20, Math.round(Number(b.historyCount)));
  if (b.light && typeof b.light === 'object') s.light = { provider: PROVIDERS.includes(b.light.provider) ? b.light.provider : '', model: String(b.light.model || '').trim() };
  if (b.routes && typeof b.routes === 'object') s.routes = Object.fromEntries(['region', 'fix', 'plan', 'css', 'describe'].map((k) => [k, Boolean(b.routes[k])]));
  if (b.sessionModels && typeof b.sessionModels === 'object') {
    s.sessionModels = Object.fromEntries(['integrated', 'region', 'verify'].map((k) => {
      const m = b.sessionModels[k] || {};
      return [k, { provider: PROVIDERS.includes(m.provider) ? m.provider : '', model: String(m.model || '').trim() }];
    }));
  }
  if (b.freeMode && typeof b.freeMode === 'object') s.freeMode = normalizeFreeMode(b.freeMode);
  if (b.prices && typeof b.prices === 'object') s.prices = Object.fromEntries(Object.entries(b.prices).map(([m, p]) => [m, { in: Number(p.in) || 0, out: Number(p.out) || 0 }]));
  if (Number(b.logKeepDays) >= 1) s.logKeepDays = Math.min(365, Math.round(Number(b.logKeepDays)));
  logger.enabled = s.logging !== false;
  await saveSettings(s);
  res.json({ ok: true });
}));

// ── 로그 보기 ──
app.get('/api/logs', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ dir: LOGS_DIR, enabled: s.logging !== false, keepDays: s.logKeepDays, days: await logger.days() });
}));
app.get('/api/logs/day/:day', wrap(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.day)) throw new Error('잘못된 날짜');
  res.json({ events: await logger.readEvents(req.params.day, Number(req.query.limit) || 500) });
}));
app.get('/api/logs/ai', wrap(async (req, res) => res.json({ text: await logger.readAiFile(String(req.query.file || '')) })));

// 개발 로그 자동 분석 요약 (이벤트 분포 · 오류 목록 · 가장 느린 호출 · UI 행동 집계)
app.get('/api/logs/summary/:day', wrap(async (req, res) => {
  const day = req.params.day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('잘못된 날짜');
  const events = await logger.readEvents(day, 100000);
  const byType = {};
  const uiActions = {};
  const errors = [];
  const slow = [];
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (e.type === 'client' && e.kind === 'ui-action' && e.target) {
      uiActions[e.target] = (uiActions[e.target] || 0) + 1;
    }
    if (e.error || e.type === 'error' || e.type === 'ai-rejected' || (e.type === 'request' && e.status >= 400) || (e.type === 'client' && /error|reject/i.test(e.kind || ''))) {
      errors.push({ ts: e.ts, type: e.type, via: e.via || e.kind || e.purpose || '', message: e.error || e.message || e.reason || `HTTP ${e.status}` });
    }
    if (Number(e.ms) > 0 && (e.type === 'ai' || e.type === 'request')) {
      slow.push({ ts: e.ts, type: e.type, label: e.via || `${e.provider}/${e.purpose}`, ms: Number(e.ms) });
    }
  }
  slow.sort((a, b) => b.ms - a.ms);
  const topActions = Object.entries(uiActions).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([action, count]) => ({ action, count }));
  res.json({ day, total: events.length, byType, errorCount: errors.length, recentErrors: errors.slice(-20).reverse(), slowest: slow.slice(0, 10), topActions });
}));

// 하루치 전체 로그 JSONL 파일 다운로드
app.get('/api/logs/export/:day', wrap(async (req, res) => {
  const day = req.params.day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('잘못된 날짜');
  const file = path.join(LOGS_DIR, day, 'events.jsonl');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="webapp-ide-logs-${day}.jsonl"`);
  res.send(text);
}));

// AI 사용량: 로그의 AI 호출 기록을 날짜·모델·용도·프로젝트별로 모은다 (가격을 넣어 두면 비용 추정)
app.get('/api/usage', wrap(async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const s = await getSettings();
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const bucket = () => ({ calls: 0, errors: 0, input: 0, output: 0, ms: 0, cost: 0 });
  const add = (b, e) => {
    b.calls++;
    if (e.error) b.errors++;
    const inp = Number(e.usage?.input_tokens) || 0;
    const out = Number(e.usage?.output_tokens) || 0;
    b.input += inp;
    b.output += out;
    b.ms += Number(e.ms) || 0;
    const p = s.prices?.[e.model];
    if (p) b.cost += (inp * p.in + out * p.out) / 1e6;
  };
  const total = bucket();
  const group = { day: {}, model: {}, purpose: {}, project: {} };
  for (const d of (await logger.days()).filter((x) => x >= since)) {
    for (const e of await logger.readEvents(d, 1e6)) {
      if (e.type !== 'ai') continue;
      add(total, e);
      const keys = { day: d, model: `${e.provider}/${e.model || '-'}${e.tier === 'light' ? ' (가벼운)' : ''}`, purpose: e.purpose, project: e.project || '-' };
      for (const [g, k] of Object.entries(keys)) add((group[g][k] ||= bucket()), e);
    }
  }
  res.json({ days, total, group, hasPrices: Object.keys(s.prices || {}).length > 0 });
}));

// 오늘의 실시간 AI 호출량 및 무료 한도 상태 (상단 게이지용)
async function todayUsageSummary() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const events = await logger.readEvents(today, 10000);
  let calls = 0;
  let tokens = 0;
  const byProvider = {};
  for (const e of events) {
    if (e.type !== 'ai') continue;
    calls++;
    const t = (Number(e.usage?.input_tokens) || 0) + (Number(e.usage?.output_tokens) || 0);
    tokens += t;
    byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
  }
  return { day: today, calls, tokens, byProvider };
}

function aiConnectionStatus(s) {
  const ready = Boolean(PROVIDER_READY[s.provider]?.(s));
  const labelMap = {
    cli: `로컬 CLI (${s.cliPreset || 'codex'})`,
    gemini: `Gemini (${s.geminiModel || '미선택'})`,
    claude: `Claude (${s.model || '미선택'})`,
    local: `OpenAI/로컬 (${s.localModel || '미선택'})`,
  };
  return { ready, provider: s.provider, label: labelMap[s.provider] || s.provider };
}

app.get('/api/quota', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ ...(await todayUsageSummary()), freeMode: normalizeFreeMode(s.freeMode), aiStatus: aiConnectionStatus(s) });
}));

// 편집기·미리보기에서 난 오류 등 (브라우저 쪽 기록)
app.post('/api/log', wrap(async (req, res) => {
  logger.event('client', summarize(req.body));
  res.json({ ok: true });
}));

async function projectSummary(name) {
  const p = new Project(projectPath(name));
  try {
    const layout = await p.getLayout();
    const wf = await new WorkflowStore(p).read();
    const stat = await fs.stat(p.layoutPath).catch(() => null);
    const leaves = flatten(layout).filter((e) => !e.region.regions?.length);
    return {
      name,
      title: layout.name || name,
      mode: layout.mode || 'grid',
      regionsCount: leaves.length,
      grid: layout.grid,
      regions: (layout.regions || []).map((r) => ({ id: r.id, title: r.title, color: r.color, x: r.x, y: r.y, w: r.w, h: r.h })),
      workflowStep: wf.step || 1,
      checklistTotal: (wf.checklist || []).length,
      checklistVerified: (wf.checklist || []).filter((f) => f.verified).length,
      deployReady: Boolean(wf.deployReady),
      updatedAt: wf.updatedAt || stat?.mtime?.toISOString() || null,
    };
  } catch {
    return { name, title: name, mode: 'grid', regionsCount: 0, grid: { cols: 12, rows: 12, fill: true }, regions: [], workflowStep: 1, checklistTotal: 0, checklistVerified: 0, deployReady: false, updatedAt: null };
  }
}

app.get('/api/projects', wrap(async (req, res) => {
  const list = await listProjects();
  const details = await Promise.all(list.map(projectSummary));
  res.json({ current: path.basename(project.root), list, details });
}));

app.post('/api/projects', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if ((await listProjects()).includes(name)) throw new Error('이미 있는 프로젝트입니다');
  const tpl = req.body.template;
  if (tpl && typeof tpl === 'object') {
    const baseLayout = { ...(tpl.layout || {}), name };
    const regions = Array.isArray(baseLayout.regions) ? baseLayout.regions : [];
    await openProject(name, { ...baseLayout, regions: [] });
    if (regions.length) await project.saveLayout({ ...(await project.getLayout()), ...baseLayout, regions });
    if (typeof tpl.sharedCss === 'string' && tpl.sharedCss.trim()) await project.writeShared('css', tpl.sharedCss);
    if (tpl.files && typeof tpl.files === 'object') {
      for (const [id, f] of Object.entries(tpl.files)) {
        if (!ID_RE.test(id) || !f || typeof f !== 'object') continue;
        const clean = Object.fromEntries(Object.entries(f).filter(([k, v]) => FILES[k] && typeof v === 'string'));
        if (Object.keys(clean).length) await project.writeRegion(id, clean, { backup: false });
      }
    }
  } else {
    await openProject(name, { name });
  }
  res.json({ ok: true });
}));

app.post('/api/projects/open', wrap(async (req, res) => {
  const name = String(req.body.name || '');
  if (!(await listProjects()).includes(name)) throw new Error('없는 프로젝트입니다');
  await openProject(name);
  res.json({ ok: true });
}));

// 프로젝트 이름 변경
app.post('/api/projects/rename', wrap(async (req, res) => {
  const newName = String(req.body.newName || '').trim();
  const oldName = path.basename(project.root);
  if (!newName || newName === oldName) throw new Error('새 프로젝트 이름을 입력하세요');
  if ((await listProjects()).includes(newName)) throw new Error('이미 같은 이름의 프로젝트가 있습니다');
  const dest = projectPath(newName);
  await fs.rename(project.root, dest);
  await openProject(newName);
  const layout = await project.getLayout();
  if (layout.name === oldName) {
    layout.name = newName;
    await project.saveLayout(layout);
  }
  logger.event('project-rename', { from: oldName, to: newName });
  res.json({ ok: true, name: newName });
}));

// 프로젝트 복제 (.trash/.snapshots/.history 제외)
async function copyProjectDir(src, dst) {
  const SKIP = new Set(['.trash', '.snapshots', '.history', '.history-layout', '.pending', 'dist']);
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) await copyProjectDir(a, b);
    else await fs.copyFile(a, b);
  }
}

app.post('/api/projects/clone', wrap(async (req, res) => {
  const newName = String(req.body.newName || '').trim();
  if (!newName) throw new Error('복제할 프로젝트 이름을 입력하세요');
  if ((await listProjects()).includes(newName)) throw new Error('이미 같은 이름의 프로젝트가 있습니다');
  const dest = projectPath(newName);
  await copyProjectDir(project.root, dest);
  await openProject(newName);
  const layout = await project.getLayout();
  layout.name = newName;
  await project.saveLayout(layout);
  logger.event('project-clone', { to: newName });
  res.json({ ok: true, name: newName });
}));

// 프로젝트 초기화 (스냅샷 자동 백업 후 빈 캔버스·워크플로우로 리셋)
app.post('/api/projects/reset', wrap(async (req, res) => {
  await autoSnapshot('프로젝트 초기화 전');
  const cur = await project.getLayout();
  await project.saveLayout({
    name: cur.name || path.basename(project.root),
    appPrompt: '',
    mode: 'grid',
    lang: cur.lang || 'ko',
    grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
    regions: [],
  });
  await project.writeProjectPrompt({ request: '', plan: null });
  await project.writeDecisions('');
  await workflowStore().write({ step: 1, workload: '', proposed: null, distributed: [], checklist: [], deployReady: false });
  logger.event('project-reset', { name: path.basename(project.root) });
  res.json({ ok: true });
}));

// 프로젝트 삭제 (projects/.trash 로 안전하게 이동)
app.delete('/api/projects/:name', wrap(async (req, res) => {
  const name = String(req.params.name || '').trim();
  const list = await listProjects();
  if (!list.includes(name)) throw new Error('없는 프로젝트입니다');
  const trashDir = path.join(PROJECTS_DIR, '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.rename(projectPath(name), path.join(trashDir, `${name}-${stamp}`));
  logger.event('project-delete', { name });
  const rest = await listProjects();
  await openProject(rest[0] || 'my-app');
  res.json({ ok: true, current: path.basename(project.root) });
}));

// ── 3대 세션 (통합 · 다중 영역별 · 검증) ──
const sessionStore = () => new SessionStore(project);
app.get('/api/sessions', wrap(async (req, res) => {
  const layout = await project.getLayout();
  const ids = flatten(layout).filter((e) => !e.region.regions?.length).map((e) => e.region.id);
  res.json({ sessions: await sessionStore().summary(ids) });
}));
app.post('/api/sessions/region', wrap(async (req, res) => {
  const regionId = String(req.body.regionId || '').trim();
  const layout = await project.getLayout();
  if (!find(layout, regionId)) throw new Error('없는 영역입니다');
  const created = await sessionStore().createRegionSession(regionId, req.body.title);
  res.json(created);
}));
app.get('/api/sessions/:key', wrap(async (req, res) => {
  res.json(await sessionStore().read(req.params.key));
}));
app.post('/api/sessions/:key/clear', wrap(async (req, res) => {
  res.json(await sessionStore().clear(req.params.key));
}));
app.delete('/api/sessions/:key', wrap(async (req, res) => {
  res.json(await sessionStore().remove(req.params.key));
}));

// ── 7단계 가이드 워크플로우 (워크로드 → 레이아웃 추천 → 시각 편집 → 프롬프트 분배 → 제작 → 기능 전수 검증 → 배포) ──
const workflowStore = () => new WorkflowStore(project);

app.get('/api/workflow', wrap(async (req, res) => {
  const wf = await workflowStore().read();
  if (!wf.workload) {
    const existing = await project.readProjectPrompt();
    if (existing?.request?.trim()) wf.workload = existing.request;
  }
  res.json(wf);
}));

app.put('/api/workflow', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.workload === 'string') patch.workload = b.workload;
  if (Number.isInteger(b.step) && b.step >= 1 && b.step <= 7) patch.step = b.step;
  if (b.proposed === null || (b.proposed && typeof b.proposed === 'object')) patch.proposed = b.proposed;
  if (Array.isArray(b.checklist)) patch.checklist = b.checklist;
  if (Array.isArray(b.distributed)) patch.distributed = b.distributed;
  res.json(await workflowStore().write(patch));
}));

// ① 초보자용 AI 요구사항 구체화 도우미
app.post('/api/workflow/refine-workload', wrap(async (req, res) => {
  const rough = String(req.body.workload || '').trim();
  if (!rough) throw new Error('먼저 만들고 싶은 앱을 한두 줄이라도 적어 주세요');
  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt: buildRefineWorkloadPrompt(rough), system: REFINE_WORKLOAD_SYSTEM }, { purpose: 'describe' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const refined = text.trim();
  if (!refined) throw new Error('AI 응답이 비어 있습니다');
  await workflowStore().write({ workload: refined });
  res.json({ refined });
}));

// 내보낸 폴더 열기 (Windows 탐색기)
let lastExportDir = '';
const resolveExportDir = (raw) => {
  const s = String(raw || '').trim();
  return s ? path.resolve(s) : path.join(project.root, 'dist');
};
const isAllowedExportDir = (dir) => {
  if (!dir) return false;
  const norm = path.resolve(dir);
  const def = path.resolve(project.root, 'dist');
  return norm === def || (lastExportDir && (norm === lastExportDir || norm.startsWith(lastExportDir + path.sep)));
};

const sanitizeExportBase = (raw, fallback = 'index') => {
  const s = String(raw || '')
    .replace(/\.exe$|\.html?$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || fallback;
};

app.post('/api/open-folder', wrap(async (req, res) => {
  const t = req.body?.target;
  const customDir = String(req.body?.dir || '').trim();
  let sub;
  if (customDir && isAllowedExportDir(customDir)) {
    sub = path.resolve(customDir);
  } else {
    const base = customDir ? resolveExportDir(customDir) : path.join(project.root, 'dist');
    sub = t === 'dist'
      ? base
      : t === 'electron'
        ? path.join(base, 'electron')
        : t === 'electron-dist'
          ? path.join(base, 'electron-dist')
          : project.root;
  }
  await fs.mkdir(sub, { recursive: true });
  if (process.platform === 'win32') {
    // cmd /c start "" "<path>" 는 ShellExecute 로 탐색기를 최상단 포그라운드로 연다
    spawn('cmd.exe', ['/c', 'start', '', sub], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  res.json({ ok: true, path: sub });
}));

// Windows 기본 폴더 선택 대화상자 열기 (최신 탐색기 스타일 OpenFileDialog 폴더 선택 모드 · 화면 중앙 최상단 표시)
app.post('/api/export/pick-folder', wrap(async (req, res) => {
  if (process.platform !== 'win32') {
    throw new Error('폴더 찾아보기 대화상자는 Windows 환경에서 지원됩니다. 경로를 직접 입력해 주세요.');
  }
  const initial = String(req.body?.initial || lastExportDir || path.join(project.root, 'dist')).replace(/'/g, "''");
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = '내보내기 파일을 저장할 폴더를 선택하세요'",
    '$d.ValidateNames = $false',
    '$d.CheckFileExists = $false',
    '$d.CheckPathExists = $true',
    "$d.FileName = '이 폴더 선택'",
    `if (Test-Path -LiteralPath '${initial}') { $d.InitialDirectory = '${initial}' }`,
    '$top = New-Object System.Windows.Forms.Form',
    '$top.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$top.Size = New-Object System.Drawing.Size(1,1)',
    '$top.Opacity = 0',
    '$top.ShowInTaskbar = $false',
    '$top.TopMost = $true',
    '$top.Show(); $top.Activate()',
    'if ($d.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ([System.IO.Path]::GetDirectoryName($d.FileName)) }',
    '$top.Close(); $top.Dispose()',
  ].join('; ');
  const picked = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(''); }, 120000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error(err.trim() || '폴더 선택 대화상자를 열지 못했습니다'));
      resolve(out.trim());
    });
  });
  if (picked) lastExportDir = path.resolve(picked);
  res.json({ path: picked, cancelled: !picked });
}));

// Step 1 → 2: 워크로드 분석 → 레이아웃 + 초기 기능 목록 추천 (수정 피드백 반영 재추천 포함)
app.post('/api/workflow/propose-layout', wrap(async (req, res) => {
  const curWf = await workflowStore().read();
  const workload = String(req.body.workload || curWf.workload || '').trim();
  const feedback = String(req.body.feedback || '').trim();
  if (!workload) throw new Error('먼저 만들 웹앱의 워크로드(요구사항)를 입력하세요');
  const layout = await project.getLayout();
  const prompt = buildProposeLayoutPrompt({
    workload,
    appName: layout.name,
    decisions: await project.readDecisions(),
    feedback,
    currentProposed: feedback ? (req.body.currentProposed || curWf.proposed) : null,
  });
  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt, system: PROPOSE_LAYOUT_SYSTEM }, { purpose: 'plan' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const proposed = parseProposeResponse(text);
  const wf = await workflowStore().write({
    step: 2,
    workload,
    proposed,
    checklist: proposed.features,
    deployReady: false,
  });
  await sessionStore().append('integrated', { role: 'assistant', status: 'ok', summary: `② 레이아웃 ${feedback ? '수정 ' : ''}추천 완료 (${proposed.regions.length}개 영역, 기능 ${proposed.features.length}개)` }).catch(() => {});
  res.json(wf);
}));

// Step 2 → 3: 추천된(또는 사용자가 수정한) 멀티 화면 레이아웃을 실제 캔버스(layout.json)에 반영
app.post('/api/workflow/apply-layout', wrap(async (req, res) => {
  const wf = await workflowStore().read();
  const prop = (req.body?.proposed && typeof req.body.proposed === 'object') ? req.body.proposed : wf.proposed;
  if (!prop?.regions?.length) throw new Error('적용할 추천 레이아웃이 없습니다');
  const propScreens = Array.isArray(prop.screens) && prop.screens.length
    ? prop.screens.filter((sc) => sc && sc.enabled !== false)
    : [{ id: 'main', title: '메인 화면', enabled: true, layout: prop.layout }];
  if (!propScreens.length) throw new Error('적용할 화면을 최소 1개 이상 선택하세요');

  const enabledScreenIds = new Set(propScreens.map((sc) => sc.id));
  const activeRegions = prop.regions.filter((r) => r && r.enabled !== false && (!r.screen || enabledScreenIds.has(r.screen)));
  if (!activeRegions.length) throw new Error('적용할 영역을 최소 1개 이상 선택하세요');

  await autoSnapshot('워크플로우 레이아웃 추천 반영 전');
  await project.backupLayout();
  const cur = await project.getLayout();

  const buildScreenRegions = (sc, scRegs) => {
    const cols = sc.layout?.cols || 12;
    let maxBottom = 0;
    for (const p of sc.layout?.regions || []) maxBottom = Math.max(maxBottom, (p.y || 0) + (p.h || 1));
    const placedRegs = scRegs.map((r) => {
      const pos = sc.layout?.regions?.find((p) => p.id === r.id);
      if (pos) return { id: r.id, title: r.title, color: r.color, x: pos.x, y: pos.y, w: pos.w, h: pos.h, summary: r.purpose };
      const placed = { id: r.id, title: r.title, color: r.color || '#5b5bd6', x: 0, y: maxBottom, w: cols, h: 2, summary: r.purpose };
      maxBottom += 2;
      return placed;
    });
    const rows = Math.max(sc.layout?.rows || 12, maxBottom);
    return {
      id: sc.id,
      title: sc.title || sc.id,
      grid: { ...cur.grid, cols, rows, fill: sc.layout?.fill !== false, gap: cur.grid.gap ?? 8 },
      regions: placedRegs,
    };
  };

  const builtScreens = propScreens.map((sc, idx) => {
    const scRegs = activeRegions.filter((r) => (r.screen ? r.screen === sc.id : idx === 0));
    return buildScreenRegions(sc, scRegs);
  }).filter((sc) => sc.regions.length > 0);
  if (!builtScreens.length) throw new Error('선택된 화면에 적용할 영역이 없습니다');

  const nextLayout = {
    ...cur,
    mode: 'grid',
    appPrompt: cur.appPrompt || wf.workload.slice(0, 600),
    grid: builtScreens[0].grid,
    regions: builtScreens[0].regions,
    activeScreen: builtScreens[0].id,
    ...(builtScreens.length > 1 ? { screens: builtScreens } : { screens: undefined }),
  };
  if (builtScreens.length <= 1) delete nextLayout.screens;

  await project.saveLayout(nextLayout);
  for (const r of activeRegions) {
    if (r.purpose) await project.writeRegion(r.id, { prompt: r.purpose }, { backup: false });
  }
  const activeIds = new Set(activeRegions.map((r) => r.id));
  const nextChecklist = (prop.features || [])
    .filter((f) => f && f.enabled !== false && String(f.name || '').trim())
    .map((f) => ({ ...f, region: activeIds.has(f.region) ? f.region : activeRegions[0].id }));
  // 요구사항에 명단·양식·저장·인쇄 같은 말이 있으면 맞는 스킬을 켜 둔다 (🧩 스킬에서 끌 수 있음)
  const skillsNow = await project.readSkills();
  const addSkills = recommendSkills(wf.workload).filter((id) => !skillsNow.enabled.includes(id));
  if (addSkills.length) await project.writeSkills({ ...skillsNow, enabled: [...skillsNow.enabled, ...addSkills] });
  const updated = await workflowStore().write({ step: 3, proposed: prop, checklist: nextChecklist, deployReady: false });
  await sessionStore().append('integrated', { role: 'system', status: 'ok', summary: `③ 추천 레이아웃을 캔버스에 반영 (${builtScreens.length}개 화면, ${activeRegions.length}개 영역, 기능 ${nextChecklist.length}개)` }).catch(() => {});
  if (addSkills.length) await sessionStore().append('integrated', { role: 'system', status: 'ok', summary: `🧩 요구사항에 맞는 스킬을 켰습니다: ${addSkills.map((id) => SKILLS.find((k) => k.id === id)?.title || id).join(', ')}` }).catch(() => {});
  res.json({ layout: nextLayout, workflow: updated, skillsAdded: addSkills });
}));

// Step 3 → 4: 사용자가 시각적으로 최종 편집한 layout.json 을 읽어 각 영역별 프롬프트 + 최종 기능 목록 분배
app.post('/api/workflow/distribute', wrap(async (req, res) => {
  const wf = await workflowStore().read();
  const workload = String(req.body.workload || wf.workload || '').trim();
  if (!workload) throw new Error('워크로드가 비어 있습니다');
  const layout = await project.getLayout();
  const leaves = flatten(layout).filter((e) => !isContainer(e.region)).map((e) => e.region);
  if (!leaves.length) throw new Error('캔버스에 영역이 없습니다. 먼저 영역을 배치하세요');
  const prompt = buildDistributePrompt({ workload, layout, existingChecklist: wf.checklist || [], decisions: await project.readDecisions() });
  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt, system: DISTRIBUTE_PROMPTS_SYSTEM }, { purpose: 'plan' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const dist = parseDistributeResponse(text, leaves.map((r) => r.id));
  for (const item of dist.prompts) {
    await project.writeRegion(item.region, { prompt: item.prompt }, { backup: false });
    const target = find(layout, item.region)?.region;
    if (target) target.summary = item.prompt.split('\n')[0].slice(0, 100);
  }
  await project.saveLayout(layout);
  const updated = await workflowStore().write({
    step: 4,
    workload,
    distributed: dist.prompts,
    checklist: dist.checklist.length ? dist.checklist : wf.checklist,
    deployReady: false,
  });
  await sessionStore().append('integrated', { role: 'assistant', status: 'ok', summary: `④ 편집된 레이아웃 기준 ${dist.prompts.length}개 영역에 프롬프트 분배 완료 (기능 ${updated.checklist.length}개)` }).catch(() => {});
  res.json({ workflow: updated, layout, summary: dist.summary });
}));

// Step 5 → 6: 기능 목록 전수 점검 + 실제 브라우저 통합 검증
app.post('/api/workflow/verify-features', wrap(async (req, res) => {
  const wf = await workflowStore().read();
  // 테스트가 하나도 없으면 기본 스모크 테스트를 자동 생성해 함께 검증
  const existingTests = await project.readTests();
  if (!existingTests.length) {
    const auto = await generateAutoTests(project);
    if (auto.length) await project.writeTests(auto);
  }
  const report = await verifyProject(project, { runBrowser: req.body?.runBrowser !== false });
  await attachFieldErrors(report);
  const layout = await project.getLayout();
  const regionFiles = {};
  for (const { region: r } of flatten(layout)) {
    if (!isContainer(r)) regionFiles[r.id] = await project.readRegion(r.id);
  }
  const { checklist, deployReady } = reconcileChecklist(wf.checklist || [], report, regionFiles);
  const updated = await workflowStore().write({
    step: 6,
    checklist,
    lastVerifiedAt: new Date().toISOString(),
    lastVerifyOk: report.ok,
    deployReady,
  });
  await sessionStore().append('verify', {
    role: 'verify',
    status: deployReady ? 'ok' : 'error',
    summary: deployReady
      ? `⑥ 기능 전수 검증 통과 (${checklist.filter((f) => f.verified).length}/${checklist.length}개 기능 확인) → ⑦ 배포 가능`
      : `⑥ 기능 검증 확인 필요 (통과 ${checklist.filter((f) => f.verified).length}/${checklist.length}개)`,
  }).catch(() => {});
  res.json({ report, workflow: updated });
}));

// 기존 단일 HTML 앱 가져오기 → 새 프로젝트
app.post('/api/import', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if ((await listProjects()).includes(name)) throw new Error('같은 이름의 프로젝트가 이미 있습니다');
  const result = importHtml(String(req.body.html || ''));
  if (!result.regions.length) throw new Error('<body> 안에서 가져올 내용을 찾지 못했습니다');
  const colors = ['#5b5bd6', '#e5484d', '#12a594', '#f76b15', '#8e4ec6', '#0090ff', '#d6409f', '#46a758'];
  const regions = result.regions.map(({ html, ...r }, i) => ({ ...r, color: colors[i % colors.length] }));
  await openProject(name, { ...result.layout, source: req.body.fileName || '', regions: [] });
  await project.saveLayout({ ...(await project.getLayout()), regions });
  for (const r of result.regions) await project.writeRegion(r.id, { html: r.html }, { backup: false });
  for (const key of ['css', 'js', 'head']) await project.writeShared(key, result.shared[key]);
  res.json({ ok: true, regions: regions.length });
}));

// 입력한(또는 저장된) 키로 Gemini 모델 목록 조회
app.post('/api/gemini/models', wrap(async (req, res) => {
  const key = String(req.body.apiKey || '').trim() || geminiKey(await getSettings());
  res.json({ models: await gemini.listModels(key) });
}));

app.post('/api/local/models', wrap(async (req, res) => {
  const s = await getSettings();
  const url = String(req.body.baseUrl || '').trim() || s.localUrl;
  const key = String(req.body.apiKey || '').trim() || localKey(s);
  res.json({ models: await local.listModels(url, key, { freeOnly: Boolean(req.body.freeOnly) }) });
}));

app.get('/api/cli/detect', wrap(async (req, res) => {
  res.json({ clis: await cli.detectClis(req.query.force === '1') });
}));

// ── 레이아웃 ──
app.get('/api/layout', wrap(async (req, res) => res.json(await project.getLayout())));
app.put('/api/layout', wrap(async (req, res) => res.json(await project.saveLayout(req.body))));

// 말로 현재 화면 레이아웃만 빠르게 재배치 (영역 코드·프롬프트는 그대로 유지)
app.post('/api/layout/ai-adjust', wrap(async (req, res) => {
  const instruction = String(req.body?.instruction || '').trim();
  if (!instruction) throw new Error('어떻게 배치를 바꿀지 한 줄로 적어 주세요');
  const screenId = String(req.body?.screenId || '').trim();
  const layout = await project.getLayout();
  const isMulti = Array.isArray(layout.screens) && layout.screens.length > 0;
  const targetScreen = isMulti ? (layout.screens.find((s) => s.id === screenId) || layout.screens[0]) : layout;
  const regs = targetScreen.regions || [];
  if (!regs.length) throw new Error('현재 화면에 배치할 영역이 없습니다');

  const g = targetScreen.grid || layout.grid || { cols: 12, rows: 12, fill: true, gap: 8 };
  const prompt = `# 현재 화면의 영역 목록 (${g.cols}열 × ${g.rows}행, ${g.fill ? '화면 채우기' : '스크롤'})\n` +
    regs.map((r) => `- ${r.id} ("${r.title || r.id}", 현재 x=${r.x}, y=${r.y}, w=${r.w}, h=${r.h})`).join('\n') +
    `\n\n# 사용자 배치 수정 요청\n${instruction}\n\n# 출력 형식 (다른 설명 없이 JSON 만, 모든 기존 영역 ID 를 정확히 한 번씩 포함)\n` +
    `{"summary":"바뀐 배치 한 줄 설명","layout":{"fill":${Boolean(g.fill)},"rows":[{"height":1,"cells":[{"id":"${regs[0].id}","width":12}]}]}}`;

  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt, system: '당신은 UI 레이아웃 디자이너입니다. 사용자의 배치 수정 요청에 맞게 기존 영역 ID 들을 12열 그리드 rows JSON 으로 재배치합니다. JSON 만 출력하세요.' }, { purpose: 'plan-layout-fix' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('AI 응답에서 레이아웃 JSON 을 찾지 못했습니다');
  const parsed = JSON.parse(text.slice(i, j + 1));
  const nextGrid = layoutFromRows(parsed.layout || parsed, regs.map((r) => r.id));

  await project.backupLayout();
  targetScreen.grid = { ...g, cols: nextGrid.cols || 12, rows: nextGrid.rows || 12, fill: nextGrid.fill !== false };
  targetScreen.regions = regs.map((r) => {
    const p = nextGrid.regions.find((x) => x.id === r.id);
    return p ? { ...r, x: p.x, y: p.y, w: p.w, h: p.h } : r;
  });
  if (isMulti && targetScreen === layout.screens[0]) {
    layout.grid = targetScreen.grid;
    layout.regions = targetScreen.regions;
  }
  await project.saveLayout(layout);
  logger.event('layout-ai-adjust', { screen: screenId || 'main', instruction });
  res.json({ layout, summary: String(parsed.summary || '요청대로 배치를 조정했습니다') });
}));

// ── 영역 파일 ──
app.get('/api/regions/:id', wrap(async (req, res) => {
  res.json({ files: await project.readRegion(req.params.id), history: await project.listHistory(req.params.id) });
}));

app.put('/api/regions/:id', wrap(async (req, res) => {
  const files = Object.fromEntries(Object.entries(req.body).filter(([k, v]) => FILES[k] && typeof v === 'string'));
  const promptOnly = Object.keys(files).length === 1 && 'prompt' in files;
  await project.writeRegion(req.params.id, files, { backup: !promptOnly });
  res.json({ ok: true });
}));

app.post('/api/regions/:id/rename', wrap(async (req, res) => {
  res.json(await project.renameRegion(req.params.id, req.body.newId));
}));

// ── 스냅샷 (프로젝트 전체 저장·되돌리기) ──
const snapshots = () => new Snapshots(project);
const autoSnapshot = (label) => snapshots().create(label, { auto: true });

app.get('/api/snapshots', wrap(async (req, res) => res.json({ list: await snapshots().list() })));
app.post('/api/snapshots', wrap(async (req, res) => res.json(await snapshots().create(req.body.label, { auto: Boolean(req.body.auto) }))));
app.post('/api/snapshots/:id/restore', wrap(async (req, res) => res.json(await snapshots().restore(req.params.id))));
app.delete('/api/snapshots/:id', wrap(async (req, res) => {
  await snapshots().remove(req.params.id);
  res.json({ ok: true });
}));

// ── 분할 / 합치기 / 안쪽 레이아웃 풀기 ──
app.post('/api/regions/merge', wrap(async (req, res) => {
  await autoSnapshot(`합치기 전: ${(req.body.ids || []).join(', ')}`);
  res.json(await mergeRegions(project, req.body.ids));
}));
app.post('/api/regions/:id/split', wrap(async (req, res) => {
  await autoSnapshot(`나누기 전: ${req.params.id}`);
  res.json(await splitRegion(project, req.params.id, req.body));
}));
app.post('/api/regions/:id/unwrap', wrap(async (req, res) => {
  await autoSnapshot(`안쪽 레이아웃 풀기 전: ${req.params.id}`);
  res.json(await unwrapRegion(project, req.params.id));
}));

app.post('/api/regions/:id/restore', wrap(async (req, res) => {
  await project.restoreHistory(req.params.id, req.body.version);
  res.json({ files: await project.readRegion(req.params.id) });
}));

async function regionPrompt(regionId, request, projectRequest = '', override = null, measured = '') {
  const layout = await project.getLayout();
  const region = find(layout, regionId)?.region;
  if (!region) throw new Error('없는 영역입니다');
  if (region.regions?.length) throw new Error('안쪽 레이아웃이 있는 영역은 안쪽의 각 영역을 따로 구현하세요');
  const files = { ...(await project.readRegion(region.id)), ...(override || {}) };
  // 가져온 앱(전역 app.js 가 있는 앱)이면 그리드로 재배치한 뒤에도 전역 코드·CSS 맥락을 함께 보낸다
  const appJs = await project.readShared('js');
  const shared = layout.mode === 'flow' || appJs.trim()
    ? { js: appJs, head: await project.readShared('head'), css: await project.readShared('css') }
    : {};
  // 이 영역에도 적용되는 바깥 영역(안쪽 레이아웃의 부모)의 CSS·JS, 이 영역을 함께 제어하는 형제 영역의 JS
  const inherited = [];
  for (const aid of ancestors(layout, region.id)) {
    const f = await project.readRegion(aid);
    if (f.css.trim() || f.js.trim()) inherited.push({ id: aid, why: '바깥 영역 (스코프가 이 영역을 감쌈)', css: f.css, js: f.js });
  }
  for (const { region: r } of flatten(layout)) {
    if (r.id !== region.id && r.jsRoots?.includes(region.id)) {
      inherited.push({ id: r.id, why: '이 영역의 요소도 함께 다루는 스크립트', css: '', js: (await project.readRegion(r.id)).js });
    }
  }
  const decisions = await project.readDecisions();
  const st = await getSettings();
  const rawN = st.historyCount ?? 8;
  const n = st.freeMode?.enabled ? Math.min(rawN, 2) : rawN; // 무료 절약 모드: 최근 요청 2개로 토큰 다이어트
  let history = n > 0 ? await project.recentRequests(region.id, n + 1) : [];
  const current = String(request || '').split('\n\n# 고쳐야 할 문제')[0].trim();
  if (history.at(-1)?.text === current) history = history.slice(0, -1);
  history = history.slice(-n);
  const skillNote = skillsPromptSection(await project.readSkills());
  const prompt = buildPrompt({ layout, region, files, request: request || files.prompt, shared, inherited, projectRequest, measured, decisions, history });
  // 켜 둔 스킬 사용법은 "# 요청" 바로 앞에 넣어 AI 가 직접 다시 만들지 않게 한다
  const at = prompt.lastIndexOf('\n# 요청\n');
  return { region, files, prompt: skillNote ? (at >= 0 ? prompt.slice(0, at) + skillNote + prompt.slice(at) : prompt + skillNote) : prompt };
}

// ── 스킬: 앱에 끼워 넣는 재사용 기능 (명단 업로드 · 양식 분석 · 인쇄 · 저장/백업) ──
async function skillsState() {
  const wf = await workflowStore().read().catch(() => ({}));
  const layout = await project.getLayout();
  return {
    catalog: SKILLS.map(({ id, icon, title, desc }) => ({ id, icon, title, desc })),
    ...(await project.readSkills()),
    recommended: recommendSkills(`${wf.workload || ''}\n${layout.appPrompt || ''}`),
  };
}
app.get('/api/skills', wrap(async (req, res) => res.json(await skillsState())));
// 편집기에서 양식 파일을 미리 분석할 때 쓰는 스킬 런타임 코드 (앱에 들어가는 것과 같은 코드)
app.get('/api/skills/runtime.js', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  res.type('application/javascript').send(skillsRuntime({ enabled: ids, options: { backupButton: false } }));
});
app.put('/api/skills', wrap(async (req, res) => {
  const cur = await project.readSkills();
  const b = req.body || {};
  await project.writeSkills({ enabled: Array.isArray(b.enabled) ? b.enabled : cur.enabled, options: { ...cur.options, ...(b.options || {}) } });
  res.json(await skillsState());
}));

// ── 🐞 실사용 오류: 내보낸 앱에서 모은 오류 기록 가져오기 ──
async function attachFieldErrors(report) {
  report.fieldErrors = await project.activeFieldErrors();
  if (report.fieldErrors.length) report.ok = false;
  return report;
}
app.get('/api/field-errors', wrap(async (req, res) => res.json({ all: await project.readFieldErrors(), active: await project.activeFieldErrors() })));
app.post('/api/field-errors/import', wrap(async (req, res) => {
  const result = await project.importFieldErrors(req.body?.data);
  logger.event('field-errors-import', result);
  res.json({ ...result, all: await project.readFieldErrors(), active: await project.activeFieldErrors() });
}));
app.post('/api/field-errors/clear', wrap(async (req, res) => {
  const { region, message } = req.body || {};
  const list = await project.readFieldErrors();
  await project.writeFieldErrors(message === undefined && region === undefined ? [] : list.filter((e) => !(e.message === message && e.region === (region ?? null))));
  res.json({ all: await project.readFieldErrors(), active: await project.activeFieldErrors() });
}));

// ── 프로젝트 전체 프롬프트 ──
app.get('/api/project', wrap(async (req, res) => {
  res.json({ appPrompt: (await project.getLayout()).appPrompt || '', decisions: await project.readDecisions(), ...(await project.readProjectPrompt()) });
}));

app.put('/api/project', wrap(async (req, res) => {
  const { appPrompt, request, plan, decisions } = req.body;
  if (typeof decisions === 'string') await project.writeDecisions(decisions.slice(0, 20000));
  if (typeof appPrompt === 'string') {
    const layout = await project.getLayout();
    layout.appPrompt = appPrompt;
    await project.saveLayout(layout);
  }
  await project.writeProjectPrompt({ request, plan });
  res.json({ ok: true });
}));

app.post('/api/project/decisions/add', wrap(async (req, res) => {
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => String(l).trim()).filter(Boolean);
  const before = await project.readDecisions();
  const have = new Set(before.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()));
  const add = lines.filter((l) => !have.has(l));
  if (add.length) await project.writeDecisions(`${before.trimEnd()}${before.trim() ? '\n' : ''}${add.map((l) => `- ${l}`).join('\n')}\n`);
  res.json({ decisions: await project.readDecisions(), added: add.length });
}));

// 프로젝트 요청 → 영역별 작업 계획 (실행은 편집기가 단계마다 영역 생성 API 를 호출)
app.post('/api/project/plan', wrap(async (req, res) => {
  const request = String(req.body.request || '').trim();
  if (!request) throw new Error('프로젝트 요청을 입력하세요');
  const layout = await project.getLayout();
  const regions = {};
  const overlays = await overlayIds(layout);
  const features = new Map(); // 기능ID → { region, name } (계획의 기능 옮기기 검사용)
  for (const { region } of flatten(layout)) {
    if (region.regions?.length) continue;
    const files = await ensureFeatureIds(region.id);
    const notes = await project.readFeatureNotes(region.id);
    regions[region.id] = {
      hasCode: Boolean(files.html.trim() || files.js.trim()),
      prompt: files.prompt,
      features: analyze(files.html).blocks.map((b) => {
        const name = noteOf(notes, b)?.name || b.label;
        if (b.fid) features.set(b.fid, { fid: b.fid, region: region.id, name });
        return { fid: b.fid, name };
      }).slice(0, 30),
    };
  }
  const userImages = normalizeUserImages(req.body.images);
  const prCtx = await new ChatMemoryStore(project).buildPrContext(4);
  const reqWithCtx = `${request}${userImages.length ? `\n\n(참고 이미지 ${userImages.length}장이 첨부되었습니다. 이미지의 레이아웃 구조·구성 요소를 참고해 영역과 배치를 계획하세요.)` : ''}${prCtx}`;
  const prompt = buildPlanPrompt({
    layout,
    regions,
    request: reqWithCtx,
    sharedCss: await project.readShared('css'),
    hasAppJs: Boolean((await project.readShared('js')).trim()),
    overlays,
    decisions: await project.readDecisions(),
  });
  let text = '';
  try {
    for await (const ev of runProvider(await getSettings(), { prompt, system: PLAN_SYSTEM, images: userImages }, { purpose: 'plan' })) {
      if (ev.type === 'final') text = ev.text;
    }
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  const valid = new Set(['shared:css', ...Object.keys(regions)]);
  const { rawLayout, ...parsed } = parsePlan(text, valid, { layout, overlays, features });
  const plan = { request, createdAt: new Date().toISOString(), ...parsed };
  // 배치가 잘못됐으면(영역 빠짐·겹침 등) 오류를 알려 주고 한 번 더 고치게 한다
  // 새 영역·지울 영역을 반영한 최상위 영역으로 배치를 검사한다
  const base = plannedLayout(layout, { newRegions: plan.newRegions, removeRegions: plan.removeRegions.filter((r) => r.valid).map((r) => r.id) });
  if (plan.layout && !plan.layout.valid) {
    let fixed = '';
    try {
      const fixPrompt = buildLayoutFixPrompt({ layout: base, bad: { ...plan.layout, regions: rawLayout?.regions }, overlays, request });
      for await (const ev of runProvider(await getSettings(), { prompt: fixPrompt, system: PLAN_SYSTEM }, { purpose: 'plan-layout-fix' })) {
        if (ev.type === 'final') fixed = ev.text;
      }
    } catch {}
    const retry = normalizeLayoutPlan(base, parseLayoutJson(fixed), overlays);
    if (retry?.valid) plan.layout = { ...retry, retried: true };
  }
  if (plan.layout) plan.layout.enabled = plan.layout.valid;
  logger.event('plan', {
    request,
    summary: plan.summary,
    steps: plan.steps.map((s) => ({ target: s.target, enabled: s.enabled, warn: s.warn || undefined, prompt: s.prompt })),
    layout: plan.layout && { valid: plan.layout.valid, error: plan.layout.error, retried: plan.layout.retried, autoAdded: plan.layout.autoAdded, regions: plan.layout.regions },
    newRegions: plan.newRegions,
    featureMoves: plan.featureMoves,
    removeRegions: plan.removeRegions,
  });
  await project.writeProjectPrompt({ request, plan });
  await project.appendProjectLog(`${request}\n\n**계획**: ${plan.summary}\n${plan.steps.map((s) => `- ${s.target}: ${s.prompt}`).join('\n')}`);
  await sessionStore().append('integrated', { role: 'assistant', status: 'ok', summary: `계획 수립 (${plan.steps.length}단계): ${plan.summary || request.slice(0, 80)}` }).catch(() => {});
  res.json(plan);
}));

async function overlayIds(layout) {
  const out = new Set();
  for (const r of layout.regions) {
    if (!r.regions?.length && isOverlayHtml((await project.readRegion(r.id)).html)) out.add(r.id);
  }
  return out;
}

// 계획의 새 배치를 레이아웃에 적용 (최상위 영역 좌표 + 그리드). 적용 전 layout.json 을 백업한다
app.post('/api/layout/restructure', wrap(async (req, res) => {
  const layout = await project.getLayout();
  const overlays = await overlayIds(layout);
  const next = validateLayoutPlan(layout, req.body.layout, overlays);
  if (!next?.valid) throw new Error(next?.error || '배치 정보가 없습니다');
  await autoSnapshot('레이아웃 재배치 전');
  await project.backupLayout();
  layout.mode = 'grid';
  layout.grid = { ...layout.grid, cols: next.cols, rows: next.rows, fill: next.fill, gap: layout.grid.gap || 8 };
  for (const p of next.regions) Object.assign(layout.regions.find((r) => r.id === p.id), { x: p.x, y: p.y, w: p.w, h: p.h });
  // 오버레이 영역은 칸을 차지하지 않으므로 그리드 오른쪽 아래 1칸에 둔다 (캔버스에서는 따로 표시)
  for (const r of layout.regions) if (overlays.has(r.id)) Object.assign(r, { x: next.cols - 1, y: next.rows - 1, w: 1, h: 1 });
  await project.saveLayout(layout);
  res.json({ layout });
}));

app.get('/api/layout/backups', wrap(async (req, res) => res.json({ list: await project.listLayoutBackups() })));

app.post('/api/layout/undo', wrap(async (req, res) => {
  await autoSnapshot('레이아웃 되돌리기 전');
  res.json({ layout: await project.restoreLayoutBackup() });
}));

// 공통 CSS 를 AI 로 고친다 (프로젝트 계획의 shared:css 단계)
app.post('/api/shared/css/generate', wrap(async (req, res) => {
  const request = String(req.body.request || '').trim();
  if (!request) throw new Error('요청이 비어 있습니다');
  const layout = await project.getLayout();
  const prompt = buildSharedCssPrompt({ layout, css: await project.readShared('css'), request, projectRequest: req.body.projectRequest || '', decisions: await project.readDecisions() });
  let text = '';
  try {
    for await (const ev of runProvider(await getSettings(), { prompt, system: SHARED_CSS_SYSTEM }, { purpose: 'shared-css' })) {
      if (ev.type === 'final') text = ev.text;
    }
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  const css = parseFiles(text).css;
  if (!css) throw new Error('응답에서 CSS 코드 블록을 찾지 못했습니다');
  if (addsLayoutCss(await project.readShared('css'), css)) {
    throw new Error('AI 가 html/body 에 배치(grid/flex)를 넣으려 해서 저장하지 않았습니다. 배치는 📐 레이아웃 재배치나 캔버스에서 바꾸세요');
  }
  await project.writeShared('css', css);
  res.json({ ok: true, size: css.length });
}));

// AI 호출. 보낸 system/prompt 와 받은 응답 원문을 logs/<날짜>/ai/ 에 남긴다
// meta: { purpose: 'region' | 'plan' | 'plan-layout-fix' | 'shared-css' | 'describe', region }
// 작업 종류별로 '세션 전용 모델' 또는 '가벼운 모델'로 보낼 수 있다. 키·주소는 주 설정의 것을 쓴다
const PURPOSE_ROUTE = { region: 'region', 'region-fix': 'fix', plan: 'plan', 'plan-layout-fix': 'plan', 'shared-css': 'css', describe: 'describe', 'tests-gen': 'describe' };
const PURPOSE_SESSION = { plan: 'integrated', 'plan-layout-fix': 'integrated', 'shared-css': 'integrated', region: 'region', 'region-fix': 'region', describe: 'verify', 'tests-gen': 'verify' };
function applyModelOverride(settings, override, tier) {
  const s = { ...settings, provider: override.provider, tier };
  if (override.provider === 'gemini') s.geminiModel = override.model;
  else if (override.provider === 'local') s.localModel = override.model;
  else if (override.provider === 'cli') s.cliModel = override.model;
  else s.model = override.model;
  return s;
}
function routeSettings(settings, purpose) {
  const sess = PURPOSE_SESSION[purpose];
  const sm = sess && settings.sessionModels?.[sess];
  if (sm?.provider && sm?.model) return applyModelOverride(settings, sm, `session:${sess}`);
  const route = PURPOSE_ROUTE[purpose];
  const light = settings.light;
  if (!route || !settings.routes?.[route] || !light?.provider || !light?.model) return { ...settings, tier: 'main' };
  return applyModelOverride(settings, light, 'light');
}

// 그림 토큰 대략값 (Claude 기준: 가로×세로/750)
const imageTokens = (im) => Math.ceil(((im.width || 800) * (im.height || 600)) / 750);

// 사용자가 프롬프트에 첨부한 참고 이미지 검증·정규화 (최대 4장, 장당 ~6MB)
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export function normalizeUserImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 4)) {
    const mime = String(item?.mime || '').toLowerCase();
    const data = String(item?.data || '').replace(/\s+/g, '');
    if (!ALLOWED_IMAGE_MIME.has(mime) || !data || data.length > 8_500_000) continue;
    const width = Math.max(1, Math.min(4096, Math.round(Number(item?.width) || 800)));
    const height = Math.max(1, Math.min(4096, Math.round(Number(item?.height) || 600)));
    out.push({ mime, data, width, height, bytes: Math.floor(data.length * 0.75) });
  }
  return out;
}

// 그림을 보낼지: auto 면 모양·배치에 관한 요청이거나, 잰 값에 칸 문제가 보일 때만
const VISUAL_WORDS = /모양|디자인|레이아웃|배치|겹|어긋|잘려|잘림|삐져|정렬|간격|여백|크기|넘쳐|넘침|깨져|깨짐|위치|보기 좋|예쁘|색|화면|look|layout|align|overlap|spacing|style/i;
const FRAME_PROBLEMS = /넘쳐|넘침|밖으로|sticky|fixed|떨어져/;
function wantImage(mode, request, measured) {
  if (mode === 'always') return true;
  if (mode !== 'auto') return false;
  return VISUAL_WORDS.test(request) || FRAME_PROBLEMS.test(measured);
}

const PROVIDER_READY = {
  gemini: (s) => Boolean(geminiKey(s) && s.geminiModel),
  local: (s) => Boolean(s.localModel && s.localUrl),
  cli: (s) => Boolean(s.cliCommand || cli.CLI_PRESETS[s.cliPreset]?.bin),
  claude: (s) => Boolean(claudeKey(s) && s.model),
};

// JS .slice() 가 이모지(UTF-16 서로게이트 쌍) 중간을 잘라 생긴 깨진 문자를 제거해 API 400 오류를 원천 차단
const stripLoneSurrogates = (s) => String(s ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

async function* callSingleProvider(settings, ctx, meta) {
  const safeCtx = {
    ...ctx,
    prompt: stripLoneSurrogates(ctx.prompt),
    ...(ctx.system !== undefined ? { system: stripLoneSurrogates(ctx.system) } : {}),
  };
  const model = { gemini: settings.geminiModel, local: settings.localModel, claude: settings.model, cli: `${settings.cliPreset || 'cli'}${settings.cliModel ? `:${settings.cliModel}` : ''}` }[settings.provider];
  const rec = logger.startAi({ ...meta, purpose: meta.purpose || 'ai', provider: settings.provider, tier: settings.tier, model, system: safeCtx.system || SYSTEM, prompt: safeCtx.images?.length ? `${safeCtx.prompt}\n\n[첨부 그림 ${safeCtx.images.length}장: ${safeCtx.images.map((im) => `${im.width}×${im.height}px ${Math.round(im.bytes / 1024)}KB ≈ ${imageTokens(im)} 토큰`).join(', ')}]` : safeCtx.prompt });
  const inner = {
    gemini: () => gemini.generate({ ...safeCtx, apiKey: geminiKey(settings), model: settings.geminiModel }),
    local: () => local.generate({ ...safeCtx, baseUrl: settings.localUrl, apiKey: localKey(settings), model: settings.localModel }),
    cli: () => cli.generate({ ...safeCtx, preset: settings.cliPreset, command: settings.cliCommand, args: settings.cliArgs, model: settings.cliModel, cwd: project?.root || here }),
    claude: () => generate({ ...safeCtx, apiKey: settings.apiKey, model: settings.model }),
  }[settings.provider]();
  let finished = false;
  try {
    for await (const ev of inner) {
      if (ev.type === 'delta') rec.delta(ev.text);
      if (ev.type === 'final') {
        finished = true;
        rec.finish({ text: ev.text, usage: ev.usage });
      }
      yield ev;
    }
  } catch (err) {
    if (!finished) rec.finish({ error: errorMessage(err) });
    finished = true;
    throw err;
  } finally {
    if (!finished) rec.finish({ error: '응답이 끝나기 전에 중단됨' });
  }
}

async function* runProvider(settings0, ctx, meta = {}) {
  const settings = routeSettings(settings0, meta.purpose);
  const fm = normalizeFreeMode(settings0.freeMode);
  if (fm.enabled && fm.dailyLimit > 0) {
    const today = await todayUsageSummary();
    quotaGuard.checkDailyCap(today.calls, fm.dailyLimit);
  }
  const chain = [settings.provider, ...(fm.autoFallback ? buildFallbackOrder(settings0, settings.provider, PROVIDER_READY) : [])];
  let lastErr = null;
  for (let i = 0; i < chain.length; i++) {
    const prov = chain[i];
    const active = i === 0 ? settings : { ...settings0, provider: prov, tier: 'fallback' };
    if (fm.enabled && fm.minIntervalSec > 0) {
      const waited = await quotaGuard.waitCooldown(prov, fm.minIntervalSec * 1000);
      if (waited > 500) yield { type: 'delta', text: `🍃 무료 RPM 보호 대기 ${(waited / 1000).toFixed(1)}초…\n` };
    }
    if (i > 0) {
      yield { type: 'delta', text: `\n🔄 이전 제공자 한도/혼잡으로 ${prov} 제공자로 자동 전환합니다…\n\n` };
    }
    try {
      for await (const ev of callSingleProvider(active, ctx, meta)) yield ev;
      return;
    } catch (err) {
      lastErr = err;
      if (i < chain.length - 1 && isRateOrOverloadError(err)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('사용 가능한 AI 제공자가 없습니다');
}

// ── 기능 목록 (영역 마크업의 최상위 블록) ──
// 최상위 블록에 data-feature ID 를 붙여 두면 옮기거나 고쳐도 같은 기능으로 추적된다
async function ensureFeatureIds(id) {
  const files = await project.readRegion(id);
  const taken = new Set();
  for (const { region } of flatten(await project.getLayout())) {
    if (region.id === id) continue;
    for (const f of featureIdsIn((await project.readRegion(region.id)).html)) taken.add(f);
  }
  featureIdsIn(files.html).forEach((f) => taken.add(f));
  const { html, added } = withFeatureIds(files.html, taken);
  if (!added.length) return files;
  // 예전 메모(해시 기준)를 새 ID 로 옮긴다
  const notes = await project.readFeatureNotes(id);
  const before = analyze(files.html).blocks;
  analyze(html).blocks.forEach((b, i) => {
    const old = before[i];
    if (b.fid && old && notes[old.hash] && !notes[b.fid]) notes[b.fid] = notes[old.hash];
  });
  await project.writeFeatureNotes(id, notes);
  await project.writeRegion(id, { html }, { backup: false });
  logger.event('feature-ids', { region: id, added });
  return { ...files, html };
}

const noteOf = (saved, b) => (b.fid && saved[b.fid]) || saved[b.hash] || null;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function regionFeatures(id) {
  const files = await ensureFeatureIds(id);
  const a = analyze(files.html);
  const saved = await project.readFeatureNotes(id);
  return {
    wrappers: a.wrappers.map((w) => w.tag + (w.id ? `#${w.id}` : '')),
    blocks: a.blocks.map(({ html, tokens, ...b }) => ({ ...b, size: html.length, note: noteOf(saved, b) })),
    hasJs: Boolean(files.js.trim()),
    hasCss: Boolean(files.css.trim()),
  };
}

// 기능 하나가 함께 데려가야 하는 CSS·JS·이벤트
app.get('/api/regions/:id/features/:fid/deps', wrap(async (req, res) => {
  const files = await ensureFeatureIds(req.params.id);
  const deps = featureDeps(files, req.params.fid);
  if (!deps) throw new Error('기능을 찾지 못했습니다');
  const appJs = await project.readShared('js');
  const block = analyze(files.html).blocks.find((b) => b.fid === req.params.fid);
  // 전역 app.js 가 쓰는 id (가져온 앱): id 가 그대로 옮겨지므로 계속 동작한다
  deps.global = appJs.trim() ? block.tokens.ids.filter((x) => new RegExp(`['"\`#]${reEsc(x)}['"\`\\s.:\\[]`).test(appJs)) : [];
  res.json(deps);
}));

// 기능을 다른 영역으로 옮긴다 (AI 없이 결정적으로). dryRun 이면 무엇이 옮겨질지만 알려 준다
app.post('/api/features/move', wrap(async (req, res) => {
  const { fid, from, to, position = 'end', dryRun = false } = req.body;
  if (!fid || !from || !to || from === to) throw new Error('옮길 기능과 영역을 지정하세요');
  const layout = await project.getLayout();
  const src = find(layout, from)?.region;
  const dst = find(layout, to)?.region;
  if (!src || !dst) throw new Error('영역을 찾지 못했습니다');
  if (dst.regions?.length) throw new Error('안쪽 레이아웃이 있는 영역에는 넣을 수 없습니다. 안쪽 영역을 고르세요');
  if (dryRun) {
    const { plan, bridge } = await prepareMove(fid, from, to, position, src);
    return res.json({ summary: plan.summary, bridge });
  }
  const { summary } = await prepareMove(fid, from, to, position, src);
  const snap = await autoSnapshot(`기능 이동 전: ${summary.feature} (${from} → ${to})`);
  const done = await moveFeatureNow(fid, from, to, position);
  logger.event('feature-move', { fid, from, to, summary: done.summary, bridge: done.bridge, snapshot: snap.id });
  res.json({ ok: true, snapshot: snap.id, summary: done.summary, bridge: done.bridge });
}));

async function prepareMove(fid, from, to, position, src) {
  const source = await ensureFeatureIds(from);
  const target = await ensureFeatureIds(to);
  const notes = await project.readFeatureNotes(from);
  const block = analyze(source.html).blocks.find((b) => b.fid === fid);
  if (!block) throw new Error('이 영역에 없는 기능입니다');
  const linked = {};
  for (const rid of src.jsRoots || []) if (rid !== from && rid !== to) linked[rid] = (await project.readRegion(rid)).html;
  const plan = planMove({ source, target, fid, sourceId: from, targetId: to, label: noteOf(notes, block)?.name || block.label, position, linked });
  for (const [k, f] of Object.entries(plan.files)) {
    const err = jsSyntaxError(f.js);
    if (err) throw new Error(`옮긴 뒤 ${k === 'source' ? '원래' : '새'} 영역의 script.js 문법이 깨져 중단했습니다: ${err}`);
  }
  // 남는 스크립트가 옮겨 간 요소도 다루면 root 를 두 영역으로 넓힌다 (jsRoots)
  const bridge = plan.needsBridge ? [...new Set([...(src.jsRoots || [from]), to])] : null;
  // 옮겨 가는 스크립트가 원래 영역과 연결돼 있던 다른 영역의 요소를 쓰면 새 영역도 그 영역과 연결한다
  const dst = find(await project.getLayout(), to)?.region;
  const targetRoots = plan.targetLinks.length ? [...new Set([...(dst?.jsRoots || [to]), ...plan.targetLinks])] : null;
  return { plan, bridge, targetRoots, block, notes, summary: plan.summary };
}

// 기능 하나를 옮겨 저장한다 (스냅샷은 부르는 쪽에서)
async function moveFeatureNow(fid, from, to, position = 'end') {
  const src = find(await project.getLayout(), from)?.region;
  const { plan, bridge, targetRoots, block, notes } = await prepareMove(fid, from, to, position, src);
  await project.writeRegion(from, plan.files.source);
  await project.writeRegion(to, plan.files.target);
  if (bridge || targetRoots) {
    const fresh = await project.getLayout();
    if (bridge) find(fresh, from).region.jsRoots = bridge;
    if (targetRoots) find(fresh, to).region.jsRoots = targetRoots;
    await project.saveLayout(fresh);
  }
  const note = noteOf(notes, block);
  if (note) {
    delete notes[fid];
    delete notes[block.hash];
    await project.writeFeatureNotes(from, notes);
    const tnotes = await project.readFeatureNotes(to);
    tnotes[fid] = note;
    await project.writeFeatureNotes(to, tnotes);
  }
  return { summary: plan.summary, bridge: bridge || targetRoots };
}

// 프로젝트 계획의 화면 재구성: 새 영역 → 기능 옮기기 → 빈 영역 지우기 → 배치. 한 번의 스냅샷으로 묶는다
const REGION_COLORS = ['#5b5bd6', '#e5484d', '#12a594', '#f76b15', '#8e4ec6', '#0090ff', '#d6409f', '#46a758'];
app.post('/api/project/reorganize', wrap(async (req, res) => {
  const newRegions = Array.isArray(req.body.newRegions) ? req.body.newRegions : [];
  const featureMoves = Array.isArray(req.body.featureMoves) ? req.body.featureMoves : [];
  const removeRegions = Array.isArray(req.body.removeRegions) ? req.body.removeRegions.map(String) : [];
  const log = [];
  const snap = await autoSnapshot('화면 재구성 전');
  await project.backupLayout();

  // 1. 새 영역 (최상위, 일단 맨 아래에 두고 4 단계에서 배치)
  let layout = await project.getLayout();
  for (const n of newRegions) {
    const id = String(n.id || '');
    if (!ID_RE.test(id) || find(layout, id)) {
      log.push({ ok: false, text: `새 영역 ${id}: 쓸 수 없는 ID` });
      continue;
    }
    const rows = layout.grid.rows;
    layout.regions.push({ id, title: String(n.title || id).slice(0, 40), x: 0, y: rows, w: layout.grid.cols, h: 1, color: REGION_COLORS[flatten(layout).length % REGION_COLORS.length] });
    layout.grid.rows = Math.min(rows + 1, 48);
    if (n.purpose) await project.writeRegion(id, { prompt: String(n.purpose) }, { backup: false });
    log.push({ ok: true, text: `새 영역 ${n.title || id}` });
  }
  await project.saveLayout(layout);

  // 2. 기능 옮기기 (하나가 실패해도 나머지는 계속)
  for (const m of featureMoves) {
    try {
      const r = await moveFeatureNow(String(m.feature), String(m.from), String(m.to));
      log.push({ ok: true, text: `기능 "${r.summary.feature}" ${m.from} → ${m.to}${r.bridge ? ' (스크립트 연결)' : ''}` });
    } catch (e) {
      log.push({ ok: false, text: `기능 ${m.name || m.feature} ${m.from} → ${m.to}: ${e.message}` });
    }
  }

  // 3. 빈 영역 지우기: 기능이 남았거나 다른 영역에 연결된 스크립트가 남으면 지우지 않는다
  layout = await project.getLayout();
  const removed = [];
  for (const id of removeRegions) {
    const r = layout.regions.find((x) => x.id === id);
    if (!r || r.regions?.length) continue;
    const f = await project.readRegion(id);
    if (analyze(f.html).blocks.length) {
      log.push({ ok: false, text: `영역 ${id}: 아직 기능이 남아 지우지 않음` });
      continue;
    }
    if (f.js.trim()) {
      log.push({ ok: false, text: `영역 ${id}: 남은 script.js 가 있어 지우지 않음 (다른 영역으로 옮긴 요소를 다룸)` });
      continue;
    }
    layout.regions = layout.regions.filter((x) => x.id !== id);
    removed.push(id);
    log.push({ ok: true, text: `빈 영역 ${r.title || id} 지움 (.trash 로 이동)` });
  }
  for (const { region: r } of flatten(layout)) {
    if (!r.jsRoots) continue;
    r.jsRoots = r.jsRoots.filter((x) => !removed.includes(x));
    if (r.jsRoots.length < 2) delete r.jsRoots;
  }
  await project.saveLayout(layout);

  // 4. 배치 (단일 화면 + 다중 화면 간 영역 이동/병합 모두 지원)
  if (req.body.layout) {
    const overlays = await overlayIds(layout);
    const targetScreenId = req.body.layout.targetScreen;
    const isMulti = Array.isArray(layout.screens) && layout.screens.length > 1;
    if (isMulti) {
      const targetSc = layout.screens.find((s) => s.id === targetScreenId) || layout.screens.find((s) => s.id === layout.activeScreen) || layout.screens[0];
      // 다른 화면에서 이 화면으로 옮겨오는 영역 먼저 이동
      const incomingIds = new Set((req.body.layout.regions || []).map((p) => p.id));
      for (const sc of layout.screens) {
        if (sc.id === targetSc.id) continue;
        const moving = (sc.regions || []).filter((r) => incomingIds.has(r.id));
        if (moving.length) {
          sc.regions = sc.regions.filter((r) => !incomingIds.has(r.id));
          for (const mr of moving) {
            if (!targetSc.regions.some((x) => x.id === mr.id)) targetSc.regions.push(mr);
          }
          log.push({ ok: true, text: `화면 "${sc.title || sc.id}" → "${targetSc.title || targetSc.id}" 영역 ${moving.length}개 병합 이동` });
        }
      }
      // 영역을 모두 옮겨 비게 된 화면은 자동 정리
      const emptyScreens = layout.screens.filter((sc) => sc.id !== targetSc.id && !(sc.regions || []).length && incomingIds.size > 0);
      if (emptyScreens.length && layout.screens.length > emptyScreens.length) {
        const emptyIds = new Set(emptyScreens.map((s) => s.id));
        for (const sc of layout.screens) if (emptyIds.has(sc.parentScreen)) sc.parentScreen = targetSc.id;
        layout.screens = layout.screens.filter((sc) => !emptyIds.has(sc.id));
      }
      const need = targetSc.regions.filter((r) => !overlays.has(r.id)).map((r) => r.id);
      const virtualLayout = { ...layout, grid: targetSc.grid || layout.grid, regions: targetSc.regions };
      const next = validateLayoutPlan(virtualLayout, fitLayoutTo(req.body.layout, need), overlays);
      if (next?.valid) {
        targetSc.grid = { ...(targetSc.grid || layout.grid), cols: next.cols, rows: next.rows, fill: next.fill, gap: (targetSc.grid || layout.grid)?.gap || 8 };
        for (const p of next.regions) {
          const reg = targetSc.regions.find((r) => r.id === p.id);
          if (reg) Object.assign(reg, { x: p.x, y: p.y, w: p.w, h: p.h });
        }
        layout.activeScreen = targetSc.id;
        layout.regions = layout.screens[0].regions;
        await project.saveLayout(layout);
        log.push({ ok: true, text: `화면 "${targetSc.title || targetSc.id}" 배치 ${next.cols}×${next.rows}` });
      } else log.push({ ok: false, text: `배치: ${next?.error || '배치 정보가 없습니다'}` });
    } else {
      const need = layout.regions.filter((r) => !overlays.has(r.id)).map((r) => r.id);
      const next = validateLayoutPlan(layout, fitLayoutTo(req.body.layout, need), overlays);
      if (next?.valid) {
        layout.mode = 'grid';
        layout.grid = { ...layout.grid, cols: next.cols, rows: next.rows, fill: next.fill, gap: layout.grid.gap || 8 };
        for (const p of next.regions) Object.assign(layout.regions.find((r) => r.id === p.id), { x: p.x, y: p.y, w: p.w, h: p.h });
        for (const r of layout.regions) if (overlays.has(r.id)) Object.assign(r, { x: next.cols - 1, y: next.rows - 1, w: 1, h: 1 });
        await project.saveLayout(layout);
        log.push({ ok: true, text: `배치 ${next.cols}×${next.rows}` });
      } else log.push({ ok: false, text: `배치: ${next?.error || '배치 정보가 없습니다'}` });
    }
  }
  logger.event('reorganize', { snapshot: snap.id, log });
  res.json({ layout: await project.getLayout(), log, snapshot: snap.id });
}));

app.get('/api/regions/:id/features', wrap(async (req, res) => res.json(await regionFeatures(req.params.id))));

// AI 로 기능마다 이름·설명을 붙인다 (블록 내용이 바뀌면 해시가 달라져 다시 설명 필요)
app.post('/api/regions/:id/describe', wrap(async (req, res) => {
  const id = req.params.id;
  const layout = await project.getLayout();
  const files = await ensureFeatureIds(id);
  const a = analyze(files.html);
  if (!a.blocks.length) throw new Error('설명할 기능이 없습니다');
  const appJs = layout.mode === 'flow' ? await project.readShared('js') : files.js;
  const prompt = `영역 "${find(layout, id)?.region.title || id}" 의 마크업을 기능 블록으로 나눴습니다. 각 블록이 사용자에게 어떤 기능인지 설명하세요.

${a.blocks.map((b) => `## 블록 ${b.index} (${b.tag}${b.id ? '#' + b.id : ''})
\`\`\`html
${b.html.trim().slice(0, 1500)}
\`\`\`
관련 코드:
\`\`\`js
${relatedCode(b.html, appJs, 2500) || '(없음)'}
\`\`\``).join('\n\n')}

출력: 다른 말 없이 JSON 배열만. 형식: [{"index": 0, "name": "짧은 기능 이름(15자 이내)", "desc": "무엇을 하는지 한 문장"}]`;
  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt, system: '당신은 웹앱 UI 를 분석해 기능을 한국어로 간결하게 설명하는 도우미입니다. JSON 만 출력합니다.' }, { purpose: 'describe', region: id })) {
    if (ev.type === 'final') text = ev.text;
  }
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    throw new Error('AI 응답을 해석하지 못했습니다. 다시 시도하세요');
  }
  const notes = await project.readFeatureNotes(id);
  for (const item of list) {
    const b = a.blocks[Number(item.index)];
    if (b && item.name) notes[b.fid || b.hash] = { name: String(item.name).slice(0, 40), desc: String(item.desc || '').slice(0, 200) };
  }
  await project.writeFeatureNotes(id, notes);
  res.json(await regionFeatures(id));
}));

// Claude Code 등 다른 도구에 붙여 넣을 수 있게 전체 프롬프트를 돌려준다
app.post('/api/regions/:id/prompt', wrap(async (req, res) => {
  const { region, prompt } = await regionPrompt(req.params.id, req.body.request);
  const dir = path.relative(here, project.regionDir(region.id)).replaceAll('\\', '/');
  res.json({ text: `${prompt}\n\n(파일 위치: ${dir}/view.html, style.css, script.js — 규칙은 프로젝트 폴더의 CLAUDE.md 참고)` });
}));

// 바이브 코딩: 응답을 NDJSON 으로 스트리밍하고, 끝나면 파일에 저장
app.post('/api/regions/:id/generate', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  try {
    const id = req.params.id;
    const request = String(req.body.request || '').trim();
    if (!request) throw new Error('프롬프트를 입력하세요');
    const projectRequest = String(req.body.projectRequest || '');
    const sessionKey = String(req.body.sessionKey || `region:${id}`);
    const review = Boolean(req.body.review); // true 면 저장하지 않고 검토 대기(.pending)로
    const runtimeError = String(req.body.runtimeError || ''); // 브라우저 실행 검사에서 난 오류로 다시 고치는 경우
    const measured = String(req.body.measured || '').slice(0, 2500);
    const cell = req.body.cell && Number(req.body.cell.w) > 0 ? { w: Number(req.body.cell.w), h: Number(req.body.cell.h) } : null; // 편집기가 미리보기에서 잰 칸·내용 크기 (그림 대신 글이라 토큰이 적다)
    const userImages = normalizeUserImages(req.body.images);
    const settings = await getSettings();
    const appJs = await project.readShared('js');
    const saved = await project.readRegion(id);
    const pendingBase = req.body.fromPending ? (await project.readPending(id))?.files : null;

    if (!runtimeError) {
      await project.writeRegion(id, { prompt: request }, { backup: false });
      await project.appendLog(id, request);
    }

    // 생성 → 검사(형식·문법·사라진 id) → 문제가 있으면 문제를 알려 주고 다시 (최대 3번)
    let base = pendingBase; // AI 에게 "현재 코드"로 보여 줄 내용 (없으면 저장된 파일)
    let feedback = runtimeError ? [`방금 만든 코드를 미리보기에서 실행하니 오류가 났습니다: ${runtimeError}`] : [];
    let result = null;
    for (let attempt = 1; attempt <= GENERATE_ATTEMPTS && !result; attempt++) {
      const req2 = feedback.length ? `${request}\n\n# 고쳐야 할 문제 (자동 검사 결과)\n${feedback.map((f) => `- ${f}`).join('\n')}` : request;
      const { prompt } = await regionPrompt(id, req2, projectRequest, base, measured);
      if (attempt > 1) send({ type: 'delta', text: `\n\n🔁 자동 검사에서 문제를 찾아 다시 요청합니다 (${attempt}/${GENERATE_ATTEMPTS}): ${feedback.join(' / ')}\n\n` });
      let text = '';
      let usage;
      // 그림은 첫 시도에만 (다시 시도할 때는 글로 된 검사 결과로 충분)
      let images = [];
      if (attempt === 1 && userImages.length) {
        images.push(...userImages);
        send({ type: 'delta', text: `🖼 첨부한 참고 이미지 ${userImages.length}장을 함께 보냅니다\n\n` });
      }
      if (attempt === 1 && !settings.freeMode?.enabled && cell && wantImage(settings.visualMode, request, measured) && saved.html.trim()) {
        try {
          const im = await shoot(`http://127.0.0.1:${PORT}/preview?only=${encodeURIComponent(id)}&w=${cell.w}&h=${cell.h}&t=${Date.now()}`, cell.w, cell.h);
          images.push(im);
          send({ type: 'delta', text: `📷 영역 화면을 그림으로 함께 보냅니다 (${im.width}×${im.height}px, 약 ${imageTokens(im)} 토큰)\n\n` });
        } catch (e) {
          send({ type: 'delta', text: `📷 화면을 찍지 못해 글로 된 측정값만 보냅니다: ${e.message}\n\n` });
        }
      }
      for await (const ev of runProvider(settings, { prompt, images }, { purpose: attempt > 1 || runtimeError ? 'region-fix' : 'region', region: id })) {
        if (ev.type === 'delta') send(ev);
        else ({ text, usage } = ev);
      }
      const parsed = normalizeFiles(parseFiles(text));
      const candidate = { ...pick(base || saved), ...parsed };
      const problems = checkRegionOutput({ before: saved, parsed, appJs });
      if (!problems.length) {
        result = { candidate, parsed, usage, attempt, memo: parseMemo(text) };
        break;
      }
      logger.event('ai-check-failed', { region: id, attempt, problems: problems.map((p) => p.text) });
      feedback = problems.map((p) => p.text);
      // 문법 오류는 방금 코드를 고치게 하고, 형식·id 문제는 원래 코드에서 다시 시작하게 한다
      base = problems.every((p) => p.kind.endsWith('syntax')) ? candidate : pendingBase;
    }
    if (!result) {
      logger.event('ai-rejected', { region: id, reason: 'checks-failed', problems: feedback });
      throw new Error(`자동 검사를 ${GENERATE_ATTEMPTS}번 통과하지 못해 저장하지 않았습니다: ${feedback.join(' / ')}`);
    }

    const changed = ['html', 'css', 'js'].filter((k) => result.candidate[k] !== saved[k]);
    const memoHave = await project.readDecisions();
    const memo = result.memo.filter((l) => !memoHave.includes(l));
    if (memo.length) logger.event('memo-suggested', { region: id, memo });
    if (review) {
      await project.writePending(id, result.candidate, { request, projectRequest, attempt: result.attempt });
      logger.event('ai-pending', { region: id, files: changed, attempt: result.attempt });
      await sessionStore().append(sessionKey, { role: 'assistant', status: 'ok', summary: `검토 대기 (${changed.join(', ') || '변경 없음'}): ${request.slice(0, 100)}` }).catch(() => {});
      send({ type: 'done', pending: true, files: result.candidate, current: pick(saved), updated: changed, usage: result.usage, attempt: result.attempt, memo });
    } else {
      await project.writeRegion(id, Object.fromEntries(changed.map((k) => [k, result.candidate[k]])));
      await project.clearPending(id);
      logger.event('ai-saved', { region: id, files: changed, attempt: result.attempt, fromPlan: Boolean(projectRequest) });
      await project.markFieldErrorsFixed(id).catch(() => {});
      await sessionStore().append(sessionKey, { role: 'assistant', status: 'ok', summary: `저장 완료 (${changed.join(', ') || '변경 없음'}): ${request.slice(0, 100)}` }).catch(() => {});
      await new ChatMemoryStore(project).append({
        kind: 'handoff',
        session: sessionKey,
        region: id,
        text: `[세션 전달 완료 · ${id}] ${request.split('\n')[0].slice(0, 120)} (변경: ${changed.join(', ') || '없음'})`,
      }).catch(() => {});
      send({ type: 'done', files: await project.readRegion(id), updated: changed, usage: result.usage, attempt: result.attempt, memo });
    }
  } catch (err) {
    logger.event('error', { where: 'generate', region: req.params.id, message: errorMessage(err) });
    send({ type: 'error', message: errorMessage(err) });
  }
  res.end();
});

// ── 분석: 영역 연결 지도, app.js 나누기 ──
async function leafSources(key) {
  const layout = await project.getLayout();
  const out = {};
  for (const { region } of flatten(layout)) if (!region.regions?.length) out[region.id] = (await project.readRegion(region.id))[key];
  return { layout, out };
}

app.get('/api/analysis/connections', wrap(async (req, res) => {
  const { out } = await leafSources('js');
  const appJs = await project.readShared('js');
  if (appJs.trim()) out['app.js'] = appJs;
  res.json(scanConnections(out, skillsProvides(await project.readSkills())));
}));

app.get('/api/analysis/appjs', wrap(async (req, res) => {
  const appJs = await project.readShared('js');
  if (!appJs.trim()) return res.json({ functions: [], empty: true });
  const { layout, out } = await leafSources('html');
  res.json({ functions: analyzeAppJs(appJs, layout, out), size: appJs.length });
}));

// 고른 함수들을 app.js 에서 떼어 각 영역 script.js 로 옮긴다 (실행 전 스냅샷)
app.post('/api/analysis/appjs/move', wrap(async (req, res) => {
  const names = Array.isArray(req.body.names) ? req.body.names.map(String) : [];
  if (!names.length) throw new Error('옮길 함수를 고르세요');
  let appJs = await project.readShared('js');
  const { layout, out } = await leafSources('html');
  const info = new Map(analyzeAppJs(appJs, layout, out).map((f) => [f.name, f]));
  const byRegion = {};
  for (const name of names) {
    const f = info.get(name);
    if (!f?.status.ok) throw new Error(`${name}: ${f ? f.status.why : '없는 함수'} — 옮기지 않았습니다`);
    const ex = extractFunction(appJs, name);
    appJs = ex.appJs;
    (byRegion[f.target] ||= []).push(ex.snippet);
  }
  // 옮긴 결과가 문법적으로 맞는지 확인한 뒤에 저장
  // app.js 는 영역 래퍼 없이 실행되므로 그대로 검사
  try {
    new vm.Script(appJs);
  } catch (e) {
    throw new Error(`옮긴 뒤 app.js 문법이 깨져 저장하지 않았습니다: ${e.message}`);
  }
  await autoSnapshot(`app.js 나누기 전: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 외 ${names.length - 5}개` : ''}`);
  for (const [id, snippets] of Object.entries(byRegion)) {
    const cur0 = (await project.readRegion(id)).js;
    const next = `${cur0.trimEnd()}${cur0.trim() ? '\n\n' : ''}${snippets.join('\n')}`;
    const err = jsSyntaxError(next);
    if (err) throw new Error(`${id} 영역 script.js 문법 오류: ${err}`);
    await project.writeRegion(id, { js: next });
  }
  await project.writeShared('js', appJs);
  logger.event('appjs-move', { names, regions: Object.keys(byRegion) });
  res.json({ moved: names.length, regions: Object.keys(byRegion) });
}));

// ── AI PR 요약기 (상한선 초과 시 오래된 대화·세션 전달 기록을 PR 카드로 압축) ──
const chatMemory = () => new ChatMemoryStore(project);
async function aiSummarizePr(prNumber, older) {
  const transcript = older.map((it) => `[${it.session || 'chat'}${it.region ? '/' + it.region : ''}] (${it.kind}) ${String(it.text || '').slice(0, 220)}`).join('\n').slice(0, 8000);
  const prompt = `다음은 웹앱 개발 중 사용자·AI 대화 및 통합/영역/검증 세션 간 주고받은 작업 로그입니다.
나중에 개발을 이어갈 때 참고할 수 있도록 GitHub PR 요약 형식으로 압축하세요.
다른 설명 없이 아래 JSON만 출력하세요:
{"title": "PR #${prNumber} · 핵심 변경/결정 한 줄 제목 (35자 이내)", "changes": ["세션 간 전달·변경·결정 핵심 1", "핵심 2", "핵심 3"]}

# 원본 기록 (${older.length}건)
${transcript}`;
  let text = '';
  for await (const ev of runProvider(await getSettings(), {
    prompt,
    system: '당신은 개발 기록을 간결한 PR 요약(JSON)으로 압축하는 시니어 엔지니어입니다.',
  }, { purpose: 'describe' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(text.slice(s, e + 1));
  return null;
}

app.get('/api/chat/memory', wrap(async (req, res) => {
  res.json(await chatMemory().read());
}));

app.post('/api/chat/memory', wrap(async (req, res) => {
  const b = req.body || {};
  const result = await chatMemory().append({
    kind: b.kind || 'ok',
    session: b.session || 'chat',
    screen: b.screen || '',
    region: b.region || '',
    text: b.text || '',
    options: b.options,
  }, { summarizeFn: aiSummarizePr });
  res.json(result);
}));

app.post('/api/chat/memory/compact', wrap(async (req, res) => {
  const keepRecent = Number(req.body?.keepRecent ?? 4);
  const result = await chatMemory().compactNow({ keepRecent, summarizeFn: aiSummarizePr });
  res.json(result);
}));

app.get('/api/chat/memory/archive', wrap(async (req, res) => {
  const prId = String(req.query.pr || '').trim();
  const limit = Math.min(500, Number(req.query.limit) || 120);
  res.json({ prId, entries: await chatMemory().readArchive(prId, limit) });
}));

// ── 미리보기 하단 프롬프트 양방향 의사소통 (질문 응답 · AI가 의견 묻기 · 명확하면 즉시 실행 판정) ──
app.post('/api/chat/ask', wrap(async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) throw new Error('내용을 입력하세요');
  const screenId = String(req.body?.screenId || '').trim();
  const inspected = req.body?.inspected || null;
  const allowExecute = Boolean(req.body?.allowExecute);
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];

  const layout = await project.getLayout();
  const screens = getScreens(layout);
  const wf = await new WorkflowStore(project).read().catch(() => null);
  const prCtx = await chatMemory().buildPrContext(5);
  const screenSummary = screens.map((sc) => {
    const regs = flatten(sc).filter((e) => !isContainer(e.region)).map((e) => `${e.region.id}(${e.region.title || ''}${e.region.summary ? ': ' + e.region.summary.slice(0, 40) : ''})`);
    return `- 화면 ${sc.id} (${sc.title || sc.id}): ${regs.join(', ') || '영역 없음'}`;
  }).join('\n');

  const inspNote = inspected ? `\n현재 선택된 요소: 영역 ${inspected.region}, 선택자 ${inspected.selector}, 태그 <${inspected.tag}>` : '';
  const histNote = history.length ? `\n최근 대화:\n${history.map((h) => `${h.role === 'user' ? '사용자' : 'AI'}: ${String(h.text || '').slice(0, 220)}`).join('\n')}\n` : '';
  const modeRule = allowExecute
    ? `당신은 사용자와 일방적 명령이 아니라 **양방향 의사소통**을 하는 개발 파트너입니다. 사용자 메시지를 보고 아래 3가지 중 하나를 선택하세요:
1. "answer": 사용자가 질문·상담·상태 확인을 한 경우 → 답변 + 선택 가능한 진행방향 2~3개 제안.
2. "clarify": 수정/추가 요청이지만 방향이 모호하거나, 디자인·기능 선택지가 여러 갈래이거나, 여러 화면/데이터 구조에 큰 영향을 미쳐 **먼저 사용자 의견을 확인하는 것이 좋은 경우** → 바로 코드를 바꾸지 말고, 짧은 질문과 함께 선택 가능한 방향 2~3개(options)를 제안하세요.
3. "execute": 수정/배치 요청이 구체적이고 모호함이 없는 경우(또는 이전 대화에서 이미 방향이 합의된 경우) → 실행할 계획 한 줄(answer)과 함께 executeAction("edit" 또는 "layout"), executePrompt(구체화된 실행 지시)를 반환하세요.`
    : `사용자의 질문에 명확히 답하고, 클릭해서 바로 진행할 수 있는 다음 진행방향 2~3개(options)를 제안하세요. replyType은 "answer" 또는 "clarify"만 사용하세요.`;

  const prompt = `현재 작업 중인 웹앱 정보:
- 프로젝트 이름: ${layout.name || path.basename(project.root)}
- 현재 보고 있는 화면: ${screenId || screens[0]?.id || 'main'}${inspNote}
- 화면·영역 구성:
${screenSummary}
${wf?.workload ? `- 앱 요구사항 요약: ${wf.workload.trim().slice(0, 800)}` : ''}${prCtx}
${histNote}
사용자 입력:
${question}

${modeRule}

반드시 아래 JSON 형식만 출력하세요:
{
  "replyType": "answer | clarify | execute",
  "answer": "사용자에게 보여줄 친절한 한국어 응답 또는 의견 확인 질문 (2~5문장)",
  "executeAction": "edit | layout",
  "executePrompt": "replyType이 execute일 때 실행할 구체적 수정 지시",
  "options": [
    {
      "title": "선택지 짧은 제목 (18자 이내)",
      "desc": "이 방향을 선택하면 바뀌는 점 한 문장",
      "action": "edit | layout | verify | export | ask",
      "prompt": "클릭 시 바로 실행할 구체적 수정 지시 또는 후속 질문"
    }
  ]
}`;

  let text = '';
  for await (const ev of runProvider(await getSettings(), {
    prompt,
    system: '당신은 웹앱제작기의 양방향 AI 개발 파트너입니다. 모호한 요청은 먼저 의견을 묻고(clarify), 질문에는 답하며(answer), 명확한 수정은 실행(execute)하는 JSON만 출력합니다.',
  }, { purpose: 'chat-ask' })) {
    if (ev.type === 'final') text = ev.text;
  }

  let parsed = null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  const rawType = String(parsed?.replyType || 'answer');
  const replyType = allowExecute && rawType === 'execute' ? 'execute' : rawType === 'clarify' ? 'clarify' : 'answer';
  const answer = String(parsed?.answer || text || '답변을 생성하지 못했습니다.').trim();
  const executeAction = parsed?.executeAction === 'layout' ? 'layout' : 'edit';
  const executePrompt = String(parsed?.executePrompt || question).trim();
  const validActions = new Set(['edit', 'layout', 'verify', 'export', 'ask']);
  const options = Array.isArray(parsed?.options)
    ? parsed.options.slice(0, 4).filter((o) => o && o.title).map((o) => ({
        title: String(o.title).slice(0, 40),
        desc: String(o.desc || '').slice(0, 120),
        action: validActions.has(o.action) ? o.action : 'edit',
        prompt: String(o.prompt || o.title).slice(0, 400),
      }))
    : [];

  // 대화 기록을 프로젝트 영구 메모리에 저장 (상한선 초과 시 자동 PR 요약 + 원본 로그 아카이브)
  await chatMemory().append({ kind: 'user', session: 'chat', screen: screenId, text: `💬 ${question}` }, { summarizeFn: aiSummarizePr }).catch(() => {});
  const saved = await chatMemory().append({
    kind: 'ai',
    session: 'chat',
    screen: screenId,
    text: answer,
    replyType,
    options: replyType === 'execute' ? [] : options,
  }, { summarizeFn: aiSummarizePr }).catch(() => null);
  res.json({ replyType, answer, executeAction, executePrompt, options, memory: saved?.state || null, compactedPr: saved?.compactedPr || null });
}));

// ── 동작 테스트 및 앱 통합 검증 ──
const TEST_ACTIONS = ['navigate', 'click', 'type', 'wait', 'expectText', 'expectValue', 'expectVisible', 'expectCount'];
const sanitizeTests = (raw) =>
  (Array.isArray(raw) ? raw : []).map((t) => ({
    name: String(t?.name || '테스트').slice(0, 80),
    steps: (Array.isArray(t?.steps) ? t.steps : [])
      .filter((s) => TEST_ACTIONS.includes(s?.action))
      .map((s) => ({ action: s.action, selector: String(s.selector || ''), value: String(s.value ?? '') })),
  })).filter((t) => t.steps.length);

app.get('/api/tests', wrap(async (req, res) => res.json({ tests: await project.readTests() })));
app.put('/api/tests', wrap(async (req, res) => {
  const list = (Array.isArray(req.body.tests) ? req.body.tests : []).map((t) => ({
    name: String(t.name || '테스트').slice(0, 80),
    steps: (Array.isArray(t.steps) ? t.steps : []).filter((s) => TEST_ACTIONS.includes(s.action)).map((s) => ({ action: s.action, selector: String(s.selector || ''), value: String(s.value ?? '') })),
  }));
  await project.writeTests(list);
  res.json({ tests: list });
}));

// AI 없이 HTML 구조 분석으로 기본 스모크 테스트 자동 생성
app.post('/api/tests/auto', wrap(async (req, res) => {
  const generated = await generateAutoTests(project);
  const existing = req.body?.append ? await project.readTests() : [];
  const names = new Set(existing.map((t) => t.name));
  const merged = [...existing, ...generated.filter((t) => !names.has(t.name))];
  await project.writeTests(merged);
  logger.event('tests-auto', { count: merged.length });
  res.json({ tests: merged, added: merged.length - existing.length });
}));

// AI 로 앱의 실제 HTML/JS + 요구사항을 분석해 동작 테스트 시나리오 생성 (depth: 'deep' | 'quick')
app.post('/api/tests/generate', wrap(async (req, res) => {
  const depth = req.body?.depth === 'quick' ? 'quick' : 'deep';
  const layout = await project.getLayout();
  const screens = getScreens(layout);
  const multiScreen = Array.isArray(layout.screens) && layout.screens.length > 1;
  const wf = await new WorkflowStore(project).read().catch(() => null);
  const workloadNote = wf?.workload?.trim()
    ? `\n# 앱 요구사항 요약\n${wf.workload.trim().slice(0, 1800)}\n`
    : '';
  const regions = [];
  for (const sc of screens) {
    for (const { region } of flatten(sc)) {
      if (region.regions?.length) continue;
      const f = await project.readRegion(region.id);
      if (!f.html.trim()) continue;
      const scrTag = multiScreen ? ` [화면: ${sc.id} / ${sc.title || sc.id}]` : '';
      regions.push(`## 영역 ${region.id} (${region.title || ''})${scrTag}\n\`\`\`html\n${f.html.slice(0, 2500)}\n\`\`\`\n\`\`\`js\n${f.js.slice(0, 2000)}\n\`\`\``);
    }
  }
  if (!regions.length) throw new Error('아직 구현된 영역 마크업이 없습니다');
  const screenGuide = multiScreen
    ? `\n다중 화면 앱입니다. 화면 목록: ${screens.map((s) => `${s.id}(${s.title || s.id})`).join(', ')}. 기본 시작 화면은 "${screens[0].id}"입니다.\n다른 화면의 요소를 검증할 때는 반드시 먼저 {"action": "navigate", "selector": "", "value": "화면ID"} 단계를 넣으세요.`
    : '';
  const targetCount = depth === 'deep'
    ? (multiScreen ? `${Math.min(10, Math.max(6, screens.length + 2))}~10개` : '6~8개')
    : '2~4개';
  const depthGuide = depth === 'deep'
    ? `\n심층 시나리오 작성 기준:
- 단순 렌더링 확인만 하지 말고, 실제 사용자 흐름(입력 → 버튼 클릭 → 결과 텍스트/목록/상태 변화 확인)을 끝까지 검증하세요.
- ${multiScreen ? '모든 주요 화면마다 최소 1개 이상 시나리오를 포함하세요.' : '핵심 기능마다 정상 흐름과 예외(빈 입력/잘못된 값) 흐름을 모두 포함하세요.'}
- 각 시나리오는 3~6단계로 구체적으로 작성하세요.`
    : '';
  const prompt = `다음 웹앱의 요구사항과 각 영역 HTML·JS 를 보고, 핵심 사용자 동작을 검증하는 시나리오 테스트 ${targetCount}를 JSON 배열로 작성하세요.${workloadNote}
반드시 HTML 에 실제로 존재하는 CSS 선택자(#id, .class, [data-...], section[data-region="..."] 등)만 사용하세요.
중요 규칙:
- HTML 에 \`hidden\` 속성이나 \`display:none\` 으로 처음부터 숨겨진 요소(닫힌 모달, 조건부 타이머, 오류 배너 등)에는 사전 동작(클릭·입력) 없이 \`expectVisible\` 을 걸지 마세요.
- 화면에 즉시 표시되는 요소이거나, 앞선 \`click\`/\`type\` 동작으로 표시되는 요소만 \`expectVisible\` 로 검증하세요.${screenGuide}${depthGuide}

사용 가능한 action:
- "navigate": 다중 화면 앱에서 value 에 적힌 화면 ID 로 이동 (selector: "", value: "화면ID")
- "click": selector 클릭 (value: "")
- "type": selector 입력칸에 value 입력
- "wait": value 밀리초 대기 (예: "200")
- "expectVisible": selector 요소가 화면에 보이는지 확인 (value: "")
- "expectText": selector 요소에 value 텍스트가 포함되는지 확인
- "expectValue": selector 입력칸의 값이 value 인지 확인
- "expectCount": selector 요소의 개수가 value 개 인지 확인

${regions.join('\n\n')}

다른 설명 없이 JSON 배열만 출력하세요:
[{"name": "시나리오 이름", "steps": [{"action": "click", "selector": "#btn", "value": ""}, {"action": "expectVisible", "selector": "#modal", "value": ""}]}]`;

  let text = '';
  for await (const ev of runProvider(await getSettings(), { prompt, system: '당신은 웹앱 QA 엔지니어입니다. 실제 DOM 선택자만 사용해 정확한 JSON 배열만 출력합니다.' }, { purpose: 'tests-gen' })) {
    if (ev.type === 'final') text = ev.text;
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI 응답에서 테스트 JSON 배열을 찾지 못했습니다');
  const generated = sanitizeTests(JSON.parse(text.slice(start, end + 1)));
  if (!generated.length) throw new Error('유효한 테스트 단계가 생성되지 않았습니다');
  await project.writeTests(generated);
  logger.event('tests-ai-generated', { depth, count: generated.length });
  res.json({ tests: generated, depth });
}));

app.post('/api/verify', wrap(async (req, res) => {
  const report = await verifyProject(project, { runBrowser: req.body?.runBrowser !== false });
  await attachFieldErrors(report);
  logger.event('verify', { ok: report.ok, syntaxErrors: report.syntaxErrors.length, connectionIssues: report.connectionIssues.length, runtimeErrors: report.browser?.runtimeErrors?.length || 0 });
  const tests = report.browser?.testResults || [];
  const passed = tests.filter((t) => t.ok).length;
  await sessionStore().append('verify', {
    role: 'verify',
    status: report.ok ? 'ok' : 'error',
    summary: report.ok
      ? `통합 검증 통과 (테스트 ${passed}/${tests.length}, 오류 0건)`
      : `검증 문제 발견 (문법 ${report.syntaxErrors.length}, 연결 ${report.connectionIssues.length}, 런타임 ${report.browser?.runtimeErrors?.length || 0}, 테스트 ${passed}/${tests.length})`,
  }).catch(() => {});
  res.json(report);
}));

// ── 검토 대기 중인 AI 결과: 보기 / 적용 / 버리기 ──
app.get('/api/regions/:id/pending', wrap(async (req, res) => res.json({ pending: await project.readPending(req.params.id) })));

app.post('/api/regions/:id/pending/apply', wrap(async (req, res) => {
  const id = req.params.id;
  const p = await project.readPending(id);
  if (!p) throw new Error('검토 중인 변경이 없습니다');
  const saved = await project.readRegion(id);
  const changed = ['html', 'css', 'js'].filter((k) => p.files[k] !== saved[k]);
  await project.writeRegion(id, Object.fromEntries(changed.map((k) => [k, p.files[k]])));
  await project.clearPending(id);
  logger.event('ai-saved', { region: id, files: changed, reviewed: true });
  await project.markFieldErrorsFixed(id).catch(() => {});
  res.json({ files: await project.readRegion(id) });
}));

app.post('/api/regions/:id/pending/discard', wrap(async (req, res) => {
  await project.clearPending(req.params.id);
  logger.event('ai-discarded', { region: req.params.id });
  res.json({ ok: true });
}));

// ── 공통 파일 (css: global.css, js: app.js, head: head.html) ──
app.get('/api/shared/:key', wrap(async (req, res) => res.json({ text: await project.readShared(req.params.key) })));
app.put('/api/shared/:key', wrap(async (req, res) => {
  await project.writeShared(req.params.key, String(req.body.text ?? ''));
  res.json({ ok: true });
}));

// ── 프로젝트 파일 변경 실시간 감지 (SSE — 외부 에이전트가 코드 수정 시 미리보기 자동 새로고침) ──
app.get('/api/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'ready', project: path.basename(project.root) })}\n\n`);
  const rootDir = project.root;
  let timer = null;
  let lastFile = '';
  let watcher = null;
  const ignore = (f) => !f || /(^|[\\/])(\.history|\.history-layout|\.snapshots|\.trash|\.pending|\.sessions|\.chat-memory\.json|dist|logs)|\.tmp$/i.test(f);
  try {
    watcher = fsWatch(rootDir, { recursive: true }, (_ev, filename) => {
      const f = String(filename || '').replace(/\\/g, '/');
      if (ignore(f)) return;
      lastFile = f;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { res.write(`data: ${JSON.stringify({ type: 'change', file: lastFile, ts: Date.now() })}\n\n`); } catch {}
      }, 250);
    });
  } catch {}
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearTimeout(timer);
    clearInterval(ping);
    try { watcher?.close(); } catch {}
  });
});

// ── 미리보기 / 내보내기 ──
// ?project=<이름> 면 해당 프로젝트를 바로 미리보기 (현재 열린 프로젝트는 그대로 유지)
// ?candidate=<영역ID> 면 그 영역의 검토 대기 결과를 넣어서 (저장하지 않고) 미리보기
app.get('/preview', wrap(async (req, res) => {
  const targetName = String(req.query.project || '').trim();
  let targetProject = project;
  if (targetName && targetName !== path.basename(project.root)) {
    if (!(await listProjects()).includes(targetName)) throw new Error('없는 프로젝트입니다');
    targetProject = new Project(projectPath(targetName));
  }
  const overrides = {};
  const cand = String(req.query.candidate || '');
  if (cand) {
    const p = await targetProject.readPending(cand);
    if (p) overrides[cand] = p.files;
  }
  // ?test=<번호> 면 그 동작 테스트를 페이지 안에서 실행하는 스크립트를 넣는다
  let inject = '';
  if (req.query.test !== undefined) {
    const i = Number(req.query.test);
    const tests = await targetProject.readTests();
    if (tests[i]) inject = testRunnerScript(tests[i], i);
  }
  // ?only=<영역>&w=&h= 면 그 영역만 보이게 (화면 찍기용)
  if (req.query.only) inject += onlyRegionStyle(String(req.query.only), Number(req.query.w) || 800, Number(req.query.h) || 600);
  res.type('html').send(await buildApp(targetProject, { preview: true, overrides, inject }));
}));

// 로컬 단독 실행 호환성 사전 점검 (내보내기 모달용)
app.get('/api/export/check', wrap(async (req, res) => {
  res.json(await checkLocalCompatibility(project));
}));

// 내보낸 HTML 파일 브라우저 직접 다운로드
app.get('/api/export/download', wrap(async (req, res) => {
  const rawFile = path.basename(String(req.query.file || 'index.html'));
  const file = /\.html?$/i.test(rawFile) ? rawFile : 'index.html';
  const reqDir = String(req.query.dir || '').trim();
  const baseDir = reqDir && isAllowedExportDir(reqDir) ? path.resolve(reqDir) : (lastExportDir || path.join(project.root, 'dist'));
  const full = path.join(baseDir, file);
  const html = await fs.readFile(full, 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file)}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.send(html);
}));

// Electron Windows 단일 .exe 빌드 실행 (outputDir/electron → outputDir/electron-dist/*.exe)
app.post('/api/export/electron/build-exe', wrap(async (req, res) => {
  const baseDir = resolveExportDir(req.body?.outputDir || lastExportDir);
  lastExportDir = baseDir;
  const electronDir = path.join(baseDir, 'electron');
  const exists = await fs.access(path.join(electronDir, 'package.json')).then(() => true).catch(() => false);
  if (!exists) throw new Error('먼저 Electron 앱 패키지를 내보내세요');
  const built = await buildElectronExe(electronDir);
  logger.event('export-electron-exe', { exe: built.exeName, bytes: built.bytes, outDir: built.outDir });
  res.json({ ...built, outputDir: baseDir, downloadUrl: `/api/export/electron/download-exe?dir=${encodeURIComponent(baseDir)}` });
}));

// 빌드된 Windows .exe 직접 다운로드
app.get('/api/export/electron/download-exe', wrap(async (req, res) => {
  const reqDir = String(req.query.dir || '').trim();
  const baseDir = reqDir && isAllowedExportDir(reqDir) ? path.resolve(reqDir) : (lastExportDir || path.join(project.root, 'dist'));
  const outDir = path.join(baseDir, 'electron-dist');
  const entries = await fs.readdir(outDir).catch(() => []);
  const exe = entries.find((f) => /\.exe$/i.test(f));
  if (!exe) throw new Error('빌드된 .exe 파일이 없습니다');
  const full = path.join(outDir, exe);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exe)}"; filename*=UTF-8''${encodeURIComponent(exe)}`);
  res.send(await fs.readFile(full));
}));

// offline: true 면 CDN 라이브러리·폰트까지 내려받아 파일 하나에 넣는다 (인터넷 없이 열리게)
// mode: 'electron' 이면 <outputDir>/electron/ 데스크톱 앱 패키지 생성 (offline 함께 지정 가능)
app.post('/api/export', wrap(async (req, res) => {
  const dist = resolveExportDir(req.body?.outputDir);
  lastExportDir = dist;
  await fs.mkdir(dist, { recursive: true });
  const localCompatibility = await checkLocalCompatibility(project);
  const layout = await project.getLayout();
  let html = await buildApp(project);

  const customBase = String(req.body?.fileName || '').trim();

  if (req.body?.mode === 'electron' || req.body?.electron) {
    let report = null;
    if (req.body?.offline !== false) {
      const off = await makeOffline(html);
      html = off.html;
      report = off.report;
    }
    const el = await exportElectronProject({
      distDir: dist,
      projectName: path.basename(project.root),
      productName: layout.name || path.basename(project.root),
      fileName: customBase || layout.name || path.basename(project.root),
      html,
    });
    logger.event('export-electron', { bytes: el.bytes, offline: req.body?.offline !== false, outputDir: dist, fileName: customBase });
    return res.json({
      mode: 'electron',
      outputDir: dist,
      path: el.electronDir,
      file: 'electron/',
      files: el.files,
      bytes: el.bytes,
      exeOutDir: el.exeOutDir,
      report,
      localCompatibility,
    });
  }

  if (!req.body?.offline) {
    const file = customBase ? `${sanitizeExportBase(customBase, 'index')}.html` : 'index.html';
    const out = path.join(dist, file);
    await fs.writeFile(out, html, 'utf8');
    return res.json({ mode: 'online', outputDir: dist, path: out, file, downloadUrl: `/api/export/download?file=${encodeURIComponent(file)}&dir=${encodeURIComponent(dist)}`, bytes: Buffer.byteLength(html), localCompatibility });
  }
  const { html: offline, report } = await makeOffline(html);
  const file = customBase ? `${sanitizeExportBase(customBase, 'index-offline')}.html` : 'index-offline.html';
  const out = path.join(dist, file);
  await fs.writeFile(out, offline, 'utf8');
  logger.event('export-offline', { bytes: Buffer.byteLength(offline), downloaded: report.downloaded.length, failed: report.failed, outputDir: dist, file });
  res.json({ mode: 'offline', outputDir: dist, path: out, file, downloadUrl: `/api/export/download?file=${encodeURIComponent(file)}&dir=${encodeURIComponent(dist)}`, bytes: Buffer.byteLength(offline), report, localCompatibility });
}));

// 단일 인스턴스 보장: 같은 포트에서 2개 이상 동시 실행 방지
const LOCK_PATH = path.join(here, `.webapp-ide-${PORT}.pid`);
async function acquireSingleInstanceLock() {
  try {
    const oldPid = Number((await fs.readFile(LOCK_PATH, 'utf8')).trim());
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.error(`이미 웹앱제작기가 실행 중입니다 (PID ${oldPid}, http://localhost:${PORT}). 2개 이상 동시 실행할 수 없습니다.`);
        process.exit(1);
      } catch {
        // 이전 프로세스가 이미 종료된 고아 잠금 파일
      }
    }
  } catch {}
  await fs.writeFile(LOCK_PATH, String(process.pid), 'utf8').catch(() => {});
  const cleanup = () => { fs.unlink(LOCK_PATH).catch(() => {}); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
await acquireSingleInstanceLock();

// 이 컴퓨터에서만 접속되게 루프백 주소에만 연다 (같은 네트워크의 다른 PC 에서 IDE·API 키를 쓰지 못하게).
// 꼭 다른 기기에서 열어야 하면 --host 0.0.0.0 으로 실행
const hostArg = process.argv.indexOf('--host');
const HOSTS = hostArg > 0 ? [process.argv[hostArg + 1]] : ['127.0.0.1', '::1'];
for (const [i, host] of HOSTS.entries()) {
  const server = app.listen(PORT, host, () => {
    if (i === 0) {
      console.log(`웹앱제작기: http://localhost:${PORT}  (접속 허용: ${HOSTS.join(', ')})`);
      console.log(`프로젝트 폴더: ${project.root}`);
    }
  });
  server.on('error', (err) => {
    if (host === '::1' && err.code === 'EADDRNOTAVAIL') return; // IPv6 가 없는 PC
    if (err.code === 'EADDRINUSE') {
      console.error(`이미 웹앱제작기가 실행 중입니다 (http://localhost:${PORT}). 2개 이상 동시 실행할 수 없습니다.`);
      process.exit(1);
    }
    console.error(`[${host}:${PORT}] ${err.message}`);
    if (i === 0) process.exit(1);
  });
}
