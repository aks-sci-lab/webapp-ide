// 로컬 구독 CLI (Claude Code · OpenAI Codex · Gemini CLI · Antigravity · 커스텀) 실행기
// API 키 없이 PC 에 로그인된 구독 CLI 프로세스를 표준입출력(stdin → stdout)으로 연결해 스트리밍한다.
import { spawn, execFile } from 'node:child_process';
import { SYSTEM } from './ai.js';

export const CLI_PRESETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code (claude)',
    bin: 'claude',
    args: ['-p', '--output-format', 'text'],
    modelFlag: '--model',
    note: 'Claude Pro/Max 구독 계정 로그인 필요 (claude login)',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI (codex)',
    bin: 'codex',
    args: ['exec', '--skip-git-repo-check', '-'],
    modelFlag: '-m',
    note: 'ChatGPT Plus/Pro 구독 계정 로그인 필요 (codex login)',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI (gemini)',
    bin: 'gemini',
    args: ['-p', ''],
    modelFlag: '-m',
    note: 'Google 계정 로그인 필요 (gemini)',
  },
  agy: {
    id: 'agy',
    label: 'Antigravity CLI (agy)',
    bin: 'agy',
    args: ['chat', '--no-interactive'],
    modelFlag: '--model',
    note: 'Antigravity 로컬 CLI (인자가 다르면 커스텀 인자로 조정 가능)',
  },
  custom: {
    id: 'custom',
    label: '커스텀 CLI 명령',
    bin: '',
    args: [],
    modelFlag: '',
    note: 'stdin 으로 프롬프트를 받아 stdout 으로 응답하는 임의의 CLI 명령',
  },
};

// ANSI 터미널 색상 코드 제거
export function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// 간단한 공백/따옴표 인자 파서
export function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// 프리셋 + 사용자 입력으로 실제 실행할 { command, args } 계산
export function buildCliInvocation({ preset = 'codex', command = '', args = '', model = '' } = {}) {
  const p = CLI_PRESETS[preset] || CLI_PRESETS.custom;
  const cmd = String(command || '').trim() || p.bin;
  if (!cmd) throw new Error('실행할 CLI 명령어가 비어 있습니다. ⚙️ 설정에서 CLI 를 선택하거나 입력하세요.');
  const baseArgs = String(args || '').trim() ? splitArgs(args) : [...p.args];
  const m = String(model || '').trim();
  if (m && p.modelFlag && !baseArgs.includes(p.modelFlag)) {
    // codex 의 '-' (stdin 표시) 가 마지막이면 그 앞에 모델 플래그를 삽입
    if (baseArgs.at(-1) === '-') {
      baseArgs.splice(baseArgs.length - 1, 0, p.modelFlag, m);
    } else {
      baseArgs.push(p.modelFlag, m);
    }
  }
  return { command: cmd, args: baseArgs };
}

function whichBin(bin) {
  if (!bin) return Promise.resolve(null);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [bin], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Windows 에서는 .ps1 대신 .exe / .cmd 를 우선 선택 (실행 정책 오류 방지)
      const preferred = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0] || null;
      resolve(preferred);
    });
  });
}

let detectCache = null;
export async function detectClis(force = false) {
  if (detectCache && !force) return detectCache;
  const entries = await Promise.all(
    Object.values(CLI_PRESETS).map(async (p) => {
      const found = p.bin ? await whichBin(p.bin) : null;
      return {
        id: p.id,
        label: p.label,
        bin: p.bin,
        defaultArgs: p.args.join(' '),
        note: p.note,
        installed: Boolean(found),
        path: found,
      };
    }),
  );
  detectCache = entries;
  return entries;
}

export async function* generate({ preset = 'codex', command = '', args = '', model = '', prompt, system = SYSTEM, cwd = process.cwd(), timeoutMs = 180000 }) {
  const inv = buildCliInvocation({ preset, command, args, model });
  const combined = `${system ? `[시스템 지침]\n${system}\n\n` : ''}${prompt}\n`;

  // Windows 에서 .exe 는 shell:false 로 안전하게 직접 실행하고, .cmd/.bat 만 shell:true 로 실행한다
  const isWin = process.platform === 'win32';
  const resolved = isWin && !/[\\/]/.test(inv.command) ? (await whichBin(inv.command)) || inv.command : inv.command;
  const needShell = isWin && /\.(cmd|bat)$/i.test(resolved);
  const finalArgs = needShell ? inv.args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : inv.args;
  const child = spawn(resolved, finalArgs, {
    cwd,
    shell: needShell,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const queue = [];
  let wake = null;
  let ended = false;
  let fullText = '';
  let stderrText = '';
  let exitCode = null;
  let spawnErr = null;

  const push = (item) => {
    queue.push(item);
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    spawnErr = new Error(`CLI(${inv.command}) 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`);
    ended = true;
    push(null);
  }, timeoutMs);

  child.on('error', (err) => {
    spawnErr = new Error(`CLI(${inv.command})를 실행하지 못했습니다: ${err.message}`);
    ended = true;
    push(null);
  });
  child.stdout.on('data', (buf) => {
    const chunk = stripAnsi(buf.toString('utf8'));
    if (!chunk) return;
    fullText += chunk;
    push({ type: 'delta', text: chunk });
  });
  child.stderr.on('data', (buf) => {
    stderrText += stripAnsi(buf.toString('utf8'));
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    exitCode = code;
    ended = true;
    push(null);
  });

  // 프롬프트를 stdin 으로 전달하고 입력 종료
  child.stdin.write(combined, 'utf8');
  child.stdin.end();

  for (;;) {
    while (queue.length) {
      const item = queue.shift();
      if (item) yield item;
    }
    if (ended) break;
    await new Promise((r) => { wake = r; });
  }

  if (spawnErr) throw spawnErr;
  if (exitCode !== 0 && !fullText.trim()) {
    throw new Error(`CLI(${inv.command}) 종료 오류 (코드 ${exitCode}): ${stderrText.trim().slice(0, 400) || '로그인이 필요하거나 명령 인자가 올바르지 않습니다'}`);
  }
  yield {
    type: 'final',
    text: fullText,
    usage: { input_tokens: Math.ceil(combined.length / 4), output_tokens: Math.ceil(fullText.length / 4) },
  };
}
