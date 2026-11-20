import { ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';

const WIN32_WAV_PLAYER_CS = [
  'using System;',
  'using System.Media;',
  'using System.Text;',
  'using System.Threading;',
  'public class MindStreamWavPlayer {',
  '  private static readonly object Sync = new object();',
  '  private static SoundPlayer _player;',
  '  private static ManualResetEventSlim _cancelEvent;',
  '  public static void Run() {',
  '    Console.InputEncoding = Encoding.UTF8;',
  '    Console.OutputEncoding = Encoding.UTF8;',
  '    Console.WriteLine("READY");',
  '    Console.Out.Flush();',
  '    string line;',
  '    while ((line = Console.ReadLine()) != null) {',
  '      if (line == "STOP") {',
  '        CancelActive();',
  '      } else if (line == "QUIT") {',
  '        CancelActive();',
  '        break;',
  '      } else if (line.StartsWith("PLAY|")) {',
  '        var parts = line.Split(new char[] { \'|\' }, 4);',
  '        if (parts.Length == 4) {',
  '          var id = parts[1];',
  '          int durationMs;',
  '          if (!int.TryParse(parts[2], out durationMs)) durationMs = 1500;',
  '          var wavPath = Encoding.UTF8.GetString(Convert.FromBase64String(parts[3]));',
  '          CancelActive();',
  '          var cancelEv = new ManualResetEventSlim(false);',
  '          SoundPlayer sp = null;',
  '          lock (Sync) {',
  '            _cancelEvent = cancelEv;',
  '          }',
  '          try {',
  '            sp = new SoundPlayer(wavPath);',
  '            sp.Load();',
  '            lock (Sync) {',
  '              _player = sp;',
  '            }',
  '            if (!cancelEv.IsSet) {',
  '              sp.Play();',
  '              cancelEv.Wait(Math.Max(50, durationMs + 60));',
  '            }',
  '          } catch {',
  '            // Never crash worker on transient audio device errors.',
  '          } finally {',
  '            try { if (sp != null) { sp.Stop(); sp.Dispose(); } } catch { }',
  '            lock (Sync) {',
  '              if (object.ReferenceEquals(_player, sp)) _player = null;',
  '              if (object.ReferenceEquals(_cancelEvent, cancelEv)) _cancelEvent = null;',
  '            }',
  '            cancelEv.Dispose();',
  '            Console.WriteLine("DONE|" + id);',
  '            Console.Out.Flush();',
  '          }',
  '        }',
  '      }',
  '    }',
  '  }',
  '  private static void CancelActive() {',
  '    lock (Sync) {',
  '      if (_cancelEvent != null) {',
  '        try { _cancelEvent.Set(); } catch { }',
  '      }',
  '      if (_player != null) {',
  '        try { _player.Stop(); } catch { }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

export interface IWavAudioPlayer {
  play(wavPath: string, durationMs: number, signal?: AbortSignal): Promise<void>;
  stop(): void;
  dispose(): void;
}

/**
 * Cross-platform local WAV player with immediate (<10ms) abort/stop support.
 * Keeps a warm Windows SoundPlayer worker so sequential Kokoro sentences play gaplessly.
 */
export class WavAudioPlayer implements IWavAudioPlayer {
  private activePosixProcess: ChildProcess | null = null;

  private winWorker: ChildProcess | null = null;
  private winWorkerReadyPromise: Promise<boolean> | null = null;
  private readonly winPending = new Map<string, () => void>();
  private winCounter = 0;

  public async play(
    wavPath: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!wavPath || signal?.aborted) {
      return;
    }

    if (process.platform === 'win32') {
      await this.playWindowsWarm(wavPath, durationMs, signal);
      return;
    }

    this.stop();

    await new Promise<void>((resolve) => {
      let settled = false;
      let proc: ChildProcess | null = null;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.activePosixProcess === proc) {
          this.activePosixProcess = null;
        }
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        this.stop();
        finish();
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        proc = this.spawnPosixPlayer(wavPath);
      } catch {
        finish();
        return;
      }

      if (!proc) {
        finish();
        return;
      }

      this.activePosixProcess = proc;
      proc.on('exit', finish);
      proc.on('error', finish);
    });
  }

  public stop(): void {
    if (process.platform === 'win32') {
      if (this.winWorker && !this.winWorker.killed && this.winWorker.stdin?.writable) {
        try {
          this.winWorker.stdin.write('STOP\n');
        } catch {
          // Ignore pipe write errors.
        }
      }
      for (const [id, resolver] of this.winPending.entries()) {
        this.winPending.delete(id);
        resolver();
      }
      return;
    }

    if (this.activePosixProcess) {
      const proc = this.activePosixProcess;
      this.activePosixProcess = null;
      try {
        proc.kill();
      } catch {
        // Ignore kill errors.
      }
    }
  }

  public dispose(): void {
    this.stop();
    if (this.winWorker) {
      const proc = this.winWorker;
      this.winWorker = null;
      this.winWorkerReadyPromise = null;
      try {
        if (proc.stdin?.writable) {
          proc.stdin.write('QUIT\n');
        }
        proc.kill();
      } catch {
        // Ignore disposal errors.
      }
    }
  }

  private async ensureWinWorkerReady(): Promise<boolean> {
    if (this.winWorker && !this.winWorker.killed && this.winWorkerReadyPromise) {
      return this.winWorkerReadyPromise;
    }

    const encodedScript = Buffer.from(WIN32_WAV_PLAYER_CS, 'utf8').toString('base64');
    const psCmd =
      `$src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedScript}')); ` +
      'Add-Type -TypeDefinition $src; ' +
      '[MindStreamWavPlayer]::Run()';

    this.winWorkerReadyPromise = new Promise<boolean>((resolveReady) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolveReady(ok);
        }
      };

      let proc: ChildProcess;
      try {
        proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch {
        settle(false);
        return;
      }

      this.winWorker = proc;

      if (proc.stdout) {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (trimmed === 'READY') {
            settle(true);
          } else if (trimmed.startsWith('DONE|')) {
            const id = trimmed.slice(5);
            const resolver = this.winPending.get(id);
            if (resolver) {
              this.winPending.delete(id);
              resolver();
            }
          }
        });
      }

      const startupTimer = setTimeout(() => settle(true), 4000);

      proc.on('exit', () => {
        clearTimeout(startupTimer);
        if (this.winWorker === proc) {
          this.winWorker = null;
          this.winWorkerReadyPromise = null;
        }
        for (const [id, resolver] of this.winPending.entries()) {
          this.winPending.delete(id);
          resolver();
        }
        settle(false);
      });

      proc.on('error', () => {
        clearTimeout(startupTimer);
        settle(false);
      });
    });

    return this.winWorkerReadyPromise;
  }

  private async playWindowsWarm(
    wavPath: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const ok = await this.ensureWinWorkerReady();
    if (!ok || signal?.aborted || !this.winWorker?.stdin?.writable) {
      return;
    }

    const id = `wp${++this.winCounter}`;
    const b64Path = Buffer.from(wavPath, 'utf8').toString('base64');
    const safeDuration = Math.max(80, Math.round(durationMs));

    await new Promise<void>((resolve) => {
      let settled = false;
      const safetyMs = safeDuration + 4500;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(safetyTimer);
        this.winPending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        if (this.winWorker?.stdin?.writable) {
          try {
            this.winWorker.stdin.write('STOP\n');
          } catch {
            // Ignore write error.
          }
        }
        finish();
      };

      const safetyTimer = setTimeout(finish, safetyMs);
      this.winPending.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.winWorker?.stdin?.write(`PLAY|${id}|${safeDuration}|${b64Path}\n`);
      } catch {
        finish();
      }
    });
  }

  private spawnPosixPlayer(wavPath: string): ChildProcess | null {
    if (process.platform === 'darwin') {
      return spawn('afplay', [wavPath], { stdio: 'ignore' });
    }

    if (process.platform === 'linux') {
      const proc = spawn('paplay', [wavPath], { stdio: 'ignore' });
      proc.on('error', () => {
        try {
          const fallback = spawn('aplay', ['-q', wavPath], { stdio: 'ignore' });
          this.activePosixProcess = fallback;
          fallback.on('error', () => {
            try {
              const ff = spawn(
                'ffplay',
                ['-nodisp', '-autoexit', '-loglevel', 'quiet', wavPath],
                { stdio: 'ignore' },
              );
              this.activePosixProcess = ff;
            } catch {
              // No POSIX WAV player installed.
            }
          });
        } catch {
          // Ignore fallback errors.
        }
      });
      return proc;
    }

    return null;
  }
}
