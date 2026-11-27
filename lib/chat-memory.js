// 프로젝트별 AI 대화 + 세션 간 주고받은 작업 기록 영구 저장소 (PR 방식 자동 요약 + 원본 JSONL 아카이브)
// - 활성 대화/로그: projects/<name>/.chat-memory.json
// - 상한선 초과 시: 오래된 기록을 PR #N 요약 카드로 압축하고, 원본은 projects/<name>/logs/chat-archive.jsonl 에 보존
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LIMITS = {
  maxItems: 30,
  maxChars: 12000,
  keepRecent: 10,
};

// 이모지 중간이 잘려 생긴 깨진 유니코드(lone surrogate) 제거
export const cleanStr = (s, maxLen = 0) => {
  const raw = maxLen > 0 ? String(s || '').slice(0, maxLen) : String(s || '');
  return raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
};

function charsOf(items) {
  return items.reduce((sum, it) => sum + String(it.text || '').length + JSON.stringify(it.options || []).length, 0);
}

// AI 호출 없이도 즉시 동작하는 결정적 PR 요약 빌더 (AI 요약기 실패 시 폴백으로도 사용)
export function buildDeterministicPr(prNumber, older) {
  const sessions = [...new Set(older.map((x) => x.session).filter(Boolean))];
  const regions = [...new Set(older.map((x) => x.region).filter(Boolean))];
  const screens = [...new Set(older.map((x) => x.screen).filter(Boolean))];
  const userMsgs = older.filter((x) => x.kind === 'user' || x.kind === 'run').map((x) => String(x.text || '').replace(/^[💬▶]\s*(\[[^\]]+\]\s*)?/, '').trim()).filter(Boolean);
  const outcomes = older.filter((x) => x.kind === 'ok' || x.kind === 'ai' || x.kind === 'handoff').map((x) => String(x.text || '').split('\n')[0].trim()).filter(Boolean);
  const errors = older.filter((x) => x.kind === 'err').map((x) => String(x.text || '').trim()).filter(Boolean);

  const firstTopic = cleanStr(userMsgs[0] || outcomes[0] || '개발 작업 및 대화', 48);
  const title = `PR #${prNumber} · ${firstTopic}${firstTopic.length >= 48 ? '…' : ''}`;

  const changes = [];
  if (userMsgs.length) changes.push(`요청/질문(${userMsgs.length}건): ${userMsgs.slice(0, 3).map((s) => cleanStr(s, 60)).join(' / ')}`);
  if (outcomes.length) changes.push(`진행/결과(${outcomes.length}건): ${outcomes.slice(-3).map((s) => cleanStr(s, 70)).join(' / ')}`);
  if (errors.length) changes.push(`발생 이슈(${errors.length}건): ${errors.slice(-2).map((s) => cleanStr(s, 60)).join(' / ')}`);
  if (!changes.length) changes.push(`${older.length}건의 작업 기록을 요약 아카이브했습니다.`);

  return {
    id: `PR #${prNumber}`,
    number: prNumber,
    ts: new Date().toISOString(),
    title,
    sessions,
    regions,
    screens,
    changes,
    itemCount: older.length,
    fromTs: older[0]?.ts || '',
    toTs: older[older.length - 1]?.ts || '',
    archiveFile: 'logs/chat-archive.jsonl',
  };
}

export class ChatMemoryStore {
  constructor(project, limits = DEFAULT_LIMITS) {
    this.project = project;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.file = path.join(project.root, '.chat-memory.json');
    this.archiveFile = path.join(project.root, 'logs', 'chat-archive.jsonl');
  }

