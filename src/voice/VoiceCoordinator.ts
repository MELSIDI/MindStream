import { IVoiceAdapter, SpeakOptions } from '../engine/PlaybackEngine';
import { estimateSpeechDurationMs, splitSentences } from '../engine/SentenceSplitter';
import { ExtensionToWebviewMessage, VoiceOptionInfo } from '../types/session';
import { GeminiTTSService } from './GeminiTTSService';
import { NativeTTSFallback } from './NativeTTSFallback';

export type TTSProviderSetting = 'auto' | 'webspeech' | 'native' | 'gemini';

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

  private readonly nativeTTS = new NativeTTSFallback();
  private readonly geminiTTS = new GeminiTTSService();
  private readonly pendingUtterances = new Map<string, PendingUtterance>();
  private utteranceCounter = 0;
  private onMetadataChanged: (() => void) | null = null;

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

  public updateSettings(opts: {
    ttsProvider?: TTSProviderSetting;
    geminiApiKey?: string | null;
    geminiVoice?: string;
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
    this.onMetadataChanged?.();
  }

  public handleWebviewVoices(voices: VoiceOptionInfo[]): void {
    this.webviewVoices = voices;
    if (this.selectedVoiceId && !voices.some((v) => v.id === this.selectedVoiceId)) {
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
    const list: VoiceOptionInfo[] = [...this.webviewVoices];
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

    for (let i = startIdx; i < sentences.length; i++) {
      if (options.signal?.aborted) {
        return;
      }

      const sentence = sentences[i];
      options.onSentenceStart?.(i, sentence, sentences.length);
      await this.speakSingleSentence(sentence, options);

      if (options.signal?.aborted) {
        return;
      }
    }
  }

  private async speakSingleSentence(
    sentence: string,
    options: SpeakOptions,
  ): Promise<void> {
    const backend = this.resolveBackend();

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

  private resolveBackend(): 'gemini' | 'webspeech' | 'native' {
    if (this.selectedVoiceId === 'native-os') {
      return 'native';
    }
    if (this.selectedVoiceId?.startsWith('gemini-') && this.geminiApiKey && this.webviewReady) {
      return 'gemini';
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
