#!/usr/bin/env node
// One-shot smoke test of the LLM judge end-to-end against the configured
// OpenAI-compatible endpoint (OpenAI itself, Ollama, LM Studio, …). Builds
// two synthetic memories per case and asks the judge to merge / supersede
// / keep_separate. Use:
//
//   OPENAI_BASE_URL=http://192.168.20.45:11434/v1 \
//   OPENAI_API_KEY=ollama \
//   OPENAI_MODEL=qwen2.5:7b-instruct-q4_K_M \
//   pnpm exec node scripts/smoke-judge.mjs

import { judge } from '../dist/consolidation/judge.js';
import { LlmClient } from '../dist/llm/index.js';

const baseUrl = process.env.OPENAI_BASE_URL ?? 'http://localhost:11434/v1';
const apiKey = process.env.OPENAI_API_KEY ?? undefined;
const model = process.env.OPENAI_MODEL ?? 'qwen2.5:7b-instruct-q4_K_M';

console.error(`smoke-judge: ${baseUrl} model=${model}`);

const client = new LlmClient({ baseUrl, apiKey });
const now = Date.now();

function mem(id, content, tags = []) {
  return {
    id,
    scope: 'project',
    projectId: 'proj_1',
    type: 'user',
    content,
    tags,
    status: 'active',
    replaces: [],
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    source: null,
  };
}

const cases = [
  {
    name: 'redundant pair → expect merge',
    memories: [
      mem('a', 'The user prefers indenting with tabs rather than spaces.', ['editor']),
      mem('b', 'User wants tab-based indentation in code, not spaces.', ['editor', 'style']),
    ],
  },
  {
    name: 'unrelated pair → expect keep_separate',
    memories: [
      mem('c', 'The user prefers indenting with tabs rather than spaces.', ['editor']),
      mem('d', 'The user runs the test suite via pnpm test before pushing.', ['workflow']),
    ],
  },
];

for (const c of cases) {
  console.log(`\n--- ${c.name} ---`);
  const start = Date.now();
  const decision = await judge({ client, model, candidates: c.memories });
  const ms = Date.now() - start;
  console.log(JSON.stringify({ ms, decision }, null, 2));
}
