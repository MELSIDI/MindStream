import { IEditorAdapter, IVoiceAdapter } from '../engine/PlaybackEngine';
import { splitSentences } from '../engine/SentenceSplitter';
import { classifyImportance, computeChunkDelayMs, computePace, SPEED_ORDER } from '../engine/SmartPacer';
import {
  BargeInExchange,
  BlockCategory,
  BlockImportance,
  CheckpointOption,
  CheckpointStep,
  CodeBlock,
  EffectivePaceInfo,
  FileStopTarget,
  LiveContextSnapshot,
  PlaybackState,
  ResearchReport,
  SessionUIState,
  SpeedMode,
  SpeechCaptionState,
  TimelineBlockSummary,
  TimelineStepSummary,
} from '../types/session';

export interface ILiveEditorAdapter extends IEditorAdapter {
  openFile(
    filePath: string,
    languageId: string,
    rootSubdir: string,
    workspaceRoot?: string,
  ): Promise<void>;
  prepareEditTarget(
    filePath: string,
    insertMode:
      | 'append'
      | 'replace-file'
      | 'replace-target'
      | 'insert-before'
      | 'inside-container',
    targetOrAnchorText?: string,
    hasTrailingNewline?: boolean,
  ): Promise<{ matched: boolean }>;
  resetSession(clearExistingOnFirstOpen: boolean): void;
}

export interface StartLiveSessionParams {
  title: string;
  goal: string;
  language?: 'fr' | 'en';
  workspaceRoot?: string;
  researchSummary?: string;
  findings?: string[];
  architectureDecisions?: string[];
  spokenIntro?: string;
  plannedFiles?: string[];
}

export interface WriteLiveBlockParams {
  filePath: string;
  workspaceRoot?: string;
  languageId?: string;
  title: string;
  category?: BlockCategory;
  importance?: BlockImportance;
  code: string;
  narration: string;
  shortCue?: string;
  rationale?: string;
  insertMode?:
    | 'append'
    | 'replace-file'
    | 'replace-target'
    | 'insert-before'
    | 'inside-container';
  targetText?: string;
  anchorText?: string;
}

export interface WriteLiveBlockResult {
  status: 'completed' | 'skipped' | 'stopped' | 'interrupted';
  filePath: string;
  lineNumber: number;
  speedMode: SpeedMode;
  muted: boolean;
  fileFastActive: boolean;
  question?: string;
  currentLineText?: string;
  surroundingLines?: string;
  codeWrittenSoFar?: string;
  remainingCode?: string;
  currentSentence?: string;
  instruction?: string;
}

export interface LiveCheckpointParams {
  title: string;
  question: string;
  rationale?: string;
  relatedFilePath?: string;
  options: Array<{
    id?: string;
    label: string;
    description?: string;
    recommended?: boolean;
  }>;
}

export interface LiveCheckpointResult {
  status: 'resolved' | 'stopped';
  selectedOptionId?: string;
  selectedLabel?: string;
  customReply?: string;
}

