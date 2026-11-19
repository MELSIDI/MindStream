import {
  BargeInExchange,
  CheckpointStep,
  CodeBlock,
  CodingSessionPlan,
  EffectivePaceInfo,
  FileStep,
  FileStopTarget,
  LiveContextSnapshot,
  PlaybackState,
  SessionStep,
  SessionUIState,
  SpeedMode,
  SpeechCaptionState,
  TimelineStepSummary,
  VoiceOptionInfo,
} from '../types/session';
import { splitSentences } from './SentenceSplitter';
import { classifyImportance, computeChunkDelayMs, computePace, SPEED_ORDER } from './SmartPacer';

export interface AppendChunkResult {
  lineNumber: number;
  column: number;
  currentLineText: string;
  surroundingLines: string;
}

export interface AppendChunkOptions {
  isBlockStart: boolean;
  isBlockEnd: boolean;
  blockId: string;
  blockTitle: string;
  rationale: string;
}

export interface IEditorAdapter {
  openFile(filePath: string, languageId: string, rootSubdir: string): Promise<void>;
  appendChunk(
    filePath: string,
    chunk: string,
    options: AppendChunkOptions,
  ): Promise<AppendChunkResult>;
  getContextSnapshot(
    filePath: string,
  ): Promise<{
    lineNumber: number;
    column: number;
    currentLineText: string;
    surroundingLines: string;
  } | null>;
  setVisualState(
    filePath: string | null,
    lineNumber: number,
    state: PlaybackState,
    inlineLabel?: string,
    blockRange?: { startLine: number; endLine: number },
  ): Promise<void>;
  clearDecorations(): void;
}

export interface SpeakOptions {
  lang: 'fr' | 'en';
  rate: number;
  startSentenceIndex?: number;
  signal?: AbortSignal;
  onSentenceStart?: (sentenceIndex: number, sentenceText: string, totalSentences: number) => void;
  onWordBoundary?: (charIndex: number, charLength: number, sentenceText: string) => void;
}

export interface IVoiceAdapter {
  speakSentences(text: string, options: SpeakOptions): Promise<void>;
  stopImmediately(): void;
  getBackendLabel(): string;
  getAvailableVoices(): VoiceOptionInfo[];
  getSelectedVoiceId(): string | null;
}

export interface IQuestionResponder {
  answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string>;
}

export interface PlaybackEngineConfig {
  language: 'fr' | 'en';
  defaultSpeed: SpeedMode;
  voiceRateMultiplier: number;
  autoResearchIntro: boolean;
  providerLabel: string;
}

