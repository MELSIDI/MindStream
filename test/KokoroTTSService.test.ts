import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KokoroTTSService,
  resolveKokoroVoiceForLanguage,
} from '../src/voice/KokoroTTSService';
import { NativeTTSFallback } from '../src/voice/NativeTTSFallback';
import { VoiceCoordinator } from '../src/voice/VoiceCoordinator';
import { IWavAudioPlayer } from '../src/voice/WavAudioPlayer';

class RecordingWavPlayer implements IWavAudioPlayer {
  public readonly played: Array<{ wavPath: string; durationMs: number; existed: boolean }> = [];
  public stopCalls = 0;
  public disposeCalls = 0;

  constructor(private readonly playDelayMs = 25) {}

  async play(wavPath: string, durationMs: number, signal?: AbortSignal): Promise<void> {
    let existed = false;
    try {
      await fs.access(wavPath);
      existed = true;
    } catch {
      existed = false;
    }
    this.played.push({ wavPath, durationMs, existed });
    if (signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.playDelayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  stop(): void {
    this.stopCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

const FAKE_KOKORO_WORKER_JS = `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv.includes('--check')) {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
  process.exit(0);
}

process.stdout.write(JSON.stringify({ type: 'ready', device: 'cpu', repoId: 'hexgrad/Kokoro-82M' }) + '\\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const cmd = JSON.parse(trimmed);
  if (cmd.type === 'quit') {
    process.exit(0);
  }
  if (cmd.type === 'synth') {
    fs.mkdirSync(path.dirname(cmd.outPath), { recursive: true });
    // Minimal 44-byte WAV header + silent sample
    const buf = Buffer.alloc(48, 0);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(40, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(24000, 24);
    buf.writeUInt32LE(48000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(4, 40);
    fs.writeFileSync(cmd.outPath, buf);

    const logFile = process.env.FAKE_KOKORO_LOG;
    if (logFile) {
      fs.appendFileSync(logFile, JSON.stringify({ text: cmd.text, lang: cmd.lang, voice: cmd.voice, speed: cmd.speed }) + '\\n');
    }

    process.stdout.write(JSON.stringify({
      type: 'audio',
      id: cmd.id,
      path: cmd.outPath,
      durationMs: 35,
      lang: cmd.lang,
      voice: cmd.voice,
    }) + '\\n');
  }
});
`;

describe('KokoroTTSService & VoiceCoordinator auto FR/EN switching', () => {
  const tempDirs: string[] = [];
  const disposables: Array<{ dispose(): void }> = [];

  afterEach(async () => {
    for (const d of disposables.splice(0)) {
      d.dispose();
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    delete process.env.FAKE_KOKORO_LOG;
  });

  it('maps French and English voices safely without cross-language mismatch', () => {
    expect(resolveKokoroVoiceForLanguage('fr', undefined)).toBe('ff_siwis');
    expect(resolveKokoroVoiceForLanguage('fr', 'af_heart')).toBe('ff_siwis');
    expect(resolveKokoroVoiceForLanguage('en', undefined)).toBe('af_heart');
    expect(resolveKokoroVoiceForLanguage('en', 'ff_siwis')).toBe('af_heart');
    expect(resolveKokoroVoiceForLanguage('en', 'kokoro:bf_emma')).toBe('bf_emma');
  });

  it('synthesizes, pre-fetches next sentence, cleans temp wav files, and switches FR/EN automatically', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-kokoro-test-'));
    tempDirs.push(tmpDir);

    const workerJs = path.join(tmpDir, 'fake_worker.js');
    const logPath = path.join(tmpDir, 'worker-calls.jsonl');
    await fs.writeFile(workerJs, FAKE_KOKORO_WORKER_JS, 'utf8');
    process.env.FAKE_KOKORO_LOG = logPath;

    const player = new RecordingWavPlayer(20);
    const kokoro = new KokoroTTSService({
      pythonPath: process.execPath,
      workerScriptPath: workerJs,
      audioPlayer: player,
      tempDir: path.join(tmpDir, 'wavs'),
    });
    disposables.push(kokoro);

    const nativeCalls: Array<{ text: string; lang: 'fr' | 'en' }> = [];
    const fakeNative = {
      isAvailable: () => true,
      speak: async (text: string, lang: 'fr' | 'en') => {
        nativeCalls.push({ text, lang });
      },
      stop: () => {},
      dispose: () => {},
    } as unknown as NativeTTSFallback;

    const coordinator = new VoiceCoordinator({
      kokoroTTS: kokoro,
      nativeTTS: fakeNative,
    });
    disposables.push(coordinator);

    expect(coordinator.isKokoroAvailable()).toBe(true);
    expect(coordinator.getBackendLabel()).toContain('Kokoro-82M');
    expect(coordinator.getAvailableVoices()[0]?.id).toBe('kokoro-auto');

    // User selected an English voice, yet sentence 1 is French and sentence 2 is English:
    // intelligent per-utterance detection must switch sentence 1 to ff_siwis and keep bf_emma on sentence 2!
    coordinator.setSelectedVoiceId('kokoro:bf_emma');

    const startedSentences: string[] = [];
    await coordinator.speakSentences(
      'Voici pourquoi nous utilisons une Map ici. Now we validate the incoming payload cleanly.',
      {
        lang: 'fr',
        rate: 1.15,
        onSentenceStart: (_idx, txt) => startedSentences.push(txt),
      },
    );

    expect(startedSentences).toHaveLength(2);
    expect(player.played).toHaveLength(2);
    expect(player.played.every((p) => p.existed)).toBe(true);
    expect(nativeCalls).toHaveLength(0);

    // Temp WAV files must be deleted after playback.
    await new Promise((r) => setTimeout(r, 40));
    const remainingWavs = await fs.readdir(path.join(tmpDir, 'wavs'));
    expect(remainingWavs).toEqual([]);

    const logLines = (await fs.readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; lang: string; voice: string; speed: number });

    expect(logLines).toEqual([
      {
        text: 'Voici pourquoi nous utilisons une Map ici.',
        lang: 'fr',
        voice: 'ff_siwis',
        speed: 1.15,
      },
      {
        text: 'Now we validate the incoming payload cleanly.',
        lang: 'en',
        voice: 'bf_emma',
        speed: 1.15,
      },
    ]);
  });

  it('aborts playback immediately via AbortSignal and falls back cleanly when Kokoro is unavailable', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-kokoro-abort-'));
    tempDirs.push(tmpDir);

    const workerJs = path.join(tmpDir, 'fake_worker.js');
    await fs.writeFile(workerJs, FAKE_KOKORO_WORKER_JS, 'utf8');

    const player = new RecordingWavPlayer(250);
    const kokoro = new KokoroTTSService({
      pythonPath: process.execPath,
      workerScriptPath: workerJs,
      audioPlayer: player,
      tempDir: path.join(tmpDir, 'wavs'),
    });
    disposables.push(kokoro);

    const ac = new AbortController();
    const speakPromise = kokoro.speakSentences(
      [
        { text: 'First sentence.', lang: 'en', voice: 'af_heart', rate: 1.0 },
        { text: 'Second sentence.', lang: 'en', voice: 'af_heart', rate: 1.0 },
      ],
      0,
      undefined,
      ac.signal,
    );

    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    await speakPromise;

    // Aborted during sentence 1 -> sentence 2 must never play.
    expect(player.played.length).toBeLessThanOrEqual(1);

    // Unavailable Kokoro falls back seamlessly to native TTS.
    const unavailableKokoro = new KokoroTTSService({
      pythonPath: path.join(tmpDir, 'missing-python'),
      workerScriptPath: workerJs,
      audioPlayer: new RecordingWavPlayer(),
    });
    disposables.push(unavailableKokoro);

    const fallbackCalls: Array<{ text: string; lang: 'fr' | 'en' }> = [];
    const fakeNative = {
      isAvailable: () => true,
      speak: async (text: string, lang: 'fr' | 'en') => {
        fallbackCalls.push({ text, lang });
      },
      stop: () => {},
      dispose: () => {},
    } as unknown as NativeTTSFallback;

    const fallbackCoordinator = new VoiceCoordinator({
      kokoroTTS: unavailableKokoro,
      nativeTTS: fakeNative,
    });
    disposables.push(fallbackCoordinator);

    expect(fallbackCoordinator.isKokoroAvailable()).toBe(false);
    expect(fallbackCoordinator.getBackendLabel()).toBe('Synthèse OS Native');

    await fallbackCoordinator.speakSentences('Why is this cached here?', {
      lang: 'fr',
      rate: 1.0,
    });
    expect(fallbackCalls).toEqual([{ text: 'Why is this cached here?', lang: 'en' }]);
  });
});
