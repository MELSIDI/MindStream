import {
  ExtensionToWebviewMessage,
  SessionUIState,
  SpeedMode,
  WebviewToExtensionMessage,
} from '../types/session';
import { WebviewSpeechBridge } from './speechBridge';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToExtensionMessage) => vscode.postMessage(msg);
const speech = new WebviewSpeechBridge(post);

let currentState: SessionUIState | null = null;
let structuralSignature = '';

let draftBargeIn = '';
let draftCheckpointCustom = '';
let micStatusNote = '';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function getStructuralSignature(s: SessionUIState): string {
  return JSON.stringify({
    playbackState: s.playbackState,
    language: s.language,
    speedMode: s.speedMode,
    muted: s.muted,
    isDemo: s.isDemo,
    isMcpSession: Boolean(s.isMcpSession),
    sessionTitle: s.sessionTitle,
    currentStepIndex: s.currentStepIndex,
    currentBlockIndex: s.currentBlockIndex,
    fileStopPath: s.fileStopTarget?.filePath ?? null,
    pauseBanner: s.pauseBanner,
    checkpointId: s.activeCheckpoint?.id ?? null,
    snapshotLine: s.activeSnapshot?.lineNumber ?? null,
    bargeInCount: s.bargeInHistory.length,
    isAnsweringQuestion: s.isAnsweringQuestion,
    voicesCount: s.availableVoices.length,
    selectedVoiceId: s.selectedVoiceId,
    ttsBackendLabel: s.ttsBackendLabel,
    autoReason: s.effectivePace?.autoReason ?? null,
    timelineLen: s.timeline.length,
    timelineDone: s.timeline.filter((t) => t.status === 'done').length,
  });
}

function renderCaptionContent(container: HTMLElement, state: SessionUIState): void {
  container.replaceChildren();
  const isFr = state.language === 'fr';
  const text = state.caption.text;

  if (!text) {
    container.appendChild(
      el(
        'span',
        'hud-caption-muted',
        state.playbackState === 'playing'
          ? isFr
            ? 'Mode silencieux rapide sur ce bloc…'
            : 'Fast silent mode on this block…'
          : isFr
            ? 'Sous-titres synchronisés prêts.'
            : 'Synchronized captions ready.',
      ),
    );
    return;
  }

  const charIdx = Math.max(0, Math.min(text.length, state.caption.charIndex));
  const charLen = Math.max(0, state.caption.charLength);

  if (charLen > 0 && charIdx < text.length) {
    const before = text.slice(0, charIdx);
    const active = text.slice(charIdx, Math.min(text.length, charIdx + charLen));
    const after = text.slice(Math.min(text.length, charIdx + charLen));
    if (before) container.appendChild(document.createTextNode(before));
    container.appendChild(el('mark', 'hud-karaoke', active));
    if (after) container.appendChild(document.createTextNode(after));
  } else {
    container.textContent = text;
  }
}

function updateLiveSpotsOnly(state: SessionUIState): void {
  const progressFill = document.getElementById('cp-progress-fill');
  if (progressFill) {
    progressFill.style.width = `${state.progressPercent}%`;
  }
  const locationEl = document.getElementById('cp-live-location');
  if (locationEl) {
    locationEl.textContent = state.currentFilePath
      ? `${state.currentFilePath}:${state.currentLineNumber}`
      : state.sessionTitle || 'MindStream';
  }
  const captionTextEl = document.getElementById('cp-caption-text');
  if (captionTextEl) {
    renderCaptionContent(captionTextEl, state);
  }
  const waveEl = document.getElementById('cp-waveform');
  if (waveEl) {
    waveEl.classList.toggle(
      'speaking',
      state.playbackState === 'playing' && state.caption.speaking && !state.muted,
    );
  }
}

