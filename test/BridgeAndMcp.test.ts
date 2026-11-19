import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeRegistry } from '../src/bridge/BridgeRegistry';
import { BridgeServer } from '../src/bridge/BridgeServer';
import {
  ILiveEditorAdapter,
  LiveAgentSessionDriver,
} from '../src/bridge/LiveAgentSessionDriver';
import {
  findBeforeAnchorOffset,
  findContainerInsertionPoint,
  normalizeLineEndings,
} from '../src/editor/ContainerLocator';
import { AppendChunkOptions, AppendChunkResult, IVoiceAdapter, SpeakOptions } from '../src/engine/PlaybackEngine';
import { BridgeClient } from '../src/mcp/bridgeClient';
import { PlaybackState, VoiceOptionInfo } from '../src/types/session';

class InMemoryLiveEditor implements ILiveEditorAdapter {
  public readonly files = new Map<string, string>();
  public readonly offsets = new Map<string, number>();

  constructor(private readonly eol: '\n' | '\r\n' = '\n') {}

  resetSession(clearExistingOnFirstOpen: boolean): void {
    if (clearExistingOnFirstOpen) {
      this.files.clear();
      this.offsets.clear();
    }
  }

  async openFile(filePath: string): Promise<void> {
    if (!this.files.has(filePath)) {
      this.files.set(filePath, '');
      this.offsets.set(filePath, 0);
    }
  }

  async prepareEditTarget(
    filePath: string,
    insertMode:
      | 'append'
      | 'replace-file'
      | 'replace-target'
      | 'insert-before'
      | 'inside-container',
    targetOrAnchorText?: string,
    hasTrailingNewline = false,
  ): Promise<{ matched: boolean }> {
    const existing = this.files.get(filePath) ?? '';
    if (insertMode === 'append') {
      this.offsets.set(filePath, existing.length);
      return { matched: true };
    }
    if (insertMode === 'replace-file') {
      this.files.set(filePath, '');
      this.offsets.set(filePath, 0);
      return { matched: true };
    }
    if (insertMode === 'replace-target' && targetOrAnchorText) {
      const normTarget = normalizeLineEndings(targetOrAnchorText, this.eol);
      const idx = existing.indexOf(normTarget);
      if (idx !== -1) {
        this.files.set(
          filePath,
          existing.slice(0, idx) + existing.slice(idx + normTarget.length),
        );
        this.offsets.set(filePath, idx);
        return { matched: true };
      }
      return { matched: false };
    }
    if (insertMode === 'insert-before' && targetOrAnchorText) {
      const found = findBeforeAnchorOffset(existing, targetOrAnchorText, this.eol);
      this.offsets.set(filePath, found.insertOffset);
      return { matched: found.matched };
    }
    if (insertMode === 'inside-container' && targetOrAnchorText) {
      const container = findContainerInsertionPoint(
        existing,
        targetOrAnchorText,
        this.eol,
        hasTrailingNewline,
      );
      if (!container.matched) {
        this.offsets.set(filePath, existing.length);
        return { matched: false };
      }
      if (
        container.deleteLength > 0 ||
        container.prefixToInsert.length > 0 ||
        container.suffixToInsert.length > 0
      ) {
        const updated =
          existing.slice(0, container.insertOffset) +
          container.prefixToInsert +
          container.suffixToInsert +
          existing.slice(container.insertOffset + container.deleteLength);
        this.files.set(filePath, updated);
        this.offsets.set(
          filePath,
          container.insertOffset + container.prefixToInsert.length,
        );
      } else {
        this.offsets.set(filePath, container.insertOffset);
      }
      return { matched: true };
    }
    return { matched: true };
  }

  async appendChunk(
    filePath: string,
    chunk: string,
    _options: AppendChunkOptions,
  ): Promise<AppendChunkResult> {
    const content = this.files.get(filePath) ?? '';
    const normChunk = normalizeLineEndings(chunk, this.eol);
    const pos = Math.min(this.offsets.get(filePath) ?? content.length, content.length);
    const updated = content.slice(0, pos) + normChunk + content.slice(pos);
    const actualDelta = updated.length - content.length;
    this.files.set(filePath, updated);
    this.offsets.set(filePath, pos + actualDelta);

    const beforeCursor = updated.slice(0, pos + actualDelta);
    const lines = beforeCursor.split('\n');
    return {
      lineNumber: lines.length,
      column: (lines[lines.length - 1] ?? '').length + 1,
      currentLineText: lines[lines.length - 1] ?? '',
      surroundingLines: lines.slice(-4).join('\n'),
    };
  }

