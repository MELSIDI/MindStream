import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function hasCommand(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function runChecked(cmd, args, label) {
  console.log(`\n[MindStream] ${label}...`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`${label} failed with exit code ${res.status ?? 'unknown'}`);
  }
}

function resolveWorkerScript() {
  const candidates = [
    path.join(import.meta.dirname, 'kokoro_worker.py'),
    path.resolve(import.meta.dirname, '../src/voice/kokoro_worker.py'),
    path.resolve(import.meta.dirname, '../dist/kokoro_worker.py'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not locate kokoro_worker.py');
}

function main() {
  const isWin = process.platform === 'win32';
  const venvDir = path.join(os.homedir(), '.mindstream', 'kokoro-venv');
  const venvPython = path.join(
    venvDir,
    isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'),
  );

  fs.mkdirSync(path.dirname(venvDir), { recursive: true });

  const useUv = hasCommand('uv');
  const basePython = isWin
    ? hasCommand('python')
      ? 'python'
      : 'py'
    : hasCommand('python3')
      ? 'python3'
      : 'python';

  if (!fs.existsSync(venvPython)) {
    if (useUv) {
      try {
        runChecked(
          'uv',
          ['venv', '--seed', '--python', '3.12', venvDir],
          'Creating Kokoro Python 3.12 virtualenv via uv',
        );
      } catch {
        runChecked(
          'uv',
          ['venv', '--seed', venvDir],
          'Creating Kokoro Python virtualenv via uv',
        );
      }
    } else {
      const venvArgs = basePython === 'py' ? ['-3', '-m', 'venv', venvDir] : ['-m', 'venv', venvDir];
      runChecked(basePython, venvArgs, 'Creating Kokoro Python virtualenv');
    }
  } else {
    console.log(`[MindStream] Reusing existing Kokoro virtualenv: ${venvDir}`);
  }

  const packages = [
    'kokoro>=0.9.4',
    'misaki[en]',
    'espeakng-loader',
    'phonemizer-fork',
    'soundfile',
    'numpy',
  ];

  if (useUv) {
    runChecked(
      'uv',
      ['pip', 'install', '--python', venvPython, '--upgrade', ...packages],
      'Installing Kokoro-82M & G2P dependencies via uv',
    );
  } else {
    runChecked(
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
      'Upgrading pip in Kokoro virtualenv',
    );
    runChecked(
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', ...packages],
      'Installing Kokoro-82M & G2P dependencies via pip',
    );
  }

  // Pre-install spaCy English model if spacy is present so misaki[en] never downloads at runtime.
  const spacyCheck = spawnSync(
    venvPython,
    ['-c', "import spacy; spacy.load('en_core_web_sm')"],
    { stdio: 'ignore', windowsHide: true },
  );
  if (spacyCheck.status !== 0) {
    const hasSpacy =
      spawnSync(venvPython, ['-c', 'import spacy'], { stdio: 'ignore', windowsHide: true })
        .status === 0;
    if (hasSpacy) {
      try {
        runChecked(
          venvPython,
          ['-m', 'spacy', 'download', 'en_core_web_sm'],
          'Downloading spaCy English model (en_core_web_sm) for misaki[en]',
        );
      } catch {
        console.warn('[MindStream] Warning: could not pre-download en_core_web_sm; Kokoro will retry if needed.');
      }
    }
  }

  const workerScript = resolveWorkerScript();
  runChecked(
    venvPython,
    [workerScript, '--warmup'],
    'Downloading hexgrad/Kokoro-82M weights & verifying FR (ff_siwis) + EN (af_heart)',
  );

  console.log('\n[MindStream] Kokoro-82M local TTS is ready!');
  console.log(`  Python venv : ${venvPython}`);
  console.log('  French voice: ff_siwis (lang_code="f")');
  console.log('  English voice: af_heart (lang_code="a")');
}

try {
  main();
} catch (err) {
  console.error('[MindStream] Kokoro setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