export interface LiveDriverConfig {
  language: 'fr' | 'en';
  defaultSpeed: SpeedMode;
  voiceRateMultiplier: number;
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

function inferLanguageId(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

export class LiveAgentSessionDriver {
  private playbackState: PlaybackState = 'idle';
  private speedMode: SpeedMode;
  private muted = false;
  private config: LiveDriverConfig;

  private sessionTitle = '';
  private sessionGoal = '';
  private workspaceRoot: string | undefined;
  private research: ResearchReport | null = null;

  private timelineSteps: TimelineStepSummary[] = [];
  private activeFilePath: string | null = null;
  private lastWrittenFilePath: string | null = null;
  private currentLineNumber = 1;
  private currentColumn = 1;
  private currentLineText = '';
  private surroundingLines = '';

  private activeBlock: CodeBlock | null = null;
  private charOffset = 0;
  private sentenceIndex = 0;
  private activeBlockStartLine = 1;

  private fileStopTarget: FileStopTarget | null = null;
  private pauseBanner: string | null = null;
  private activeCheckpoint: CheckpointStep | null = null;
  private activeSnapshot: LiveContextSnapshot | null = null;
  private bargeInHistory: BargeInExchange[] = [];

  private caption: SpeechCaptionState = {
    text: '',
    sentenceIndex: 0,
    totalSentences: 0,
    charIndex: 0,
    charLength: 0,
    speaking: false,
  };

  private activeAbortController: AbortController | null = null;
  private pendingOutcome: 'skipped' | 'stopped' | 'interrupted' | null = null;
  private pendingInterruptQuestion: string | null = null;

  private resumeWaiters: Array<() => void> = [];
  private checkpointWaiter: ((res: LiveCheckpointResult) => void) | null = null;

  private readonly listeners = new Set<StateListener>();
  private onCheckpointPromptNeeded?: (step: CheckpointStep) => void;
  private onBargeInPromptNeeded?: (snapshot: LiveContextSnapshot) => void;

  constructor(
    private readonly editor: ILiveEditorAdapter,
    private readonly voice: IVoiceAdapter,
    initialConfig: LiveDriverConfig,
  ) {
    this.config = { ...initialConfig };
    this.speedMode = initialConfig.defaultSpeed;
  }

  public setPromptHooks(hooks: {
    onCheckpointPromptNeeded?: (step: CheckpointStep) => void;
    onBargeInPromptNeeded?: (snapshot: LiveContextSnapshot) => void;
  }): void {
    this.onCheckpointPromptNeeded = hooks.onCheckpointPromptNeeded;
    this.onBargeInPromptNeeded = hooks.onBargeInPromptNeeded;
  }

  public updateConfig(patch: Partial<LiveDriverConfig>): void {
    this.config = { ...this.config, ...patch };
    this.emitState();
  }

  public onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getUIState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public isActive(): boolean {
    return this.playbackState !== 'idle' && this.playbackState !== 'completed';
  }

  public notifyVoiceMetadataChanged(): void {
    this.emitState();
  }

  public async startSession(params: StartLiveSessionParams): Promise<{
    ok: boolean;
    speedMode: SpeedMode;
    muted: boolean;
  }> {
    this.stop();

    const lang = params.language ?? this.config.language;
    this.config.language = lang;
    this.sessionTitle = params.title || 'MindStream Session';
    this.sessionGoal = params.goal || '';
    this.workspaceRoot = params.workspaceRoot;
    this.research = {
      summary: params.researchSummary ?? params.goal ?? '',
      findings: params.findings ?? [],
      architectureDecisions: params.architectureDecisions ?? [],
      spokenIntro: params.spokenIntro ?? '',
    };

    this.timelineSteps = (params.plannedFiles ?? []).map((fp, idx) => ({
      id: `mcp-file-${idx}`,
      kind: 'file',
      title: fp,
      filePath: fp,
      summary: fp,
      status: 'pending',
      blocks: [],
    }));

    this.editor.resetSession(false);
    this.playbackState = 'playing';
    this.activeFilePath = params.plannedFiles?.[0] ?? null;
    this.lastWrittenFilePath = null;
    this.currentLineNumber = 1;
    this.bargeInHistory = [];
    this.pauseBanner = null;
    this.fileStopTarget = null;
    this.emitState();

    if (params.spokenIntro && !this.muted) {
      const ctrl = this.createRunAbort();
      await this.speakSafe(
        params.spokenIntro,
        1.0 * this.config.voiceRateMultiplier,
        ctrl.signal,
        0,
      );
    }

    return {
      ok: true,
      speedMode: this.speedMode,
      muted: this.muted,
    };
  }

  public async writeBlock(params: WriteLiveBlockParams): Promise<WriteLiveBlockResult> {
    if (this.playbackState === 'idle') {
      await this.startSession({
        title: params.filePath,
        goal: params.title,
        workspaceRoot: params.workspaceRoot,
      });
    }

    // If a previous file had File-Fast-Pause enabled and we are moving to a new file,
    // honor the pause-at-end-of-file contract BEFORE opening the next file.
    if (
      this.fileStopTarget &&
      this.lastWrittenFilePath &&
      this.normalizePath(this.lastWrittenFilePath) !== this.normalizePath(params.filePath)
    ) {
      await this.triggerFileStopPause(this.lastWrittenFilePath);
      if (this.pendingOutcome === 'stopped' || this.playbackState === 'idle') {
        return {
          status: 'stopped',
          filePath: params.filePath,
          lineNumber: this.currentLineNumber,
          speedMode: this.speedMode,
          muted: this.muted,
          fileFastActive: false,
        };
      }
    }

    const block: CodeBlock = {
      id: `mcp-blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: params.title,
      category: params.category ?? 'core-logic',
      importance: params.importance,
      code: params.code,
      narration: params.narration,
      shortCue: params.shortCue,
      rationale: params.rationale ?? params.title,
    };

    this.activeBlock = block;
    this.charOffset = 0;
    this.sentenceIndex = 0;
    this.pendingOutcome = null;
    this.pendingInterruptQuestion = null;
    this.activeSnapshot = null;
    this.pauseBanner = null;

    const effectiveWorkspaceRoot = params.workspaceRoot ?? this.workspaceRoot;
    const langId = params.languageId ?? inferLanguageId(params.filePath);

    await this.editor.openFile(params.filePath, langId, '', effectiveWorkspaceRoot);

    await this.editor.prepareEditTarget(
      params.filePath,
      params.insertMode ?? 'append',
      params.anchorText ?? params.targetText,
      params.code.endsWith('\n') || params.code.endsWith('\r'),
    );

    this.activeFilePath = params.filePath;
    this.lastWrittenFilePath = params.filePath;
    this.activeBlockStartLine = this.currentLineNumber;
    this.registerBlockInTimeline(params.filePath, block);
    this.emitState();

    // Main loop allows seamless Pause -> Resume & Barge-in mid-block
    while (true) {
      if (this.playbackState === 'paused' || this.playbackState === 'interrupted') {
        await this.waitForResume();
      }

      if (this.pendingOutcome === 'stopped' || this.playbackState === 'idle') {
        return {
          status: 'stopped',
          filePath: params.filePath,
          lineNumber: this.currentLineNumber,
          speedMode: this.speedMode,
          muted: this.muted,
          fileFastActive: false,
        };
      }

      if (this.pendingOutcome === 'interrupted') {
        const snapshot = this.activeSnapshot ?? (await this.captureSnapshot(params.filePath, block));
        const question = this.pendingInterruptQuestion ?? '';
        this.pendingOutcome = null;
        this.pendingInterruptQuestion = null;
        return {
          status: 'interrupted',
          filePath: snapshot.filePath,
          lineNumber: snapshot.lineNumber,
          speedMode: this.speedMode,
          muted: this.muted,
          fileFastActive: this.isFileFastActive(params.filePath),
          question,
          currentLineText: snapshot.currentLineText,
          surroundingLines: snapshot.surroundingLines,
          codeWrittenSoFar: snapshot.codeWrittenSoFar,
          remainingCode: snapshot.remainingCode,
          currentSentence: snapshot.currentSentence,
          instruction:
            'Answer the user question concisely grounded on the exact line and context above (call mindstream_speak if voice is unmuted), wait for their green light if appropriate, then continue with remainingCode using append mode.',
        };
      }

      if (this.pendingOutcome === 'skipped') {
        await this.flushRemainingCode(params.filePath, block);
        this.pendingOutcome = null;
        this.markBlockDoneInTimeline(params.filePath, block.id);
        this.activeBlock = null;
        this.resetCaption(false);
        this.emitState();
        return {
          status: 'skipped',
          filePath: params.filePath,
          lineNumber: this.currentLineNumber,
          speedMode: this.speedMode,
          muted: this.muted,
          fileFastActive: this.isFileFastActive(params.filePath),
        };
      }

      const signal = this.createRunAbort().signal;
      const isFileFast = this.isFileFastActive(params.filePath);
      const initialPace = computePace(
        this.speedMode,
        block,
        this.config.voiceRateMultiplier,
        isFileFast,
        this.config.language,
      );

      const narrationText = this.selectNarrationText(block, initialPace.narrationMode);
      const speechPromise =
        narrationText && !this.muted
          ? this.speakSafe(
              narrationText,
              initialPace.speechRate,
              signal,
              this.sentenceIndex,
            )
          : Promise.resolve();

      while (this.charOffset < block.code.length && !signal.aborted) {
        const liveFast = this.isFileFastActive(params.filePath);
        const livePace = computePace(
          this.speedMode,
          block,
          this.config.voiceRateMultiplier,
          liveFast,
          this.config.language,
        );

        const nextOffset = Math.min(block.code.length, this.charOffset + livePace.chunkSize);
        const chunk = block.code.slice(this.charOffset, nextOffset);
        const appendRes = await this.editor.appendChunk(params.filePath, chunk, {
          isBlockStart: this.charOffset === 0,
          isBlockEnd: nextOffset >= block.code.length,
          blockId: block.id,
          blockTitle: block.title,
          rationale: block.rationale,
        });

        this.charOffset = nextOffset;
        this.currentLineNumber = appendRes.lineNumber;
        this.currentColumn = appendRes.column;
        this.currentLineText = appendRes.currentLineText;
        this.surroundingLines = appendRes.surroundingLines;

        await this.editor.setVisualState(
          params.filePath,
          appendRes.lineNumber,
          'playing',
          `🎙 ${block.title}`,
          { startLine: this.activeBlockStartLine, endLine: appendRes.lineNumber },
        );

        const delayMs = computeChunkDelayMs(chunk, livePace.tickMs);
        const ok = await sleepWithAbort(delayMs, signal);
        if (!ok) {
          break;
        }
      }

      await speechPromise;

      if (
        this.playbackState === 'paused' ||
        this.playbackState === 'interrupted' ||
        this.pendingOutcome !== null
      ) {
        continue;
      }

      if (!signal.aborted && this.charOffset >= block.code.length) {
        this.markBlockDoneInTimeline(params.filePath, block.id);
        this.activeBlock = null;
        this.resetCaption(false);
        this.emitState();
        return {
          status: 'completed',
          filePath: params.filePath,
          lineNumber: this.currentLineNumber,
          speedMode: this.speedMode,
          muted: this.muted,
          fileFastActive: this.isFileFastActive(params.filePath),
        };
      }
      // Otherwise aborted due to pause/skip/stop/interrupt — loop handles outcome on next iteration.
    }
  }

  public async askCheckpoint(params: LiveCheckpointParams): Promise<LiveCheckpointResult> {
    if (this.playbackState === 'idle') {
      this.playbackState = 'checkpoint';
    } else {
      this.playbackState = 'checkpoint';
    }

    const options: CheckpointOption[] = params.options.map((o, idx) => ({
      id: o.id ?? `opt-${idx}`,
      label: o.label,
      description: o.description ?? '',
      recommended: o.recommended,
    }));

    const step: CheckpointStep = {
      kind: 'checkpoint',
      id: `mcp-ck-${Date.now()}`,
      title: params.title,
      question: params.question,
      rationale: params.rationale ?? '',
      relatedFilePath: params.relatedFilePath,
      options,
    };

    this.activeCheckpoint = step;
    this.resetCaption(false);
    await this.syncEditorDecorator();
    this.emitState();

    if (!this.muted && params.question) {
      const ckAbort = this.createRunAbort();
      void this.speakSafe(
        params.question,
        1.0 * this.config.voiceRateMultiplier,
        ckAbort.signal,
        0,
      );
    }

    const result = await new Promise<LiveCheckpointResult>((resolve) => {
      this.checkpointWaiter = resolve;
      this.onCheckpointPromptNeeded?.(step);
    });

    this.activeCheckpoint = null;
    if (result.status === 'resolved') {
      this.playbackState = 'playing';
    }
    await this.syncEditorDecorator();
    this.emitState();
    return result;
  }

  public resolveCheckpoint(optionId: string, customReply?: string): void {
    const ck = this.activeCheckpoint;
    if (!ck || !this.checkpointWaiter) {
      return;
    }

    const chosen = ck.options.find((o) => o.id === optionId) ?? ck.options[0];
    this.voice.stopImmediately();
    const waiter = this.checkpointWaiter;
    this.checkpointWaiter = null;

    waiter({
      status: 'resolved',
      selectedOptionId: chosen?.id,
      selectedLabel: chosen?.label,
      customReply: customReply?.trim() ? customReply.trim() : undefined,
    });
  }

  public async speak(text: string, waitForCompletion = true): Promise<{ ok: boolean; muted: boolean }> {
    if (!text.trim() || this.muted) {
      return { ok: true, muted: this.muted };
    }

    const signal = this.createRunAbort().signal;
    const p = this.speakSafe(text, 1.02 * this.config.voiceRateMultiplier, signal, 0);
    if (waitForCompletion) {
      await p;
    }
    return { ok: true, muted: this.muted };
  }

  public async finishSession(
    summary: string,
    spokenOutro?: string,
  ): Promise<{ ok: boolean }> {
    if (this.fileStopTarget && this.lastWrittenFilePath) {
      await this.triggerFileStopPause(this.lastWrittenFilePath);
      if (this.pendingOutcome === 'stopped' || this.playbackState === 'idle') {
        return { ok: true };
      }
    }

    this.playbackState = 'completed';
    this.activeBlock = null;
    this.fileStopTarget = null;
    this.pauseBanner = summary || null;
    this.resetCaption(false);
    await this.syncEditorDecorator();
    this.emitState();

    if (spokenOutro && !this.muted) {
      const ctrl = this.createRunAbort();
      await this.speakSafe(
        spokenOutro,
        1.02 * this.config.voiceRateMultiplier,
        ctrl.signal,
        0,
      );
    }

    return { ok: true };
  }

  public pause(bannerMessage?: string): void {
    if (this.playbackState === 'idle' || this.playbackState === 'completed') {
      return;
    }
    if (bannerMessage) {
      this.pauseBanner = bannerMessage;
    }
    this.playbackState = 'paused';
    this.abortActiveRun();
    this.resetCaption(false);
    void this.syncEditorDecorator();
    this.emitState();
  }

  public resume(): void {
    if (this.playbackState === 'idle' || this.playbackState === 'completed') {
      return;
    }
    this.pauseBanner = null;
    this.activeSnapshot = null;
    this.playbackState = 'playing';
    this.emitState();
    this.wakeAllResumeWaiters();
  }

  public togglePlayPause(): void {
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'interrupted') {
      this.resume();
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

  public skipBlock(): void {
    if (!this.isActive()) {
      return;
    }
    if (this.playbackState === 'checkpoint' && this.activeCheckpoint) {
      const rec =
        this.activeCheckpoint.options.find((o) => o.recommended) ??
        this.activeCheckpoint.options[0];
      if (rec) {
        this.resolveCheckpoint(rec.id);
      }
      return;
    }
    this.pendingOutcome = 'skipped';
    this.pauseBanner = null;
    this.playbackState = 'playing';
    this.abortActiveRun();
    this.wakeAllResumeWaiters();
  }

  public implementFileAndPause(filePath?: string): boolean {
    const target = filePath ?? this.activeFilePath;
    if (!target) {
      return false;
    }
    const previousSpeed = this.fileStopTarget?.previousSpeed ?? this.speedMode;
    this.fileStopTarget = {
      filePath: target,
      stepId: target,
      previousSpeed,
    };
    this.voice.stopImmediately();
    if (this.playbackState === 'paused') {
      this.resume();
    } else {
      this.emitState();
    }
    return true;
  }

  public async interruptWithPrompt(): Promise<LiveContextSnapshot | null> {
    if (!this.isActive()) {
      return null;
    }
    this.playbackState = 'interrupted';
    this.abortActiveRun();
    this.resetCaption(false);

    const filePath = this.activeFilePath ?? 'session';
    const snapshot = await this.captureSnapshot(filePath, this.activeBlock);
    this.activeSnapshot = snapshot;
    await this.syncEditorDecorator();
    this.emitState();

    this.onBargeInPromptNeeded?.(snapshot);
    return snapshot;
  }

  public submitBargeInQuestion(
    question: string,
    source: BargeInExchange['source'] = 'text',
  ): void {
    const clean = question.trim();
    if (!clean) {
      this.cancelBargeInToPause();
      return;
    }

    const snapshot = this.activeSnapshot;
    const exchange: BargeInExchange = {
      id: `mcp-qa-${Date.now()}`,
      question: clean,
      answer:
        this.config.language === 'fr'
          ? 'Transmis à votre agent IA dans le chat…'
          : 'Sent to your AI agent in chat…',
      filePath: snapshot?.filePath ?? this.activeFilePath ?? 'session',
      lineNumber: snapshot?.lineNumber ?? this.currentLineNumber,
      timestamp: Date.now(),
      source,
    };
    this.bargeInHistory = [...this.bargeInHistory, exchange];
    this.pendingOutcome = 'interrupted';
    this.pendingInterruptQuestion = clean;
    this.playbackState = 'playing';
    this.emitState();
    this.wakeAllResumeWaiters();
  }

  public cancelBargeInToPause(): void {
    if (this.playbackState === 'interrupted') {
      this.playbackState = 'paused';
      this.pauseBanner =
        this.config.language === 'fr'
          ? 'En pause. Cliquez sur ▶ Reprendre quand vous êtes prêt.'
          : 'Paused. Click ▶ Resume whenever you are ready.';
      void this.syncEditorDecorator();
      this.emitState();
    }
  }

  public stop(): void {
    this.pendingOutcome = 'stopped';
    this.abortActiveRun();

    if (this.checkpointWaiter) {
      const waiter = this.checkpointWaiter;
      this.checkpointWaiter = null;
      waiter({ status: 'stopped' });
    }

    this.playbackState = 'idle';
    this.activeBlock = null;
    this.activeCheckpoint = null;
    this.activeSnapshot = null;
    this.fileStopTarget = null;
    this.pauseBanner = null;
    this.timelineSteps = [];
    this.activeFilePath = null;
    this.lastWrittenFilePath = null;
    this.resetCaption(false);
    this.editor.clearDecorations();
    this.wakeAllResumeWaiters();
    this.emitState();
  }

  public applyControl(
    action:
      | 'pause'
      | 'resume'
      | 'skip'
      | 'stop'
      | 'mute'
      | 'unmute'
      | 'set_speed'
      | 'file_fast_pause'
      | 'status',
    opts?: { speed?: SpeedMode; filePath?: string },
  ): Record<string, unknown> {
    switch (action) {
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resume();
        break;
      case 'skip':
        this.skipBlock();
        break;
      case 'stop':
        this.stop();
        break;
      case 'mute':
        this.setMuted(true);
        break;
      case 'unmute':
        this.setMuted(false);
        break;
      case 'set_speed':
        if (opts?.speed) {
          this.setSpeed(opts.speed);
        }
        break;
      case 'file_fast_pause':
        this.implementFileAndPause(opts?.filePath);
        break;
      case 'status':
        break;
    }

    return {
      playbackState: this.playbackState,
      speedMode: this.speedMode,
      muted: this.muted,
      currentFilePath: this.activeFilePath,
      currentLineNumber: this.currentLineNumber,
      fileStopTarget: this.fileStopTarget,
    };
  }

  public getUIState(): SessionUIState {
    const fileFast = this.activeFilePath
      ? this.isFileFastActive(this.activeFilePath)
      : false;
    const effectivePace: EffectivePaceInfo | null = this.activeBlock
      ? computePace(
          this.speedMode,
          this.activeBlock,
          this.config.voiceRateMultiplier,
          fileFast,
          this.config.language,
        )
      : null;

    const totalBlocks = this.timelineSteps.reduce(
      (acc, s) => acc + (s.blocks?.length ?? 0),
      0,
    );
    const doneBlocks = this.timelineSteps.reduce(
      (acc, s) => acc + (s.blocks?.filter((b) => b.status === 'done').length ?? 0),
      0,
    );
    const progressPercent =
      this.playbackState === 'completed'
        ? 100
        : totalBlocks > 0
          ? Math.min(99, Math.round((doneBlocks / totalBlocks) * 100))
          : 0;

    return {
      playbackState: this.playbackState,
      language: this.config.language,
      speedMode: this.speedMode,
      effectivePace,
      muted: this.muted,
      isDemo: false,
      isMcpSession: true,
      sessionTitle: this.sessionTitle,
      sessionGoal: this.sessionGoal,
      research: this.research,
      researchStatusMessage: '',
      currentStepIndex: Math.max(
        0,
        this.timelineSteps.findIndex((s) => s.status === 'active'),
      ),
      totalSteps: this.timelineSteps.length,
      currentBlockIndex: 0,
      totalBlocksInCurrentFile: 0,
      currentFilePath: this.activeFilePath,
      currentLineNumber: this.currentLineNumber,
      currentBlockTitle: this.activeBlock?.title ?? this.activeCheckpoint?.title ?? null,
      currentBlockRationale:
        this.activeBlock?.rationale ?? this.activeCheckpoint?.rationale ?? null,
      currentBlockImportance: this.activeBlock
        ? classifyImportance(this.activeBlock)
        : null,
      progressPercent,
      fileStopTarget: this.fileStopTarget,
      pauseBanner: this.pauseBanner,
      activeCheckpoint: this.activeCheckpoint,
      activeSnapshot: this.activeSnapshot,
      bargeInHistory: this.bargeInHistory,
      isAnsweringQuestion: false,
      caption: { ...this.caption },
      timeline: this.timelineSteps,
      activeProviderLabel: this.config.providerLabel,
      ttsBackendLabel: this.voice.getBackendLabel(),
      availableVoices: this.voice.getAvailableVoices(),
      selectedVoiceId: this.voice.getSelectedVoiceId(),
    };
  }

  private async triggerFileStopPause(completedFilePath: string): Promise<void> {
    if (!this.fileStopTarget) {
      return;
    }
    const prevSpeed = this.fileStopTarget.previousSpeed;
    this.speedMode = prevSpeed;
    this.fileStopTarget = null;
    this.playbackState = 'paused';
    this.pauseBanner =
      this.config.language === 'fr'
        ? `Fichier ${completedFilePath} terminé en mode rapide. Relisez tranquillement, puis cliquez ▶ Reprendre.`
        : `Finished ${completedFilePath} in fast mode. Inspect calmly, then click ▶ Resume.`;
    this.resetCaption(false);
    await this.syncEditorDecorator();
    this.emitState();

    if (!this.muted) {
      const ctrl = this.createRunAbort();
      const notice =
        this.config.language === 'fr'
          ? `Le fichier ${completedFilePath} est terminé. Je me mets en pause pour que tu puisses le relire.`
          : `${completedFilePath} is complete. Pausing here for your review.`;
      void this.speakSafe(notice, 1.05 * this.config.voiceRateMultiplier, ctrl.signal, 0);
    }

    await this.waitForResume();
  }

  private async flushRemainingCode(filePath: string, block: CodeBlock): Promise<void> {
    const remaining = block.code.slice(this.charOffset);
    if (remaining.length > 0) {
      const res = await this.editor.appendChunk(filePath, remaining, {
        isBlockStart: this.charOffset === 0,
        isBlockEnd: true,
        blockId: block.id,
        blockTitle: block.title,
        rationale: block.rationale,
      });
      this.charOffset = block.code.length;
      this.currentLineNumber = res.lineNumber;
      this.currentColumn = res.column;
      this.currentLineText = res.currentLineText;
      this.surroundingLines = res.surroundingLines;
    }
  }

  private async captureSnapshot(
    filePath: string,
    block: CodeBlock | null,
  ): Promise<LiveContextSnapshot> {
    const editorCtx = await this.editor.getContextSnapshot(filePath);
    const lineNumber = editorCtx?.lineNumber ?? this.currentLineNumber;
    const column = editorCtx?.column ?? this.currentColumn;
    const currentLineText = editorCtx?.currentLineText ?? this.currentLineText;
    const surroundingLines = editorCtx?.surroundingLines ?? this.surroundingLines;

    const sentences = block ? splitSentences(block.narration) : [];
    const currentSentence =
      this.caption.text ||
      sentences[Math.min(this.sentenceIndex, Math.max(0, sentences.length - 1))] ||
      '';

    return {
      filePath,
      lineNumber,
      column,
      blockId: block?.id ?? 'live',
      blockTitle: block?.title ?? this.sessionTitle,
      blockRationale: block?.rationale ?? this.research?.summary ?? '',
      codeWrittenSoFar: block ? block.code.slice(0, this.charOffset) : '',
      remainingCode: block ? block.code.slice(this.charOffset) : '',
      currentLineText,
      surroundingLines,
      currentSentence,
      fullNarration: block?.narration ?? '',
    };
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
      // Never block code execution on speech synthesis glitches.
    } finally {
      if (!signal.aborted) {
        this.caption = { ...this.caption, speaking: false };
        this.emitState();
      }
    }
  }

  private selectNarrationText(
    block: CodeBlock,
    mode: EffectivePaceInfo['narrationMode'],
  ): string {
    if (mode === 'silent') return '';
    if (mode === 'short') {
      return block.shortCue ?? splitSentences(block.narration)[0] ?? '';
    }
    return block.narration;
  }

  private isFileFastActive(filePath: string): boolean {
    if (!this.fileStopTarget) {
      return false;
    }
    const a = this.normalizePath(this.fileStopTarget.filePath);
    const b = this.normalizePath(filePath);
    return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  private registerBlockInTimeline(filePath: string, block: CodeBlock): void {
    let step = this.timelineSteps.find(
      (s) => s.kind === 'file' && this.normalizePath(s.filePath ?? '') === this.normalizePath(filePath),
    );
    if (!step) {
      step = {
        id: `mcp-file-${this.timelineSteps.length}`,
        kind: 'file',
        title: filePath,
        filePath,
        summary: filePath,
        status: 'active',
        blocks: [],
      };
      this.timelineSteps = [...this.timelineSteps, step];
    }

    for (const s of this.timelineSteps) {
      if (s !== step && s.status === 'active') {
        s.status = 'done';
      }
    }
    step.status = 'active';
    const summary: TimelineBlockSummary = {
      id: block.id,
      title: block.title,
      category: block.category,
      importance: classifyImportance(block),
      status: 'active',
    };
    step.blocks = [...(step.blocks ?? []), summary];
  }

  private markBlockDoneInTimeline(filePath: string, blockId: string): void {
    const step = this.timelineSteps.find(
      (s) => s.kind === 'file' && this.normalizePath(s.filePath ?? '') === this.normalizePath(filePath),
    );
    if (!step?.blocks) {
      return;
    }
    const blk = step.blocks.find((b) => b.id === blockId);
    if (blk) {
      blk.status = 'done';
    }
  }

  private async syncEditorDecorator(): Promise<void> {
    if (!this.activeFilePath) {
      return;
    }
    await this.editor.setVisualState(
      this.activeFilePath,
      this.currentLineNumber,
      this.playbackState,
    );
  }

  private waitForResume(): Promise<void> {
    if (this.playbackState !== 'paused' && this.playbackState !== 'interrupted') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  private wakeAllResumeWaiters(): void {
    const list = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const r of list) {
      r();
    }
  }

  private createRunAbort(): AbortController {
    this.activeAbortController?.abort();
    const ctrl = new AbortController();
    this.activeAbortController = ctrl;
    return ctrl;
  }

  private abortActiveRun(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
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
    const snap = this.getUIState();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
