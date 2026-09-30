# Obsidian Mind in Kimi Code

Read the vault-root `CLAUDE.md` for note conventions, memory, linking, and workflows. `brain/Skills.md` is the command catalog. These files are the shared source of truth for every agent.

- Commands are Kimi skills: `/skill:om-standup`, `/skill:om-dump <text>`, `/skill:om-wrap-up`. When a shared prompt says `/om-...`, use its `/skill:om-...` equivalent. If setup has not run, read the matching `.claude/commands/om-....md` and perform the workflow using the user's arguments.
- Use the installed Obsidian and QMD skills. The original instructions and their references live under `.claude/skills/`. Named subagents are generated from `.claude/agents/`; supply their names as `subagent_type` to Kimi's `Agent` tool. Include the relevant vault conventions in the delegation prompt and request a complete handoff. Claude-specific model and turn-limit fields are not Kimi settings.
- The Kimi adapter injects startup context on the first user prompt, then routing hints on later prompts. Write-validation and end-of-turn checklist feedback arrives on a subsequent user prompt. Do not rely on that delay for correctness: verify frontmatter and wikilinks before finishing each write, and execute `om-wrap-up` when the user asks to finish a session.
- If hooks are not installed, read `brain/North Star.md`, the relevant brain topics and active notes before substantial work. The Markdown vault remains usable without hooks or QMD.
- Durable memories belong in the vault's `brain/` notes. Do not follow Claude's home-directory memory-loader instructions.
- External integrations such as Slack need their own configured tools. Report unavailable tools instead of inventing retrieved material. The cross-repository `om` server's `reason` tool still uses Claude; search and memory tools do not need that inference subprocess.

Installation and current limitations: see `.kimi-code/README.md`.