  async getContextSnapshot(filePath: string) {
    const content = this.files.get(filePath) ?? '';
    const pos = this.offsets.get(filePath) ?? content.length;
    const lines = content.slice(0, pos).split('\n');
    return {
      lineNumber: lines.length,
      column: (lines[lines.length - 1] ?? '').length + 1,
      currentLineText: lines[lines.length - 1] ?? '',
      surroundingLines: lines.slice(-4).join('\n'),
    };
  }

  async setVisualState(
    _filePath: string | null,
    _lineNumber: number,
    _state: PlaybackState,
  ): Promise<void> {}

  clearDecorations(): void {}
}

class SilentVoiceAdapter implements IVoiceAdapter {
  public stopCount = 0;

  async speakSentences(_text: string, options: SpeakOptions): Promise<void> {
    if (options.signal?.aborted) {
      return;
    }
    options.onSentenceStart?.(0, 'Narration.', 1);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 15);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  stopImmediately(): void {
    this.stopCount += 1;
  }

  getBackendLabel(): string {
    return 'Silent Test';
  }

  getAvailableVoices(): VoiceOptionInfo[] {
    return [];
  }

  getSelectedVoiceId(): string | null {
    return null;
  }
}

async function postBridge(
  port: number,
  token: string,
  route: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('BridgeServer & LiveAgentSessionDriver', () => {
  const serversToClose: BridgeServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const s of serversToClose.splice(0)) {
      await s.dispose();
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unauthorized requests and completes write-block, skip, barge-in, checkpoint, and file-fast-pause over HTTP', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-bridge-'));
    tempDirs.push(tmpDir);

    const registry = new BridgeRegistry(path.join(tmpDir, 'bridges.json'));
    const editor = new InMemoryLiveEditor();
    const voice = new SilentVoiceAdapter();
    const driver = new LiveAgentSessionDriver(editor, voice, {
      language: 'fr',
      defaultSpeed: '0.5x',
      voiceRateMultiplier: 1.0,
      providerLabel: 'Chat /CodePace',
    });

    const server = new BridgeServer(driver, () => [tmpDir], registry);
    serversToClose.push(server);
    const entry = await server.start();

    // 1. Auth guard check
    const unauth = await fetch(`http://127.0.0.1:${entry.port}/health`);
    expect(unauth.status).toBe(401);

    const authHealth = await fetch(`http://127.0.0.1:${entry.port}/health`, {
      headers: { Authorization: `Bearer ${entry.token}` },
    });
    expect(authHealth.status).toBe(200);

    // 2. Start session
    const startRes = await postBridge(entry.port, entry.token, '/session/start', {
      title: 'Test /CodePace',
      goal: 'Build module',
      plannedFiles: ['a.ts', 'b.ts'],
    });
    expect(startRes.status).toBe(200);
    expect(startRes.json.ok).toBe(true);

    // 3. Barge-in mid-block returns interrupted + exact remainingCode, then resuming completes
    const writePromise = postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'a.ts',
      title: 'Core function',
      importance: 'high',
      code: 'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
      narration: 'Une phrase longue pour laisser le temps d interrompre.',
    });

    await waitUntil(() => (editor.files.get('a.ts')?.length ?? 0) >= 10);
    await driver.interruptWithPrompt();
    expect(driver.getUIState().playbackState).toBe('interrupted');
    driver.submitBargeInQuestion('Pourquoi string ici ?');

    const interruptedRes = await writePromise;
    expect(interruptedRes.json.status).toBe('interrupted');
    expect(interruptedRes.json.question).toBe('Pourquoi string ici ?');
    const remainingCode = String(interruptedRes.json.remainingCode ?? '');
    expect(remainingCode.length).toBeGreaterThan(0);

    // Complete remaining code cleanly with 3x speed + skip test
    driver.setSpeed('3x');
    const finishARes = await postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'a.ts',
      title: 'Core function (suite)',
      code: remainingCode,
      narration: 'Suite.',
    });
    expect(finishARes.json.status).toBe('completed');
    expect(editor.files.get('a.ts')).toBe(
      'export function greet(name: string) {\n  return `Hello ${name}`;\n}\n',
    );

    // 4. Checkpoint resolution
    driver.setPromptHooks({
      onCheckpointPromptNeeded: () => {
        setTimeout(() => driver.resolveCheckpoint('opt-1', 'Avec tests unitaires'), 20);
      },
    });
    const ckRes = await postBridge(entry.port, entry.token, '/session/checkpoint', {
      title: 'Architecture',
      question: 'Mode immuable ?',
      options: [
        { id: 'opt-1', label: 'Immuable', recommended: true },
        { id: 'opt-2', label: 'Mutable' },
      ],
    });
    expect(ckRes.json.status).toBe('resolved');
    expect(ckRes.json.selectedLabel).toBe('Immuable');
    expect(ckRes.json.customReply).toBe('Avec tests unitaires');

    // 5. Skip mid-block flushes entire block immediately
    driver.setSpeed('0.5x');
    const skipPromise = postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'b.ts',
      title: 'Second file',
      code: 'export const x = 42;\nexport const y = 99;\n',
      narration: 'Explication.',
    });
    await waitUntil(() => (editor.files.get('b.ts')?.length ?? 0) >= 6);
    driver.skipBlock();
    const skipRes = await skipPromise;
    expect(skipRes.json.status).toBe('skipped');
    expect(editor.files.get('b.ts')).toBe('export const x = 42;\nexport const y = 99;\n');

    // 6. File-Fast + Pause pauses before moving onto c.ts and restores speed
    driver.setSpeed('1x');
    driver.implementFileAndPause('b.ts');
    const cPromise = postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'c.ts',
      title: 'Third file',
      code: 'export const z = 1;\n',
      narration: 'Fin.',
    });

    await waitUntil(() => driver.getUIState().playbackState === 'paused');
    expect(driver.getUIState().speedMode).toBe('1x');
    expect(driver.getUIState().pauseBanner).toContain('b.ts');
    driver.resume();

    const cRes = await cPromise;
    expect(cRes.json.status).toBe('completed');
    expect(editor.files.get('c.ts')).toBe('export const z = 1;\n');
  }, 15000);

  it('writes multi-block CRLF documents and inside-container class shells without character drift', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-crlf-'));
    tempDirs.push(tmpDir);

    const registry = new BridgeRegistry(path.join(tmpDir, 'bridges.json'));
    const editor = new InMemoryLiveEditor('\r\n');
    const voice = new SilentVoiceAdapter();
    const driver = new LiveAgentSessionDriver(editor, voice, {
      language: 'fr',
      defaultSpeed: '3x',
      voiceRateMultiplier: 1.0,
      providerLabel: 'Chat /CodePace',
    });

    const server = new BridgeServer(driver, () => [tmpDir], registry);
    serversToClose.push(server);
    const entry = await server.start();

    await postBridge(entry.port, entry.token, '/session/start', {
      title: 'Snake Game',
      goal: 'Build SnakeGame cleanly',
      workspaceRoot: tmpDir,
    });

    await postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'game.js',
      title: 'Constants + SnakeGame shell',
      code: "'use strict';\nconst GRID_SIZE = 20;\nconst TILE_SIZE = 24;\n\nclass SnakeGame {\n}\n",
      narration: 'Constantes et squelette SnakeGame.',
    });

    await postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'game.js',
      title: 'State variables inside SnakeGame',
      insertMode: 'inside-container',
      anchorText: 'class SnakeGame',
      code: '  score = 0;\n  direction = { x: 1, y: 0 };\n',
      narration: 'Variables internes.',
    });

    await postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'game.js',
      title: 'reset() method inside SnakeGame',
      insertMode: 'inside-container',
      anchorText: 'class SnakeGame',
      code: '  reset() {\n    this.score = 0;\n  }\n',
      narration: 'Méthode reset.',
    });

    await postBridge(entry.port, entry.token, '/session/write-block', {
      filePath: 'game.js',
      title: 'Boot instance at EOF',
      insertMode: 'append',
      code: 'const game = new SnakeGame();\n',
      narration: 'Instanciation.',
    });

    expect(editor.files.get('game.js')).toBe(
      [
        "'use strict';",
        'const GRID_SIZE = 20;',
        'const TILE_SIZE = 24;',
        '',
        'class SnakeGame {',
        '  score = 0;',
        '  direction = { x: 1, y: 0 };',
        '  reset() {',
        '    this.score = 0;',
        '  }',
        '}',
        'const game = new SnakeGame();',
        '',
      ].join('\r\n'),
    );
  });

  it('routes checkpoints strictly to the matching workspace window even when another window is focused', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-multiwin-'));
    tempDirs.push(tmpDir);

    const codepaceDir = path.join(tmpDir, 'CodePace');
    const snakeDir = path.join(tmpDir, 'Snake');
    await fs.mkdir(codepaceDir, { recursive: true });
    await fs.mkdir(snakeDir, { recursive: true });

    const registry = new BridgeRegistry(path.join(tmpDir, 'bridges.json'));

    let codepaceCheckpoints = 0;
    const driverA = new LiveAgentSessionDriver(
      new InMemoryLiveEditor(),
      new SilentVoiceAdapter(),
      { language: 'fr', defaultSpeed: '3x', voiceRateMultiplier: 1.0, providerLabel: 'A' },
    );
    driverA.setPromptHooks({
      onCheckpointPromptNeeded: () => {
        codepaceCheckpoints += 1;
        setTimeout(() => driverA.resolveCheckpoint('opt-1'), 10);
      },
    });
    const serverA = new BridgeServer(driverA, () => [codepaceDir], registry);
    serversToClose.push(serverA);
    await serverA.start();
    await serverA.setFocused(true); // Focused window is CodePace!

    let snakeCheckpoints = 0;
    const driverB = new LiveAgentSessionDriver(
      new InMemoryLiveEditor(),
      new SilentVoiceAdapter(),
      { language: 'fr', defaultSpeed: '3x', voiceRateMultiplier: 1.0, providerLabel: 'B' },
    );
    driverB.setPromptHooks({
      onCheckpointPromptNeeded: () => {
        snakeCheckpoints += 1;
        setTimeout(() => driverB.resolveCheckpoint('opt-1'), 10);
      },
    });
    const serverB = new BridgeServer(driverB, () => [snakeDir], registry);
    serversToClose.push(serverB);
    await serverB.start();
    await serverB.setFocused(false);

    const client = new BridgeClient(registry);
    const startRes = await client.callBridge(
      '/session/start',
      'POST',
      { title: 'Snake', goal: 'Build Snake', workspaceRoot: snakeDir },
      snakeDir,
    );
    expect(startRes.ok).toBe(true);
    const pinnedId = startRes.ok ? startRes.bridgeId : undefined;

    // Even if checkpoint omits workspaceRoot, pinnedBridgeId keeps it inside Snake window!
    const ckRes = await client.callBridge(
      '/session/checkpoint',
      'POST',
      {
        title: 'Murs',
        question: 'Murs solides ?',
        options: [{ id: 'opt-1', label: 'Oui', recommended: true }],
      },
      undefined,
      pinnedId,
    );

    expect(ckRes.ok).toBe(true);
    expect(snakeCheckpoints).toBe(1);
    expect(codepaceCheckpoints).toBe(0);
  });
});

