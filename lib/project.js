// 프로젝트 저장소: layout.json + 영역별 폴더(regions/<id>/...)
import fs from 'node:fs/promises';
import path from 'node:path';
import { flatten, find } from '../public/tree.js';
import { lineDelta } from './logger.js';

export const FILES = {
  html: 'view.html',
  css: 'style.css',
  js: 'script.js',
  prompt: 'prompt.md',
};

// 이 폴더를 Claude Code 등으로 직접 고칠 때 참고하는 규칙
const PROJECT_GUIDE = `# 프로젝트 구조

- layout.json : 그리드 크기와 영역 목록 (id, title, x, y, w, h — 0부터 시작하는 칸 좌표)
  - mode 가 "flow" 이면 가져온 앱: 영역을 y 순서대로 원래 문서 흐름 그대로 이어 붙인다
- shared/global.css : 모든 영역 공통 스타일 (스코프 없음)
- shared/head.html : <head> 에 들어가는 CDN 라이브러리·폰트 링크
- shared/app.js : 영역 마크업 뒤에 실행되는 전역 스크립트 (가져온 앱의 기존 로직)
- regions/<id>/ : 영역 하나 = 폴더 하나
  - prompt.md : 이 영역에 구현할 내용 (마지막 요청)
  - prompt-log.md : 지금까지의 요청 기록
  - view.html : 영역 내부 마크업 (html/head/body/script/style 태그 금지)
  - style.css : 빌드 시 @scope ([data-region="<id>"]) 로 감싸짐. 영역 자신은 :scope
  - script.js : 빌드 시 (function (root, app) { ... }) 로 감싸짐. DOM 은 root.querySelector 로만 접근
  - .history/ : 덮어쓰기 전 자동 백업
- dist/index.html : 내보내기 결과 (직접 수정하지 말 것)

## 영역 간 통신 (window.app)
app.emit(evt, data) / app.on(evt, fn) / app.set(key, v) / app.get(key) / app.on('state:' + key, fn)
이벤트명은 "영역ID:동작" 형식.
`;

// 모든 영역이 함께 쓰는 파일 (가져온 앱은 전역 CSS/JS/CDN 을 여기에 둔다)
export const SHARED = {
  css: 'global.css',
  js: 'app.js',
  head: 'head.html',
};

export const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PROJECT_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u;

// mode: 'grid' = 그리드 칸에 배치하는 새 앱, 'flow' = 원래 문서 흐름을 유지하는 가져온 앱
const DEFAULT_LAYOUT = {
  name: '내 웹앱',
  appPrompt: '',
  mode: 'grid',
  lang: 'ko',
  grid: { cols: 12, rows: 12, gap: 8, fill: true, rowHeight: 60 },
  regions: [],
};

export class Project {
  constructor(root) {
    this.root = root;
    this.regionsDir = path.join(root, 'regions');
    this.layoutPath = path.join(root, 'layout.json');
    this.onChange = null; // (event) => void — 변경 로그용 (서버가 연결)
  }

  emit(event) {
    try {
      this.onChange?.(event);
    } catch {}
  }

  async init(layout = {}) {
    await fs.mkdir(this.regionsDir, { recursive: true });
    await fs.mkdir(path.join(this.root, 'shared'), { recursive: true });
    if (!(await exists(this.layoutPath))) {
      await this.writeJson(this.layoutPath, { ...DEFAULT_LAYOUT, ...layout });
    }
    const globalCss = path.join(this.root, 'shared', SHARED.css);
    if (!(await exists(globalCss))) {
      await fs.writeFile(globalCss, '/* 모든 영역에 공통으로 적용되는 스타일 */\n', 'utf8');
    }
    for (const file of [SHARED.js, SHARED.head]) {
      const p = path.join(this.root, 'shared', file);
      if (!(await exists(p))) await fs.writeFile(p, '', 'utf8');
    }
    const guide = path.join(this.root, 'CLAUDE.md');
    if (!(await exists(guide))) await fs.writeFile(guide, PROJECT_GUIDE, 'utf8');
  }

  async getLayout() {
    const layout = JSON.parse(await fs.readFile(this.layoutPath, 'utf8'));
    return { ...DEFAULT_LAYOUT, ...layout, grid: { ...DEFAULT_LAYOUT.grid, ...layout.grid } };
  }

