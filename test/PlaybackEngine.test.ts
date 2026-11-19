import { describe, expect, it } from 'vitest';
import {
  AppendChunkOptions,
  AppendChunkResult,
  IEditorAdapter,
  IQuestionResponder,
  IVoiceAdapter,
  PlaybackEngine,
  SpeakOptions,
} from '../src/engine/PlaybackEngine';
import { CodingSessionPlan, PlaybackState, VoiceOptionInfo } from '../src/types/session';

class MemoryEditorAdapter implements IEditorAdapter {
  public readonly files = new Map<string, string>();
  public readonly visualHistory: Array<{ file: string | null; line: number; state: PlaybackState }> = [];

  async openFile(filePath: string): Promise<void> {
    if (!this.files.has(filePath)) {
      this.files.set(filePath, '');
    }
  }

  async appendChunk(
    filePath: string,
    chunk: string,
    _options: AppendChunkOptions,
  ): Promise<AppendChunkResult> {
    const prev = this.files.get(filePath) ?? '';
    const next = prev + chunk;
    this.files.set(filePath, next);
    const lines = next.split('\n');
    const lineNumber = lines.length;
    const currentLineText = lines[lines.length - 1] ?? '';
    return {
      lineNumber,
      column: currentLineText.length + 1,
      currentLineText,
      surroundingLines: lines.slice(-5).join('\n'),
    };
  }

  async getContextSnapshot(filePath: string) {
    const content = this.files.get(filePath) ?? '';
    const lines = content.split('\n');
    return {
      lineNumber: lines.length,
      column: (lines[lines.length - 1] ?? '').length + 1,
      currentLineText: lines[lines.length - 1] ?? '',
      surroundingLines: lines.slice(-5).join('\n'),
    };
  }

  async setVisualState(
    filePath: string | null,
    lineNumber: number,
    state: PlaybackState,
  ): Promise<void> {
    this.visualHistory.push({ file: filePath, line: lineNumber, state });
  }

  clearDecorations(): void {}
}

class MockVoiceAdapter implements IVoiceAdapter {
  public readonly spokenCalls: Array<{ text: string; startSentenceIndex: number }> = [];
  public stopCount = 0;

  async speakSentences(text: string, options: SpeakOptions): Promise<void> {
    this.spokenCalls.push({
      text,
      startSentenceIndex: options.startSentenceIndex ?? 0,
    });
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    const start = options.startSentenceIndex ?? 0;
    for (let i = start; i < sentences.length; i++) {
      if (options.signal?.aborted) {
        return;
      }
      options.onSentenceStart?.(i, sentences[i], sentences.length);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 12);
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  stopImmediately(): void {
    this.stopCount += 1;
  }

  getBackendLabel(): string {
    return 'Mock Voice';
  }

  getAvailableVoices(): VoiceOptionInfo[] {
    return [];
  }

  getSelectedVoiceId(): string | null {
    return null;
  }
}

function makeSamplePlan(): CodingSessionPlan {
  return {
    id: 'test-plan',
    title: 'Test Plan',
    goal: 'Test MindStream',
    isDemo: true,
    language: 'fr',
    rootSubdir: 'tmp-test',
    research: {
      summary: 'Research summary',
      findings: ['Finding A'],
      architectureDecisions: ['Decision A'],
      spokenIntro: 'Intro rapide.',
    },
    steps: [
      {
        kind: 'file',
        id: 'step-a',
        filePath: 'a.ts',
        languageId: 'typescript',
        summary: 'File A',
        blocks: [
          {
            id: 'a-1',
            title: 'Block A1',
            category: 'core-logic',
            importance: 'high',
            code: 'export const alpha = 100;\nexport const beta = 200;\n',
            narration: 'Première phrase. Deuxième phrase.',
            rationale: 'Définit alpha et beta.',
          },
        ],
      },
      {
        kind: 'checkpoint',
        id: 'ck-1',
        title: 'Check Strategy',
        question: 'Use variant B?',
        rationale: 'Architectural choice.',
        options: [
          {
            id: 'opt-default',
            label: 'Default',
            description: 'Keep default',
            recommended: true,
            variantKey: 'default',
          },
          {
            id: 'opt-alt',
            label: 'Variant B',
            description: 'Swap to B',
            variantKey: 'alt-b',
          },
        ],
      },
      {
        kind: 'file',
        id: 'step-b',
        filePath: 'b.ts',
        languageId: 'typescript',
        summary: 'File B',
        blocks: [
          {
            id: 'b-1',
            title: 'Block B1',
            category: 'core-logic',
            importance: 'high',
            code: 'export const mode = "default";\n',
            narration: 'Mode par défaut.',
            rationale: 'Choix standard.',
            variants: {
              'alt-b': {
                code: 'export const mode = "variant-b";\n',
                narration: 'Mode variant B activé.',
              },
            },
          },
        ],
      },
    ],
  };
}

async function waitForState(
  engine: PlaybackEngine,
  predicate: (state: PlaybackState) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(engine.getUIState().playbackState)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `Timed out waiting for state; current state=${engine.getUIState().playbackState}`,
  );
}

