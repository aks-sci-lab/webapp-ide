// 프로젝트 전체 스냅샷: layout.json + 모든 영역 파일 + 공통 파일 + 프로젝트 프롬프트를 통째로 저장하고 되돌린다.
// 계획 실행·분할·합치기·배치 변경처럼 여러 파일을 한꺼번에 바꾸는 작업 전에 자동으로 만든다.
//   projects/<이름>/.snapshots/<시각>/{meta.json, layout.json, regions/<id>/..., shared/...}
import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_AUTO = 40; // 자동 스냅샷은 최근 것만 남긴다 (직접 만든 것은 지우지 않음)
const SKIP = new Set(['.history', '.trash', '.snapshots', '.history-layout', '.pending', 'dist', 'logs']);
const ROOT_FILES = ['layout.json', 'project-prompt.md', 'project-plan.json', 'tests.json', 'decisions.md', 'skills.json', 'field-errors.json'];

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(a, b);
    else await fs.copyFile(a, b);
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class Snapshots {
  constructor(project) {
    this.project = project;
    this.dir = path.join(project.root, '.snapshots');
  }

  async create(label, { auto = false } = {}) {
    const id = stamp();
    const dest = path.join(this.dir, id);
    await fs.mkdir(dest, { recursive: true });
    for (const f of ROOT_FILES) {
      const p = path.join(this.project.root, f);
      if (await exists(p)) await fs.copyFile(p, path.join(dest, f));
    }
    for (const sub of ['regions', 'shared']) {
      const p = path.join(this.project.root, sub);
      if (await exists(p)) await copyDir(p, path.join(dest, sub));
    }
    const layout = await this.project.getLayout();
    const meta = { id, label: String(label || '').slice(0, 120) || '직접 저장', auto, createdAt: new Date().toISOString(), regions: (await fs.readdir(path.join(dest, 'regions')).catch(() => [])).length, mode: layout.mode };
    await fs.writeFile(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    this.project.emit({ kind: 'snapshot', id, label: meta.label, auto });
    if (auto) await this.prune();
    return meta;
  }

  async list() {
    const out = [];
    for (const id of (await fs.readdir(this.dir).catch(() => [])).sort().reverse()) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(this.dir, id, 'meta.json'), 'utf8')));
      } catch {}
    }
    return out;
  }

  // 되돌리기: 지금 상태도 먼저 스냅샷으로 남긴 뒤 통째로 바꾼다. 지금은 있고 스냅샷엔 없는 영역은 .trash 로
  async restore(id) {
    if (!/^[\d-]+$/.test(id)) throw new Error('잘못된 스냅샷');
    const src = path.join(this.dir, id);
    if (!(await exists(path.join(src, 'meta.json')))) throw new Error('없는 스냅샷입니다');
    const meta = JSON.parse(await fs.readFile(path.join(src, 'meta.json'), 'utf8'));
    const before = await this.create(`되돌리기 전 자동 저장 (→ ${meta.label})`, { auto: true });
    const root = this.project.root;

    const snapRegions = new Set(await fs.readdir(path.join(src, 'regions')).catch(() => []));
    for (const id2 of await fs.readdir(path.join(root, 'regions')).catch(() => [])) {
      if (!id2.startsWith('.') && !snapRegions.has(id2)) await this.project.trashRegion(id2);
    }
    // 영역 폴더의 파일만 교체 (.history 백업은 보존)
    for (const rid of snapRegions) {
      const to = path.join(root, 'regions', rid);
      await fs.mkdir(to, { recursive: true });
      for (const e of await fs.readdir(to, { withFileTypes: true })) {
        if (e.isFile()) await fs.rm(path.join(to, e.name));
      }
      await copyDir(path.join(src, 'regions', rid), to);
    }
    if (await exists(path.join(src, 'shared'))) {
      for (const e of await fs.readdir(path.join(src, 'shared'), { withFileTypes: true })) {
        if (e.isFile()) await fs.copyFile(path.join(src, 'shared', e.name), path.join(root, 'shared', e.name));
      }
    }
    for (const f of ROOT_FILES) {
      const p = path.join(src, f);
      if (await exists(p)) await fs.copyFile(p, path.join(root, f));
      else if (f !== 'layout.json') await fs.rm(path.join(root, f), { force: true });
    }
    this.project.emit({ kind: 'snapshot-restore', id, label: meta.label, savedBefore: before.id });
    return { restored: meta, savedBefore: before };
  }

  async remove(id) {
    if (!/^[\d-]+$/.test(id)) throw new Error('잘못된 스냅샷');
    await fs.rm(path.join(this.dir, id), { recursive: true, force: true });
  }

  async prune() {
    const autos = (await this.list()).filter((m) => m.auto);
    for (const m of autos.slice(KEEP_AUTO)) await this.remove(m.id);
  }
}
