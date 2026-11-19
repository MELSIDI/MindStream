export type PlaybackState =
  | 'idle'
  | 'researching'
  | 'plan-ready'
  | 'playing'
  | 'paused'
  | 'interrupted'
  | 'checkpoint'
  | 'completed';

export type SpeedMode = '0.5x' | '1x' | '2x' | '3x' | 'auto';

export type BlockCategory =
  | 'boilerplate'
  | 'setup'
  | 'core-logic'
  | 'architecture'
  | 'ui'
  | 'test';

export type BlockImportance = 'low' | 'medium' | 'high';

export type NarrationMode = 'full' | 'short' | 'silent';

export interface CodeBlockVariant {
  /** Overrides block code when this variant key is active from a checkpoint. */
  code: string;
  /** Overrides narration when this variant key is active. */
  narration?: string;
  /** Overrides short cue for fast/auto modes. */
  shortCue?: string;
  /** Overrides architectural rationale. */
  rationale?: string;
  /** Optional Q&A hints specific to this variant. */
  qaHints?: Record<string, string>;
}

export interface CodeBlock {
  id: string;
  title: string;
  category: BlockCategory;
  importance?: BlockImportance;
  code: string;
  narration: string;
  shortCue?: string;
  rationale: string;
  qaHints?: Record<string, string>;
  /** Keyed by checkpoint variantKey (e.g. 'immutable', 'mutable', 'drift-safe'). */
  variants?: Record<string, CodeBlockVariant>;
}

export interface FileStep {
  kind: 'file';
  id: string;
  filePath: string;
  languageId: string;
  summary: string;
  blocks: CodeBlock[];
}

export interface CheckpointOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  /** Activates matching block variants in subsequent steps. */
  variantKey?: string;
  /** Spoken feedback after the user validates this option. */
  aiReaction?: string;
}

export interface CheckpointStep {
  kind: 'checkpoint';
  id: string;
  title: string;
  question: string;
  rationale: string;
  options: CheckpointOption[];
  relatedFilePath?: string;
}

export type SessionStep = FileStep | CheckpointStep;

export interface ResearchReport {
  summary: string;
  findings: string[];
  architectureDecisions: string[];
  spokenIntro: string;
}

export interface CodingSessionPlan {
  id: string;
  title: string;
  goal: string;
  isDemo: boolean;
  language: 'fr' | 'en';
  /** Relative subdirectory inside workspace (e.g. 'codepace-demo' or ''). */
  rootSubdir: string;
  research: ResearchReport;
  steps: SessionStep[];
}

export interface LiveContextSnapshot {
  filePath: string;
  lineNumber: number;
  column: number;
  blockId: string;
  blockTitle: string;
  blockRationale: string;
  codeWrittenSoFar: string;
  remainingCode: string;
  currentLineText: string;
  surroundingLines: string;
  currentSentence: string;
  fullNarration: string;
}

export interface BargeInExchange {
  id: string;
  question: string;
  answer: string;
  filePath: string;
  lineNumber: number;
  timestamp: number;
  source: 'voice' | 'text' | 'quick-chip';
}

export interface EffectivePaceInfo {
  speedMode: SpeedMode;
  importance: BlockImportance;
  charsPerSecond: number;
  tickMs: number;
  chunkSize: number;
  speechRate: number;
  narrationMode: NarrationMode;
  autoReason?: 'boilerplate' | 'standard' | 'core-logic' | 'file-fast';
  label: string;
}

export interface FileStopTarget {
  filePath: string;
  stepId: string;
  previousSpeed: SpeedMode;
}

export interface SpeechCaptionState {
  text: string;
  sentenceIndex: number;
  totalSentences: number;
  charIndex: number;
  charLength: number;
  speaking: boolean;
}

export interface VoiceOptionInfo {
  id: string;
  name: string;
  lang: string;
  source: 'webspeech' | 'native' | 'gemini';
}

export interface TimelineBlockSummary {
  id: string;
  title: string;
  category: BlockCategory;
  importance: BlockImportance;
  status: 'pending' | 'active' | 'done';
}

export interface TimelineStepSummary {
  id: string;
  kind: 'file' | 'checkpoint';
  title: string;
  filePath?: string;
  summary: string;
  status: 'pending' | 'active' | 'done';
  blocks?: TimelineBlockSummary[];
}

export interface SessionUIState {
  playbackState: PlaybackState;
  language: 'fr' | 'en';
  speedMode: SpeedMode;
  effectivePace: EffectivePaceInfo | null;
  muted: boolean;
  isDemo: boolean;
  isMcpSession?: boolean;
  sessionTitle: string;
  sessionGoal: string;
  research: ResearchReport | null;
  researchStatusMessage: string;
  currentStepIndex: number;
  totalSteps: number;
  currentBlockIndex: number;
  totalBlocksInCurrentFile: number;
  currentFilePath: string | null;
  currentLineNumber: number;
  currentBlockTitle: string | null;
  currentBlockRationale: string | null;
  currentBlockImportance: BlockImportance | null;
  progressPercent: number;
  fileStopTarget: FileStopTarget | null;
  pauseBanner: string | null;
  activeCheckpoint: CheckpointStep | null;
  activeSnapshot: LiveContextSnapshot | null;
  bargeInHistory: BargeInExchange[];
  isAnsweringQuestion: boolean;
  caption: SpeechCaptionState;
  timeline: TimelineStepSummary[];
  activeProviderLabel: string;
  ttsBackendLabel: string;
  availableVoices: VoiceOptionInfo[];
  selectedVoiceId: string | null;
}

export type ExtensionToWebviewMessage =
  | { type: 'stateUpdate'; state: SessionUIState }
  | {
      type: 'ttsSpeak';
      utteranceId: string;
      text: string;
      lang: string;
      rate: number;
      voiceId?: string;
    }
  | {
      type: 'ttsPlayAudio';
      utteranceId: string;
      base64Audio: string;
      mimeType: string;
    }
  | { type: 'ttsStop' }
  | { type: 'focusBargeInInput' }
  | { type: 'triggerVoiceTest'; lang: string };

export type WebviewToExtensionMessage =
  | { type: 'webviewReady' }
  | { type: 'startDemo' }
  | { type: 'startLiveSession'; prompt: string }
  | { type: 'startPlayback' }
  | { type: 'togglePlayPause' }
  | { type: 'setSpeed'; speed: SpeedMode }
  | { type: 'previousBlock' }
  | { type: 'skipBlock' }
  | { type: 'stopSession' }
  | { type: 'toggleMute' }
  | { type: 'implementFileAndPause'; filePath: string }
  | { type: 'bargeInTrigger' }
  | {
      type: 'bargeInQuestion';
      question: string;
      source: 'voice' | 'text' | 'quick-chip';
    }
  | { type: 'bargeInAudioQuestion'; base64Audio: string; mimeType: string }
  | { type: 'resumeAfterBargeIn' }
  | {
      type: 'resolveCheckpoint';
      optionId: string;
      customReply?: string;
    }
  | { type: 'selectVoice'; voiceId: string }
  | { type: 'testVoice' }
  | { type: 'installPlugin' }
  | { type: 'configureApiKey' }
  | { type: 'openSettings' }
  | {
      type: 'ttsVoicesAvailable';
      voices: VoiceOptionInfo[];
    }
  | {
      type: 'ttsBoundary';
      utteranceId: string;
      charIndex: number;
      charLength: number;
    }
  | { type: 'ttsEnded'; utteranceId: string }
  | { type: 'ttsError'; utteranceId: string; error: string };
