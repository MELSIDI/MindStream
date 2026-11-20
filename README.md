# MindStream — Pair-Programming Synchronisé & Vocal directement via `/MindStream`

**MindStream** transforme directement votre agent IA existant (**Antigravity** ou **VS Code Chat**) en binôme de Pair-Programming humain qui code à votre rythme en expliquant *pourquoi* à voix haute — **sans ouvrir de deuxième fenêtre de chat** et **sans configurer de clé API**.

---

## Utilisation Instantanée : `/MindStream` dans votre Chat

Dans **n'importe quel projet**, ajoutez simplement **`/MindStream`** à la fin (ou au début) de votre demande dans le chat existant :

> `Implémente-moi un module d'authentification avec gestion de session /MindStream`

Le modèle actif :
1. **Recherche et présente son plan** brièvement avant de toucher aux fichiers.
2. **Pilote directement votre éditeur bloc par bloc** via le serveur MCP `mindstream-driver` :
   - écriture caractère par caractère / bloc par bloc à vitesse humaine (squelette de classe ou HTML d'abord via `inside-container`, puis une fonction/méthode par bloc),
   - surlignement de la ligne et du bloc actifs avec icônes de gouttière SVG,
   - narration vocale simultanée expliquant le **pourquoi** de chaque classe, fonction et variable (Web Speech / synthèse OS native instantanée).
3. **S'adapte en direct à vos contrôles minimalistes** (barre de statut en bas ou raccourcis clavier) :
   - **`Ctrl+Alt+P`** : Pause / Reprendre exactement à la même lettre et phrase.
   - **`Ctrl+Alt+S`** : Variateur de vitesse (`0.5x`, `1x`, `2x`, `3x`, `✨ Auto` rapide sur le boilerplate et attentif sur la logique métier).
   - **`Ctrl+Alt+N`** : Passer au bloc suivant (`Skip`).
   - **`Ctrl+Alt+F`** : Coder le fichier actif rapidement puis mettre automatiquement en pause pour inspection (`File + Pause`).
   - **`Ctrl+Shift+Space`** : **Barge-in** — coupe instantanément frappe et voix, capture la ligne exacte, vous demande votre question dans une simple barre en haut et la renvoie directement à l'IA dans votre chat pour qu'elle y réponde en contexte avant de reprendre !
   - **`MindStream` (barre de statut)** : contrôles compacts (`⏸`, `1x/Auto`, `⏭`, `🎯`, `✋`, `🔊/🔇`, `⏹`, `fichier:ligne`) + Mini-HUD latéral optionnel.

Vous pouvez aussi piloter MindStream directement en texte dans le chat :
- `/MindStream vitesse 2x` ou `/speed auto`
- `/MindStream code ce fichier rapidement puis pause`
- `@mindstream` (dans VS Code Chat : `/speed`, `/pause`, `/resume`, `/skip`, `/file`, `/stop`, `/demo`).

---

## Installation & Démarrage

### 1. Compiler et installer le plugin global `/MindStream` (Antigravity)
```bash
npm install
npm run build
npm run install:plugin
```
Cela installe le plugin global dans `~/.gemini/config/plugins/mindstream/` (`plugin.json`, `rules/AGENTS.md`, `skills/mindstream/SKILL.md`, `mcp_config.json`, `mcp/mcp-server.js`).

> Vous pouvez aussi l'installer directement depuis la palette de commandes de l'extension : `MindStream: Installer le plugin /MindStream (Antigravity & MCP)`.

### 2. Installer la voix neurale locale Kokoro-82M (`hexgrad/Kokoro-82M`) + détection auto FR/EN
MindStream utilise **Kokoro-82M** localement (sans clé API ni latence réseau) et détecte intelligemment si vos prompts, questions barge-in et phrases sont en **français** (`ff_siwis`, `lang_code='f'`) ou en **anglais** (`af_heart`, `lang_code='a'`) :
```bash
npm run setup:kokoro
```
Cela crée l'environnement isolé `~/.mindstream/kokoro-venv`, installe `kokoro`, `misaki[en]` et `espeakng-loader`, puis pré-télécharge `hexgrad/Kokoro-82M`. *(Vous pouvez aussi le lancer depuis la palette de commandes : `MindStream: Installer / Configurer Kokoro-82M TTS Local`. Sans Kokoro installé, MindStream bascule automatiquement sur Web Speech ou la synthèse OS native.)*

### 3. Lancer ou installer l'extension IDE
- En développement : ouvrez le dossier du projet dans VS Code / Antigravity et appuyez sur **`F5`** (`Lancer MindStream`).
- Ou installez `mindstream-0.2.1.vsix` (`Extensions → ... → Install from VSIX...`) pour qu'elle soit active sur **tous vos projets**.
- Un **Mode Démo FocusFlow** reste également accessible sans projet ni IA via `MindStream: Lancer la Démo Interactive`.

---

## Architecture Hybride (3 Briques)

```text
Chat Existant (Antigravity / VS Code)
   │  détecte `/MindStream` via `rules/AGENTS.md` + `skills/mindstream/SKILL.md`
   ▼
Serveur MCP `mindstream-driver` (`dist/mcp-server.js`, zéro dépendance externe)
   │  découvre l'IDE actif via `~/.mindstream/bridges.json` (localhost HTTP + Bearer token)
   │  (repli autonome disque + TTS natif si aucun IDE n'est connecté)
   ▼
Extension IDE MindStream (`dist/extension.js`)
   ├── BridgeServer + LiveAgentSessionDriver (pause, skip, speed, file+pause, barge-in, checkpoints)
   ├── EditorChoreographer + ContainerLocator + EditorDecorator (curseurs, gouttières, squelette-d'abord)
   ├── VoiceCoordinator + LanguageDetector (FR/EN auto) + KokoroTTSService (hexgrad/Kokoro-82M) + NativeTTSFallback
   └── StatusBarController minimaliste + Mini-HUD optionnel (`dist/webview.js`)
```

---

## Licence

Ce projet est open source, distribué sous licence **Apache-2.0** — voir les fichiers [LICENSE](LICENSE) et [NOTICE](NOTICE) pour plus de détails.

La synthèse vocale locale s'appuie sur **Kokoro-82M** ([hexgrad/kokoro](https://github.com/hexgrad/kokoro) / [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)), également distribué sous licence **Apache-2.0** (installé localement à la demande dans `~/.mindstream/kokoro-venv` avec ses dépendances Python tierces).
