# LLP — LocalLoopPrompting

A PAI UserPromptSubmit hook that intercepts every prompt before it reaches Claude, runs it through a local Ollama model for vagueness scoring, and either rewrites it, flags it for clarification, or blocks it. Cheap local inference protects expensive Claude tokens and creates a feedback loop between you and your prompts.

## What it does

Every prompt gets scored 0–12 across four dimensions:
- **Ambiguous referents** — unresolved "it", "that", "this"
- **Vague qualifiers** — "some", "a bit", "kind of", "maybe"
- **Underspecified scope** — missing which files, systems, or range
- **Missing constraints** — no format, length, or success criterion

Score determines the mode:

| Score | Mode | Behavior |
|-------|------|----------|
| 0–4 | **PASS** | Strips filler, compresses, adds output constraint. Shows you the rewrite in terminal, sends it to Claude. |
| 5–8 | **CLARIFY** | Injects context asking Claude to seek clarification on specific vague points before executing. |
| 9+ | **BLOCK** | Rejects the prompt entirely with a specific reason. You never pay for Claude to try to answer something unanswerable. |

Bias is strongly toward CLARIFY. BLOCK is rare.

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- [Bun](https://bun.sh) runtime
- [Ollama](https://ollama.ai) running locally at `localhost:11434`
- A Gemma or compatible model pulled in Ollama

## Installation

1. Copy the hook files into your PAI hooks directory:

```bash
cp LocalLoopPrompting.hook.ts ~/.claude/hooks/
cp LLPToggle.ts ~/.claude/hooks/
chmod +x ~/.claude/hooks/LocalLoopPrompting.hook.ts ~/.claude/hooks/LLPToggle.ts
```

2. Register in `~/.claude/settings.json` under `hooks.UserPromptSubmit` — add it **first** so it runs before other hooks:

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "${PAI_DIR}/hooks/LocalLoopPrompting.hook.ts"
      }
    ]
  }
]
```

3. Enable it:

```bash
bun ~/.claude/hooks/LLPToggle.ts enable
```

## Usage

```bash
# Toggle on/off
bun ~/.claude/hooks/LLPToggle.ts

# Explicit control
bun ~/.claude/hooks/LLPToggle.ts enable
bun ~/.claude/hooks/LLPToggle.ts disable
bun ~/.claude/hooks/LLPToggle.ts status
```

**Bypass:** Start any prompt with `!!` to skip LLP entirely — useful for pre-composed, urgent, or already-precise prompts.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LLP_OLLAMA_MODEL` | `gemma4:e4b` | Ollama model to use for scoring |
| `PAI_DIR` | `~/.claude` | PAI root directory |

Set in `~/.claude/settings.json` under `env`:

```json
"env": {
  "LLP_OLLAMA_MODEL": "gemma3:4b"
}
```

## How it looks

**PASS** — terminal shows the rewrite before it goes to Claude:
```
╔══ LLP REWRITE ══════════════════════════════════════╗
║ Original: please can you fix the null pointer in Au…
║ Rewrite:  Fix null pointer in AuthService.java line…
╚═════════════════════════════════════════════════════╝
```

**CLARIFY** — Claude will ask these before doing anything:
```
╔══ LLP CLARIFY ══════════════════════════════════════╗
║ Vague spots detected — Claude will ask first:
║   • What specific 'stuff' needs fixing?
║   • Which project/repository?
╚═════════════════════════════════════════════════════╝
```

**BLOCK** — prompt rejected, shown in Claude Code UI with reason.

## Architecture

- `LocalLoopPrompting.hook.ts` — the hook. Reads stdin JSON (Claude Code UserPromptSubmit format), calls Ollama `/api/chat` with `format:"json"` to enforce structured output, routes to PASS/CLARIFY/BLOCK handler.
- `LLPToggle.ts` — CLI toggle. Creates/removes a flag file at `$PAI_DIR/MEMORY/STATE/llp-enabled`. Hook checks this file on every run.

The hook always exits `0` — it never blocks your session on error. Ollama call has an 8-second hard timeout with fallthrough.

## Part of PAI

This mod is built for [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/fabric) — a Claude Code harness for personal AI. The hook conventions (stdin format, `process.stdin` reader, `paiPath()` utility) follow PAI patterns.
