import { IVoiceAdapter, SpeakOptions } from '../engine/PlaybackEngine';
import { estimateSpeechDurationMs, splitSentences } from '../engine/SentenceSplitter';
import { ExtensionToWebviewMessage, VoiceOptionInfo } from '../types/session';
import { GeminiTTSService } from './GeminiTTSService';
import {
  KOKORO_VOICES_CATALOG,
  KokoroDevice,
  KokoroSpeakSentenceItem,
  KokoroTTSService,
  resolveKokoroVoiceForLanguage,
} from './KokoroTTSService';
import { resolveUtteranceLanguage } from './LanguageDetector';
import { NativeTTSFallback } from './NativeTTSFallback';

export type TTSProviderSetting = 'auto' | 'kokoro' | 'webspeech' | 'native' | 'gemini';

interface PendingUtterance {
  resolve: () => void;
  sentenceText: string;
  onWordBoundary?: (charIndex: number, charLength: number, sentenceText: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VoiceCoordinator implements IVoiceAdapter {
  private webviewSender: ((msg: ExtensionToWebviewMessage) => void) | null = null;
  private webviewReady = false;
  private webviewVoices: VoiceOptionInfo[] = [];
  private selectedVoiceId: string | null = null;

  private ttsProvider: TTSProviderSetting = 'auto';
  private geminiApiKey: string | null = null;
  private geminiVoice = 'Kore';
  private kokoroVoiceFr = 'ff_siwis';
  private kokoroVoiceEn = 'af_heart';
  private autoDetectSpeechLanguage = true;

  private readonly kokoroTTS: KokoroTTSService;
  private readonly nativeTTS: NativeTTSFallback;
  private readonly geminiTTS: GeminiTTSService;
  private readonly pendingUtterances = new Map<string, PendingUtterance>();
  private utteranceCounter = 0;
  private onMetadataChanged: (() => void) | null = null;

  constructor(deps?: {
    kokoroTTS?: KokoroTTSService;
    nativeTTS?: NativeTTSFallback;
    geminiTTS?: GeminiTTSService;
  }) {
    this.kokoroTTS = deps?.kokoroTTS ?? new KokoroTTSService();
    this.nativeTTS = deps?.nativeTTS ?? new NativeTTSFallback();
    this.geminiTTS = deps?.geminiTTS ?? new GeminiTTSService();
  }

  public attachWebview(sender: (msg: ExtensionToWebviewMessage) => void): void {
    this.webviewSender = sender;
  }

  public setWebviewReady(ready: boolean): void {
    this.webviewReady = ready;
    this.onMetadataChanged?.();
  }

  public setOnMetadataChanged(cb: () => void): void {
    this.onMetadataChanged = cb;
  }

  public isKokoroAvailable(): boolean {
    return this.kokoroTTS.isAvailable();
  }

  public refreshKokoroAvailability(): boolean {
    const ok = this.kokoroTTS.refreshAvailability();
    this.onMetadataChanged?.();
    return ok;
  }

  public warmup(): void {
    const backend = this.resolveBackend();
    if (backend === 'kokoro') {
      this.kokoroTTS.warmup();
    }
  }

  public updateSettings(opts: {
    ttsProvider?: TTSProviderSetting;
    geminiApiKey?: string | null;
    geminiVoice?: string;
    kokoroVoiceFr?: string;
    kokoroVoiceEn?: string;
    kokoroPythonPath?: string;
    kokoroDevice?: KokoroDevice;
    autoDetectSpeechLanguage?: boolean;
  }): void {
    if (opts.ttsProvider !== undefined) {
      this.ttsProvider = opts.ttsProvider;
    }
    if (opts.geminiApiKey !== undefined) {
      this.geminiApiKey = opts.geminiApiKey;
    }
    if (opts.geminiVoice !== undefined) {
      this.geminiVoice = opts.geminiVoice;
    }
    if (opts.kokoroVoiceFr !== undefined && opts.kokoroVoiceFr.trim()) {
      this.kokoroVoiceFr = opts.kokoroVoiceFr.trim();
    }
    if (opts.kokoroVoiceEn !== undefined && opts.kokoroVoiceEn.trim()) {
      this.kokoroVoiceEn = opts.kokoroVoiceEn.trim();
    }
    if (opts.autoDetectSpeechLanguage !== undefined) {
      this.autoDetectSpeechLanguage = opts.autoDetectSpeechLanguage;
    }

    this.kokoroTTS.updateConfig({
      pythonPath: opts.kokoroPythonPath,
      device: opts.kokoroDevice,
      voiceFr: this.kokoroVoiceFr,
      voiceEn: this.kokoroVoiceEn,
    });

    this.onMetadataChanged?.();
  }

  public handleWebviewVoices(voices: VoiceOptionInfo[]): void {
    this.webviewVoices = voices;
    if (
      this.selectedVoiceId &&
      !this.selectedVoiceId.startsWith('kokoro') &&
      this.selectedVoiceId !== 'native-os' &&
      !this.selectedVoiceId.startsWith('gemini-') &&
      !voices.some((v) => v.id === this.selectedVoiceId)
    ) {
      this.selectedVoiceId = null;
    }
    this.onMetadataChanged?.();
  }

  public setSelectedVoiceId(voiceId: string | null): void {
    this.selectedVoiceId = voiceId || null;
    this.onMetadataChanged?.();
  }

  public getSelectedVoiceId(): string | null {
    return this.selectedVoiceId;
  }

  public getAvailableVoices(): VoiceOptionInfo[] {
    const list: VoiceOptionInfo[] = [];

    if (this.kokoroTTS.isAvailable()) {
      list.push({
        id: 'kokoro-auto',
        name: 'Kokoro-82M Local (Auto FR / EN)',
        lang: 'multi',
        source: 'kokoro',
      });
      for (const v of KOKORO_VOICES_CATALOG) {
        list.push({
          id: v.id,
          name: v.name,
          lang: v.lang,
          source: 'kokoro',
        });
      }
    }

    list.push(...this.webviewVoices);

    if (this.nativeTTS.isAvailable()) {
      list.push({
        id: 'native-os',
        name:
          process.platform === 'win32'
            ? 'Voix Système Windows (SAPI)'
            : process.platform === 'darwin'
              ? 'Voix Système macOS (say)'
              : 'Voix Système Linux',
        lang: 'multi',
        source: 'native',
      });
    }
    if (this.geminiApiKey) {
      list.push({
        id: `gemini-${this.geminiVoice}`,
        name: `Gemini 3.8 TTS (${this.geminiVoice})`,
        lang: 'multi',
        source: 'gemini',
      });
    }
    return list;
  }

  public getBackendLabel(): string {
    const resolved = this.resolveBackend();
    if (resolved === 'kokoro') {
      if (this.selectedVoiceId?.startsWith('kokoro:')) {
        return `Kokoro-82M (${this.selectedVoiceId.slice(7)})`;
      }
      return 'Kokoro-82M Local (Auto FR/EN)';
    }
    if (resolved === 'gemini') {
      return `Gemini 3.8 TTS (${this.geminiVoice})`;
    }
    if (resolved === 'webspeech') {
      return `Web Speech (${this.webviewVoices.length} voix)`;
    }
    return 'Synthèse OS Native';
  }

  public handleWebviewBoundary(
    utteranceId: string,
    charIndex: number,
    charLength: number,
  ): void {
    const entry = this.pendingUtterances.get(utteranceId);
    if (!entry) {
      return;
    }
    entry.onWordBoundary?.(charIndex, charLength, entry.sentenceText);
  }

  public handleWebviewEnded(utteranceId: string): void {
    const entry = this.pendingUtterances.get(utteranceId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pendingUtterances.delete(utteranceId);
    entry.resolve();
  }

  public handleWebviewError(utteranceId: string): void {
    this.handleWebviewEnded(utteranceId);
  }

  public stopImmediately(): void {
    this.kokoroTTS.stop();
    this.nativeTTS.stop();
    if (this.webviewSender && this.webviewReady) {
      this.webviewSender({ type: 'ttsStop' });
    }
    for (const [id, entry] of this.pendingUtterances.entries()) {
      clearTimeout(entry.timer);
      this.pendingUtterances.delete(id);
      entry.resolve();
    }
  }

  public dispose(): void {
    this.stopImmediately();
    this.kokoroTTS.dispose();
    this.nativeTTS.dispose();
  }

  public async speakSentences(text: string, options: SpeakOptions): Promise<void> {
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      return;
    }

    const startIdx = Math.min(
      Math.max(0, options.startSentenceIndex ?? 0),
      sentences.length - 1,
    );

    const resolvedSentences = sentences.map((sentence) => ({
      text: sentence,
      lang: resolveUtteranceLanguage(sentence, options.lang, this.autoDetectSpeechLanguage),
    }));

    let resumeIdx = startIdx;
    const backend = this.resolveBackend();

    if (backend === 'kokoro') {
      const explicitVoice =
        this.selectedVoiceId && this.selectedVoiceId.startsWith('kokoro:')
          ? this.selectedVoiceId.slice(7)
          : undefined;

      const kokoroItems: KokoroSpeakSentenceItem[] = resolvedSentences.map((item) => ({
        text: item.text,
        lang: item.lang,
        voice: resolveKokoroVoiceForLanguage(
          item.lang,
          explicitVoice,
          this.kokoroVoiceFr,
          this.kokoroVoiceEn,
        ),
        rate: options.rate,
      }));

      let lastStartedIdx = startIdx;
      const handled = await this.kokoroTTS.speakSentences(
        kokoroItems,
        startIdx,
        {
          onSentenceStart: (idx, sentenceText, total) => {
            lastStartedIdx = idx;
            options.onSentenceStart?.(idx, sentenceText, total);
          },
        },
        options.signal,
      );

      if (handled || options.signal?.aborted) {
        return;
      }

      resumeIdx = lastStartedIdx;
    }

    const fallbackBackend = backend === 'kokoro' ? this.resolveNonKokoroFallback() : backend;

    for (let i = resumeIdx; i < resolvedSentences.length; i++) {
      if (options.signal?.aborted) {
        return;
      }

      const item = resolvedSentences[i];
      options.onSentenceStart?.(i, item.text, resolvedSentences.length);
      await this.speakSingleSentence(item.text, { ...options, lang: item.lang }, fallbackBackend);

      if (options.signal?.aborted) {
        return;
      }
    }
  }

  private async speakSingleSentence(
    sentence: string,
    options: SpeakOptions,
    backend: 'gemini' | 'webspeech' | 'native',
  ): Promise<void> {
    if (backend === 'gemini' && this.geminiApiKey && this.webviewSender && this.webviewReady) {
      try {
        const audio = await this.geminiTTS.synthesize(
          this.geminiApiKey,
          sentence,
          options.lang,
          this.geminiVoice,
          options.signal,
        );
        if (audio && !options.signal?.aborted) {
          await this.playAudioViaWebview(audio.base64Audio, audio.mimeType, sentence, options);
          return;
        }
      } catch {
        // Fall through to Web Speech or OS native TTS.
      }
    }

    if (backend === 'webspeech' && this.webviewSender && this.webviewReady) {
      await this.speakViaWebview(sentence, options);
      return;
    }

    await this.nativeTTS.speak(sentence, options.lang, options.rate, options.signal);
  }

  private resolveNonKokoroFallback(): 'gemini' | 'webspeech' | 'native' {
    if (this.ttsProvider === 'gemini' && this.geminiApiKey && this.webviewReady) {
      return 'gemini';
    }
    if (this.webviewReady && this.webviewSender && this.webviewVoices.length > 0) {
      return 'webspeech';
    }
    return 'native';
  }

  private resolveBackend(): 'kokoro' | 'gemini' | 'webspeech' | 'native' {
    if (this.selectedVoiceId === 'native-os') {
      return 'native';
    }
    if (
      (this.selectedVoiceId === 'kokoro-auto' || this.selectedVoiceId?.startsWith('kokoro:')) &&
      this.kokoroTTS.isAvailable()
    ) {
      return 'kokoro';
    }
    if (this.selectedVoiceId?.startsWith('gemini-') && this.geminiApiKey && this.webviewReady) {
      return 'gemini';
    }
    if (this.ttsProvider === 'kokoro') {
      return this.kokoroTTS.isAvailable() ? 'kokoro' : this.resolveNonKokoroFallback();
    }
    if (this.ttsProvider === 'native') {
      return 'native';
    }
    if (this.ttsProvider === 'gemini' && this.geminiApiKey && this.webviewReady) {
      return 'gemini';
    }
    if (this.ttsProvider === 'webspeech' && this.webviewReady && this.webviewSender) {
      return 'webspeech';
    }

    if (this.kokoroTTS.isAvailable()) {
      return 'kokoro';
    }
    if (this.webviewReady && this.webviewSender && this.webviewVoices.length > 0) {
      return 'webspeech';
    }
    return 'native';
  }

  private speakViaWebview(sentence: string, options: SpeakOptions): Promise<void> {
    if (!this.webviewSender || options.signal?.aborted) {
      return Promise.resolve();
    }

    const utteranceId = `utt-${++this.utteranceCounter}`;
    const timeoutMs = estimateSpeechDurationMs(sentence, options.rate) * 2.5 + 4500;

    return new Promise<void>((resolve) => {
      const finish = () => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        const entry = this.pendingUtterances.get(utteranceId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingUtterances.delete(utteranceId);
        }
        this.webviewSender?.({ type: 'ttsStop' });
        finish();
      };

      const timer = setTimeout(() => {
        this.pendingUtterances.delete(utteranceId);
        finish();
      }, timeoutMs);

      this.pendingUtterances.set(utteranceId, {
        resolve: finish,
        sentenceText: sentence,
        onWordBoundary: options.onWordBoundary,
        timer,
      });

      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.webviewSender?.({
        type: 'ttsSpeak',
        utteranceId,
        text: sentence,
        lang: options.lang === 'fr' ? 'fr-FR' : 'en-US',
        rate: options.rate,
        voiceId:
          this.selectedVoiceId &&
          !this.selectedVoiceId.startsWith('kokoro') &&
          this.selectedVoiceId !== 'native-os' &&
          !this.selectedVoiceId.startsWith('gemini-')
            ? this.selectedVoiceId
            : undefined,
      });
    });
  }

  private playAudioViaWebview(
    base64Audio: string,
    mimeType: string,
    sentence: string,
    options: SpeakOptions,
  ): Promise<void> {
    if (!this.webviewSender || options.signal?.aborted) {
      return Promise.resolve();
    }

    const utteranceId = `aud-${++this.utteranceCounter}`;
    const timeoutMs = estimateSpeechDurationMs(sentence, 1.0) * 2.5 + 5000;

    return new Promise<void>((resolve) => {
      const finish = () => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        const entry = this.pendingUtterances.get(utteranceId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingUtterances.delete(utteranceId);
        }
        this.webviewSender?.({ type: 'ttsStop' });
        finish();
      };

      const timer = setTimeout(() => {
        this.pendingUtterances.delete(utteranceId);
        finish();
      }, timeoutMs);

      this.pendingUtterances.set(utteranceId, {
        resolve: finish,
        sentenceText: sentence,
        onWordBoundary: options.onWordBoundary,
        timer,
      });

      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.webviewSender?.({
        type: 'ttsPlayAudio',
        utteranceId,
        base64Audio,
        mimeType,
      });
    });
  }
}
