# CodePace — Pair-Programming Synchronisé & Vocal directement via `/CodePace`

**CodePace** transforme directement votre agent IA existant (**Antigravity** ou **VS Code Chat**) en binôme de Pair-Programming humain qui code à votre rythme en expliquant *pourquoi* à voix haute — **sans ouvrir de deuxième fenêtre de chat** et **sans configurer de clé API**.

---

## Utilisation Instantanée : `/CodePace` dans votre Chat

Dans **n'importe quel projet**, ajoutez simplement **`/CodePace`** à la fin (ou au début) de votre demande dans le chat existant :

> `Implémente-moi un module d'authentification avec gestion de session /CodePace`

Le modèle actif :
1. **Recherche et présente son plan** brièvement avant de toucher aux fichiers.
2. **Pilote directement votre éditeur bloc par bloc** via le serveur MCP `codepace-driver` :
   - écriture caractère par caractère / bloc par bloc à vitesse humaine,
   - surlignement de la ligne et du bloc actifs avec icônes de gouttière SVG,
   - narration vocale simultanée expliquant les choix d'architecture (Web Speech / synthèse OS native instantanée).
3. **S'adapte en direct à vos contrôles minimalistes** (barre de statut en bas ou raccourcis clavier) :
   - **`Ctrl+Alt+P`** : Pause / Reprendre exactement à la même lettre et phrase.
   - **`Ctrl+Alt+S`** : Variateur de vitesse (`0.5x`, `1x`, `2x`, `3x`, `✨ Auto` rapide sur le boilerplate et attentif sur la logique métier).
   - **`Ctrl+Alt+N`** : Passer au bloc suivant (`Skip`).
   - **`Ctrl+Alt+F`** : Coder le fichier actif rapidement puis mettre automatiquement en pause pour inspection (`File + Pause`).
   - **`Ctrl+Shift+Space`** : **Barge-in** — coupe instantanément frappe et voix, ouvre une ligne de question rapide ancrée sur `fichier:ligne`, et renvoie votre question directement au modèle dans le chat pour qu'il y réponde en contexte avant de reprendre !
   - **`CodePace` (barre de statut)** : contrôles compacts (`⏸`, `1x/Auto`, `⏭`, `🎯`, `✋`, `🔊/🔇`, `⏹`, `fichier:ligne`) + Mini-HUD latéral optionnel.

Vous pouvez aussi piloter CodePace directement en texte dans le chat :
- `/CodePace vitesse 2x` ou `/speed auto`
- `/CodePace code ce fichier rapidement puis pause`
- `@codepace` (dans VS Code Chat : `/speed`, `/pause`, `/resume`, `/skip`, `/file`, `/stop`, `/demo`).

---

## Installation & Démarrage

### 1. Compiler et installer le plugin global `/CodePace` (Antigravity)
```bash
npm install
npm run build
npm run install:plugin
```
Cela installe le plugin global dans `~/.gemini/config/plugins/codepace/` (`plugin.json`, `rules/AGENTS.md`, `skills/codepace/SKILL.md`, `mcp_config.json`, `mcp/mcp-server.js`).

> Vous pouvez aussi l'installer directement depuis la palette de commandes de l'extension : `CodePace: Installer le plugin /CodePace (Antigravity & MCP)`.

### 2. Lancer ou installer l'extension IDE
- En développement : ouvrez ce dossier dans VS Code / Antigravity et appuyez sur **`F5`** (`Lancer CodePace`).
- Ou copiez / packagez l'extension dans votre dossier `~/.antigravity-ide/extensions` ou `~/.vscode/extensions` pour qu'elle soit active sur **tous vos projets**.
- Un **Mode Démo FocusFlow** reste également accessible sans projet ni IA via `CodePace: Lancer la Démo Interactive`.

---

## Architecture Hybride (3 Briques)

```text
Chat Existant (Antigravity / VS Code)
   │  détecte `/CodePace` via `rules/AGENTS.md` + `skills/codepace/SKILL.md`
   ▼
Serveur MCP `codepace-driver` (`dist/mcp-server.js`, zéro dépendance externe)
   │  découvre l'IDE actif via `~/.codepace/bridges.json` (localhost HTTP + Bearer token)
   │  (repli autonome disque + TTS natif si aucun IDE n'est connecté)
   ▼
Extension IDE CodePace (`dist/extension.js`)
   ├── BridgeServer + LiveAgentSessionDriver (pause, skip, speed, file+pause, barge-in, checkpoints)
   ├── EditorChoreographer + EditorDecorator (curseurs, gouttières, surlignement temps réel)
   ├── VoiceCoordinator + NativeTTSFallback (worker C#/SAPI chaud sur Windows, say, spd-say, Web Speech)
   └── StatusBarController minimaliste + Mini-HUD optionnel (`dist/webview.js`)
```
