import { describe, expect, it } from 'vitest';
import { estimateSpeechDurationMs, splitSentences } from '../src/engine/SentenceSplitter';

describe('SentenceSplitter', () => {
  it('splits French and English sentences while preserving dotted identifiers', () => {
    const input =
      "J'ouvre taskStore.ts avec Date.now(). Ensuite j'ajoute v1.0 en mode 0.5x! Ça te va?";
    const parts = splitSentences(input);

    expect(parts).toEqual([
      "J'ouvre taskStore.ts avec Date.now().",
      "Ensuite j'ajoute v1.0 en mode 0.5x!",
      'Ça te va?',
    ]);
  });

  it('preserves abbreviations like e.g. and etc. inside sentences', () => {
    const input = 'Use literal types, e.g. TaskStatus, etc. Then compile cleanly.';
    const parts = splitSentences(input);

    expect(parts).toEqual([
      'Use literal types, e.g. TaskStatus, etc.',
      'Then compile cleanly.',
    ]);
  });

  it('estimates longer duration for slower speech rates and returns 0 for empty input', () => {
    expect(estimateSpeechDurationMs('', 1.0)).toBe(0);
    const normal = estimateSpeechDurationMs('Bonjour tout le monde, voici une fonction claire.', 1.0);
    const slow = estimateSpeechDurationMs('Bonjour tout le monde, voici une fonction claire.', 0.7);
    const fast = estimateSpeechDurationMs('Bonjour tout le monde, voici une fonction claire.', 1.5);

    expect(slow).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(fast);
  });
});
