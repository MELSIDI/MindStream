import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { IWavAudioPlayer, WavAudioPlayer } from './WavAudioPlayer';

export type KokoroDevice = 'auto' | 'cpu' | 'cuda' | 'mps';

export interface KokoroConfig {
  pythonPath?: string;
  device?: KokoroDevice;
  voiceFr?: string;
  voiceEn?: string;
  idleTimeoutMs?: number;
}

export interface KokoroSynthOptions {
  lang: 'fr' | 'en';
  voice?: string;
  rate?: number;
  signal?: AbortSignal;
}

export interface KokoroSynthResult {
  wavPath: string;
  durationMs: number;
  lang: 'fr' | 'en';
  voice: string;
}

export interface KokoroSpeakSentenceItem {
  text: string;
  lang: 'fr' | 'en';
  voice?: string;
  rate: number;
}

export interface KokoroSpeakSentenceCallbacks {
  onSentenceStart?: (index: number, sentenceText: string, totalSentences: number) => void;
}

interface PendingRequest {
  resolve: (result: KokoroSynthResult | null) => void;
  reject: (err: Error) => void;
  outPath: string;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  type?: string;
  id?: string;
  path?: string;
  durationMs?: number;
  lang?: 'fr' | 'en';
  voice?: string;
  error?: string;
}

export const KOKORO_VOICES_CATALOG = [
  { id: 'kokoro:ff_siwis', voice: 'ff_siwis', name: 'Kokoro-82M — Français (Siwis)', lang: 'fr-FR' },
  { id: 'kokoro:af_heart', voice: 'af_heart', name: 'Kokoro-82M — English US (Heart)', lang: 'en-US' },
  { id: 'kokoro:af_bella', voice: 'af_bella', name: 'Kokoro-82M — English US (Bella)', lang: 'en-US' },
  { id: 'kokoro:am_michael', voice: 'am_michael', name: 'Kokoro-82M — English US (Michael)', lang: 'en-US' },
  { id: 'kokoro:am_fenrir', voice: 'am_fenrir', name: 'Kokoro-82M — English US (Fenrir)', lang: 'en-US' },
  { id: 'kokoro:bf_emma', voice: 'bf_emma', name: 'Kokoro-82M — English UK (Emma)', lang: 'en-GB' },
  { id: 'kokoro:bm_george', voice: 'bm_george', name: 'Kokoro-82M — English UK (George)', lang: 'en-GB' },
] as const;

export function resolveKokoroVoiceForLanguage(
  lang: 'fr' | 'en',
  preferredVoice?: string,
  defaultFr = 'ff_siwis',
  defaultEn = 'af_heart',
): string {
  const clean = preferredVoice?.replace(/^kokoro:/, '').trim() ?? '';
  if (lang === 'fr') {
    if (clean.startsWith('ff_') || clean.startsWith('fm_')) {
      return clean;
    }
    return defaultFr.startsWith('ff_') || defaultFr.startsWith('fm_') ? defaultFr : 'ff_siwis';
  }

  if (
    clean.startsWith('af_') ||
    clean.startsWith('am_') ||
    clean.startsWith('bf_') ||
    clean.startsWith('bm_')
  ) {
    return clean;
  }
  return defaultEn.startsWith('af_') ||
    defaultEn.startsWith('am_') ||
    defaultEn.startsWith('bf_') ||
    defaultEn.startsWith('bm_')
    ? defaultEn
    : 'af_heart';
}

export class KokoroTTSService {
  private readonly tempDir: string;
  private readonly audioPlayer: IWavAudioPlayer;
  private readonly explicitWorkerPath?: string;

  private pythonPath = '';
  private device: KokoroDevice = 'auto';
  private voiceFr = 'ff_siwis';
  private voiceEn = 'af_heart';
  private idleTimeoutMs = 15 * 60 * 1000;

  private cachedPython: string | null | undefined = undefined;
  private availableCache: boolean | null = null;