  async read() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return {
        version: 1,
        nextPr: Number(raw.nextPr) || 1,
        limits: { ...this.limits, ...(raw.limits || {}) },
        prs: Array.isArray(raw.prs) ? raw.prs : [],
        items: Array.isArray(raw.items) ? raw.items : [],
      };
    } catch {
      return { version: 1, nextPr: 1, limits: { ...this.limits }, prs: [], items: [] };
    }
  }

  async save(data) {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.file);
    return data;
  }

  async archiveRaw(prId, older) {
    await fs.mkdir(path.dirname(this.archiveFile), { recursive: true });
    const archivedAt = new Date().toISOString();
    const lines = older.map((it) => JSON.stringify({ prId, archivedAt, ...it })).join('\n') + '\n';
    await fs.appendFile(this.archiveFile, lines, 'utf8');
  }

  async append(entry, { summarizeFn = null } = {}) {
    const cur = await this.read();
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: entry.ts || new Date().toISOString(),
      kind: entry.kind || 'ok',
      session: entry.session || 'chat',
      screen: entry.screen || '',
      region: entry.region || '',
      text: cleanStr(entry.text, 3000),
      ...(entry.replyType ? { replyType: entry.replyType } : {}),
      ...(Array.isArray(entry.options) && entry.options.length ? { options: entry.options.slice(0, 4) } : {}),
    };
    cur.items.push(item);

    let compactedPr = null;
    const lim = cur.limits || this.limits;
    const overItems = cur.items.length > lim.maxItems;
    const overChars = charsOf(cur.items) > lim.maxChars && cur.items.length > lim.keepRecent + 2;
    if (overItems || overChars) {
      compactedPr = await this._compactInPlace(cur, lim.keepRecent, summarizeFn);
    }
    await this.save(cur);
    return { item, compactedPr, state: cur };
  }

  async compactNow({ keepRecent = 4, summarizeFn = null } = {}) {
    const cur = await this.read();
    if (cur.items.length <= keepRecent) return { compactedPr: null, state: cur };
    const compactedPr = await this._compactInPlace(cur, keepRecent, summarizeFn);
    await this.save(cur);
    return { compactedPr, state: cur };
  }

  async _compactInPlace(cur, keepRecent, summarizeFn) {
    const cut = Math.max(1, cur.items.length - Math.max(0, keepRecent));
    const older = cur.items.slice(0, cut);
    const recent = cur.items.slice(cut);
    const prNumber = cur.nextPr || (cur.prs.length + 1);
    const fallback = buildDeterministicPr(prNumber, older);
    let pr = fallback;
    if (typeof summarizeFn === 'function') {
      try {
        const aiPr = await summarizeFn(prNumber, older);
        if (aiPr && aiPr.title) {
          pr = {
            ...fallback,
            title: String(aiPr.title).startsWith('PR #') ? String(aiPr.title).slice(0, 80) : `PR #${prNumber} · ${String(aiPr.title).slice(0, 70)}`,
            changes: Array.isArray(aiPr.changes) && aiPr.changes.length ? aiPr.changes.slice(0, 6).map((c) => String(c).slice(0, 180)) : fallback.changes,
          };
        }
      } catch {
        // AI 요약 실패 시 결정적 요약으로 안전 폴백
      }
    }
    await this.archiveRaw(pr.id, older);
    cur.prs.push(pr);
    if (cur.prs.length > 50) cur.prs = cur.prs.slice(-50);
    cur.nextPr = prNumber + 1;
    cur.items = recent;
    return pr;
  }

  async readArchive(prId = '', limit = 100) {
    try {
      const lines = (await fs.readFile(this.archiveFile, 'utf8')).split('\n').filter(Boolean);
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = prId ? parsed.filter((x) => x.prId === prId) : parsed;
      return filtered.slice(-limit);
    } catch {
      return [];
    }
  }

  // 향후 AI 계획·질문·영역 수정에 참고할 수 있도록 최근 PR 요약을 간결한 마크다운으로 반환
  async buildPrContext(maxPrs = 5) {
    const cur = await this.read();
    if (!cur.prs.length) return '';
    const recent = cur.prs.slice(-maxPrs);
    const lines = recent.map((p) => {
      const meta = [p.screens?.length ? `화면: ${p.screens.join(', ')}` : '', p.regions?.length ? `영역: ${p.regions.join(', ')}` : ''].filter(Boolean).join(' · ');
      return `### ${p.title}${meta ? ` (${meta})` : ''}\n${(p.changes || []).map((c) => `- ${c}`).join('\n')}`;
    });
    return cleanStr(`\n# 최근 개발 PR 요약 (이전 대화 및 세션 간 전달 기록)\n${lines.join('\n\n')}\n`);
  }
}