function buildIdleHud(state: SessionUIState): HTMLElement {
  const isFr = state.language === 'fr';
  const card = el('div', 'hud-card hud-idle');

  const top = el('div', 'hud-row-between');
  top.appendChild(el('span', 'hud-title', 'MindStream Mini-HUD'));
  top.appendChild(el('span', 'hud-pill', 'Ready'));
  card.appendChild(top);

  const hint = el(
    'p',
    'hud-text',
    isFr
      ? 'Ajoutez /MindStream à n’importe quel prompt dans votre chat Antigravity ou VS Code (ex : « Implémente le projet ... /MindStream »). Aucune autre fenêtre requise.'
      : 'Append /MindStream to any prompt in your existing Antigravity or VS Code chat (e.g., "Build feature X /MindStream"). No extra window needed.',
  );
  card.appendChild(hint);

  const shortcuts = el(
    'div',
    'hud-shortcuts',
    'Ctrl+Alt+P Pause · Ctrl+Alt+S Vitesse · Ctrl+Alt+N Skip · Ctrl+Shift+Space Stop?',
  );
  card.appendChild(shortcuts);

  const actions = el('div', 'hud-row');
  const demoBtn = el(
    'button',
    'hud-btn hud-btn-primary',
    isFr ? '▶ Démo FocusFlow' : '▶ FocusFlow Demo',
  );
  demoBtn.addEventListener('click', () => post({ type: 'startDemo' }));

  const pluginBtn = el(
    'button',
    'hud-btn hud-btn-ghost',
    isFr ? '🔌 Plugin /MindStream' : '🔌 /MindStream Plugin',
  );
  pluginBtn.addEventListener('click', () => post({ type: 'installPlugin' }));

  actions.append(demoBtn, pluginBtn);
  card.appendChild(actions);

  return card;
}

function buildPlayerHud(state: SessionUIState): HTMLElement {
  const isFr = state.language === 'fr';
  const card = el('div', `hud-card hud-player state-${state.playbackState}`);

  // Header line: waveform + source pill + location
  const top = el('div', 'hud-row-between');
  const left = el('div', 'hud-row-tight');
  const wave = el(
    'div',
    `hud-wave ${state.playbackState === 'playing' && state.caption.speaking && !state.muted ? 'speaking' : ''}`,
  );
  wave.id = 'cp-waveform';
  for (let i = 0; i < 4; i++) {
    wave.appendChild(el('span', 'hud-wave-bar'));
  }

  const modePill = el(
    'span',
    'hud-pill',
    state.isMcpSession ? 'MCP 🟢' : 'Demo',
  );
  left.append(wave, modePill);

  const loc = el(
    'span',
    'hud-loc',
    state.currentFilePath
      ? `${state.currentFilePath}:${state.currentLineNumber}`
      : state.sessionTitle || 'MindStream',
  );
  loc.id = 'cp-live-location';
  top.append(left, loc);
  card.appendChild(top);

  if (state.currentBlockTitle) {
    card.appendChild(el('div', 'hud-block-name', state.currentBlockTitle));
  }

  // Thin progress bar
  const track = el('div', 'hud-progress-track');
  const fill = el('div', 'hud-progress-fill');
  fill.id = 'cp-progress-fill';
  fill.style.width = `${state.progressPercent}%`;
  track.appendChild(fill);
  card.appendChild(track);

  // Minimalist transport strip
  const controls = el('div', 'hud-controls');

  if (state.isDemo) {
    const prevBtn = el('button', 'hud-icon-btn', '⏮');
    prevBtn.title = isFr ? 'Bloc précédent' : 'Previous';
    prevBtn.addEventListener('click', () => post({ type: 'previousBlock' }));
    controls.appendChild(prevBtn);
  }

  const isPlaying = state.playbackState === 'playing';
  const playBtn = el(
    'button',
    'hud-btn hud-btn-primary hud-play-btn',
    state.playbackState === 'plan-ready'
      ? isFr
        ? '▶ Démarrer'
        : '▶ Start'
      : isPlaying
        ? '⏸ Pause'
        : isFr
          ? '▶ Reprendre'
          : '▶ Resume',
  );
  playBtn.disabled = state.playbackState === 'checkpoint' || state.playbackState === 'completed';
  playBtn.addEventListener('click', () => post({ type: 'togglePlayPause' }));

  const nextBtn = el('button', 'hud-icon-btn', '⏭');
  nextBtn.title = isFr ? 'Passer au bloc suivant (Ctrl+Alt+N)' : 'Skip block (Ctrl+Alt+N)';
  nextBtn.disabled = state.playbackState === 'completed';
  nextBtn.addEventListener('click', () => post({ type: 'skipBlock' }));

  const fastBtn = el('button', 'hud-icon-btn', '🎯');
  fastBtn.title = isFr
    ? 'Finir ce fichier vite puis pause (Ctrl+Alt+F)'
    : 'Finish file fast then pause (Ctrl+Alt+F)';
  fastBtn.disabled = !state.currentFilePath || state.playbackState === 'completed';
  fastBtn.addEventListener('click', () => {
    if (state.currentFilePath) {
      post({ type: 'implementFileAndPause', filePath: state.currentFilePath });
    }
  });

  const bargeBtn = el('button', 'hud-icon-btn hud-barge-btn', '✋');
  bargeBtn.title = isFr
    ? 'Stop & Question sur la ligne (Ctrl+Shift+Space)'
    : 'Stop & Ask on active line (Ctrl+Shift+Space)';
  bargeBtn.disabled = state.playbackState === 'completed';
  bargeBtn.addEventListener('click', () => post({ type: 'bargeInTrigger' }));

  const muteBtn = el('button', 'hud-icon-btn', state.muted ? '🔇' : '🔊');
  muteBtn.title = isFr ? 'Voix On/Off' : 'Mute/Unmute';
  muteBtn.addEventListener('click', () => post({ type: 'toggleMute' }));

  const stopBtn = el('button', 'hud-icon-btn', '⏹');
  stopBtn.title = isFr ? 'Arrêter' : 'Stop';
  stopBtn.addEventListener('click', () => post({ type: 'stopSession' }));

  controls.append(playBtn, nextBtn, fastBtn, bargeBtn, muteBtn, stopBtn);
  card.appendChild(controls);

  // Speed pills
  const speedRow = el('div', 'hud-speed-row');
  const speeds: Array<{ value: SpeedMode; label: string }> = [
    { value: '0.5x', label: '0.5x' },
    { value: '1x', label: '1x' },
    { value: '2x', label: '2x' },
    { value: '3x', label: '3x' },
    { value: 'auto', label: '✨Auto' },
  ];
  for (const s of speeds) {
    const btn = el(
      'button',
      `hud-speed-pill ${state.speedMode === s.value ? 'active' : ''}`,
      s.label,
    );
    btn.addEventListener('click', () => post({ type: 'setSpeed', speed: s.value }));
    speedRow.appendChild(btn);
  }
  card.appendChild(speedRow);

  if (state.effectivePace) {
    card.appendChild(
      el(
        'div',
        'hud-pace-meta',
        `${state.effectivePace.label} · ${state.effectivePace.charsPerSecond} car/s`,
      ),
    );
  }

  if (state.fileStopTarget) {
    card.appendChild(
      el(
        'div',
        'hud-banner hud-banner-info',
        isFr
          ? `🎯 Fast + Pause sur ${state.fileStopTarget.filePath}`
          : `🎯 Fast + Pause on ${state.fileStopTarget.filePath}`,
      ),
    );
  }
  if (state.pauseBanner) {
    card.appendChild(el('div', 'hud-banner hud-banner-warn', state.pauseBanner));
  }

  // Karaoke subtitle box
  const captionBox = el('div', 'hud-caption-box');
  const captionText = el('div', 'hud-caption-text');
  captionText.id = 'cp-caption-text';
  renderCaptionContent(captionText, state);
  captionBox.appendChild(captionText);
  card.appendChild(captionBox);

  return card;
}

