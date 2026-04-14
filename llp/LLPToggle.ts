#!/usr/bin/env bun
/**
 * LLPToggle.ts — Toggle LocalLoopPrompting on/off
 *
 * Usage:
 *   bun ~/.claude/hooks/LLPToggle.ts enable   — create flag file (LLP active)
 *   bun ~/.claude/hooks/LLPToggle.ts disable  — remove flag file (LLP inactive)
 *   bun ~/.claude/hooks/LLPToggle.ts status   — show current state
 *   bun ~/.claude/hooks/LLPToggle.ts          — toggle (enable if off, disable if on)
 *
 * Flag file: $PAI_DIR/MEMORY/STATE/llp-enabled
 */

import { existsSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { paiPath } from './lib/paths';

const TOGGLE_FLAG = paiPath('MEMORY', 'STATE', 'llp-enabled');
const MODEL = process.env.LLP_OLLAMA_MODEL || 'gemma4:e4b';

function isEnabled(): boolean {
  return existsSync(TOGGLE_FLAG);
}

function enable(): void {
  mkdirSync(paiPath('MEMORY', 'STATE'), { recursive: true });
  writeFileSync(TOGGLE_FLAG, `enabled at ${new Date().toISOString()}\nmodel: ${MODEL}\n`, 'utf-8');
  console.log('✅ LLP enabled — prompts will be scored by Ollama before Claude');
  console.log(`   Model: ${MODEL}`);
  console.log('   Bypass any prompt with !! prefix to skip');
}

function disable(): void {
  try {
    rmSync(TOGGLE_FLAG);
    console.log('⏸️  LLP disabled — prompts pass through unchanged');
  } catch {
    console.log('⏸️  LLP already disabled');
  }
}

function status(): void {
  const on = isEnabled();
  console.log(`LLP status: ${on ? '✅ ENABLED' : '⏸️  DISABLED'}`);
  console.log(`Flag file:  ${TOGGLE_FLAG}`);
  console.log(`Model:      ${MODEL} (override with LLP_OLLAMA_MODEL)`);
  if (on) {
    console.log('Modes:      PASS (0-4) → rewrite | CLARIFY (5-8) → annotate | BLOCK (9+) → reject');
    console.log('Bypass:     Start prompt with !! to skip LLP entirely');
  }
}

const cmd = process.argv[2] ?? '';

switch (cmd) {
  case 'enable':  enable(); break;
  case 'disable': disable(); break;
  case 'status':  status(); break;
  case '':
    if (isEnabled()) { disable(); } else { enable(); }
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: LLPToggle.ts [enable|disable|status]');
    process.exit(1);
}
