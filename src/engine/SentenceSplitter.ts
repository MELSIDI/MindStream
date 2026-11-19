const ALWAYS_PROTECTED_ABBREVIATIONS = /\b(e\.g|i\.e|cf|ex|vs|approx|fig)\./gi;
const INLINE_ETC = /\betc\.(?!\s+[A-ZÀ-ÖØ-Þ])/gi;
const PLACEHOLDER = '\uE000';

/**
 * Splits spoken narration into natural sentences while preserving dotted code
 * identifiers (e.g. `Date.now()`, `taskStore.ts`, `v1.0`, `0.5x`) and common
 * abbreviations (`e.g.`, inline `etc.`).
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  let masked = trimmed.replace(ALWAYS_PROTECTED_ABBREVIATIONS, (match) =>
    match.replace(/\./g, PLACEHOLDER),
  );
  masked = masked.replace(INLINE_ETC, (match) => match.replace(/\./g, PLACEHOLDER));

  // Protect dots directly nestled between alphanumeric/underscore characters
  // such as `Date.now()`, `taskStore.ts`, `0.5x`, `React.useState`.
  masked = masked.replace(/([A-Za-z0-9_])\.([A-Za-z0-9_])/g, `$1${PLACEHOLDER}$2`);

  // Split after sentence-ending punctuation followed by whitespace (or end).
  const rawParts = masked.split(/(?<=[.!?…]+(?:["'»)]*))(?:\s+|$)/u);

  return rawParts
    .map((part) => part.replaceAll(PLACEHOLDER, '.').trim())
    .filter((part) => part.length > 0);
}

/**
 * Estimates natural spoken duration in milliseconds at ~2.7 words/sec base rate.
 */
export function estimateSpeechDurationMs(text: string, speechRate = 1.0): number {
  const clean = text.trim();
  if (!clean) {
    return 0;
  }

  const words = clean.split(/\s+/).filter(Boolean).length;
  const punctuationMatches = clean.match(/[,;:—–\-!?….]/g);
  const punctuationPauseMs = (punctuationMatches?.length ?? 0) * 90;
  const effectiveRate = Math.min(2.5, Math.max(0.4, speechRate));
  const baseWordsPerSec = 2.7;
  const rawMs = (words / baseWordsPerSec) * 1000 + punctuationPauseMs;

  return Math.max(400, Math.round(rawMs / effectiveRate));
}
