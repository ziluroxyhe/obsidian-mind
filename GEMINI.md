# Obsidian Mind

This vault is built for [Claude Code](https://claude.ai/code) with a full operating manual in `CLAUDE.md`.

**Read `CLAUDE.md` for all vault conventions** — structure, note types, linking rules, frontmatter schemas, indexes, and workflows. Most of the content is agent-agnostic.

## Hooks

The hook scripts in `.claude/scripts/` are agent-agnostic TypeScript and shell, executed natively by Node via `--experimental-strip-types` — no build step, no runtime dependencies, no Claude SDK. Hook integrations are provided for the following agents:

| Agent | Config | Status |
|-------|--------|--------|
| Claude Code | `.claude/settings.json` | Full support |
| Codex CLI | `.codex/hooks.json` | Shared hook scripts |
| Gemini CLI | `.gemini/settings.json` | Shared hook scripts |
| Kimi Code CLI | `.scripts/kimi-setup.ts` → user `config.toml` | Adapter; feedback on ordinary text prompts (see `.kimi-code/README.md`) |

| Script | Purpose | Claude event | Codex event | Gemini event |
|--------|---------|--------------|-------------|--------------|
| `session-start.ts` | Inject vault context at startup | SessionStart | SessionStart | SessionStart |
| `classify-message.ts` | Classify messages, inject routing hints | UserPromptSubmit | UserPromptSubmit | BeforeAgent |
| `validate-write.ts` | Validate frontmatter and wikilinks | PostToolUse | PostToolUse | AfterTool |
| `pre-compact.ts` | Back up transcript before compaction | PreCompact | — | PreCompress |

## Commands

Commands live in `.claude/commands/` — agent-agnostic markdown with YAML frontmatter. `brain/Skills.md` is the catalog.

- **Claude Code / Gemini CLI**: invoke as `/om-standup`, `/om-dump`, etc.
- **Kimi Code CLI**: after setup, invoke `/skill:om-standup`, `/skill:om-dump`, etc. The setup script mirrors the shared commands into `.kimi-code/skills/`.
- **Codex CLI**: type the command name as a regular prompt without the `/` prefix (e.g. `om-standup`). Codex will find and execute the command file.

## Memory

The vault's memory lives in `brain/` — `Memories.md`, `Patterns.md`, `Key Decisions.md`, `Gotchas.md`. These are plain markdown files that any agent can read and write. When you learn something worth remembering, write it to the relevant `brain/` topic note with a wikilink to context.

The `~/.claude/` auto-loaded memory index is Claude Code-specific — skip that section in `CLAUDE.md`. The vault-side `brain/` notes are the source of truth.

## Reaching this vault from another repo

The `om` MCP server (`.claude/scripts/om-mcp.mjs`) exposes this vault over MCP, so a session running in a **different repository** can search it, read notes, follow the graph, and record durable lessons back into it. It speaks plain MCP over stdio, so any MCP-capable agent can register it. These memory operations are portable; the separate `om.reason` tool still launches Claude.

Register it in the *consuming* project's MCP config, pointing at this vault's absolute path, then add a short section to that project's own agent doc telling it the vault exists. **Both steps are required**: measured, a session with the server wired but no repo-side instruction made zero vault calls, because a prohibition propagates into a session reliably while a positive "go look" does not.

Do not register the raw `qmd` server in a consuming repo — it searches every note directly, so the repo matches against memories written for unrelated projects. Applying each memory's declared scope on top of the index is what `om` adds. Full details in `CLAUDE.md`.

## Subagents

10 subagents in `.claude/agents/` handle isolated tasks (brag spotting, vault auditing, cross-linking, etc.). The prompt content is agent-agnostic markdown.

- **Codex CLI**: as of the [Skills launch (Dec 2025)](https://developers.openai.com/codex/changelog), Codex discovers skills at `.agents/skills/<name>/SKILL.md` (directory-per-skill; frontmatter requires `name` and `description`). Mirror each `.claude/agents/*.md` into a `SKILL.md`, keeping the prompt body intact. See the [Codex Skills docs](https://developers.openai.com/codex/skills) for the full schema.
- **Kimi Code CLI**: the setup script mirrors `.claude/agents/` into `.kimi-code/agents/`. Claude-specific model and turn-limit metadata is ignored; Kimi uses its own model configuration.
- **Gemini CLI**: agents live in `.gemini/agents/`. Copy the files and adapt the YAML frontmatter fields to Gemini's schema.

## What's Claude Code-specific

The `~/.claude/` auto-memory loader is Claude Code-specific. Shared prompts and memory are portable, but hook event/output contracts need per-agent adaptation. Kimi write/checklist feedback is delivered on a subsequent ordinary text prompt, and transcript backup is unavailable. The separate `om.reason` MCP tool still launches Claude.

## Setup

**Codex CLI**: Reads `AGENTS.md` natively. For direct access to `CLAUDE.md`, add to `~/.codex/config.toml`:
```toml
project_doc_fallback_filenames = ["CLAUDE.md"]
```

**Gemini CLI**: Reads `GEMINI.md` natively. For direct access to `CLAUDE.md`, add to `~/.gemini/settings.json`:
```json
{ "context": { "fileName": ["GEMINI.md", "CLAUDE.md"] } }
```

**Kimi Code CLI**: reads `AGENTS.md` and `.kimi-code/AGENTS.md`. Run `node --experimental-strip-types .scripts/kimi-setup.ts` in this vault to prepare skills, agents, MCP, and a hooks preview. On macOS/Linux, add `--install-hooks` to back up and merge this vault's hooks into your Kimi user configuration. See [.kimi-code/README.md](.kimi-code/README.md) for setup and limitations.

**Other agents** (Cursor, Windsurf, Copilot): Read `AGENTS.md` for vault conventions. Hook support varies by agent.

For more information, see the [README](README.md).