function buildBargeInHud(state: SessionUIState): HTMLElement | null {
  if (state.playbackState !== 'interrupted') {
    return null;
  }

  const isFr = state.language === 'fr';
  const card = el('div', 'hud-card hud-bargein');

  const top = el('div', 'hud-row-between');
  top.appendChild(
    el('span', 'hud-title', isFr ? '✋ Question directe' : '✋ Direct Question'),
  );
  if (state.activeSnapshot) {
    top.appendChild(
      el(
        'span',
        'hud-loc',
        `${state.activeSnapshot.filePath}:${state.activeSnapshot.lineNumber}`,
      ),
    );
  }
  card.appendChild(top);

  const row = el('div', 'hud-row');
  const input = el('input', 'hud-input') as HTMLInputElement;
  input.id = 'bargein-input';
  input.placeholder = isFr
    ? 'Pourquoi ce code ici ? (Entrée pour envoyer)'
    : 'Why this code here? (Enter to ask)';
  input.value = draftBargeIn;
  input.addEventListener('input', () => {
    draftBargeIn = input.value;
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && input.value.trim()) {
      const q = input.value.trim();
      draftBargeIn = '';
      input.value = '';
      post({ type: 'bargeInQuestion', question: q, source: 'text' });
    }
  });
  row.appendChild(input);

  if (speech.isVoiceInputSupported()) {
    const micBtn = el(
      'button',
      `hud-icon-btn ${speech.getListeningState() ? 'listening' : ''}`,
      speech.getListeningState() ? '🔴' : '🎙',
    );
    micBtn.addEventListener('click', () => {
      if (speech.getListeningState()) {
        speech.stopListening();
        micBtn.textContent = '🎙';
        micBtn.classList.remove('listening');
        return;
      }
      micBtn.textContent = '🔴';
      micBtn.classList.add('listening');
      void speech.startListening(state.language, {
        onInterim: (txt) => {
          draftBargeIn = txt;
          input.value = txt;
        },
        onFinal: (txt) => {
          draftBargeIn = '';
          input.value = '';
          micStatusNote = '';
          post({ type: 'bargeInQuestion', question: txt, source: 'voice' });
        },
        onAudioCaptured: (base64Audio, mimeType) => {
          post({ type: 'bargeInAudioQuestion', base64Audio, mimeType });
        },
        onError: (reason) => {
          micStatusNote = reason;
          const noteEl = document.getElementById('cp-mic-note');
          if (noteEl) noteEl.textContent = reason;
        },
        onEnd: () => {
          micBtn.textContent = '🎙';
          micBtn.classList.remove('listening');
        },
      });
    });
    row.appendChild(micBtn);
  }

  const sendBtn = el('button', 'hud-btn hud-btn-primary', isFr ? 'OK' : 'Ask');
  sendBtn.addEventListener('click', () => {
    const q = input.value.trim();
    if (q) {
      draftBargeIn = '';
      input.value = '';
      post({ type: 'bargeInQuestion', question: q, source: 'text' });
    }
  });
  row.appendChild(sendBtn);
  card.appendChild(row);

  if (micStatusNote) {
    const note = el('div', 'hud-pace-meta', micStatusNote);
    note.id = 'cp-mic-note';
    card.appendChild(note);
  }

  const resumeBtn = el(
    'button',
    'hud-btn hud-btn-ghost',
    isFr ? '▶ Reprendre sans question' : '▶ Resume without asking',
  );
  resumeBtn.addEventListener('click', () => post({ type: 'resumeAfterBargeIn' }));
  card.appendChild(resumeBtn);

  return card;
}

