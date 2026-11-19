import { VoiceOptionInfo, WebviewToExtensionMessage } from '../types/session';

type PostToExtension = (msg: WebviewToExtensionMessage) => void;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export class WebviewSpeechBridge {
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private activeAudio: HTMLAudioElement | null = null;
  private watchdogTimer: number | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private recordedChunks: Blob[] = [];
  private isListening = false;

  constructor(private readonly post: PostToExtension) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.publishVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        this.publishVoices();
      });
    } else {
      this.post({ type: 'ttsVoicesAvailable', voices: [] });
    }
  }

  public publishVoices(): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.post({ type: 'ttsVoicesAvailable', voices: [] });
      return;
    }

    const voices = window.speechSynthesis.getVoices();
    const mapped: VoiceOptionInfo[] = voices.map((v) => ({
      id: v.voiceURI || v.name,
      name: `${v.name} (${v.lang})`,
      lang: v.lang,
      source: 'webspeech',
    }));

    this.post({ type: 'ttsVoicesAvailable', voices: mapped });
  }

  public speak(
    utteranceId: string,
    text: string,
    lang: string,
    rate: number,
    voiceId?: string,
  ): void {
    this.stopAll();

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.post({
        type: 'ttsError',
        utteranceId,
        error: 'Web Speech API unavailable',
      });
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    this.currentUtterance = utterance;
    utterance.lang = lang;
    utterance.rate = Math.min(2.2, Math.max(0.5, rate));

    const voices = window.speechSynthesis.getVoices();
    const chosenVoice = this.pickBestVoice(voices, lang, voiceId);
    if (chosenVoice) {
      utterance.voice = chosenVoice;
      utterance.lang = chosenVoice.lang;
    }

    let settled = false;
    const finish = (isError = false, errorMsg = '') => {
      if (settled) {
        return;
      }
      settled = true;
      if (this.watchdogTimer !== null) {
        window.clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
      if (this.currentUtterance === utterance) {
        this.currentUtterance = null;
      }
      if (isError) {
        this.post({ type: 'ttsError', utteranceId, error: errorMsg });
      } else {
        this.post({ type: 'ttsEnded', utteranceId });
      }
    };

    utterance.onboundary = (event) => {
      if (typeof event.charIndex === 'number') {
        this.post({
          type: 'ttsBoundary',
          utteranceId,
          charIndex: event.charIndex,
          charLength: typeof event.charLength === 'number' ? event.charLength : 0,
        });
      }
    };

    utterance.onend = () => finish(false);
    utterance.onerror = (ev) => {
      if (ev.error === 'interrupted' || ev.error === 'canceled') {
        finish(false);
      } else {
        finish(true, ev.error || 'Speech synthesis error');
      }
    };

    const estimatedMs = Math.max(4000, Math.round((text.length / 10) * (1000 / utterance.rate)) + 5000);
    this.watchdogTimer = window.setTimeout(() => finish(false), estimatedMs);

    try {
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      finish(true, err instanceof Error ? err.message : String(err));
    }
  }

  public playBase64Audio(
    utteranceId: string,
    base64Audio: string,
    mimeType: string,
  ): void {
    this.stopAll();
    const audio = new Audio(`data:${mimeType};base64,${base64Audio}`);
    this.activeAudio = audio;

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (this.activeAudio === audio) {
        this.activeAudio = null;
      }
      this.post({ type: 'ttsEnded', utteranceId });
    };

    audio.onended = finish;
    audio.onerror = finish;
    void audio.play().catch(finish);
  }

  public stopAll(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.currentUtterance = null;

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore browser cancel errors.
      }
    }

    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.src = '';
      } catch {
        // Ignore audio stop errors.
      }
      this.activeAudio = null;
    }
  }

  public isVoiceInputSupported(): boolean {
    const win = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    return Boolean(
      win.SpeechRecognition ||
        win.webkitSpeechRecognition ||
        (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia),
    );
  }

  public getListeningState(): boolean {
    return this.isListening;
  }

  public async startListening(
    lang: 'fr' | 'en',
    callbacks: {
      onInterim: (text: string) => void;
      onFinal: (text: string) => void;
      onAudioCaptured: (base64Audio: string, mimeType: string) => void;
      onError: (reason: string) => void;
      onEnd: () => void;
    },
  ): Promise<void> {
    if (this.isListening) {
      this.stopListening();
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SpeechRec = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (SpeechRec) {
      try {
        const rec = new SpeechRec();
        this.recognition = rec;
        this.isListening = true;
        rec.lang = lang === 'fr' ? 'fr-FR' : 'en-US';
        rec.interimResults = true;
        rec.continuous = false;

        let finalTranscript = '';
        rec.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
              finalTranscript += result[0].transcript + ' ';
            } else {
              interim += result[0].transcript;
            }
          }
          if (interim.trim()) {
            callbacks.onInterim(interim.trim());
          }
          if (finalTranscript.trim()) {
            callbacks.onFinal(finalTranscript.trim());
            finalTranscript = '';
          }
        };

        rec.onerror = (ev) => {
          this.isListening = false;
          this.recognition = null;
          callbacks.onError(
            ev.error === 'not-allowed'
              ? lang === 'fr'
                ? 'Accès micro bloqué par la sandbox IDE — tapez votre question ci-dessous.'
                : 'Microphone blocked by IDE sandbox — type your question below.'
              : ev.error || 'Speech recognition unavailable',
          );
        };

        rec.onend = () => {
          this.isListening = false;
          this.recognition = null;
          callbacks.onEnd();
        };

        rec.start();
        return;
      } catch {
        this.isListening = false;
        this.recognition = null;
      }
    }

    // Progressive fallback: MediaRecorder -> Gemini 3.5 Transcribe
    if (navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaStream = stream;
        const mimeType = MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg';
        const recorder = new MediaRecorder(stream, { mimeType });
        this.mediaRecorder = recorder;
        this.recordedChunks = [];
        this.isListening = true;

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) {
            this.recordedChunks.push(ev.data);
          }
        };

        recorder.onstop = () => {
          const blob = new Blob(this.recordedChunks, { type: mimeType });
          this.cleanupMediaStream();
          this.isListening = false;

          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = typeof reader.result === 'string' ? reader.result : '';
            const base64 = dataUrl.split(',')[1] ?? '';
            if (base64) {
              callbacks.onAudioCaptured(base64, mimeType);
            }
            callbacks.onEnd();
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
        return;
      } catch {
        this.cleanupMediaStream();
        this.isListening = false;
      }
    }

    callbacks.onError(
      lang === 'fr'
        ? 'Micro indisponible dans cette webview — saisissez votre question directement.'
        : 'Microphone unavailable in this webview — type your question directly.',
    );
    callbacks.onEnd();
  }

  public stopListening(): void {
    this.isListening = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore stop errors.
      }
      this.recognition = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        this.cleanupMediaStream();
      }
      this.mediaRecorder = null;
    }
  }

  private cleanupMediaStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }

  private pickBestVoice(
    voices: SpeechSynthesisVoice[],
    targetLang: string,
    explicitVoiceId?: string,
  ): SpeechSynthesisVoice | undefined {
    if (explicitVoiceId) {
      const exact = voices.find(
        (v) => v.voiceURI === explicitVoiceId || v.name === explicitVoiceId,
      );
      if (exact) {
        return exact;
      }
    }

    const prefix = targetLang.slice(0, 2).toLowerCase();
    const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    if (candidates.length === 0) {
      return voices[0];
    }

    const scored = candidates
      .map((v) => {
        let score = 0;
        const lower = v.name.toLowerCase();
        if (lower.includes('natural') || lower.includes('online')) score += 5;
        if (lower.includes('google') || lower.includes('microsoft')) score += 3;
        if (lower.includes('denise') || lower.includes('henri') || lower.includes('thomas') || lower.includes('hortense')) score += 4;
        if (!v.localService) score += 1;
        return { v, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0]?.v;
  }
}
