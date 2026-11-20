import { LanguageSetting } from '../types/session';

export interface LanguageDetectionResult {
  language: 'fr' | 'en';
  confidence: number;
  frScore: number;
  enScore: number;
  source: 'detected' | 'fallback';
}

const FRENCH_DIACRITICS_RE = /[éèêëàâäùûüôöîïçœæ]/i;
const FRENCH_ELISION_RE = /(?:^|[\s([{"'«])(?:l|d|qu|n|s|c|j|m|t)['’][a-zà-ÿ]{2,}/gi;
const ENGLISH_CONTRACTION_RE =
  /(?:^|[\s([{"'])(?:don't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't|can't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|it's|that's|what's|there's|here's|where's|who's|let's|i'm|you're|we're|they're|i've|you've|we've|they've|i'll|you'll|we'll|they'll|i'd|you'd|we'd|they'd)(?=$|[\s.,!?;:)\]}"'])/gi;

/** Words strongly characteristic of French prose, including unaccented everyday forms. */
const FRENCH_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'au', 'aux', 'ce', 'cet', 'cette', 'ces',
  'mon', 'ton', 'son', 'ma', 'ta', 'sa', 'mes', 'tes', 'ses', 'notre', 'votre', 'leur', 'leurs',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'moi', 'toi', 'lui', 'eux',
  'qui', 'que', 'quoi', 'dont', 'ou', 'où', 'quand', 'comment', 'pourquoi', 'combien',
  'est', 'sont', 'suis', 'es', 'sommes', 'etes', 'êtes', 'etait', 'était', 'sera', 'soit',
  'ai', 'as', 'avons', 'avez', 'ont', 'avoir', 'etre', 'être', 'faut', 'peut', 'peux', 'veut', 'veux',
  'fais', 'fait', 'faire', 'faits', 'dit', 'dire', 'met', 'mets', 'mettre', 'prend', 'prendre',
  'avec', 'sans', 'dans', 'sur', 'sous', 'pour', 'par', 'vers', 'chez', 'entre', 'pendant', 'depuis',
  'avant', 'apres', 'après', 'alors', 'donc', 'mais', 'car', 'puis', 'ensuite', 'aussi', 'encore',
  'plus', 'moins', 'tres', 'très', 'bien', 'mal', 'pas', 'rien', 'jamais', 'toujours', 'souvent',
  'ici', 'voici', 'voila', 'voilà', 'oui', 'non', 'merci', 'bonjour', 'salut', 'tout', 'tous', 'toute', 'toutes',
  'chaque', 'autre', 'autres', 'meme', 'même', 'comme', 'si', 'parce', 'puisque', 'afin', 'lorsque',
  'ajouter', 'ajoute', 'creer', 'créer', 'cree', 'crée', 'gerer', 'gérer', 'gere', 'gère',
  'implémenter', 'implemente', 'implémente', 'verifier', 'vérifier', 'verifie', 'vérifie',
  'corriger', 'corrige', 'expliquer', 'explique', 'utiliser', 'utilise', 'utilises', 'utilisons',
  'choisir', 'choisis', 'choisit', 'savoir', 'comprendre', 'garder', 'garde', 'passer', 'passe',
  'fichier', 'fichiers', 'ligne', 'lignes', 'fonction', 'fonctions', 'methode', 'méthode',
  'donnee', 'donnée', 'donnees', 'données', 'projet', 'etape', 'étape', 'etapes', 'étapes',
  'vitesse', 'voix', 'langue', 'francais', 'français', 'anglais', 'rapide', 'rapidement', 'lentement',
  'maintenant', 'suite', 'deja', 'déjà', 'seulement', 'simplement', 'automatiquement',
  'permet', 'permettre', 'eviter', 'éviter', 'evite', 'évite', 'garantit', 'garantir',
  'renvoie', 'retourne', 'recupere', 'récupère', 'sauvegarde', 'charge', 'affiche', 'ecrit', 'écrit',
]);

/** Words strongly characteristic of English prose (excluding neutral tech nouns like api/json/map/set). */
const ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our', 'their',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'us', 'them', 'it', 'its',
  'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'with', 'without', 'from', 'into', 'onto', 'upon', 'about', 'above', 'below', 'under', 'over',
  'between', 'through', 'during', 'before', 'after', 'around', 'against', 'among', 'within',
  'and', 'or', 'but', 'because', 'since', 'although', 'though', 'while', 'whereas', 'unless', 'until',
  'if', 'then', 'else', 'also', 'already', 'always', 'never', 'often', 'sometimes', 'usually',
  'very', 'much', 'many', 'more', 'most', 'less', 'few', 'only', 'just', 'even', 'still', 'yet',
  'here', 'there', 'now', 'today', 'yes', 'please', 'thanks', 'hello', 'hi', 'welcome', 'ready',
  'all', 'each', 'every', 'some', 'any', 'both', 'other', 'another', 'such', 'same', 'own',
  'make', 'makes', 'made', 'create', 'creates', 'created', 'build', 'builds', 'built',
  'add', 'adds', 'added', 'implement', 'implements', 'implemented', 'handle', 'handles', 'handled',
  'use', 'uses', 'used', 'using', 'keep', 'keeps', 'kept', 'check', 'checks', 'checked',
  'explain', 'explains', 'avoid', 'avoids', 'ensure', 'ensures', 'return', 'returns', 'returning',
  'allow', 'allows', 'allowing', 'prevent', 'prevents', 'instead', 'inside', 'outside',
  'write', 'writes', 'writing', 'read', 'reads', 'reading', 'run', 'runs', 'running',
  'need', 'needs', 'want', 'wants', 'work', 'works', 'working', 'know', 'understand',
  'step', 'steps', 'file', 'files', 'line', 'lines', 'voice', 'speech', 'language', 'english', 'french',
  'speed', 'fast', 'slow', 'slowly', 'quickly', 'automatically', 'locally', 'smart',
]);

/** Remove code blocks, paths, URLs, slash directives, and camelCase/snake_case symbols before language scoring. */
function stripCodeNoise(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)[/@][a-zA-Z0-9_-]+/g, ' ')
    .replace(/\b[a-zA-Z0-9_.-]+(?:[\\/][a-zA-Z0-9_.-]+)+\b/g, ' ')
    .replace(/\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g, ' ')
    .replace(/\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g, ' ')
    .replace(/\b[a-zA-Z0-9]+_[a-zA-Z0-9_]+\b/g, ' ')
    .replace(/\b[A-Z0-9_]{3,}\b/g, ' ');
}

/**
 * Intelligently detects whether natural prose (even mixed with code terminology)
 * is French or English. Falls back cleanly on short or ambiguous inputs.
 */
export function detectLanguage(
  text: string,
  fallback: 'fr' | 'en' = 'fr',
): LanguageDetectionResult {
  const cleaned = stripCodeNoise(text ?? '').trim();
  if (!cleaned) {
    return {
      language: fallback,
      confidence: 0,
      frScore: 0,
      enScore: 0,
      source: 'fallback',
    };
  }

  let frScore = 0;
  let enScore = 0;

  const frElisions = cleaned.match(FRENCH_ELISION_RE);
  if (frElisions) {
    frScore += frElisions.length * 2.4;
  }

  const enContractions = cleaned.match(ENGLISH_CONTRACTION_RE);
  if (enContractions) {
    enScore += enContractions.length * 2.4;
  }

  // Split words while preserving accented Latin letters.
  const tokens = cleaned
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .match(/[a-zàâäéèêëîïôöùûüçœæ]{1,}/gi) ?? [];

  for (const token of tokens) {
    if (FRENCH_DIACRITICS_RE.test(token)) {
      frScore += 2.2;
      continue;
    }
    if (FRENCH_WORDS.has(token)) {
      frScore += token.length >= 4 ? 1.8 : 1.4;
    }
    if (ENGLISH_WORDS.has(token)) {
      enScore += token.length >= 4 ? 1.8 : 1.4;
    }
  }

  const maxScore = Math.max(frScore, enScore);
  const diff = Math.abs(frScore - enScore);
  const total = frScore + enScore;

  if (maxScore < 1.4 || diff < 0.8) {
    return {
      language: fallback,
      confidence: 0,
      frScore,
      enScore,
      source: 'fallback',
    };
  }

  const winner: 'fr' | 'en' = frScore > enScore ? 'fr' : 'en';
  const confidence = Math.min(1, Number((diff / Math.max(total, 1)).toFixed(3)));

  return {
    language: winner,
    confidence,
    frScore,
    enScore,
    source: 'detected',
  };
}

/**
 * Resolves the effective session language ('fr' | 'en') from user setting ('auto' | 'fr' | 'en')
 * plus optional prompt/text context.
 */
export function resolveEffectiveLanguage(
  setting: LanguageSetting | undefined,
  text?: string,
  fallback: 'fr' | 'en' = 'fr',
): 'fr' | 'en' {
  if (setting === 'fr' || setting === 'en') {
    return setting;
  }
  if (!text || !text.trim()) {
    return fallback;
  }
  return detectLanguage(text, fallback).language;
}

/**
 * Resolves the spoken language of a single sentence. When auto-detection is enabled,
 * switches transparently between French and English per sentence when confident.
 */
export function resolveUtteranceLanguage(
  sentence: string,
  sessionLang: 'fr' | 'en',
  autoDetect: boolean,
): 'fr' | 'en' {
  if (!autoDetect) {
    return sessionLang;
  }
  const detected = detectLanguage(sentence, sessionLang);
  if (detected.source === 'detected' && detected.confidence >= 0.2) {
    return detected.language;
  }
  return sessionLang;
}

/** Derives a safe FR/EN fallback from the host IDE/OS locale (e.g. vscode.env.language). */
export function getSystemLocaleFallback(hostLocale?: string): 'fr' | 'en' {
  if (!hostLocale) {
    return 'fr';
  }
  return hostLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}