type StateListener = (state: SessionUIState) => void;

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class PlaybackEngine {
  private plan: CodingSessionPlan | null = null;
  private playbackState: PlaybackState = 'idle';
  private speedMode: SpeedMode;
  private muted = false;
  private config: PlaybackEngineConfig;

  private stepIndex = 0;
  private blockIndex = 0;
  private charOffset = 0;
  private sentenceIndex = 0;

  private activeVariants = new Set<string>();
  private completedSteps = new Set<string>();
  private completedBlocks = new Set<string>();
  private blockStartLines = new Map<string, number>();

  private currentFilePath: string | null = null;
  private currentLineNumber = 1;
  private currentColumn = 1;
  private currentLineText = '';
  private surroundingLines = '';
  private researchStatusMessage = '';
  private fileStopTarget: FileStopTarget | null = null;
  private pauseBanner: string | null = null;
  private activeSnapshot: LiveContextSnapshot | null = null;
  private bargeInHistory: BargeInExchange[] = [];
  private isAnsweringQuestion = false;

  private caption: SpeechCaptionState = {
    text: '',
    sentenceIndex: 0,
    totalSentences: 0,
    charIndex: 0,
    charLength: 0,
    speaking: false,
  };

  private runAbortController: AbortController | null = null;
  private activeLoopToken = 0;
  private isLoopRunning = false;

  private readonly listeners = new Set<StateListener>();

  constructor(
    private readonly editor: IEditorAdapter,
    private readonly voice: IVoiceAdapter,
    private questionResponder: IQuestionResponder,
    initialConfig: PlaybackEngineConfig,
  ) {
    this.config = { ...initialConfig };
    this.speedMode = initialConfig.defaultSpeed;
  }

  public updateConfig(patch: Partial<PlaybackEngineConfig>): void {
    this.config = { ...this.config, ...patch };
    this.emitState();
  }

  public setQuestionResponder(responder: IQuestionResponder): void {
    this.questionResponder = responder;
  }

  public onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getUIState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notifyVoiceMetadataChanged(): void {
    this.emitState();
  }

  public setResearching(goalPrompt: string, statusMessage?: string): void {
    this.abortCurrentRun();
    this.plan = null;
    this.playbackState = 'researching';
    this.researchStatusMessage =
      statusMessage ??
      (this.config.language === 'fr'
        ? `Analyse du workspace et préparation du plan pour : "${goalPrompt}"...`
        : `Analyzing workspace and crafting plan for: "${goalPrompt}"...`);
    this.stepIndex = 0;
    this.blockIndex = 0;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.activeVariants.clear();
    this.completedSteps.clear();
    this.completedBlocks.clear();
    this.blockStartLines.clear();
    this.bargeInHistory = [];
    this.activeSnapshot = null;
    this.fileStopTarget = null;
    this.pauseBanner = null;
    this.currentFilePath = null;
    this.currentLineNumber = 1;
    this.resetCaption();
    this.editor.clearDecorations();
    this.emitState();
  }

  public async loadSession(plan: CodingSessionPlan, autoStart = false): Promise<void> {
    this.abortCurrentRun();
    this.plan = plan;
    this.playbackState = 'plan-ready';
    this.researchStatusMessage = '';
    this.stepIndex = 0;
    this.blockIndex = 0;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.activeVariants.clear();
    this.completedSteps.clear();
    this.completedBlocks.clear();
    this.blockStartLines.clear();
    this.bargeInHistory = [];
    this.activeSnapshot = null;
    this.fileStopTarget = null;
    this.pauseBanner = null;
    this.currentFilePath = this.findFirstFilePath(plan);
    this.currentLineNumber = 1;
    this.currentColumn = 1;
    this.currentLineText = '';
    this.surroundingLines = '';
    this.resetCaption();
    this.editor.clearDecorations();
    this.emitState();

    if (autoStart) {
      await this.start();
    }
  }

  public async start(): Promise<void> {
    if (!this.plan) {
      return;
    }

    if (this.playbackState === 'completed') {
      return;
    }

    if (this.playbackState === 'playing' && this.isLoopRunning) {
      return;
    }

    const wasPlanReady = this.playbackState === 'plan-ready';
    this.pauseBanner = null;
    this.activeSnapshot = null;
    this.playbackState = 'playing';
    this.emitState();

    if (wasPlanReady && this.config.autoResearchIntro && !this.muted && this.plan.research.spokenIntro) {
      const introAbort = this.createRunSignal();
      await this.speakSafe(this.plan.research.spokenIntro, 1.0 * this.config.voiceRateMultiplier, introAbort.signal, 0);
      if (introAbort.signal.aborted || this.playbackState !== 'playing') {
        return;
      }
    }

    this.launchRunLoop();
  }

  public async resume(): Promise<void> {
    if (!this.plan) {
      return;
    }
    if (this.playbackState === 'plan-ready') {
      await this.start();
      return;
    }
    if (this.playbackState === 'checkpoint') {
      return;
    }
    if (this.playbackState === 'completed') {
      return;
    }
    if (this.playbackState === 'playing' && this.isLoopRunning) {
      return;
    }

    this.abortCurrentRun();
    this.pauseBanner = null;
    this.activeSnapshot = null;
    this.playbackState = 'playing';
    this.emitState();
    this.launchRunLoop();
  }

  public pause(bannerMessage?: string): void {
    if (!this.plan) {
      return;
    }
    if (
      this.playbackState === 'idle' ||
      this.playbackState === 'completed' ||
      this.playbackState === 'paused'
    ) {
      return;
    }

    this.abortCurrentRun();
    this.playbackState = 'paused';
    if (bannerMessage) {
      this.pauseBanner = bannerMessage;
    }
    this.resetCaption(false);
    void this.syncEditorDecorator();
    this.emitState();
  }

  public async togglePlayPause(): Promise<void> {
    if (!this.plan) {
      return;
    }

    switch (this.playbackState) {
      case 'playing':
        this.pause();
        break;
      case 'paused':
      case 'interrupted':
      case 'plan-ready':
        await this.resume();
        break;
      default:
        break;
    }
  }

  public setSpeed(speed: SpeedMode): void {
    this.speedMode = speed;
    this.emitState();
  }

  public cycleSpeed(): SpeedMode {
    const idx = SPEED_ORDER.indexOf(this.speedMode);
    const next = SPEED_ORDER[(idx + 1) % SPEED_ORDER.length];
    this.setSpeed(next);
    return next;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.voice.stopImmediately();
      this.resetCaption(false);
    }
    this.emitState();
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Implements a specific file in fast silent mode and automatically pauses
   * upon completion so the developer can review the file calmly.
   */
  public async implementFileAndPause(filePath?: string): Promise<boolean> {
    if (!this.plan) {
      return false;
    }

    const targetIdx = this.resolveTargetFileStepIndex(filePath);
    if (targetIdx === -1) {
      return false;
    }

    const targetStep = this.plan.steps[targetIdx] as FileStep;
    const previousSpeed = this.fileStopTarget?.previousSpeed ?? this.speedMode;

    this.abortCurrentRun();

    if (targetIdx !== this.stepIndex) {
      this.stepIndex = targetIdx;
      this.blockIndex = 0;
      this.charOffset = 0;
      this.sentenceIndex = 0;
    }

    this.fileStopTarget = {
      filePath: targetStep.filePath,
      stepId: targetStep.id,
      previousSpeed,
    };
    this.pauseBanner = null;
    this.activeSnapshot = null;
    this.playbackState = 'playing';
    this.emitState();

    this.launchRunLoop();
    return true;
  }

  /**
   * Barge-in: immediately aborts typing and voice, captures the exact code
   * context around the active line, and waits for questions / explicit resume.
   */
  public async interrupt(initialQuestion?: string): Promise<LiveContextSnapshot | null> {
    if (!this.plan) {
      return null;
    }

    this.abortCurrentRun();
    this.resetCaption(false);

    const snapshot = await this.captureLiveContextSnapshot();
    this.activeSnapshot = snapshot;
    this.playbackState = 'interrupted';
    await this.syncEditorDecorator();
    this.emitState();

    if (initialQuestion && initialQuestion.trim().length > 0) {
      await this.askQuestion(initialQuestion.trim(), 'voice');
    }

    return snapshot;
  }

  public async askQuestion(
    question: string,
    source: BargeInExchange['source'] = 'text',
  ): Promise<BargeInExchange | null> {
    if (!this.plan) {
      return null;
    }

    const cleanQuestion = question.trim();
    if (!cleanQuestion) {
      return null;
    }

    if (this.playbackState !== 'interrupted') {
      await this.interrupt();
    }

    const snapshot = this.activeSnapshot ?? (await this.captureLiveContextSnapshot());
    this.activeSnapshot = snapshot;
    this.isAnsweringQuestion = true;
    this.emitState();

    let answer = '';
    try {
      answer = await this.questionResponder.answerQuestion(cleanQuestion, snapshot, this.plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      answer =
        this.config.language === 'fr'
          ? `Je n'ai pas pu contacter le modèle IA (${msg}), mais sur ${snapshot.filePath} ligne ${snapshot.lineNumber} : ${snapshot.blockRationale}`
          : `Could not reach the AI provider (${msg}), however on ${snapshot.filePath} line ${snapshot.lineNumber}: ${snapshot.blockRationale}`;
    }

    const exchange: BargeInExchange = {
      id: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      question: cleanQuestion,
      answer,
      filePath: snapshot.filePath,
      lineNumber: snapshot.lineNumber,
      timestamp: Date.now(),
      source,
    };

    this.bargeInHistory = [...this.bargeInHistory, exchange];
    this.isAnsweringQuestion = false;
    this.emitState();

    if (!this.muted && this.playbackState === 'interrupted') {
      const qaAbort = this.createRunSignal();
      await this.speakSafe(
        answer,
        1.05 * this.config.voiceRateMultiplier,
        qaAbort.signal,
        0,
      );
    }

    return exchange;
  }

  public async resolveCheckpoint(optionId: string, customReply?: string): Promise<void> {
    if (!this.plan || this.playbackState !== 'checkpoint') {
      return;
    }

    const step = this.getCurrentStep();
    if (!step || step.kind !== 'checkpoint') {
      return;
    }

    const selected = step.options.find((opt) => opt.id === optionId) ?? step.options[0];
    for (const opt of step.options) {
      if (opt.variantKey) {
        this.activeVariants.delete(opt.variantKey);
      }
    }

    if (selected?.variantKey) {
      this.activeVariants.add(selected.variantKey);
    }

    let reaction = selected?.aiReaction ?? '';
    if (customReply && customReply.trim().length > 0) {
      const snapshot = await this.captureLiveContextSnapshot();
      try {
        reaction = await this.questionResponder.answerQuestion(
          customReply.trim(),
          snapshot,
          this.plan,
          selected?.label,
        );
      } catch {
        reaction =
          this.config.language === 'fr'
            ? `Bien noté : "${customReply.trim()}". On garde le cap et on continue l'implémentation.`
            : `Noted: "${customReply.trim()}". Keeping that in mind as we continue.`;
      }
    }

    this.completedSteps.add(step.id);
    this.stepIndex += 1;
    this.blockIndex = 0;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.playbackState = 'playing';
    this.emitState();

    if (reaction && !this.muted) {
      const reactionAbort = this.createRunSignal();
      await this.speakSafe(reaction, 1.05 * this.config.voiceRateMultiplier, reactionAbort.signal, 0);
      if (reactionAbort.signal.aborted || this.playbackState !== 'playing') {
        return;
      }
    }

    this.launchRunLoop();
  }

  public async skipBlock(): Promise<void> {
    if (!this.plan) {
      return;
    }

    const wasPlaying = this.playbackState === 'playing';
    this.abortCurrentRun();

    const step = this.getCurrentStep();
    if (!step) {
      return;
    }

    if (step.kind === 'checkpoint') {
      const recommended = step.options.find((o) => o.recommended) ?? step.options[0];
      if (recommended) {
        this.playbackState = 'checkpoint';
        await this.resolveCheckpoint(recommended.id);
      }
      return;
    }

    const block = step.blocks[this.blockIndex];
    if (block) {
      const resolved = this.resolveBlock(block);
      if (!this.completedBlocks.has(resolved.id)) {
        await this.editor.openFile(step.filePath, step.languageId, this.plan.rootSubdir);
        const remaining = resolved.code.slice(this.charOffset);
        if (remaining.length > 0) {
          const res = await this.editor.appendChunk(step.filePath, remaining, {
            isBlockStart: this.charOffset === 0,
            isBlockEnd: true,
            blockId: resolved.id,
            blockTitle: resolved.title,
            rationale: resolved.rationale,
          });
          this.currentFilePath = step.filePath;
          this.currentLineNumber = res.lineNumber;
          this.currentColumn = res.column;
          this.currentLineText = res.currentLineText;
          this.surroundingLines = res.surroundingLines;
        }
        this.completedBlocks.add(resolved.id);
      }
    }

    this.advancePastCurrentBlock(step);
    this.resetCaption(false);
    await this.syncEditorDecorator();
    this.emitState();

    if (wasPlaying && this.playbackState !== 'completed') {
      await this.resume();
    }
  }

  public async previousBlock(): Promise<void> {
    if (!this.plan) {
      return;
    }

    const wasPlaying = this.playbackState === 'playing';
    this.abortCurrentRun();

    if (this.blockIndex > 0) {
      this.blockIndex -= 1;
    } else if (this.stepIndex > 0) {
      this.stepIndex -= 1;
      const prevStep = this.plan.steps[this.stepIndex];
      if (prevStep?.kind === 'file') {
        this.blockIndex = Math.max(0, prevStep.blocks.length - 1);
      } else {
        this.blockIndex = 0;
      }
    }

    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.pauseBanner = null;
    this.resetCaption(false);

    const step = this.getCurrentStep();
    if (step?.kind === 'file') {
      this.currentFilePath = step.filePath;
    }
    this.emitState();

    if (wasPlaying) {
      await this.resume();
    }
  }

  public stop(): void {
    this.abortCurrentRun();
    this.plan = null;
    this.playbackState = 'idle';
    this.stepIndex = 0;
    this.blockIndex = 0;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.fileStopTarget = null;
    this.pauseBanner = null;
    this.activeSnapshot = null;
    this.bargeInHistory = [];
    this.isAnsweringQuestion = false;
    this.researchStatusMessage = '';
    this.currentFilePath = null;
    this.resetCaption(false);
    this.editor.clearDecorations();
    this.emitState();
  }

  public getUIState(): SessionUIState {
    const step = this.getCurrentStep();
    const rawBlock = step?.kind === 'file' ? step.blocks[this.blockIndex] : undefined;
    const block = rawBlock ? this.resolveBlock(rawBlock) : undefined;
    const isFileFastMode = Boolean(
      this.fileStopTarget && step?.kind === 'file' && this.fileStopTarget.stepId === step.id,
    );
    const effectivePace = block
      ? computePace(
          this.speedMode,
          block,
          this.config.voiceRateMultiplier,
          isFileFastMode,
          this.config.language,
        )
      : null;

    return {
      playbackState: this.playbackState,
      language: this.config.language,
      speedMode: this.speedMode,
      effectivePace,
      muted: this.muted,
      isDemo: this.plan?.isDemo ?? false,
      sessionTitle: this.plan?.title ?? '',
      sessionGoal: this.plan?.goal ?? '',
      research: this.plan?.research ?? null,
      researchStatusMessage: this.researchStatusMessage,
      currentStepIndex: this.stepIndex,
      totalSteps: this.plan?.steps.length ?? 0,
      currentBlockIndex: this.blockIndex,
      totalBlocksInCurrentFile: step?.kind === 'file' ? step.blocks.length : 0,
      currentFilePath:
        step?.kind === 'file' ? step.filePath : this.currentFilePath,
      currentLineNumber: this.currentLineNumber,
      currentBlockTitle: block?.title ?? (step?.kind === 'checkpoint' ? step.title : null),
      currentBlockRationale: block?.rationale ?? (step?.kind === 'checkpoint' ? step.rationale : null),
      currentBlockImportance: block ? classifyImportance(block) : null,
      progressPercent: this.computeProgressPercent(),
      fileStopTarget: this.fileStopTarget,
      pauseBanner: this.pauseBanner,
      activeCheckpoint: step?.kind === 'checkpoint' ? step : null,
      activeSnapshot: this.activeSnapshot,
      bargeInHistory: this.bargeInHistory,
      isAnsweringQuestion: this.isAnsweringQuestion,
      caption: { ...this.caption },
      timeline: this.buildTimeline(),
      activeProviderLabel: this.config.providerLabel,
      ttsBackendLabel: this.voice.getBackendLabel(),
      availableVoices: this.voice.getAvailableVoices(),
      selectedVoiceId: this.voice.getSelectedVoiceId(),
    };
  }

  private launchRunLoop(): void {
    const abortController = this.createRunSignal();
    const myToken = ++this.activeLoopToken;
    this.isLoopRunning = true;

    void this.runLoop(abortController.signal, myToken).finally(() => {
      if (this.activeLoopToken === myToken) {
        this.isLoopRunning = false;
      }
    });
  }

  private async runLoop(signal: AbortSignal, myToken: number): Promise<void> {
    while (!signal.aborted && this.plan && this.playbackState === 'playing' && this.activeLoopToken === myToken) {
      const step = this.getCurrentStep();
      if (!step) {
        this.playbackState = 'completed';
        this.fileStopTarget = null;
        this.resetCaption(false);
        await this.syncEditorDecorator();
        this.emitState();
        return;
      }

      if (step.kind === 'checkpoint') {
        await this.enterCheckpoint(step, signal);
        return;
      }

      await this.editor.openFile(step.filePath, step.languageId, this.plan.rootSubdir);
      if (signal.aborted) {
        return;
      }
      this.currentFilePath = step.filePath;

      if (this.blockIndex >= step.blocks.length) {
        await this.completeFileStep(step);
        if (this.playbackState !== 'playing') {
          return;
        }
        continue;
      }

      const rawBlock = step.blocks[this.blockIndex];
      const block = this.resolveBlock(rawBlock);
      const isFileFastMode = Boolean(this.fileStopTarget && this.fileStopTarget.stepId === step.id);

      await this.executeBlock(step, block, isFileFastMode, signal);
      if (signal.aborted || this.playbackState !== 'playing' || this.activeLoopToken !== myToken) {
        return;
      }

      this.completedBlocks.add(block.id);
      this.blockIndex += 1;
      this.charOffset = 0;
      this.sentenceIndex = 0;

      if (this.blockIndex >= step.blocks.length) {
        await this.completeFileStep(step);
        if (this.playbackState !== 'playing') {
          return;
        }
      } else {
        this.emitState();
      }
    }
  }

  private async executeBlock(
    step: FileStep,
    block: CodeBlock,
    isFileFastMode: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const initialPace = computePace(
      this.speedMode,
      block,
      this.config.voiceRateMultiplier,
      isFileFastMode,
      this.config.language,
    );

    if (!this.blockStartLines.has(block.id)) {
      this.blockStartLines.set(block.id, this.currentLineNumber);
    }

    this.emitState();

    const narrationText = this.selectNarrationText(block, initialPace.narrationMode);
    let speechPromise: Promise<void> = Promise.resolve();

    if (narrationText && !this.muted) {
      speechPromise = this.speakSafe(
        narrationText,
        initialPace.speechRate,
        signal,
        this.sentenceIndex,
      );
    } else {
      this.resetCaption(false);
    }

    // If replaying a previously completed block (via previousBlock), skip re-typing code.
    if (!this.completedBlocks.has(block.id)) {
      while (this.charOffset < block.code.length && !signal.aborted) {
        const liveIsFileFast = Boolean(this.fileStopTarget && this.fileStopTarget.stepId === step.id);
        const livePace = computePace(
          this.speedMode,
          block,
          this.config.voiceRateMultiplier,
          liveIsFileFast,
          this.config.language,
        );

        const nextOffset = Math.min(block.code.length, this.charOffset + livePace.chunkSize);
        const chunk = block.code.slice(this.charOffset, nextOffset);
        const isBlockStart = this.charOffset === 0;
        const isBlockEnd = nextOffset >= block.code.length;

        const appendResult = await this.editor.appendChunk(step.filePath, chunk, {
          isBlockStart,
          isBlockEnd,
          blockId: block.id,
          blockTitle: block.title,
          rationale: block.rationale,
        });

        this.charOffset = nextOffset;
        this.currentFilePath = step.filePath;
        this.currentLineNumber = appendResult.lineNumber;
        this.currentColumn = appendResult.column;
        this.currentLineText = appendResult.currentLineText;
        this.surroundingLines = appendResult.surroundingLines;

        const startLine = this.blockStartLines.get(block.id) ?? appendResult.lineNumber;
        await this.editor.setVisualState(
          step.filePath,
          appendResult.lineNumber,
          'playing',
          `🎙 ${block.title}`,
          { startLine, endLine: appendResult.lineNumber },
        );

        const delayMs = computeChunkDelayMs(chunk, livePace.tickMs);
        const keptGoing = await sleepWithAbort(delayMs, signal);
        if (!keptGoing) {
          return;
        }
      }
    } else {
      const startLine = this.blockStartLines.get(block.id) ?? this.currentLineNumber;
      await this.editor.setVisualState(
        step.filePath,
        startLine,
        'playing',
        `🔁 ${block.title}`,
        { startLine, endLine: startLine },
      );
    }

    await speechPromise;
    if (signal.aborted) {
      return;
    }

    // Small natural pause between blocks when not in file-fast mode.
    if (!isFileFastMode && this.speedMode !== '3x') {
      await sleepWithAbort(180, signal);
    }
  }

  private async completeFileStep(step: FileStep): Promise<void> {
    this.completedSteps.add(step.id);
    this.stepIndex += 1;
    this.blockIndex = 0;
    this.charOffset = 0;
    this.sentenceIndex = 0;

    if (this.fileStopTarget && this.fileStopTarget.stepId === step.id) {
      const previousSpeed = this.fileStopTarget.previousSpeed;
      this.speedMode = previousSpeed;
      this.fileStopTarget = null;
      this.playbackState = 'paused';
      this.pauseBanner =
        this.config.language === 'fr'
          ? `Fichier ${step.filePath} terminé en mode rapide. Prenez le temps de le relire, puis cliquez sur Reprendre.`
          : `Finished ${step.filePath} in fast mode. Inspect the file calmly, then press Resume.`;
      this.resetCaption(false);
      await this.syncEditorDecorator();
      this.emitState();

      if (!this.muted) {
        const noticeAbort = this.createRunSignal();
        const noticeText =
          this.config.language === 'fr'
            ? `Le fichier ${step.filePath} est terminé. Je me mets en pause pour que tu puisses le relire tranquillement.`
            : `${step.filePath} is ready. I'm pausing here so you can review it.`;
        void this.speakSafe(noticeText, 1.05 * this.config.voiceRateMultiplier, noticeAbort.signal, 0);
      }
      return;
    }

    this.emitState();
  }

  private async enterCheckpoint(step: CheckpointStep, signal: AbortSignal): Promise<void> {
    this.playbackState = 'checkpoint';
    this.resetCaption(false);
    await this.syncEditorDecorator();
    this.emitState();

    if (!this.muted && !signal.aborted) {
      const ckAbort = this.createRunSignal();
      await this.speakSafe(step.question, 1.0 * this.config.voiceRateMultiplier, ckAbort.signal, 0);
    }
  }

  private selectNarrationText(block: CodeBlock, mode: EffectivePaceInfo['narrationMode']): string {
    if (mode === 'silent') {
      return '';
    }
    if (mode === 'short') {
      return block.shortCue ?? splitSentences(block.narration)[0] ?? '';
    }
    return block.narration;
  }

  private async speakSafe(
    text: string,
    rate: number,
    signal: AbortSignal,
    startSentenceIndex: number,
  ): Promise<void> {
    if (!text.trim() || this.muted || signal.aborted) {
      return;
    }

    try {
      await this.voice.speakSentences(text, {
        lang: this.config.language,
        rate,
        startSentenceIndex,
        signal,
        onSentenceStart: (idx, sentenceText, total) => {
          this.sentenceIndex = idx;
          this.caption = {
            text: sentenceText,
            sentenceIndex: idx,
            totalSentences: total,
            charIndex: 0,
            charLength: 0,
            speaking: true,
          };
          this.emitState();
        },
        onWordBoundary: (charIndex, charLength, sentenceText) => {
          this.caption = {
            ...this.caption,
            text: sentenceText,
            charIndex,
            charLength,
            speaking: true,
          };
          this.emitState();
        },
      });
    } catch {
      // Voice failures must never block or crash code playback.
    } finally {
      if (!signal.aborted) {
        this.caption = { ...this.caption, speaking: false };
        this.emitState();
      }
    }
  }

  private resolveBlock(block: CodeBlock): CodeBlock {
    if (!block.variants) {
      return block;
    }

    for (const variantKey of this.activeVariants) {
      const override = block.variants[variantKey];
      if (override) {
        return {
          ...block,
          code: override.code,
          narration: override.narration ?? block.narration,
          shortCue: override.shortCue ?? block.shortCue,
          rationale: override.rationale ?? block.rationale,
          qaHints: override.qaHints ?? block.qaHints,
        };
      }
    }

    return block;
  }

  private resolveTargetFileStepIndex(filePath?: string): number {
    if (!this.plan) {
      return -1;
    }

    if (!filePath) {
      const current = this.getCurrentStep();
      if (current?.kind === 'file') {
        return this.stepIndex;
      }
      return this.plan.steps.findIndex((s, i) => i >= this.stepIndex && s.kind === 'file');
    }

    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return this.plan.steps.findIndex((step) => {
      if (step.kind !== 'file') {
        return false;
      }
      const stepPath = step.filePath.replace(/\\/g, '/').toLowerCase();
      return (
        stepPath === normalized ||
        normalized.endsWith('/' + stepPath) ||
        normalized.endsWith(stepPath)
      );
    });
  }

  private advancePastCurrentBlock(step: FileStep): void {
    this.blockIndex += 1;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    if (this.blockIndex >= step.blocks.length) {
      this.completedSteps.add(step.id);
      this.stepIndex += 1;
      this.blockIndex = 0;
      if (this.plan && this.stepIndex >= this.plan.steps.length) {
        this.playbackState = 'completed';
      }
    }
  }

  private async captureLiveContextSnapshot(): Promise<LiveContextSnapshot> {
    const step = this.getCurrentStep();
    const fileStep = step?.kind === 'file' ? step : this.findLastFileStep();
    const rawBlock = fileStep?.blocks[Math.min(this.blockIndex, Math.max(0, (fileStep?.blocks.length ?? 1) - 1))];
    const block = rawBlock ? this.resolveBlock(rawBlock) : undefined;
    const filePath = fileStep?.filePath ?? this.currentFilePath ?? 'session';

    const editorContext = fileStep
      ? await this.editor.getContextSnapshot(fileStep.filePath)
      : null;

    const lineNumber = editorContext?.lineNumber ?? this.currentLineNumber;
    const column = editorContext?.column ?? this.currentColumn;
    const currentLineText = editorContext?.currentLineText ?? this.currentLineText;
    const surroundingLines = editorContext?.surroundingLines ?? this.surroundingLines;

    const codeWrittenSoFar = block ? block.code.slice(0, this.charOffset) : '';
    const remainingCode = block ? block.code.slice(this.charOffset) : '';
    const sentences = block ? splitSentences(block.narration) : [];
    const currentSentence =
      this.caption.text ||
      sentences[Math.min(this.sentenceIndex, Math.max(0, sentences.length - 1))] ||
      '';

    return {
      filePath,
      lineNumber,
      column,
      blockId: block?.id ?? step?.id ?? 'overview',
      blockTitle: block?.title ?? (step?.kind === 'checkpoint' ? step.title : this.plan?.title ?? ''),
      blockRationale:
        block?.rationale ??
        (step?.kind === 'checkpoint'
          ? step.rationale
          : this.plan?.research.summary ?? ''),
      codeWrittenSoFar,
      remainingCode,
      currentLineText,
      surroundingLines,
      currentSentence,
      fullNarration: block?.narration ?? '',
    };
  }

  private async syncEditorDecorator(): Promise<void> {
    if (!this.currentFilePath) {
      return;
    }
    const labelMap: Partial<Record<PlaybackState, string>> =
      this.config.language === 'fr'
        ? {
            paused: '⏸ En pause — relisez tranquillement',
            interrupted: '✋ Interrompu — posez votre question',
            checkpoint: '◆ Validation demandée dans MindStream Studio',
            completed: '✅ Session terminée',
          }
        : {
            paused: '⏸ Paused — inspect calmly',
            interrupted: '✋ Interrupted — ask your question',
            checkpoint: '◆ Decision requested in MindStream Studio',
            completed: '✅ Session complete',
          };

    await this.editor.setVisualState(
      this.currentFilePath,
      this.currentLineNumber,
      this.playbackState,
      labelMap[this.playbackState],
    );
  }

  private getCurrentStep(): SessionStep | undefined {
    return this.plan?.steps[this.stepIndex];
  }

  private findFirstFilePath(plan: CodingSessionPlan): string | null {
    const firstFile = plan.steps.find((s): s is FileStep => s.kind === 'file');
    return firstFile?.filePath ?? null;
  }

  private findLastFileStep(): FileStep | undefined {
    if (!this.plan) {
      return undefined;
    }
    for (let i = Math.min(this.stepIndex, this.plan.steps.length - 1); i >= 0; i--) {
      const s = this.plan.steps[i];
      if (s?.kind === 'file') {
        return s;
      }
    }
    return this.plan.steps.find((s): s is FileStep => s.kind === 'file');
  }

  private computeProgressPercent(): number {
    if (!this.plan) {
      return 0;
    }
    if (this.playbackState === 'completed') {
      return 100;
    }

    let totalUnits = 0;
    let doneUnits = 0;

    for (let sIdx = 0; sIdx < this.plan.steps.length; sIdx++) {
      const step = this.plan.steps[sIdx];
      if (step.kind === 'checkpoint') {
        totalUnits += 20;
        if (this.completedSteps.has(step.id) || sIdx < this.stepIndex) {
          doneUnits += 20;
        }
        continue;
      }

      for (let bIdx = 0; bIdx < step.blocks.length; bIdx++) {
        const block = this.resolveBlock(step.blocks[bIdx]);
        const len = Math.max(1, block.code.length);
        totalUnits += len;
        if (sIdx < this.stepIndex || this.completedBlocks.has(block.id)) {
          doneUnits += len;
        } else if (sIdx === this.stepIndex && bIdx === this.blockIndex) {
          doneUnits += Math.min(len, this.charOffset);
        }
      }
    }

    if (totalUnits === 0) {
      return 0;
    }
    return Math.min(100, Math.round((doneUnits / totalUnits) * 100));
  }

  private buildTimeline(): TimelineStepSummary[] {
    if (!this.plan) {
      return [];
    }

    return this.plan.steps.map((step, sIdx) => {
      const status: 'pending' | 'active' | 'done' =
        this.completedSteps.has(step.id) || sIdx < this.stepIndex
          ? 'done'
          : sIdx === this.stepIndex && this.playbackState !== 'completed'
            ? 'active'
            : 'pending';

      if (step.kind === 'checkpoint') {
        return {
          id: step.id,
          kind: 'checkpoint',
          title: step.title,
          summary: step.question,
          status,
        };
      }

      return {
        id: step.id,
        kind: 'file',
        title: step.filePath,
        filePath: step.filePath,
        summary: step.summary,
        status,
        blocks: step.blocks.map((rawBlock, bIdx) => {
          const block = this.resolveBlock(rawBlock);
          const blockStatus: 'pending' | 'active' | 'done' =
            this.completedBlocks.has(block.id) || sIdx < this.stepIndex
              ? 'done'
              : sIdx === this.stepIndex && bIdx === this.blockIndex && this.playbackState !== 'completed'
                ? 'active'
                : 'pending';

          return {
            id: block.id,
            title: block.title,
            category: block.category,
            importance: classifyImportance(block),
            status: blockStatus,
          };
        }),
      };
    });
  }

  private createRunSignal(): AbortController {
    this.runAbortController?.abort();
    const ctrl = new AbortController();
    this.runAbortController = ctrl;
    return ctrl;
  }

  private abortCurrentRun(): void {
    this.activeLoopToken += 1;
    this.runAbortController?.abort();
    this.runAbortController = null;
    this.voice.stopImmediately();
  }

  private resetCaption(keepText = false): void {
    this.caption = {
      text: keepText ? this.caption.text : '',
      sentenceIndex: 0,
      totalSentences: 0,
      charIndex: 0,
      charLength: 0,
      speaking: false,
    };
  }

  private emitState(): void {
    const snapshot = this.getUIState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