function buildCheckpointHud(state: SessionUIState): HTMLElement | null {
  if (state.playbackState !== 'checkpoint' || !state.activeCheckpoint) {
    return null;
  }

  const ck = state.activeCheckpoint;
  const isFr = state.language === 'fr';
  const card = el('div', 'hud-card hud-checkpoint');
  card.appendChild(el('span', 'hud-pill', `◆ ${ck.title}`));
  card.appendChild(el('div', 'hud-text', ck.question));

  for (const opt of ck.options) {
    const btn = el(
      'button',
      `hud-opt-btn ${opt.recommended ? 'recommended' : ''}`,
      opt.label,
    );
    if (opt.description) {
      btn.title = opt.description;
    }
    btn.addEventListener('click', () => {
      draftCheckpointCustom = '';
      post({ type: 'resolveCheckpoint', optionId: opt.id });
    });
    card.appendChild(btn);
  }

  const customRow = el('div', 'hud-row');
  const input = el('input', 'hud-input') as HTMLInputElement;
  input.id = 'checkpoint-custom';
  input.placeholder = isFr ? 'Autre directive…' : 'Custom note…';
  input.value = draftCheckpointCustom;
  input.addEventListener('input', () => {
    draftCheckpointCustom = input.value;
  });

  const recId = ck.options.find((o) => o.recommended)?.id ?? ck.options[0]?.id ?? '';
  const okBtn = el('button', 'hud-btn hud-btn-ghost', 'OK');
  okBtn.addEventListener('click', () => {
    const note = input.value.trim();
    draftCheckpointCustom = '';
    post({
      type: 'resolveCheckpoint',
      optionId: recId,
      customReply: note || undefined,
    });
  });
  customRow.append(input, okBtn);
  card.appendChild(customRow);

  return card;
}

