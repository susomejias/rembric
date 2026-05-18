// Memory-slot claim and prompt section (auto-recall).
//
// `api.registerMemoryCapability` claims the `kind: "memory"` slot;
// `api.registerMemoryPromptSection` is the exclusive-slot prompt
// builder (gated on `autoRecall`). Both call `memory.search` over the
// MCP wire to Rembric.
//
// NOTE: explicit `remember|recall|acordate` matcher is NOT wired here.
// `api.registerInteractiveHandler` is an inter-plugin RPC channel, not
// a user-prompt regex matcher (per /tmp/openclaw/src/plugins/types.ts
// — its shape is { channel, namespace, handler }, no pattern). To
// match user phrases, a follow-up change can detect the regex inside
// the `before_prompt_build` hook and inject extra context when it
// hits. For v1 the auto-recall prompt section covers the dominant
// use case (memories auto-injected every turn when autoRecall=true).
const RECALL_PATTERN_NOT_YET_WIRED =
  /\b(remember|recall|acordate|qu[eé] hicimos|what did we do)\b/i;
void RECALL_PATTERN_NOT_YET_WIRED;

const PROMPT_BUILDER_LINES = [
  'Long-term memory provider: Rembric.',
  'Rembric auto-injects relevant memories into each turn via `before_prompt_build` (Memory Prompt Section) when autoRecall is enabled.',
  'For explicit reads, call `memory_search`. For writes, call `memory_save` (returns candidates[] for conflict resolution via `memory_judge`).',
  'Treat recalled context as background, not authoritative — prefer current workspace state and explicit user instructions when they conflict.',
];

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      if (block.type === 'text' && typeof block.text === 'string') return [block.text];
      return [];
    })
    .join('\n')
    .trim();
}

function searchResultToBlock(result, { tokenBudget }) {
  // The MCP `memory.search` tool returns its payload in the standard
  // `content` array (MCP tool response shape). Extract text and trim to
  // approximately `tokenBudget` characters (4 chars ≈ 1 token, a coarse
  // but standard heuristic).
  const text = extractTextFromContent(result?.content);
  if (!text) return '';
  const approxBytes = Math.max(200, tokenBudget * 4);
  return text.length > approxBytes ? text.slice(0, approxBytes) + '\n…(truncated)' : text;
}

export function registerMemorySurface(api, mcpClient, config) {
  if (typeof api.registerMemoryCapability === 'function') {
    try {
      api.registerMemoryCapability({
        promptBuilder: (_params) => PROMPT_BUILDER_LINES,
      });
    } catch (err) {
      api.logger?.warn?.(`rembric: registerMemoryCapability failed: ${String(err)}`);
    }
  } else {
    api.logger?.debug?.('rembric: api.registerMemoryCapability not available; slot not claimed');
  }

  if (config.autoRecall && typeof api.registerMemoryPromptSection === 'function') {
    try {
      api.registerMemoryPromptSection(async (params) => {
        const prompt =
          typeof params?.prompt === 'string'
            ? params.prompt.trim()
            : Array.isArray(params?.messages)
              ? (() => {
                  for (const m of [...params.messages].reverse()) {
                    if (m?.role === 'user') return extractTextFromContent(m.content);
                  }
                  return '';
                })()
              : '';
        if (!prompt) return null;
        const result = await mcpClient.callTool('memory.search', {
          query: prompt,
          limit: 5,
        });
        if (!result.ok) {
          api.logger?.warn?.(`rembric autoRecall: ${result.code} — ${result.message}`);
          return null;
        }
        const block = searchResultToBlock(result.data, { tokenBudget: config.tokenBudget });
        if (!block) return null;
        return {
          prependContext: `Relevant Rembric memories:\n${block}`,
        };
      });
    } catch (err) {
      api.logger?.warn?.(`rembric: registerMemoryPromptSection failed: ${String(err)}`);
    }
  }
}
