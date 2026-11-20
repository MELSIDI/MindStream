import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  getSystemLocaleFallback,
  resolveEffectiveLanguage,
  resolveUtteranceLanguage,
} from '../src/voice/LanguageDetector';

describe('LanguageDetector', () => {
  it('detects accented and unaccented French accurately even with English code jargon', () => {
    const accented = detectLanguage(
      "Implémente une `Map` asynchrone pour gérer le cache des `UserSession` et éviter les requêtes en double.",
      'en',
    );
    expect(accented.language).toBe('fr');
    expect(accented.source).toBe('detected');
    expect(accented.confidence).toBeGreaterThan(0.4);

    const unaccented = detectLanguage(
      'Fais moi un script python pour gerer les fichiers et verifier pourquoi cette fonction renvoie null',
      'en',
    );
    expect(unaccented.language).toBe('fr');
    expect(unaccented.source).toBe('detected');

    const mixedWithCode = detectLanguage(
      'Ajoute un event listener sur `SnakeGame` dans `src/game/SnakeEngine.ts` pour mettre a jour le score.',
      'en',
    );
    expect(mixedWithCode.language).toBe('fr');
    expect(mixedWithCode.source).toBe('detected');
  });

  it('detects English accurately even with code snippets and technical identifiers', () => {
    const pureEn = detectLanguage(
      'Build an authentication service with JWT token refresh and rate limiting middleware.',
      'fr',
    );
    expect(pureEn.language).toBe('en');
    expect(pureEn.source).toBe('detected');
    expect(pureEn.confidence).toBeGreaterThan(0.4);

    const mixedEn = detectLanguage(
      "Why are we using a `Map` instead of an array inside `TaskStore.ts` here? Because we want O(1) lookups.",
      'fr',
    );
    expect(mixedEn.language).toBe('en');
    expect(mixedEn.source).toBe('detected');
  });

  it('falls back cleanly on ambiguous or symbol-only strings', () => {
    const codeOnly = detectLanguage('`export const x = fooBarBaz(my_var);`', 'fr');
    expect(codeOnly.language).toBe('fr');
    expect(codeOnly.source).toBe('fallback');

    const tiny = detectLanguage('OK.', 'en');
    expect(tiny.language).toBe('en');
    expect(tiny.source).toBe('fallback');
  });

  it('respects explicit language overrides in resolveEffectiveLanguage', () => {
    expect(resolveEffectiveLanguage('fr', 'Hello world, how are you?', 'en')).toBe('fr');
    expect(resolveEffectiveLanguage('en', 'Bonjour tout le monde !', 'fr')).toBe('en');
    expect(resolveEffectiveLanguage('auto', 'Why does this function return early?', 'fr')).toBe('en');
    expect(resolveEffectiveLanguage('auto', 'Pourquoi cette fonction retourne ici ?', 'en')).toBe('fr');
  });

  it('switches per-utterance language automatically when autoDetect is enabled', () => {
    expect(
      resolveUtteranceLanguage(
        'Voici comment nous initialisons le serveur HTTP local.',
        'en',
        true,
      ),
    ).toBe('fr');

    expect(
      resolveUtteranceLanguage(
        'Now let us add validation for incoming JSON payloads.',
        'fr',
        true,
      ),
    ).toBe('en');

    expect(
      resolveUtteranceLanguage(
        'Now let us add validation for incoming JSON payloads.',
        'fr',
        false,
      ),
    ).toBe('fr');
  });

  it('derives system locale fallback cleanly', () => {
    expect(getSystemLocaleFallback('fr-FR')).toBe('fr');
    expect(getSystemLocaleFallback('fr')).toBe('fr');
    expect(getSystemLocaleFallback('en-US')).toBe('en');
    expect(getSystemLocaleFallback(undefined)).toBe('fr');
  });
});
