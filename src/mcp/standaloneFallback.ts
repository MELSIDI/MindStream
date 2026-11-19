import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  LiveCheckpointParams,
  StartLiveSessionParams,
  WriteLiveBlockParams,
} from '../bridge/LiveAgentSessionDriver';
import {
  findBeforeAnchorOffset,
  findContainerInsertionPoint,
  normalizeLineEndings,
} from '../editor/ContainerLocator';
import { computeChunkDelayMs, computePace } from '../engine/SmartPacer';
import { CodeBlock, SpeedMode } from '../types/session';
import { NativeTTSFallback } from '../voice/NativeTTSFallback';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Headless / CLI fallback when no IDE CodePace Extension bridge is active.
 * Writes files progressively to disk and narrates via OS native TTS.
 */
export class StandaloneFallback {
  private readonly tts = new NativeTTSFallback();
  private speedMode: SpeedMode = '1x';
  private muted = false;
  private language: 'fr' | 'en' = 'fr';
  private workspaceRoot = process.cwd();
  private activeFilePath: string | null = null;
  private fileFastTarget: string | null = null;

  public async startSession(params: StartLiveSessionParams): Promise<Record<string, unknown>> {
    this.language = params.language ?? 'fr';
    this.workspaceRoot = params.workspaceRoot || process.cwd();
    this.fileFastTarget = null;

    if (params.spokenIntro && !this.muted) {
      await this.tts.speak(params.spokenIntro, this.language, 1.0);
    }

    return {
      ok: true,
      bridgeMode: 'standalone',
      speedMode: this.speedMode,
      muted: this.muted,
    };
  }

  public async writeBlock(params: WriteLiveBlockParams): Promise<Record<string, unknown>> {
    const root = params.workspaceRoot || this.workspaceRoot;
    const fullPath = path.isAbsolute(params.filePath)
      ? params.filePath
      : path.resolve(root, params.filePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    let existing = '';
    try {
      existing = await fs.readFile(fullPath, 'utf8');
    } catch {
      existing = '';
    }

    const eol: '\n' | '\r\n' = existing.includes('\r\n') ? '\r\n' : '\n';
    const normCode = normalizeLineEndings(params.code, eol);

    let prefix = '';
    let suffix = '';
    const insertMode = params.insertMode ?? 'append';
    const anchorOrTarget = params.anchorText ?? params.targetText;

    if (insertMode === 'replace-file') {
      prefix = '';
      suffix = '';
    } else if (insertMode === 'replace-target' && anchorOrTarget) {
      const normTarget = normalizeLineEndings(anchorOrTarget, eol);
      const idx = existing.indexOf(normTarget);
      if (idx !== -1) {
        prefix = existing.slice(0, idx);
        suffix = existing.slice(idx + normTarget.length);
      } else {
        prefix = existing;
      }
    } else if (insertMode === 'insert-before' && anchorOrTarget) {
      const found = findBeforeAnchorOffset(existing, anchorOrTarget, eol);
      prefix = existing.slice(0, found.insertOffset);
      suffix = existing.slice(found.insertOffset);
    } else if (insertMode === 'inside-container' && anchorOrTarget) {
      const container = findContainerInsertionPoint(
        existing,
        anchorOrTarget,
        eol,
        normCode.endsWith('\n') || normCode.endsWith('\r'),
      );
      if (container.matched) {
        prefix = existing.slice(0, container.insertOffset) + container.prefixToInsert;
        suffix =
          container.suffixToInsert +
          existing.slice(container.insertOffset + container.deleteLength);
      } else {
        prefix = existing;
      }
    } else {
      prefix = existing;
    }

    const block: CodeBlock = {
      id: `standalone-${Date.now()}`,
      title: params.title,
      category: params.category ?? 'core-logic',
      importance: params.importance,
      code: normCode,
      narration: params.narration,
      shortCue: params.shortCue,
      rationale: params.rationale ?? params.title,
    };

    const isFileFast =
      this.fileFastTarget !== null &&
      this.fileFastTarget.toLowerCase() === params.filePath.toLowerCase();
    const pace = computePace(this.speedMode, block, 1.0, isFileFast, this.language);
    this.activeFilePath = params.filePath;

    const speechPromise =
      !this.muted && pace.narrationMode !== 'silent'
        ? this.tts.speak(
            pace.narrationMode === 'short'
              ? block.shortCue || params.narration
              : params.narration,
            this.language,
            pace.speechRate,
          )
        : Promise.resolve();

    let written = '';
    let offset = 0;
    while (offset < normCode.length) {
      const next = Math.min(normCode.length, offset + pace.chunkSize);
      const chunk = normCode.slice(offset, next);
      written += chunk;
      offset = next;
      await fs.writeFile(fullPath, prefix + written + suffix, 'utf8');
      await sleep(computeChunkDelayMs(chunk, pace.tickMs));
    }

    await speechPromise;

    const lineNumber = (prefix + written).split('\n').length;
    return {
      status: 'completed',
      bridgeMode: 'standalone',
      filePath: params.filePath,
      lineNumber,
      speedMode: this.speedMode,
      muted: this.muted,
    };
  }

  public async checkpoint(params: LiveCheckpointParams): Promise<Record<string, unknown>> {
    const rec = params.options.find((o) => o.recommended) ?? params.options[0];
    return {
      status: 'resolved',
      bridgeMode: 'standalone',
      selectedOptionId: rec?.id ?? 'opt-0',
      selectedLabel: rec?.label ?? 'Confirm',
      note: 'No live IDE bridge running; auto-selected recommended option. Ask user in chat for major design choices.',
    };
  }

  public async speak(text: string, waitForCompletion = true): Promise<Record<string, unknown>> {
    if (!this.muted && text.trim()) {
      const p = this.tts.speak(text, this.language, 1.0);
      if (waitForCompletion) {
        await p;
      }
    }
    return { ok: true, bridgeMode: 'standalone', muted: this.muted };
  }

  public control(
    action: string,
    opts?: { speed?: SpeedMode; filePath?: string },
  ): Record<string, unknown> {
    if (action === 'set_speed' && opts?.speed) {
      this.speedMode = opts.speed;
    } else if (action === 'mute') {
      this.muted = true;
      this.tts.stop();
    } else if (action === 'unmute') {
      this.muted = false;
    } else if (action === 'file_fast_pause') {
      this.fileFastTarget = opts?.filePath ?? this.activeFilePath;
    } else if (action === 'stop') {
      this.tts.stop();
      this.fileFastTarget = null;
    }

    return {
      bridgeMode: 'standalone',
      speedMode: this.speedMode,
      muted: this.muted,
      currentFilePath: this.activeFilePath,
    };
  }

  public async finishSession(spokenOutro?: string): Promise<Record<string, unknown>> {
    if (spokenOutro && !this.muted) {
      await this.tts.speak(spokenOutro, this.language, 1.0);
    }
    return { ok: true, bridgeMode: 'standalone' };
  }

  public dispose(): void {
    this.tts.dispose();
  }
}
