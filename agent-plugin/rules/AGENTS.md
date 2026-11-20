# MindStream Activation Rule

Whenever the user prompt contains `/MindStream` (case-insensitive, anywhere in the message — e.g. `"implémente le projet nana /MindStream"`):

1. **Activate the `mindstream` skill immediately** and follow its synchronized pair-programming workflow.
2. **Intelligent FR / EN language detection**: detect automatically whether the user's prompt (or barge-in question) is in French or English (ignoring code identifiers), pass the matching `language` (`"fr"` or `"en"`, or `"auto"`) to `mindstream_start_session` / `mindstream_speak`, and write all narrations/explanations in that language so local **Kokoro-82M** TTS picks the right voice automatically.
3. **Never dump full files silently** with raw file-write tools (`write_to_file`, `write_file`, `edit_file`, etc.). Write and edit ALL code progressively one logical unit at a time (skeleton/class shell first via `inside-container`, then variables & one function/method per block with clear *why* explanations) through the `mindstream-driver` MCP tools (`mindstream_start_session`, `mindstream_write_block`, `mindstream_checkpoint`, `mindstream_speak`, `mindstream_control`, `mindstream_finish_session`), always passing `workspaceRoot`.
4. **Inline pace & playback directives** (also when `/MindStream` is paired with control instructions like `/speed 2x`, `/speed auto`, `/pause`, `/resume`, `/skip`, `/stop`, or `"code ce fichier vite puis pause"`): call `mindstream_control` immediately before continuing.
5. Keep chat messages crisp so the developer stays focused on the editor and live voice narration.