  // 레이아웃 저장. 새 영역은 폴더를 만들고, 빠진 영역은 .trash 로 옮긴다(삭제하지 않음).
  async saveLayout(layout) {
    const ids = new Set();
    for (const { region: r } of flatten(layout)) {
      if (!ID_RE.test(r.id)) throw new Error(`잘못된 영역 ID: ${r.id}`);
      if (ids.has(r.id)) throw new Error(`중복된 영역 ID: ${r.id}`);
      ids.add(r.id);
    }
    let before = null;
    try {
      before = JSON.parse(await fs.readFile(this.layoutPath, 'utf8'));
    } catch {}
    for (const id of ids) await this.ensureRegion(id);
    for (const dir of await fs.readdir(this.regionsDir)) {
      if (!dir.startsWith('.') && !ids.has(dir)) await this.trashRegion(dir);
    }
    await this.writeJson(this.layoutPath, layout);
    const change = layoutChange(before, layout);
    if (change) this.emit({ kind: 'layout', ...change });
    return layout;
  }

  regionDir(id) {
    if (!ID_RE.test(id)) throw new Error(`잘못된 영역 ID: ${id}`);
    return path.join(this.regionsDir, id);
  }

  async ensureRegion(id) {
    const dir = this.regionDir(id);
    await fs.mkdir(dir, { recursive: true });
    for (const file of Object.values(FILES)) {
      const p = path.join(dir, file);
      if (!(await exists(p))) await fs.writeFile(p, '', 'utf8');
    }
  }

  async trashRegion(id) {
    const trash = path.join(this.root, '.trash');
    await fs.mkdir(trash, { recursive: true });
    const to = `${id}-${stamp()}`;
    await fs.rename(path.join(this.regionsDir, id), path.join(trash, to));
    this.emit({ kind: 'region-trash', region: id, to: `.trash/${to}` });
  }

  async renameRegion(oldId, newId) {
    if (!ID_RE.test(newId)) throw new Error(`잘못된 영역 ID: ${newId}`);
    const layout = await this.getLayout();
    if (find(layout, newId)) throw new Error(`이미 있는 ID: ${newId}`);
    const region = find(layout, oldId)?.region;
    if (!region) throw new Error(`없는 영역: ${oldId}`);
    await fs.rename(this.regionDir(oldId), this.regionDir(newId));
    // 스크립트/스타일 안의 data-region 참조도 같이 바꾼다
    for (const key of ['html', 'css', 'js']) {
      const p = path.join(this.regionDir(newId), FILES[key]);
      const src = await fs.readFile(p, 'utf8');
      await fs.writeFile(p, retarget(src, oldId, newId), 'utf8');
    }
    region.id = newId;
    for (const { region: r } of flatten(layout)) {
      if (r.jsRoots) r.jsRoots = r.jsRoots.map((x) => (x === oldId ? newId : x));
    }
    await this.writeJson(this.layoutPath, layout);
    this.emit({ kind: 'region-rename', from: oldId, to: newId });
    return layout;
  }

  async readRegion(id) {
    await this.ensureRegion(id);
    const out = {};
    for (const [key, file] of Object.entries(FILES)) {
      out[key] = await fs.readFile(path.join(this.regionDir(id), file), 'utf8');
    }
    return out;
  }

  // 덮어쓰기 전 이전 버전을 .history/<시각>/ 에 백업
  async writeRegion(id, files, { backup = true } = {}) {
    await this.ensureRegion(id);
    const dir = this.regionDir(id);
    const keys = Object.keys(files).filter((k) => FILES[k]);
    let histRel = null;
    if (backup && keys.some((k) => k !== 'prompt')) {
      const version = stamp();
      const histDir = path.join(dir, '.history', version);
      await fs.mkdir(histDir, { recursive: true });
      for (const k of keys) {
        await fs.copyFile(path.join(dir, FILES[k]), path.join(histDir, FILES[k]));
      }
      histRel = `regions/${id}/.history/${version}`;
    }
    for (const k of keys) {
      const p = path.join(dir, FILES[k]);
      const before = await fs.readFile(p, 'utf8').catch(() => '');
      await fs.writeFile(p, files[k], 'utf8');
      if (before !== files[k]) {
        this.emit({ kind: 'region-file', region: id, file: FILES[k], bytes: [before.length, files[k].length], lines: lineDelta(before, files[k]), backup: histRel });
      }
    }
  }