describe('MCP Server stdio integration (dist/mcp-server.js)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('responds to initialize, tools/list, and tools/call over JSON-RPC stdio', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-mcp-'));
    tempDirs.push(tmpDir);

    const mcpPath = path.resolve('dist/mcp-server.js');
    const proc = spawn(process.execPath, [mcpPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        CODEPACE_REGISTRY_PATH: path.join(tmpDir, 'no-bridges.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = new Map<number, Record<string, unknown>>();
    const waiters = new Map<number, (val: Record<string, unknown>) => void>();

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (typeof msg.id === 'number') {
          const payload = msg.result ?? {};
          const w = waiters.get(msg.id);
          if (w) {
            waiters.delete(msg.id);
            w(payload);
          } else {
            responses.set(msg.id, payload);
          }
        }
      } catch {
        // Ignore non-JSON lines.
      }
    });

    const rpc = (id: number, method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const existing = responses.get(id);
        if (existing) {
          responses.delete(id);
          resolve(existing);
          return;
        }
        waiters.set(id, resolve);
        proc.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      });

    try {
      const initRes = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
      expect((initRes.serverInfo as { name: string }).name).toBe('codepace-driver');

      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );

      const listRes = await rpc(2, 'tools/list');
      const tools = listRes.tools as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toEqual([
        'codepace_start_session',
        'codepace_write_block',
        'codepace_checkpoint',
        'codepace_speak',
        'codepace_control',
        'codepace_finish_session',
      ]);

      // Silence audio & switch to 3x before testing write_block in headless standalone mode
      await rpc(3, 'tools/call', {
        name: 'codepace_control',
        arguments: { action: 'mute' },
      });
      await rpc(4, 'tools/call', {
        name: 'codepace_control',
        arguments: { action: 'set_speed', speed: '3x' },
      });

      const writeRes = await rpc(5, 'tools/call', {
        name: 'codepace_write_block',
        arguments: {
          filePath: 'hello.ts',
          workspaceRoot: tmpDir,
          title: 'Hello test',
          code: 'export const hello = "world";\n',
          narration: 'Test standalone.',
        },
      });

      const textBlock = (writeRes.content as Array<{ text: string }>)[0].text;
      const parsed = JSON.parse(textBlock) as { status: string; filePath: string };
      expect(parsed.status).toBe('completed');
      expect(parsed.filePath).toBe('hello.ts');

      const writtenContent = await fs.readFile(path.join(tmpDir, 'hello.ts'), 'utf8');
      expect(writtenContent).toBe('export const hello = "world";\n');
    } finally {
      rl.close();
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.killed) {
          resolve();
          return;
        }
        proc.once('exit', () => resolve());
        proc.stdin.end();
        proc.kill();
      });
    }
  }, 15000);
});
