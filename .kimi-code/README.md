# Kimi Code CLI

This integration targets the current **Kimi Code CLI**, launched with `kimi`, using the `.kimi-code/` configuration layout documented on **2026-09-30**. The archived Python `kimi-cli` and its `.kimi/` layout are not supported by this adapter. See the [official migration guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/migration.html).

## Quick start

Install the current [Kimi Code CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/), then run this command from the vault root:

```sh
node --experimental-strip-types .scripts/kimi-setup.ts
```

This prepares project commands, skills, subagents, and QMD MCP configuration, and generates `.kimi-code/hooks.toml` for review. It leaves your user configuration and API credentials unchanged.

To enable automatic context loading and write checks on macOS or Linux, run:

```sh
node --experimental-strip-types .scripts/kimi-setup.ts --install-hooks
kimi
```

`--install-hooks` backs up your existing configuration, then merges this vault's hooks into `~/.kimi-code/config.toml` (or the directory specified by `KIMI_CODE_HOME`). Existing settings are preserved, and repeated runs do not duplicate the hooks. The hooks only handle sessions within this vault.

Sign in with `/login` when you first start Kimi. Send an ordinary text message first to load startup context, and wait for its response:

```text
Load this vault's startup context and briefly summarize the active work. Do not change any notes.
```

Then try these skills, one at a time:

```text
/skill:om-standup
/skill:om-dump We decided to finish login first and work on payments next week.
/skill:om-wrap-up
```

Kimi Code CLI 2.1.1 does not run `UserPromptSubmit` for native slash-skill requests. Pending write/checklist feedback is delivered on the next ordinary text message, such as `Review any pending write feedback without changing notes.` If a skill is your first request, Kimi must read the context it needs because the startup injection has not run.

Open the same folder in Obsidian to view your notes. Fill in `brain/North Star.md` with your goals so Kimi can use them as context. Rerun setup after updating the template; generated files you have edited are preserved and reported as conflicts.

Before enabling QMD semantic search, add `.kimi-code/` to Obsidian's **Settings → Files and links → Excluded files**, then follow the QMD bootstrap instructions in the root README. This keeps generated instructions out of the note index. Setup leaves your Obsidian settings unchanged.

## Setup and updates

Use Node 22.6+ and run the commands above from the vault root. Kimi discovers the root `AGENTS.md` and `.kimi-code/AGENTS.md` as project instructions. The setup script copies the existing command, skill, and agent prompts into Kimi's discovery directories; `.claude/` remains the canonical source. Generated files are local and gitignored, and unrelated files are preserved. Rerun setup after updating or moving the vault; reinstall hooks after moving it because hook commands contain absolute paths.

The default run only prepares local files. Review `.kimi-code/hooks.toml`, then use `--install-hooks` to install them. Hook installation currently supports macOS and Linux. Windows users can use the shared Markdown instructions manually; automatic hook installation is not supported.

Kimi's [hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) are configured at user scope. A project `.kimi-code/config.toml` would not activate them. The adapter checks the event's working directory and ignores unrelated projects and nested Git repositories. It does not change Kimi's model, credentials, or permission rules. To remove the global integration, remove this vault's marked Obsidian Mind hook block from your Kimi user configuration.

## Capabilities and boundaries

| Capability | Behavior |
|---|---|
| Vault instructions and durable memory | Shared `CLAUDE.md`, `brain/` notes, templates and wikilinks |
| Commands | `/skill:om-...`; flat skill files mirror `.claude/commands/` |
| Obsidian/QMD skills | Skill directories and reference files copied from `.claude/skills/` |
| Subagents | Profiles copied from `.claude/agents/`; Kimi ignores Claude-specific `model`, `maxTurns`, and `skills` metadata |
| Startup context | Built synchronously on the first ordinary text prompt (`UserPromptSubmit`), including fallback if no `SessionStart` was delivered |
| Prompt classification | Shared classifier output appended to each applicable ordinary text prompt |
| Write checks | Successful `Write`/`Edit` events adapt `path` to `file_path`; feedback is queued for a subsequent ordinary text prompt |
| End-of-turn checklist | Queued for the next ordinary text prompt; never blocks completion or forces another model turn |
| QMD | Optional; uses the existing vault-scoped MCP wrapper and shared index refresh logic |
| Transcript backup before compaction | Not supported: the current hook payload does not provide `transcript_path` |
| External services | Slack and other service tools require separate configuration |

Observation-only Kimi events discard returned context. Returning the existing Claude JSON envelope would therefore silently lose startup and validation feedback. The adapter supplies plain text at `UserPromptSubmit`, the event that consumes it. Pending feedback is local to `.kimi-code/.mind-hook-state/`; closing a session clears its state. Check important edits before exiting, or run `/skill:om-wrap-up` to request an explicit review.

In Kimi Code CLI 2.1.1, native slash-skill activation bypasses `UserPromptSubmit`; slash-only turns therefore neither load startup context nor consume queued feedback. Start with ordinary text as shown above. When startup context is absent, read `brain/North Star.md`, relevant brain topics and active notes, plus any other sources the skill needs. See the [upstream prompt hook implementation](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts).

To enable QMD semantic search, first add `.kimi-code/` to Obsidian's **Settings → Files and links → Excluded files**, then follow the root README's QMD installation and bootstrap steps. The bootstrap reads this exclusion list so generated Kimi prompts stay out of the note index. Rerun the bootstrap if QMD was already configured. Setup leaves your Obsidian settings unchanged. Without QMD, use filesystem search. An existing project MCP entry named `qmd` is preserved by setup; inspect `/mcp` in Kimi if it points elsewhere. Start a new session after changing skills, profiles, or MCP configuration.

For access from another repository, register `.claude/scripts/om-mcp.mjs` under `mcpServers.om` in that project's `.kimi-code/mcp.json` using an absolute path, and add vault-use instructions to its `AGENTS.md`. Use `om`, not raw `qmd`, for cross-repository memory scoping. The existing `om.reason` implementation still launches Claude; this integration does not replace that separate inference backend with Kimi.

## Verification

Run the repository's hook suite and typecheck as described in `CONTRIBUTING.md`. The adapter and setup tests exercise fixture events and temporary vaults without a model account. A logged-in Kimi session is still needed for end-to-end confirmation: send an ordinary text message first, run `/skill:om-standup`, capture a sample note with `/skill:om-dump`, then send another ordinary text message to receive pending feedback in the same session. Invoke `/skill:om-wrap-up` and check the saved note in Obsidian. In `--prompt` mode, text such as `/skill:om-standup` is passed to the model as ordinary text; use the interactive CLI to verify native slash-skill activation.

Official references: [skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html), [agent profiles and instructions](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html), [MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html), [configuration scope](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html).
