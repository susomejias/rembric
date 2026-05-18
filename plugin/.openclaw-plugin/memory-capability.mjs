// Memory-slot claim, prompt section (auto-recall), and interactive
// matcher for the `remember|recall|acordate|...` trigger phrases.
//
// All three surfaces converge on `memory.search` over the MCP wire to
// Rembric. The capability is registered unconditionally (we claim
// kind: "memory"); the prompt section is gated on `autoRecall`; the
// interactive handler is always wired so explicit recall trigger
// phrases work regardless of `autoRecall`.

const RECALL_PATTERN = /\b(remember|recall|acordate|qu[eé] hicimos|what did we do)\b/i;

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
    api.registerMemoryCapability({
      promptBuilder: (_params) => PROMPT_BUILDER_LINES,
    });
  } else {
    api.logger?.debug?.('rembric: api.registerMemoryCapability not available; slot not claimed');
  }

  if (config.autoRecall && typeof api.registerMemoryPromptSection === 'function') {
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
  }

  if (typeof api.registerInteractiveHandler === 'function') {
    api.registerInteractiveHandler({
      pattern: RECALL_PATTERN,
      handler: async (event) => {
        const text =
          typeof event?.prompt === 'string'
            ? event.prompt
            : typeof event?.text === 'string'
              ? event.text
              : '';
        if (!text) return null;
        const result = await mcpClient.callTool('memory.search', {
          query: text,
          limit: 8,
        });
        if (!result.ok) {
          api.logger?.warn?.(`rembric recall handler: ${result.code} — ${result.message}`);
          return null;
        }
        const block = searchResultToBlock(result.data, { tokenBudget: config.tokenBudget });
        if (!block) return null;
        return {
          prependContext: `Rembric recall for "${text.slice(0, 80)}":\n${block}`,
        };
      },
    });
  }
}
