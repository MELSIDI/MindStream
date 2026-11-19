import {
  BlockImportance,
  CodeBlock,
  EffectivePaceInfo,
  SpeedMode,
} from '../types/session';
import { estimateSpeechDurationMs } from './SentenceSplitter';

export const SPEED_ORDER: SpeedMode[] = ['0.5x', '1x', '2x', '3x', 'auto'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Classifies how pedagogically critical a code block is.
 * Explicit `block.importance` wins when provided, except we refine heuristics
 * when `importance` is omitted.
 */
export function classifyImportance(block: CodeBlock): BlockImportance {
  if (block.importance) {
    return block.importance;
  }

  const code = block.code.trim();
  const lines = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'));

  const hasControlOrStateLogic =
    /\b(if|else|switch|for|while|try|catch|throw|await|new\s+Map|new\s+Set|setInterval|clearInterval|subscribe|Date\.now|Math\.)\b/.test(
      code,
    ) || /=>\s*\{/.test(code);

  if (
    !hasControlOrStateLogic &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.startsWith('import ') ||
        line.startsWith('export type ') ||
        line.startsWith('export interface ') ||
        line.startsWith('type ') ||
        line.startsWith('interface ') ||
        /^[}\]);,|]+$/.test(line) ||
        /^(readonly\s+)?[a-zA-Z_]\w*\??:\s*[^=]+;?\s*$/.test(line) ||
        /^\|/.test(line),
    )
  ) {
    return 'low';
  }

  if (block.category === 'boilerplate') {
    return 'low';
  }

  if (block.category === 'core-logic' || block.category === 'architecture' || hasControlOrStateLogic) {
    return 'high';
  }

  return 'medium';
}

function paceFromCps(
  speedMode: SpeedMode,
  importance: BlockImportance,
  cps: number,
  speechRate: number,
  narrationMode: EffectivePaceInfo['narrationMode'],
  label: string,
  autoReason?: EffectivePaceInfo['autoReason'],
): EffectivePaceInfo {
  const clampedCps = clamp(Math.round(cps), 10, 500);
  // Keep tickMs >= 20ms to preserve smooth UI rendering & low CPU overhead;
  // increase chunkSize when cps exceeds ~48 chars/sec.
  let chunkSize = 1;
  let tickMs = Math.round(1000 / clampedCps);

  if (tickMs < 22) {
    chunkSize = Math.max(2, Math.ceil((clampedCps * 24) / 1000));
    tickMs = Math.max(16, Math.round((chunkSize * 1000) / clampedCps));
  }

  return {
    speedMode,
    importance,
    charsPerSecond: clampedCps,
    tickMs,
    chunkSize,
    speechRate: Number(speechRate.toFixed(2)),
    narrationMode,
    autoReason,
    label,
  };
}

/**
 * Computes effective typing cadence & voice behavior for a block given the
 * user's selected speed mode and whether File-Only Fast Mode is active.
 */
export function computePace(
  speedMode: SpeedMode,
  block: CodeBlock,
  voiceRateMultiplier = 1.0,
  isFileFastMode = false,
  lang: 'fr' | 'en' = 'fr',
): EffectivePaceInfo {
  const importance = classifyImportance(block);
  const mult = clamp(voiceRateMultiplier, 0.6, 1.8);
  const codeLen = Math.max(1, block.code.length);

  if (isFileFastMode) {
    return paceFromCps(
      speedMode,
      importance,
      320,
      1.5 * mult,
      'silent',
      lang === 'fr' ? '🎯 Mode Fichier · Rapide' : '🎯 File Mode · Fast',
      'file-fast',
    );
  }

  if (speedMode === '0.5x') {
    const speechRate = 0.72 * mult;
    const estSec = Math.max(1.2, estimateSpeechDurationMs(block.narration, speechRate) / 1000);
    const syncedCps = clamp(codeLen / estSec, 14, 22);
    return paceFromCps(
      speedMode,
      importance,
      syncedCps,
      speechRate,
      'full',
      lang === 'fr' ? '0.5x · Lent & Détaillé' : '0.5x · Slow & Detailed',
    );
  }

  if (speedMode === '1x') {
    const speechRate = 1.0 * mult;
    const estSec = Math.max(1.0, estimateSpeechDurationMs(block.narration, speechRate) / 1000);
    const syncedCps = clamp(codeLen / estSec, 16, 58);
    return paceFromCps(
      speedMode,
      importance,
      syncedCps,
      speechRate,
      'full',
      lang === 'fr' ? '1x · Humain & Synchronisé' : '1x · Human Synced',
    );
  }

  if (speedMode === '2x') {
    return paceFromCps(
      speedMode,
      importance,
      115,
      1.35 * mult,
      'full',
      lang === 'fr' ? '2x · Accéléré' : '2x · Fast',
    );
  }

  if (speedMode === '3x') {
    return paceFromCps(
      speedMode,
      importance,
      280,
      1.65 * mult,
      'short',
      lang === 'fr' ? '3x · Turbo' : '3x · Turbo',
    );
  }

  // Smart Auto Mode
  if (importance === 'low') {
    return paceFromCps(
      speedMode,
      importance,
      340,
      1.45 * mult,
      block.shortCue ? 'short' : 'silent',
      lang === 'fr' ? '✨ Auto · Rapide (Boilerplate)' : '✨ Auto · Fast (Boilerplate)',
      'boilerplate',
    );
  }

  if (importance === 'high') {
    const speechRate = 0.98 * mult;
    const estSec = Math.max(1.2, estimateSpeechDurationMs(block.narration, speechRate) / 1000);
    const syncedCps = clamp(codeLen / estSec, 18, 46);
    return paceFromCps(
      speedMode,
      importance,
      syncedCps,
      speechRate,
      'full',
      lang === 'fr' ? '✨ Auto · Pédagogique (Logique clé)' : '✨ Auto · Deep Focus (Core Logic)',
      'core-logic',
    );
  }

  return paceFromCps(
    speedMode,
    importance,
    72,
    1.12 * mult,
    'full',
    lang === 'fr' ? '✨ Auto · Fluide (Standard)' : '✨ Auto · Steady (Standard)',
    'standard',
  );
}

/**
 * Adds subtle human rhythm variation per typed chunk (faster on indentation
 * spaces, brief natural breath on newlines, semicolons, and opening braces).
 */
export function computeChunkDelayMs(chunk: string, baseTickMs: number): number {
  if (!chunk) {
    return baseTickMs;
  }

  if (/^\s+$/.test(chunk) && !chunk.includes('\n')) {
    return Math.max(6, Math.round(baseTickMs * 0.45));
  }

  if (chunk.includes('\n')) {
    return Math.min(240, Math.round(baseTickMs * 1.9 + 18));
  }

  if (chunk.endsWith(';') || chunk.endsWith('{')) {
    return Math.min(180, Math.round(baseTickMs * 1.45 + 10));
  }

  return baseTickMs;
}
