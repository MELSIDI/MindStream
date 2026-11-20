# Third-Party Notices & Licenses

**MindStream** itself is open source under the **MIT License** (see [LICENSE](LICENSE)).

When you choose to install and run the optional local neural voice backend, MindStream downloads and invokes third-party open-source models and libraries in an isolated user environment (`~/.mindstream/kokoro-venv` via `scripts/setup-kokoro.mjs`). Their weights and source code are **not** bundled in this repository and remain governed by their respective licenses:

## Kokoro / Kokoro-82M
- **Repositories:**
  - https://github.com/hexgrad/kokoro
  - https://huggingface.co/hexgrad/Kokoro-82M
- **License:** Apache License, Version 2.0 (`Apache-2.0`)
- **Usage in MindStream:** Executed out-of-process as a local TTS worker (`src/voice/kokoro_worker.py`) when installed by the user.

## Optional Local Python & G2P Dependencies
Installed on demand into `~/.mindstream/kokoro-venv` by `scripts/setup-kokoro.mjs`, each under its own open-source license:
- `misaki` (Apache-2.0)
- `espeakng-loader` / `eSpeak NG` (GPL-3.0+ for eSpeak NG native library; invoked as a local G2P backend only when Kokoro is installed)
- `phonemizer-fork` (GPL-3.0)
- `torch`, `numpy`, `soundfile`, `spacy` (respective BSD / MIT licenses)
