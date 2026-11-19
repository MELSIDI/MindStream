import { describe, expect, it } from 'vitest';
import { classifyImportance, computeChunkDelayMs, computePace } from '../src/engine/SmartPacer';
import { CodeBlock } from '../src/types/session';

const boilerplateBlock: CodeBlock = {
  id: 'b-boiler',
  title: 'Imports',
  category: 'boilerplate',
  code: "import type { FocusTask } from './types.ts';\nexport type Mode = 'a' | 'b';\n",
  narration: 'Déclaration rapide des imports et types.',
  shortCue: 'Imports rapides.',
  rationale: 'Types de base.',
};

const coreLogicBlock: CodeBlock = {
  id: 'b-core',
  title: 'Store Logic',
  category: 'core-logic',
  code: [
    'public subscribe(listener: Listener): () => void {',
    '  this.listeners.add(listener);',
    '  if (this.listeners.size > 0) {',
    '    listener(this.getSnapshot());',
    '  }',
    '  return () => { this.listeners.delete(listener); };',
    '}',
  ].join('\n'),
  narration:
    'Ici on enregistre le listener dans un Set et on retourne une closure de nettoyage pour éviter toute fuite mémoire.',
  rationale: 'Closure de désabonnement.',
};

describe('SmartPacer', () => {
  it('classifies pure imports/types without explicit importance as low', () => {
    const noExplicit: CodeBlock = { ...boilerplateBlock, importance: undefined };
    expect(classifyImportance(noExplicit)).toBe('low');

    const coreNoExplicit: CodeBlock = { ...coreLogicBlock, importance: undefined };
    expect(classifyImportance(coreNoExplicit)).toBe('high');
  });

  it('speeds up boilerplate and silences full narration in Smart Auto mode', () => {
    const autoBoiler = computePace('auto', boilerplateBlock, 1.0, false, 'fr');
    const autoCore = computePace('auto', coreLogicBlock, 1.0, false, 'fr');

    expect(autoBoiler.importance).toBe('low');
    expect(autoBoiler.autoReason).toBe('boilerplate');
    expect(autoBoiler.charsPerSecond).toBeGreaterThan(250);
    expect(autoBoiler.narrationMode).toBe('short');

    expect(autoCore.importance).toBe('high');
    expect(autoCore.autoReason).toBe('core-logic');
    expect(autoCore.charsPerSecond).toBeLessThan(60);
    expect(autoCore.narrationMode).toBe('full');
  });

  it('respects 0.5x, 1x, 2x, 3x speed hierarchy and clamps synced 1x cps', () => {
    const p05 = computePace('0.5x', coreLogicBlock, 1.0, false, 'fr');
    const p1 = computePace('1x', coreLogicBlock, 1.0, false, 'fr');
    const p2 = computePace('2x', coreLogicBlock, 1.0, false, 'fr');
    const p3 = computePace('3x', coreLogicBlock, 1.0, false, 'fr');

    expect(p05.speechRate).toBeLessThan(p1.speechRate);
    expect(p1.charsPerSecond).toBeGreaterThanOrEqual(16);
    expect(p1.charsPerSecond).toBeLessThanOrEqual(58);
    expect(p2.charsPerSecond).toBeGreaterThan(p1.charsPerSecond);
    expect(p3.charsPerSecond).toBeGreaterThan(p2.charsPerSecond);
    expect(p3.narrationMode).toBe('short');
  });

  it('forces fast silent mode when File-Only Fast Mode is active', () => {
    const fileFast = computePace('0.5x', coreLogicBlock, 1.0, true, 'fr');
    expect(fileFast.autoReason).toBe('file-fast');
    expect(fileFast.narrationMode).toBe('silent');
    expect(fileFast.charsPerSecond).toBeGreaterThanOrEqual(300);
  });

  it('adjusts chunk cadence subtly for indentation spaces and newlines', () => {
    const spaceDelay = computeChunkDelayMs('  ', 20);
    const normalDelay = computeChunkDelayMs('x', 20);
    const newlineDelay = computeChunkDelayMs('\n', 20);

    expect(spaceDelay).toBeLessThan(normalDelay);
    expect(newlineDelay).toBeGreaterThan(normalDelay);
  });
});