  private worker: ChildProcess | null = null;
  private workerReadyPromise: Promise<boolean> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private synthQueue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts?: {
    pythonPath?: string;
    workerScriptPath?: string;
    audioPlayer?: IWavAudioPlayer;
    tempDir?: string;
    device?: KokoroDevice;
    voiceFr?: string;
    voiceEn?: string;
    idleTimeoutMs?: number;
  }) {
    this.pythonPath = opts?.pythonPath ?? '';
    this.explicitWorkerPath = opts?.workerScriptPath;
    this.audioPlayer = opts?.audioPlayer ?? new WavAudioPlayer();
    this.tempDir =
      opts?.tempDir ?? path.join(os.tmpdir(), `mindstream-kokoro-${process.pid}`);
    if (opts?.device) this.device = opts.device;
    if (opts?.voiceFr) this.voiceFr = opts.voiceFr;
    if (opts?.voiceEn) this.voiceEn = opts.voiceEn;
    if (opts?.idleTimeoutMs !== undefined) this.idleTimeoutMs = opts.idleTimeoutMs;
  }

  public updateConfig(config: KokoroConfig): void {
    let shouldRestartWorker = false;

    if (config.pythonPath !== undefined && config.pythonPath.trim() !== this.pythonPath) {
      this.pythonPath = config.pythonPath.trim();
      this.cachedPython = undefined;
      this.availableCache = null;
      shouldRestartWorker = true;
    }
    if (config.device !== undefined && config.device !== this.device) {
      this.device = config.device;
      shouldRestartWorker = true;
    }
    if (config.voiceFr !== undefined && config.voiceFr.trim()) {
      this.voiceFr = config.voiceFr.trim();
    }
    if (config.voiceEn !== undefined && config.voiceEn.trim()) {
      this.voiceEn = config.voiceEn.trim();
    }
    if (config.idleTimeoutMs !== undefined) {
      this.idleTimeoutMs = config.idleTimeoutMs;
    }

    if (shouldRestartWorker) {
      this.shutdownWorker();
    }
  }

  public refreshAvailability(): boolean {
    this.cachedPython = undefined;
    this.availableCache = null;
    return this.isAvailable();
  }

  public isAvailable(): boolean {
    if (this.availableCache !== null) {
      return this.availableCache;
    }
    const workerScript = this.resolveWorkerScriptPath();
    const py = this.resolvePythonExecutable();
    if (!workerScript || !py) {
      this.availableCache = false;
      return false;
    }
    try {
      execFileSync(py, [workerScript, '--check'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        windowsHide: true,
      });
      this.availableCache = true;
    } catch {
      this.availableCache = false;
    }
    return this.availableCache;
  }

  public getResolvedPythonPath(): string | null {
    return this.resolvePythonExecutable();
  }

  public warmup(): void {
    if (!this.isAvailable()) {
      return;
    }
    void this.ensureWorkerReady().catch(() => undefined);
  }

  public async synthesize(
    text: string,
    opts: KokoroSynthOptions,
  ): Promise<KokoroSynthResult | null> {
    const clean = text.trim();
    if (!clean || opts.signal?.aborted) {
      return null;
    }
    if (!this.isAvailable()) {
      return null;
    }

    // Serialize synth requests cleanly over the single stdio worker.
    let releaseQueue!: () => void;
    const prevQueue = this.synthQueue;
    this.synthQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await prevQueue;
    try {
      if (opts.signal?.aborted) {
        return null;
      }
      const ready = await this.ensureWorkerReady();
      if (!ready || opts.signal?.aborted || !this.worker?.stdin?.writable) {
        return null;
      }

      await fsp.mkdir(this.tempDir, { recursive: true });
      const id = `k${++this.reqCounter}`;
      const outPath = path.join(this.tempDir, `${id}.wav`);
      const voice = resolveKokoroVoiceForLanguage(
        opts.lang,
        opts.voice,
        this.voiceFr,
        this.voiceEn,
      );
      const speed = Math.min(2.2, Math.max(0.5, opts.rate ?? 1.0));

      return await new Promise<KokoroSynthResult | null>((resolve, reject) => {
        let settled = false;

        const finish = (res: KokoroSynthResult | null, err?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.pending.delete(id);
          opts.signal?.removeEventListener('abort', onAbort);
          this.resetIdleTimer();
          if (err) {
            void this.safeUnlink(outPath);
            reject(err);
          } else {
            resolve(res);
          }
        };

        const onAbort = () => {
          finish(null);
        };

        const timer = setTimeout(() => {
          finish(null, new Error('Kokoro synthesis timeout'));
        }, 45000);

        opts.signal?.addEventListener('abort', onAbort, { once: true });

        this.pending.set(id, {
          resolve: (res) => finish(res),
          reject: (err) => finish(null, err),
          outPath,
          timer,
        });

        try {
          const payload = JSON.stringify({
            type: 'synth',
            id,
            text: clean,
            lang: opts.lang,
            voice,
            speed,
            outPath,
          });
          this.worker?.stdin?.write(`${payload}\n`);
        } catch (err) {
          finish(null, err instanceof Error ? err : new Error(String(err)));
        }
      });
    } finally {
      releaseQueue();
    }
  }

  /**
   * Speaks a list of resolved sentences with pipelined look-ahead synthesis:
   * while sentence `i` plays on the native WAV player, sentence `i+1` is already
   * synthesized in the background so transitions stay near-zero latency even on CPU.
   */
  public async speakSentences(
    items: KokoroSpeakSentenceItem[],
    startIdx: number,
    callbacks?: KokoroSpeakSentenceCallbacks,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (items.length === 0 || signal?.aborted || !this.isAvailable()) {
      return false;
    }

    let nextSynthPromise: Promise<KokoroSynthResult | null> | null = null;
    const clampedStart = Math.min(Math.max(0, startIdx), items.length - 1);

    for (let i = clampedStart; i < items.length; i++) {
      if (signal?.aborted) {
        return true;
      }

      const item = items[i];
      callbacks?.onSentenceStart?.(i, item.text, items.length);

      const currentPromise =
        nextSynthPromise ??
        this.synthesize(item.text, {
          lang: item.lang,
          voice: item.voice,
          rate: item.rate,
          signal,
        });
      nextSynthPromise = null;

      let result: KokoroSynthResult | null;
      try {
        result = await currentPromise;
      } catch {
        return false;
      }

      if (!result || signal?.aborted) {
        if (result?.wavPath) {
          void this.safeUnlink(result.wavPath);
        }
        return Boolean(signal?.aborted);
      }

      if (i + 1 < items.length && !signal?.aborted) {
        const nextItem = items[i + 1];
        nextSynthPromise = this.synthesize(nextItem.text, {
          lang: nextItem.lang,
          voice: nextItem.voice,
          rate: nextItem.rate,
          signal,
        }).catch(() => null);
      }

      try {
        if (result.durationMs > 0) {
          await this.audioPlayer.play(result.wavPath, result.durationMs, signal);
        }
      } finally {
        void this.safeUnlink(result.wavPath);
      }
    }

    return true;
  }

  public stop(): void {
    this.audioPlayer.stop();
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      this.pending.delete(id);
      void this.safeUnlink(req.outPath);
      req.resolve(null);
    }
  }

  public dispose(): void {
    this.stop();
    this.audioPlayer.dispose();
    this.shutdownWorker();
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }

  private resolveWorkerScriptPath(): string | null {
    if (this.explicitWorkerPath && fs.existsSync(this.explicitWorkerPath)) {
      return this.explicitWorkerPath;
    }
    const candidates = [
      path.join(__dirname, 'kokoro_worker.py'),
      path.resolve(__dirname, '../src/voice/kokoro_worker.py'),
      path.resolve(__dirname, '../../src/voice/kokoro_worker.py'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private resolvePythonExecutable(): string | null {
    if (this.cachedPython !== undefined) {
      return this.cachedPython;
    }

    const isWin = process.platform === 'win32';
    const venvRel = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
    const envPython = process.env.MINDSTREAM_KOKORO_PYTHON?.trim();

    const candidates = [
      this.pythonPath.trim(),
      envPython ?? '',
      path.join(os.homedir(), '.mindstream', 'kokoro-venv', venvRel),
      path.resolve(process.cwd(), '.kokoro-venv', venvRel),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.cachedPython = candidate;
        return candidate;
      }
    }

    this.cachedPython = null;
    return null;
  }

  private async ensureWorkerReady(): Promise<boolean> {
    if (this.worker && !this.worker.killed && this.workerReadyPromise) {
      return this.workerReadyPromise;
    }

    const py = this.resolvePythonExecutable();
    const script = this.resolveWorkerScriptPath();
    if (!py || !script) {
      return false;
    }

    this.workerReadyPromise = new Promise<boolean>((resolveReady) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          resolveReady(ok);
        }
      };

      let proc: ChildProcess;
      try {
        proc = spawn(py, [script, '--device', this.device], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        settle(false);
        return;
      }

      this.worker = proc;

      if (proc.stdout) {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return;
          }
          let msg: WorkerMessage;
          try {
            msg = JSON.parse(trimmed) as WorkerMessage;
          } catch {
            return;
          }

          if (msg.type === 'ready') {
            this.resetIdleTimer();
            settle(true);
            return;
          }

          if (msg.type === 'fatal') {
            this.availableCache = false;
            settle(false);
            return;
          }

          if (msg.id) {
            const req = this.pending.get(msg.id);
            if (!req) {
              return;
            }
            this.pending.delete(msg.id);
            clearTimeout(req.timer);

            if (msg.type === 'error') {
              req.reject(new Error(msg.error || 'Kokoro synthesis error'));
            } else if (msg.type === 'audio') {
              req.resolve({
                wavPath: msg.path ?? req.outPath,
                durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : 0,
                lang: msg.lang === 'en' ? 'en' : 'fr',
                voice: msg.voice ?? 'ff_siwis',
              });
            }
          }
        });
      }

      // First run may download ~330MB Kokoro-82M weights from HuggingFace.
      const readyTimer = setTimeout(() => settle(false), 180000);

      proc.on('exit', () => {
        clearTimeout(readyTimer);
        if (this.worker === proc) {
          this.worker = null;
          this.workerReadyPromise = null;
        }
        for (const [id, req] of this.pending.entries()) {
          clearTimeout(req.timer);
          this.pending.delete(id);
          void this.safeUnlink(req.outPath);
          req.reject(new Error('Kokoro worker exited unexpectedly'));
        }
        settle(false);
      });

      proc.on('error', () => {
        clearTimeout(readyTimer);
        settle(false);
      });
    });

    return this.workerReadyPromise;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.shutdownWorker();
      }, this.idleTimeoutMs);
    }
  }

  private shutdownWorker(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) {
      const proc = this.worker;
      this.worker = null;
      this.workerReadyPromise = null;
      try {
        if (proc.stdin?.writable) {
          proc.stdin.write(JSON.stringify({ type: 'quit' }) + '\n');
        }
        proc.kill();
      } catch {
        // Ignore shutdown errors.
      }
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fsp.unlink(filePath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}