function buildFilesHud(state: SessionUIState): HTMLElement | null {
  const fileSteps = state.timeline.filter((s) => s.kind === 'file');
  if (fileSteps.length === 0) {
    return null;
  }

  const isFr = state.language === 'fr';
  const card = el('div', 'hud-card hud-files');
  card.appendChild(
    el('div', 'hud-pace-meta', isFr ? 'Fichiers de la session' : 'Session files'),
  );

  for (const step of fileSteps) {
    const row = el('div', `hud-row-between hud-file-row status-${step.status}`);
    const icon = step.status === 'done' ? '✓' : step.status === 'active' ? '▶' : '○';
    row.appendChild(el('span', 'hud-file-name', `${icon} ${step.title}`));

    if (step.filePath && step.status !== 'done') {
      const btn = el('button', 'hud-btn-xs', '🎯 Fast+Pause');
      const target = step.filePath;
      btn.addEventListener('click', () =>
        post({ type: 'implementFileAndPause', filePath: target }),
      );
      row.appendChild(btn);
    }
    card.appendChild(row);
  }

  return card;
}

function buildFooterHud(state: SessionUIState): HTMLElement {
  const isFr = state.language === 'fr';
  const wrapper = el('div', 'hud-footer-wrap');
  const footer = el('div', 'hud-footer');

  const select = el('select', 'hud-select') as HTMLSelectElement;
  const def = el(
    'option',
    '',
    isFr ? 'Voix auto (Kokoro / OS)' : 'Auto Voice (Kokoro / OS)',
  ) as HTMLOptionElement;
  def.value = '';
  select.appendChild(def);

  for (const v of state.availableVoices) {
    const opt = el('option', '', v.name) as HTMLOptionElement;
    opt.value = v.id;
    if (state.selectedVoiceId === v.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    post({ type: 'selectVoice', voiceId: select.value });
  });

  const testBtn = el('button', 'hud-icon-btn', '🔊');
  testBtn.title = isFr ? 'Tester la voix' : 'Test voice';
  testBtn.addEventListener('click', () => post({ type: 'testVoice' }));

  const cfgBtn = el('button', 'hud-icon-btn', '⚙️');
  cfgBtn.title = isFr ? 'Réglages MindStream' : 'MindStream Settings';
  cfgBtn.addEventListener('click', () => post({ type: 'openSettings' }));

  footer.append(select, testBtn, cfgBtn);
  wrapper.append(
    footer,
    el('div', 'hud-pace-meta', `${state.ttsBackendLabel} · ${state.language.toUpperCase()}`),
  );
  return wrapper;
}

function renderFull(state: SessionUIState): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }

  const activeEl = document.activeElement as HTMLInputElement | null;
  const focusedId = activeEl?.id ?? '';
  const selStart = activeEl && 'selectionStart' in activeEl ? activeEl.selectionStart : null;
  const selEnd = activeEl && 'selectionEnd' in activeEl ? activeEl.selectionEnd : null;

  const frag = document.createDocumentFragment();
  if (state.playbackState === 'idle') {
    frag.appendChild(buildIdleHud(state));
  } else {
    frag.appendChild(buildPlayerHud(state));

    const barge = buildBargeInHud(state);
    if (barge) frag.appendChild(barge);

    const ck = buildCheckpointHud(state);
    if (ck) frag.appendChild(ck);

    const files = buildFilesHud(state);
    if (files) frag.appendChild(files);
  }

  frag.appendChild(buildFooterHud(state));
  app.replaceChildren(frag);

  if (focusedId) {
    const restored = document.getElementById(focusedId) as HTMLInputElement | null;
    if (restored) {
      restored.focus();
      if (selStart !== null && selEnd !== null && restored.setSelectionRange) {
        restored.setSelectionRange(selStart, selEnd);
      }
    }
  }
}

function handleStateUpdate(state: SessionUIState): void {
  currentState = state;
  const sig = getStructuralSignature(state);
  if (sig !== structuralSignature) {
    structuralSignature = sig;
    renderFull(state);
  } else {
    updateLiveSpotsOnly(state);
  }
}

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'stateUpdate':
      handleStateUpdate(msg.state);
      break;
    case 'ttsSpeak':
      speech.speak(msg.utteranceId, msg.text, msg.lang, msg.rate, msg.voiceId);
      break;
    case 'ttsPlayAudio':
      speech.playBase64Audio(msg.utteranceId, msg.base64Audio, msg.mimeType);
      break;
    case 'ttsStop':
      speech.stopAll();
      break;
    case 'focusBargeInInput': {
      const input = document.getElementById('bargein-input') as HTMLInputElement | null;
      input?.focus();
      break;
    }
    case 'triggerVoiceTest': {
      if (currentState) {
        renderFull(currentState);
      }
      break;
    }
  }
});

post({ type: 'webviewReady' });
