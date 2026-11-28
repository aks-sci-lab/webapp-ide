// 시뮬레이션 #3 "우리반 운영판" 을 만들어 점검하고, 심은 버그를 몇 개 잡았는지 표로 보여 준다.
// node scripts/sim-class-hub.js [--json]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../lib/project.js';
import { verifyProject } from '../lib/app-verify.js';
import { REGION_CODE, CLEAN_CODE, CLEAN_GLOBAL_CSS, AI_TESTS, LAYOUT, SKILLS, BUGS } from '../test/fixtures/class-hub-app.js';

export async function makeClassHub({ clean = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'webapp-ide-hub-'));
  const p = new Project(tmp);
  await p.init(LAYOUT);
  await p.saveLayout({ ...(await p.getLayout()), ...LAYOUT });
  for (const [id, f] of Object.entries(clean ? CLEAN_CODE : REGION_CODE)) await p.writeRegion(id, f, { backup: false });
  if (clean) await p.writeShared('css', CLEAN_GLOBAL_CSS);
  await p.writeSkills({ enabled: SKILLS });
  await p.writeTests(AI_TESTS);
  return { p, tmp };
}

export function score(report) {
  return BUGS.map((b) => ({ id: b.id, kind: b.kind, region: b.region, caught: Boolean(b.caught(report)) }));
}

// 영역별로 오류(❌)·확인 필요(⚠) 항목을 한 줄씩 펼친다
export function findings(r) {
  const out = [];
  for (const d of r.duplicateIds || []) out.push(['정적', d.regions.join('/'), `중복 id #${d.id}`]);
  for (const i of r.connectionIssues || []) out.push(['연결', (i.regions || []).join('/'), `${i.level}: ${i.text}`]);
  for (const i of r.securityIssues || []) out.push(['보안', i.region, `${i.level}: ${i.detail}`]);
  for (const i of r.storeKeyIssues || []) out.push(['저장키', i.regions.join('/'), `${i.level}: ${i.text}`]);
  for (const i of r.localCompatibility?.issues || []) out.push(['로컬', i.region, `${i.level}: ${i.detail}`]);
  for (const e of r.browser?.runtimeErrors || []) out.push(['런타임', e.region || '?', e.message]);
  for (const t of r.browser?.testResults || []) if (!t.ok) out.push(['AI테스트', t.steps.at(-1)?.region || '?', `${t.suspect ? '(테스트 문제) ' : ''}${t.name}: ${t.steps.at(-1)?.msg}`]);
  for (const x of r.explore?.regions || []) {
    for (const e of x.errors) out.push(['탐색❌', x.id, `${e.when}: ${e.message}`]);
    for (const e of x.reloadReverted) out.push(['탐색❌', x.id, `${e.when}: ${e.message}`]);
    for (const e of x.security || []) out.push(['탐색❌보안', x.id, `${e.when}: ${e.message}`]);
    for (const e of x.reloadWarnings) out.push(['탐색⚠', x.id, `${e.when}: ${e.message}`]);
    for (const e of x.warnings || []) out.push(['탐색⚠', x.id, `${e.when}: ${e.message}`]);
    if (x.deadButtons.length) out.push(['탐색⚠', x.id, `반응 없음: ${x.deadButtons.join(', ')}`]);
  }
  for (const e of r.explore?.pageErrors || []) out.push(['탐색❌', '(앱)', `${e.when}: ${e.message}`]);
  if (r.explore?.error) out.push(['탐색', '-', r.explore.error]);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clean = process.argv.includes('--clean');
  const { p, tmp } = await makeClassHub({ clean });
  try {
    const t0 = Date.now();
    const r = await verifyProject(p);
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    console.log(`점검 ${((Date.now() - t0) / 1000).toFixed(1)}초, browserError=${r.browserError || '-'}`);
    for (const f of findings(r)) console.log(f.join(' | '));
    if (clean) console.log(`\n버그를 고친 판: ok=${r.ok}`);
    else {
      const s = score(r);
      console.log('\n' + s.map((x) => `${x.caught ? '✅' : '❌'} ${x.id} ${x.kind} (${x.region})`).join('\n'));
      console.log(`\n잡음 ${s.filter((x) => x.caught).length}/${s.length}`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