describe('PlaybackEngine', () => {
  it('pauses mid-block and resumes from exact character offset without duplication', async () => {
    const editor = new MemoryEditorAdapter();
    const voice = new MockVoiceAdapter();
    const responder: IQuestionResponder = {
      answerQuestion: async () => 'Réponse contextuelle.',
    };

    const engine = new PlaybackEngine(editor, voice, responder, {
      language: 'fr',
      defaultSpeed: '0.5x',
      voiceRateMultiplier: 1.0,
      autoResearchIntro: false,
      providerLabel: 'Test',
    });

    await engine.loadSession(makeSamplePlan(), true);

    // Wait until some characters have been written into a.ts, then pause mid-block
    await waitForState(
      engine,
      () => (editor.files.get('a.ts')?.length ?? 0) >= 8,
    );
    engine.pause();
    const writtenAtPause = editor.files.get('a.ts') ?? '';
    expect(engine.getUIState().playbackState).toBe('paused');
    expect(writtenAtPause.length).toBeGreaterThan(0);
    expect(writtenAtPause.length).toBeLessThan(
      'export const alpha = 100;\nexport const beta = 200;\n'.length,
    );

    // Switch to fast mode mid-block and resume; should reach checkpoint cleanly
    engine.setSpeed('3x');
    await engine.resume();
    await waitForState(engine, (s) => s === 'checkpoint');

    expect(editor.files.get('a.ts')).toBe(
      'export const alpha = 100;\nexport const beta = 200;\n',
    );
  });

  it('handles Barge-in interrupt, captures exact snapshot, answers in context, and waits for green light', async () => {
    const editor = new MemoryEditorAdapter();
    const voice = new MockVoiceAdapter();
    let capturedFile = '';
    let capturedLine = 0;

    const responder: IQuestionResponder = {
      answerQuestion: async (q, snap) => {
        capturedFile = snap.filePath;
        capturedLine = snap.lineNumber;
        return `Explication pour "${q}" à la ligne ${snap.lineNumber}.`;
      },
    };

    const engine = new PlaybackEngine(editor, voice, responder, {
      language: 'fr',
      defaultSpeed: '0.5x',
      voiceRateMultiplier: 1.0,
      autoResearchIntro: false,
      providerLabel: 'Test',
    });

    await engine.loadSession(makeSamplePlan(), true);
    await waitForState(
      engine,
      () => (editor.files.get('a.ts')?.length ?? 0) >= 12,
    );

    const snapshot = await engine.interrupt();
    expect(snapshot).not.toBeNull();
    expect(engine.getUIState().playbackState).toBe('interrupted');
    expect(voice.stopCount).toBeGreaterThan(0);

    const exchange = await engine.askQuestion('Pourquoi alpha ici ?');
    expect(exchange?.answer).toContain('Explication pour');
    expect(capturedFile).toBe('a.ts');
    expect(capturedLine).toBeGreaterThanOrEqual(1);
    // Must stay interrupted waiting for user green light
    expect(engine.getUIState().playbackState).toBe('interrupted');

    engine.setSpeed('3x');
    await engine.resume();
    await waitForState(engine, (s) => s === 'checkpoint');

    // Resolving checkpoint with variant alt-b swaps b.ts implementation
    await engine.resolveCheckpoint('opt-alt');
    await waitForState(engine, (s) => s === 'completed');

    expect(editor.files.get('a.ts')).toBe(
      'export const alpha = 100;\nexport const beta = 200;\n',
    );
    expect(editor.files.get('b.ts')).toBe('export const mode = "variant-b";\n');
  });

  it('implements a targeted file quickly then auto-pauses and restores previous speed', async () => {
    const editor = new MemoryEditorAdapter();
    const voice = new MockVoiceAdapter();
    const responder: IQuestionResponder = {
      answerQuestion: async () => 'Ok',
    };

    const engine = new PlaybackEngine(editor, voice, responder, {
      language: 'fr',
      defaultSpeed: '1x',
      voiceRateMultiplier: 1.0,
      autoResearchIntro: false,
      providerLabel: 'Test',
    });

    await engine.loadSession(makeSamplePlan(), false);
    const ok = await engine.implementFileAndPause('a.ts');
    expect(ok).toBe(true);

    await waitForState(engine, (s) => s === 'paused');

    const state = engine.getUIState();
    expect(editor.files.get('a.ts')).toBe(
      'export const alpha = 100;\nexport const beta = 200;\n',
    );
    expect(state.speedMode).toBe('1x');
    expect(state.fileStopTarget).toBeNull();
    expect(state.pauseBanner).toContain('a.ts');
  });
});