  // ── 동작 테스트 (tests.json): [{ name, steps: [{ action, selector, value }] }] ──
  async readTests() {
    try {
      const list = JSON.parse(await fs.readFile(path.join(this.root, 'tests.json'), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async writeTests(list) {
    await this.writeJson(path.join(this.root, 'tests.json'), list);
    this.emit({ kind: 'tests', count: list.length });
  }

  // ── 검토 대기 중인 AI 결과 (regions/<id>/.pending/) — 적용하기 전까지 실제 파일은 그대로 ──
  pendingDir(id) {
    return path.join(this.regionDir(id), '.pending');
  }

  async readPending(id) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.pendingDir(id), 'meta.json'), 'utf8'));
      const files = {};
      for (const key of ['html', 'css', 'js']) files[key] = await fs.readFile(path.join(this.pendingDir(id), FILES[key]), 'utf8');
      return { files, meta };
    } catch {
      return null;
    }
  }

  async writePending(id, files, meta) {
    const dir = this.pendingDir(id);
    await fs.mkdir(dir, { recursive: true });
    for (const key of ['html', 'css', 'js']) await fs.writeFile(path.join(dir, FILES[key]), files[key] ?? '', 'utf8');
    await this.writeJson(path.join(dir, 'meta.json'), { ...meta, createdAt: new Date().toISOString() });
  }

  async clearPending(id) {
    await fs.rm(this.pendingDir(id), { recursive: true, force: true });
  }

  // ── 프로젝트 전체 프롬프트: 마지막 요청, 마지막 계획, 요청 기록 ──
  async readProjectPrompt() {
    const read = async (f, fallback) => {
      try {
        return await fs.readFile(path.join(this.root, f), 'utf8');
      } catch {
        return fallback;
      }
    };
    let plan = null;
    try {
      plan = JSON.parse(await read('project-plan.json', 'null'));
    } catch {}
    return { request: await read('project-prompt.md', ''), plan, log: await read('project-prompt-log.md', '') };
  }

  async writeProjectPrompt({ request, plan }) {
    if (typeof request === 'string') await fs.writeFile(path.join(this.root, 'project-prompt.md'), request, 'utf8');
    if (plan !== undefined) await this.writeJson(path.join(this.root, 'project-plan.json'), plan);
  }

  async appendProjectLog(text) {
    await fs.appendFile(path.join(this.root, 'project-prompt-log.md'), `\n## ${new Date().toLocaleString('ko-KR')}\n\n${text.trim()}\n`, 'utf8');
  }

  // ── 레이아웃 백업 (프로젝트 계획으로 배치를 바꾸기 전) ──
  get layoutHistoryDir() {
    return path.join(this.root, '.history-layout');
  }

  async backupLayout() {
    await fs.mkdir(this.layoutHistoryDir, { recursive: true });
    await fs.copyFile(this.layoutPath, path.join(this.layoutHistoryDir, `layout-${stamp()}.json`));
  }

  async listLayoutBackups() {
    try {
      return (await fs.readdir(this.layoutHistoryDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  // 가장 최근 백업으로 되돌리고 그 백업은 지운다 (여러 번 누르면 더 이전으로)
  async restoreLayoutBackup() {
    const list = await this.listLayoutBackups();
    if (!list.length) throw new Error('되돌릴 레이아웃 백업이 없습니다');
    const file = path.join(this.layoutHistoryDir, list.at(-1));
    const layout = JSON.parse(await fs.readFile(file, 'utf8'));
    this.emit({ kind: 'layout-undo', backup: `.history-layout/${list.at(-1)}` });
    await this.saveLayout(layout);
    await fs.rm(file);
    return layout;
  }

  // 공통 파일을 덮어쓰기 전 shared/.history/<시각>/ 에 백업
  async backupShared(key) {
    const version = stamp();
    const dir = path.join(this.root, 'shared', '.history', version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, SHARED[key]), await this.readShared(key), 'utf8');
    return `shared/.history/${version}`;
  }

  // 기능 설명 메모: { 블록해시: { name, desc } }
  async readFeatureNotes(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.regionDir(id), 'features.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  async writeFeatureNotes(id, notes) {
    await this.ensureRegion(id);
    await this.writeJson(path.join(this.regionDir(id), 'features.json'), notes);
  }

  async listHistory(id) {
    const histDir = path.join(this.regionDir(id), '.history');
    if (!(await exists(histDir))) return [];
    return (await fs.readdir(histDir)).sort().reverse();
  }

  async restoreHistory(id, version) {
    if (!/^[\d-]+$/.test(version)) throw new Error('잘못된 버전');
    const histDir = path.join(this.regionDir(id), '.history', version);
    const files = {};
    for (const [key, file] of Object.entries(FILES)) {
      const p = path.join(histDir, file);
      if (await exists(p)) files[key] = await fs.readFile(p, 'utf8');
    }
    this.emit({ kind: 'region-restore', region: id, version });
    await this.writeRegion(id, files);
  }

  async readShared(key = 'css') {
    if (!SHARED[key]) throw new Error(`없는 공통 파일: ${key}`);
    try {
      return await fs.readFile(path.join(this.root, 'shared', SHARED[key]), 'utf8');
    } catch {
      return '';
    }
  }

  // 공통 파일 저장. 내용이 바뀌면 이전 내용을 백업하고 변경을 기록한다
  async writeShared(key, text) {
    if (!SHARED[key]) throw new Error(`없는 공통 파일: ${key}`);
    const before = await this.readShared(key);
    if (before === text) return;
    const backup = before ? await this.backupShared(key) : null;
    await fs.writeFile(path.join(this.root, 'shared', SHARED[key]), text, 'utf8');
    this.emit({ kind: 'shared-file', file: `shared/${SHARED[key]}`, bytes: [before.length, text.length], lines: lineDelta(before, text), backup });
  }

  // 영역의 최근 요청들 (prompt-log.md 의 "## 시각" 단위): [{ when, text }] 오래된 것 → 최근
  async recentRequests(id, n) {
    let log = '';
    try {
      log = await fs.readFile(path.join(this.regionDir(id), 'prompt-log.md'), 'utf8');
    } catch {}
    return log
      .split(/^## /m)
      .slice(1)
      .map((chunk) => {
        const nl = chunk.indexOf('\n');
        return { when: chunk.slice(0, nl).trim(), text: chunk.slice(nl + 1).trim() };
      })
      .filter((e) => e.text)
      .slice(-n);
  }

  // 결정 메모: 사용자가 정한, 앱 전체에서 늘 지킬 규칙 (모든 AI 작업에 함께 보낸다)
  async readDecisions() {
    try {
      return await fs.readFile(path.join(this.root, 'decisions.md'), 'utf8');
    } catch {
      return '';
    }
  }

  async writeDecisions(text) {
    const before = await this.readDecisions();
    await fs.writeFile(path.join(this.root, 'decisions.md'), text, 'utf8');
    this.emit({ kind: 'decisions', lines: lineDelta(before, text) });
  }

  async appendLog(id, prompt) {
    const line = `\n## ${new Date().toLocaleString('ko-KR')}\n\n${prompt.trim()}\n`;
    await fs.appendFile(path.join(this.regionDir(id), 'prompt-log.md'), line, 'utf8');
  }

  async writeJson(p, data) {
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, p);
  }
}

// 레이아웃 변경 요약: 추가·삭제·이동한 영역, 그리드·모드 변경 (변경 없으면 null)
function layoutChange(before, after) {
  const pos = (l) => new Map(flatten(l || { regions: [] }).map(({ region: r }) => [r.id, `${r.x},${r.y},${r.w},${r.h}`]));
  const a = pos(before);
  const b = pos(after);
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const moved = [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)).map((id) => `${id}: ${a.get(id)} → ${b.get(id)}`);
  const grid = JSON.stringify(before?.grid) !== JSON.stringify(after.grid) ? { from: before?.grid, to: after.grid } : undefined;
  const mode = before?.mode !== after.mode ? `${before?.mode ?? '-'} → ${after.mode}` : undefined;
  const other = ['name', 'appPrompt'].filter((k) => before && before[k] !== after[k]);
  if (!added.length && !removed.length && !moved.length && !grid && !mode && !other.length) return null;
  return { added, removed, moved, grid, mode, changed: other.length ? other : undefined };
}

// 코드 안의 영역 참조(data-region="<id>", app.regions['<id>'])만 새 ID 로.
// id="<id>" 같은 일반 요소 id 는 영역 이름과 같아도 건드리지 않는다
export function retarget(src, oldId, newId) {
  const q = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src
    .replace(new RegExp(`(data-region\\s*=\\s*\\\\?["'])${q}(\\\\?["'])`, 'g'), `$1${newId}$2`)
    .replace(new RegExp(`(regions\\s*\\[\\s*["'])${q}(["']\\s*\\])`, 'g'), `$1${newId}$2`);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}
