import { IQuestionResponder } from '../engine/PlaybackEngine';
import {
  CodeBlock,
  CodingSessionPlan,
  FileStep,
  LiveContextSnapshot,
} from '../types/session';
import { detectLanguage } from '../voice/LanguageDetector';

interface ConstructMatcher {
  pattern: RegExp;
  fr: string;
  en: string;
}

const CONSTRUCT_ANALYZERS: ConstructMatcher[] = [
  {
    pattern: /\breadonly\b/,
    fr: "Le mot-clé `readonly` verrouille la propriété après création pour empêcher toute modification accidentelle en dehors du store.",
    en: 'The `readonly` modifier prevents external callers from mutating properties outside controlled store methods.',
  },
  {
    pattern: /\bnew Map\b|\bMap</,
    fr: "J'utilise une `Map` plutôt qu'un simple tableau afin de retrouver ou mettre à jour une tâche par son ID en temps constant O(1).",
    en: 'Using `Map` instead of an array gives O(1) lookup and update by task ID.',
  },
  {
    pattern: /\bnew Set\b|\bSet</,
    fr: 'Le `Set` évite automatiquement les doublons si le même composant s’abonne deux fois, tout en simplifiant la suppression.',
    en: '`Set` automatically prevents duplicate listeners and allows instant deletion on unsubscribe.',
  },
  {
    pattern: /\bsubscribe\b|\bonChange\b|return\s*\(\)\s*=>/,
    fr: "Cette méthode retourne une fonction de nettoyage par closure : l'appelant l'invoque pour se désabonner et éviter toute fuite mémoire.",
    en: 'Returning a cleanup closure lets callers unsubscribe cleanly without leaking memory.',
  },
  {
    pattern: /\bDate\.now\b|targetEndTimestamp/,
    fr: "Calculer le temps restant via `Date.now()` et un horodatage cible élimine la dérive cumulée des timers JavaScript.",
    en: 'Computing remaining time from `Date.now()` against a target timestamp avoids cumulative timer drift.',
  },
  {
    pattern: /\bMath\.max\b/,
    fr: "`Math.max(0, ...)` garantit que le compteur ne descend jamais dans les négatifs même si un tick arrive légèrement en retard.",
    en: '`Math.max(0, ...)` ensures the remaining countdown never drops below zero.',
  },
  {
    pattern: /\.\.\./,
    fr: "L'opérateur spread (`...`) duplique l'état précédent pour produire un nouvel objet propre sans altérer la référence d'origine.",
    en: 'Object spread (`...`) clones existing fields into a fresh object without mutating the original reference.',
  },
  {
    pattern: /\bimport\s+type\b/,
    fr: "`import type` indique à TypeScript d'effacer complètement cet import à l'exécution : aucun coût runtime ni dépendance circulaire.",
    en: '`import type` is completely erased at runtime, preventing circular runtime dependencies.',
  },
];

export class DemoQAEngine implements IQuestionResponder {
  public async answerQuestion(
    question: string,
    snapshot: LiveContextSnapshot,
    plan: CodingSessionPlan,
    customOptionHint?: string,
  ): Promise<string> {
    const lang = detectLanguage(question, plan.language).language;
    const qLower = question.toLowerCase();

    // 1. Check block-specific qaHints when the question language matches the plan language
    const matchedBlock = this.findBlock(plan, snapshot.blockId);
    if (matchedBlock?.qaHints && lang === plan.language) {
      for (const [keyword, hintAnswer] of Object.entries(matchedBlock.qaHints)) {
        if (qLower.includes(keyword.toLowerCase())) {
          return this.formatAnswer(snapshot, hintAnswer, lang);
        }
      }
    }

    // 2. Check dynamic TypeScript constructs on current line / written code
    const inspectionText = `${snapshot.currentLineText}\n${snapshot.codeWrittenSoFar}\n${snapshot.surroundingLines}`;
    for (const analyzer of CONSTRUCT_ANALYZERS) {
      if (analyzer.pattern.test(inspectionText) && this.matchesQuestionIntent(qLower, analyzer.pattern)) {
        return this.formatAnswer(snapshot, lang === 'fr' ? analyzer.fr : analyzer.en, lang);
      }
    }

    // 3. Fallback: direct check against construct in current line specifically
    for (const analyzer of CONSTRUCT_ANALYZERS) {
      if (analyzer.pattern.test(snapshot.currentLineText)) {
        const prefix =
          lang === 'fr'
            ? `Sur la ligne ${snapshot.lineNumber} de ${snapshot.filePath} : ${snapshot.blockRationale}`
            : `On line ${snapshot.lineNumber} of ${snapshot.filePath}: ${snapshot.blockRationale}`;
        const detail = lang === 'fr' ? analyzer.fr : analyzer.en;
        return this.formatAnswer(snapshot, `${prefix} ${detail}`, lang);
      }
    }

    // 4. General lost / why / what-is-this explanation grounded in exact snapshot
    if (customOptionHint) {
      return lang === 'fr'
        ? `Bien noté par rapport à "${customOptionHint}" : "${question}". Je garde ce contexte en tête sur ${snapshot.filePath}.`
        : `Noted regarding "${customOptionHint}": "${question}". Keeping that context in mind for ${snapshot.filePath}.`;
    }

    const coreExplanation =
      lang === 'fr'
        ? `Nous sommes dans ${snapshot.filePath} à la ligne ${snapshot.lineNumber}, sur le bloc "${snapshot.blockTitle}". ${snapshot.blockRationale}`
        : `We are in ${snapshot.filePath} on line ${snapshot.lineNumber}, inside "${snapshot.blockTitle}". ${snapshot.blockRationale}`;

    return this.formatAnswer(snapshot, coreExplanation, lang);
  }

  private findBlock(plan: CodingSessionPlan, blockId: string): CodeBlock | undefined {
    for (const step of plan.steps) {
      if (step.kind === 'file') {
        const found = (step as FileStep).blocks.find((b) => b.id === blockId);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  private matchesQuestionIntent(qLower: string, pattern: RegExp): boolean {
    const source = pattern.source.toLowerCase();
    if (source.includes('readonly') && qLower.includes('readonly')) return true;
    if (source.includes('map') && qLower.includes('map')) return true;
    if (source.includes('set') && qLower.includes('set')) return true;
    if (source.includes('subscribe') && (qLower.includes('subscribe') || qLower.includes('retourne') || qLower.includes('return') || qLower.includes('closure'))) return true;
    if (source.includes('date') && (qLower.includes('date') || qLower.includes('now') || qLower.includes('temps') || qLower.includes('timer'))) return true;
    if (source.includes('math') && qLower.includes('math')) return true;
    if (source.includes('import') && qLower.includes('import')) return true;
    if (source.includes('\\.\\.\\.') && (qLower.includes('spread') || qLower.includes('...') || qLower.includes('copie'))) return true;
    return false;
  }

  private formatAnswer(
    snapshot: LiveContextSnapshot,
    body: string,
    lang: 'fr' | 'en',
  ): string {
    const suffix =
      lang === 'fr'
        ? ` Dis-moi quand tu veux reprendre à la ligne ${snapshot.lineNumber}.`
        : ` Let me know when you're ready to resume at line ${snapshot.lineNumber}.`;
    return `${body}${suffix}`;
  }
}
