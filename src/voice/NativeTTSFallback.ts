import { ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';

const WIN32_CSHARP_WORKER = [
  'using System;',
  'using System.Collections.Concurrent;',
  'using System.Speech.Synthesis;',
  'using System.Text;',
  'public class CodePaceTTS {',
  '  public static void Run() {',
  '    Console.InputEncoding = Encoding.UTF8;',
  '    Console.OutputEncoding = Encoding.UTF8;',
  '    using (var synth = new SpeechSynthesizer()) {',
  '      try { synth.SetOutputToDefaultAudioDevice(); } catch { }',
  '      var ids = new ConcurrentDictionary<Prompt, string>();',
  '      var voices = synth.GetInstalledVoices();',
  '      synth.SpeakCompleted += (sender, e) => {',
  '        string id;',
  '        if (e.Prompt != null && ids.TryRemove(e.Prompt, out id)) {',
  '          Console.WriteLine("DONE|" + id);',
  '          Console.Out.Flush();',
  '        }',
  '      };',
  '      Console.WriteLine("READY");',
  '      Console.Out.Flush();',
  '      string line;',
  '      while ((line = Console.ReadLine()) != null) {',
  '        if (line == "STOP") {',
  '          synth.SpeakAsyncCancelAll();',
  '        } else if (line == "QUIT") {',
  '          synth.SpeakAsyncCancelAll();',
  '          break;',
  '        } else if (line.StartsWith("SPEAK|")) {',
  '          var parts = line.Split(new char[] { \'|\' }, 5);',
  '          if (parts.Length == 5) {',
  '            var id = parts[1];',
  '            int rate;',
  '            if (!int.TryParse(parts[2], out rate)) rate = 0;',
  '            rate = Math.Max(-10, Math.Min(10, rate));',
  '            var lang = parts[3];',
  '            var text = Encoding.UTF8.GetString(Convert.FromBase64String(parts[4]));',
  '            synth.SpeakAsyncCancelAll();',
  '            foreach (var v in voices) {',
  '              if (v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName.Equals(lang, StringComparison.OrdinalIgnoreCase)) {',
  '                try { synth.SelectVoice(v.VoiceInfo.Name); } catch { }',
  '                break;',
  '              }',
  '            }',
  '            synth.Rate = rate;',
  '            var p = new Prompt(text);',
  '            ids[p] = id;',
  '            synth.SpeakAsync(p);',
  '          }',
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

export class NativeTTSFallback {
  private activeProcess: ChildProcess | null = null;
  private aborted = false;

  // Warm persistent Windows SAPI worker state
  private winWorker: ChildProcess | null = null;
  private winWorkerReadyPromise: Promise<boolean> | null = null;
  private winPendingUtterances = new Map<string, () => void>();
  private winUtteranceCounter = 0;

  public async speak(
    text: string,
    lang: 'fr' | 'en',
    rate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const clean = text.trim();
    if (!clean || signal?.aborted) {
      return;
    }

    if (process.platform === 'win32') {
      await this.speakWindowsWarm(clean, lang, rate, signal);
      return;
    }

    this.stop();
    this.aborted = false;

    return new Promise<void>((resolve) => {
      let proc: ChildProcess | null = null;
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        this.aborted = true;
        this.stop();
        finish();
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        proc = this.spawnPosixSpeechProcess(clean, lang, rate);
      } catch {
        finish();
        return;
      }

      if (!proc) {
        finish();
        return;
      }

      this.activeProcess = proc;
      proc.on('exit', finish);
      proc.on('error', finish);
    });
  }

  public stop(): void {
    this.aborted = true;

    if (process.platform === 'win32') {
      if (this.winWorker && !this.winWorker.killed && this.winWorker.stdin?.writable) {
        try {
          this.winWorker.stdin.write('STOP\n');
        } catch {
          // Ignore pipe errors.
        }
      }
      for (const [id, resolve] of this.winPendingUtterances.entries()) {
        this.winPendingUtterances.delete(id);
        resolve();
      }
      return;
    }

    if (this.activeProcess) {
      const proc = this.activeProcess;
      this.activeProcess = null;
      try {
        proc.kill();
      } catch {
        // Ignore process termination errors.
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

  public isAvailable(): boolean {
    return (
      process.platform === 'win32' ||
      process.platform === 'darwin' ||
      process.platform === 'linux'
    );
  }

  private async ensureWinWorkerReady(): Promise<boolean> {
    if (this.winWorker && !this.winWorker.killed && this.winWorkerReadyPromise) {
      return this.winWorkerReadyPromise;
    }

    const encodedScript = Buffer.from(WIN32_CSHARP_WORKER, 'utf8').toString('base64');
    const psCmd =
      `$src = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedScript}')); ` +
      'Add-Type -ReferencedAssemblies System.Speech -TypeDefinition $src; ' +
      '[CodePaceTTS]::Run()';

    this.winWorkerReadyPromise = new Promise<boolean>((resolveReady) => {
      let readySettled = false;
      const settleReady = (ok: boolean) => {
        if (!readySettled) {
          readySettled = true;
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
        settleReady(false);
        return;
      }

      this.winWorker = proc;

      if (proc.stdout) {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (trimmed === 'READY') {
            settleReady(true);
          } else if (trimmed.startsWith('DONE|')) {
            const id = trimmed.slice(5);
            const resolver = this.winPendingUtterances.get(id);
            if (resolver) {
              this.winPendingUtterances.delete(id);
              resolver();
            }
          }
        });
      }

      const startupTimeout = setTimeout(() => settleReady(true), 4000);

      proc.on('exit', () => {
        clearTimeout(startupTimeout);
        if (this.winWorker === proc) {
          this.winWorker = null;
          this.winWorkerReadyPromise = null;
        }
        for (const [id, resolver] of this.winPendingUtterances.entries()) {
          this.winPendingUtterances.delete(id);
          resolver();
        }
        settleReady(false);
      });

      proc.on('error', () => {
        clearTimeout(startupTimeout);
        settleReady(false);
      });
    });

    return this.winWorkerReadyPromise;
  }

  private async speakWindowsWarm(
    text: string,
    lang: 'fr' | 'en',
    rate: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const ok = await this.ensureWinWorkerReady();
    if (!ok || signal?.aborted || !this.winWorker?.stdin?.writable) {
      return;
    }

    const id = `w${++this.winUtteranceCounter}`;
    const sapiRate = Math.max(-10, Math.min(10, Math.round((rate - 1.0) * 5)));
    const culturePrefix = lang === 'fr' ? 'fr' : 'en';
    const b64 = Buffer.from(text, 'utf8').toString('base64');

    return new Promise<void>((resolve) => {
      let settled = false;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const safetyMs = Math.max(5000, Math.round((wordCount / 1.8) * 1000) + 4000);

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(safetyTimer);
        this.winPendingUtterances.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        if (this.winWorker?.stdin?.writable) {
          try {
            this.winWorker.stdin.write('STOP\n');
          } catch {
            // Ignore write errors.
          }
        }
        finish();
      };

      const safetyTimer = setTimeout(finish, safetyMs);
      this.winPendingUtterances.set(id, finish);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.winWorker?.stdin?.write(`SPEAK|${id}|${sapiRate}|${culturePrefix}|${b64}\n`);
      } catch {
        finish();
      }
    });
  }

  private spawnPosixSpeechProcess(
    text: string,
    lang: 'fr' | 'en',
    rate: number,
  ): ChildProcess | null {
    if (process.platform === 'darwin') {
      const wpm = Math.max(90, Math.min(340, Math.round(175 * rate)));
      return spawn('say', ['-r', String(wpm), text], { stdio: 'ignore' });
    }

    if (process.platform === 'linux') {
      const spdRate = Math.max(-100, Math.min(100, Math.round((rate - 1.0) * 60)));
      const child = spawn('spd-say', ['-w', '-l', lang, '-r', String(spdRate), text], {
        stdio: 'ignore',
      });
      child.on('error', () => {
        if (!this.aborted) {
          const wpm = Math.max(90, Math.min(340, Math.round(165 * rate)));
          try {
            const fallback = spawn('espeak-ng', ['-v', lang, '-s', String(wpm), text], {
              stdio: 'ignore',
            });
            this.activeProcess = fallback;
          } catch {
            // No Linux TTS installed.
          }
        }
      });
      return child;
    }

    return null;
  }
}
