#!/usr/bin/env bun
/**
 * LocalLoopPrompting.hook.ts — LLP (LocalLoopPrompting) UserPromptSubmit hook
 *
 * Intercepts user prompts before Claude, calls local Ollama for vagueness scoring,
 * and applies one of three response modes:
 *
 *   PASS    (score 0-4)  — compress filler, add output constraint, rewrite via updatedUserPrompt.
 *                          Logs rewrite to stderr so user sees what changed.
 *   CLARIFY (score 5-8)  — inject additionalContext asking Claude to seek clarification first.
 *                          Logs vague spots to stderr.
 *   BLOCK   (score 9+)   — return decision:block with reason. Shown to user by Claude Code.
 *
 * BYPASS: Prompt starting with "!!" skips hook entirely (pre-composed / urgent prompts).
 * TOGGLE: Flag file at $PAI_DIR/MEMORY/STATE/llp-enabled controls on/off.
 *         Create the file to enable, delete to disable. Use LLPToggle.ts.
 *
 * TRIGGER: UserPromptSubmit
 * PERFORMANCE: 1-3s Ollama call. Hard 3s timeout — falls through on slow response.
 * MODEL: $LLP_OLLAMA_MODEL (default: gemma3:4b)
 */

import { existsSync } from 'fs';
import { paiPath } from './lib/paths';

const TOGGLE_FLAG = paiPath('MEMORY', 'STATE', 'llp-enabled');
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = process.env.LLP_OLLAMA_MODEL || 'gemma4:e4b';
const TIMEOUT_MS = 8000;

// ── System prompt (FirstPrinciples-derived, ~230 tokens) ──────────────────────

// format:"json" is set in the request body — Ollama enforces JSON output at the API level.
// System prompt only needs to describe the schema; JSON enforcement is not needed here.
const SYSTEM_PROMPT = `You assess user prompts for clarity. Score 0-12 by counting issues:
- Ambiguous referents: "it", "that", "this" with unclear antecedent (+0-3)
- Vague qualifiers: "some", "a bit", "kind of", "maybe" (+0-3)
- Underspecified scope: missing which files/systems/range affected (+0-3)
- Missing constraints: no format, length, or success criterion (+0-3)

Thresholds: 0-4=PASS, 5-8=CLARIFY, 9+=BLOCK (block only if completely unanswerable)

Output schema:
PASS: {"mode":"PASS","rewritten_prompt":"<stripped filler, compressed, add output constraint>"}
CLARIFY: {"mode":"CLARIFY","clarify_points":["<specific unclear thing 1>","<specific unclear thing 2>"]}
BLOCK: {"mode":"BLOCK","block_reason":"<why this cannot be answered at all>"}

PASS rewrite rules: remove "please/can you/could you/I need you to", compress without losing specifics, append "Be concise." or appropriate scope hint.
Bias strongly toward CLARIFY over BLOCK. BLOCK only when zero useful signal exists.`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

interface LLPResult {
  mode: 'PASS' | 'CLARIFY' | 'BLOCK';
  rewritten_prompt?: string;
  clarify_points?: string[];
  block_reason?: string;
}

// ── Stdin reader (process.stdin events — reliable with large piped inputs) ────
// NOTE: hook-io.ts uses Bun.stdin.stream() which silently fails on large inputs.
// All UserPromptSubmit hooks use process.stdin instead (per SessionAutoName docs).

async function readStdin(timeoutMs = 5000): Promise<HookInput | null> {
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => resolve(data), timeoutMs);
      process.stdin.on('data', chunk => { data += chunk.toString(); });
      process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
      process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
    });
    if (!raw.trim()) return null;
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

// ── Ollama call with hard timeout ─────────────────────────────────────────────

async function callOllama(prompt: string): Promise<LLPResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[LLP] Ollama error: ${res.status}`);
      return null;
    }

    const body = await res.json() as { message?: { content?: string } };
    const text = body?.message?.content?.trim() ?? '';
    return JSON.parse(text) as LLPResult;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[LLP] Ollama timeout after ${TIMEOUT_MS}ms — falling through`);
    } else {
      console.error(`[LLP] Ollama call failed: ${err}`);
    }
    return null;
  }
}

// ── Shared stderr box renderer ────────────────────────────────────────────────

function stderrBox(label: string, lines: string[]): void {
  const width = 53;
  const border = '═'.repeat(width);
  console.error('');
  console.error(`╔══ ${label} ${'═'.repeat(Math.max(0, width - label.length - 4))}╗`);
  lines.forEach(l => console.error(`║ ${l}`));
  console.error(`╚${border}╝`);
  console.error('');
}

// ── Mode handlers ─────────────────────────────────────────────────────────────

function handlePass(result: LLPResult, original: string): void {
  const rewritten = result.rewritten_prompt?.trim() ?? '';
  if (!rewritten || rewritten.trim() === original.trim()) {
    console.error('[LLP] PASS — no meaningful rewrite, passing through');
    return;
  }

  stderrBox('LLP REWRITE', [
    `Original: ${original.slice(0, 60)}${original.length > 60 ? '…' : ''}`,
    `Rewrite:  ${rewritten.slice(0, 60)}${rewritten.length > 60 ? '…' : ''}`,
  ]);

  console.log(JSON.stringify({ updatedUserPrompt: rewritten }));
}

function handleClarify(result: LLPResult): void {
  const points = result.clarify_points ?? [];
  if (points.length === 0) {
    console.error('[LLP] CLARIFY — no clarify_points returned, falling through');
    return;
  }

  stderrBox('LLP CLARIFY', [
    'Vague spots detected — Claude will ask first:',
    ...points.map(p => `  • ${p}`),
  ]);

  const context = `[LLP: Before executing, ask the user to clarify these specific points, then proceed:\n${points.map(p => `• ${p}`).join('\n')}]`;
  console.log(JSON.stringify({ additionalContext: context }));
}

function handleBlock(result: LLPResult): void {
  const reason = result.block_reason?.trim() || 'Prompt too vague to be useful.';
  console.error(`[LLP] BLOCK — ${reason}`);
  console.log(JSON.stringify({
    decision: 'block',
    reason: `LLP: ${reason}\n\nRewrite your prompt with a specific goal, scope, and expected output format.`,
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    if (!existsSync(TOGGLE_FLAG)) {
      console.error('[LLP] Disabled. Enable: bun ~/.claude/hooks/LLPToggle.ts enable');
      process.exit(0);
    }

    const hookInput = await readStdin();
    if (!hookInput) {
      process.exit(0);
    }

    const prompt = (hookInput.prompt ?? hookInput.user_prompt ?? '').trim();
    if (!prompt || prompt.length < 12) {
      process.exit(0);
    }

    if (prompt.startsWith('!!')) {
      console.error('[LLP] Bypass (!!) — skipping');
      process.exit(0);
    }

    console.error(`[LLP] Scoring prompt (${prompt.length} chars) via ${MODEL}…`);
    const result = await callOllama(prompt);

    if (!result?.mode || !['PASS', 'CLARIFY', 'BLOCK'].includes(result.mode)) {
      console.error(`[LLP] Invalid/missing mode "${result?.mode ?? ''}" — falling through`);
      process.exit(0);
    }

    console.error(`[LLP] Mode: ${result.mode}`);

    switch (result.mode) {
      case 'PASS':    handlePass(result, prompt); break;
      case 'CLARIFY': handleClarify(result); break;
      case 'BLOCK':   handleBlock(result); break;
    }

    process.exit(0);
  } catch (err) {
    console.error(`[LLP] Fatal error: ${err}`);
    process.exit(0);
  }
}

main();
