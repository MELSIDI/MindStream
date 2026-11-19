# CodePace Activation Rule

Whenever the user prompt contains `/CodePace` (case-insensitive, anywhere in the message — e.g. `"implémente le projet nana /CodePace"`):

1. **Activate the `codepace` skill immediately** and follow its synchronized pair-programming workflow.
2. **Never dump full files silently** with raw file-write tools (`write_to_file`, `write_file`, `edit_file`, etc.). Write and edit ALL code progressively one logical unit at a time (skeleton/class shell first via `inside-container`, then variables & one function/method per block with clear *why* explanations) through the `codepace-driver` MCP tools (`codepace_start_session`, `codepace_write_block`, `codepace_checkpoint`, `codepace_speak`, `codepace_control`, `codepace_finish_session`), always passing `workspaceRoot`.
3. **Inline pace & playback directives** (also when `/CodePace` is paired with control instructions like `/speed 2x`, `/speed auto`, `/pause`, `/resume`, `/skip`, `/stop`, or `"code ce fichier vite puis pause"`): call `codepace_control` immediately before continuing.
4. Keep chat messages crisp so the developer stays focused on the editor and live voice narration.
