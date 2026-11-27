// 3대 세션 저장소:
//  - 통합 개발 세션: integrated
//  - 검증 세션: verify
//  - 레이아웃 영역별 세션 (다중 지원): region:<영역ID> 또는 region:<영역ID>:<세션ID>
// 각 세션의 대화·실행 기록을 프로젝트 폴더(.sessions/<file>.json)에 독립적으로 저장한다.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 60;
const KEY_RE = /^(integrated|verify|region:[a-z][a-z0-9-]{0,39}(?::[a-z0-9-]{1,24})?)$/;

export function normalizeSessionKey(key) {
  const k = String(key || '').trim();
  if (!KEY_RE.test(k)) throw new Error(`잘못된 세션 키입니다: ${k}`);
  return k;
}

export function parseRegionSessionKey(key) {
  const k = normalizeSessionKey(key);
  if (!k.startsWith('region:')) return null;
  const parts = k.split(':');
  return { regionId: parts[1], subId: parts[2] || '' };
}

function fileNameOf(key) {
  return `${key.replaceAll(':', '__')}.json`;
}

export class SessionStore {
  constructor(project) {
    this.project = project;
    this.dir = path.join(project.root, '.sessions');
  }

  filePath(key) {
    return path.join(this.dir, fileNameOf(normalizeSessionKey(key)));
  }

  async read(key) {
    const k = normalizeSessionKey(key);
    try {
      const data = JSON.parse(await fs.readFile(this.filePath(k), 'utf8'));
      return {
        key: k,
        title: data.title || '',
        regionId: data.regionId || parseRegionSessionKey(k)?.regionId || null,
        updatedAt: data.updatedAt || null,
        entries: Array.isArray(data.entries) ? data.entries : [],
      };
    } catch {
      return {
        key: k,
        title: '',
        regionId: parseRegionSessionKey(k)?.regionId || null,
        updatedAt: null,
        entries: [],
      };
    }
  }

  async createRegionSession(regionId, title = '') {
    const base = normalizeSessionKey(`region:${regionId}`);
    const sub = `s${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    const key = normalizeSessionKey(`${base}:${sub}`);
    const now = new Date().toISOString();
    const data = {
      key,
      regionId,
      title: String(title || '').trim().slice(0, 40) || '새 작업 세션',
      updatedAt: now,
      entries: [],
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(key), JSON.stringify(data, null, 2) + '\n', 'utf8');
    return data;
  }

  async append(key, entry) {
    const k = normalizeSessionKey(key);
    const cur = await this.read(k);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      role: entry.role || 'system',
      status: entry.status || 'ok',
      summary: String(entry.summary || '').slice(0, 600),
      detail: entry.detail ? String(entry.detail).slice(0, 2000) : undefined,
      meta: entry.meta || undefined,
    };
    const entries = [...cur.entries, item].slice(-MAX_ENTRIES);
    const next = {
      key: k,
      title: cur.title || entry.title || '',
      regionId: cur.regionId || parseRegionSessionKey(k)?.regionId || null,
      updatedAt: item.ts,
      entries,
    };
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(k), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return item;
  }

  async clear(key) {
    const k = normalizeSessionKey(key);
    const cur = await this.read(k);
    const next = { ...cur, updatedAt: null, entries: [] };
    if (parseRegionSessionKey(k)?.subId) {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.filePath(k), JSON.stringify(next, null, 2) + '\n', 'utf8');
    } else {
      await fs.rm(this.filePath(k), { force: true });
    }
    return next;
  }

  async remove(key) {
    const k = normalizeSessionKey(key);
    if (!parseRegionSessionKey(k)?.subId) {
      throw new Error('기본 영역 세션은 삭제할 수 없습니다 (초기화만 가능)');
    }
    await fs.rm(this.filePath(k), { force: true });
    return { ok: true, key: k };
  }

  async listKeys(regionIds = []) {
    const set = new Set(['integrated', 'verify', ...regionIds.map((id) => `region:${id}`)]);
    try {
      for (const f of await fs.readdir(this.dir)) {
        if (!f.endsWith('.json')) continue;
        const k = f.slice(0, -5).replaceAll('__', ':');
        if (!KEY_RE.test(k)) continue;
        const parsed = parseRegionSessionKey(k);
        if (!parsed || regionIds.includes(parsed.regionId)) set.add(k);
      }
    } catch {}
    return [...set];
  }

  async summary(regionIds = []) {
    const keys = await this.listKeys(regionIds);
    const out = {};
    for (const k of keys) {
      const s = await this.read(k);
      out[k] = {
        key: k,
        title: s.title || '',
        regionId: s.regionId,
        isExtra: Boolean(parseRegionSessionKey(k)?.subId),
        count: s.entries.length,
        updatedAt: s.updatedAt,
        last: s.entries.at(-1) || null,
      };
    }
    return out;
  }
}
