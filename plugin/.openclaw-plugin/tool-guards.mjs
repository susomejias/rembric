// Non-prompting guardrails for Rembric-as-memory-provider.
//
// OpenClaw still exposes regular filesystem tools. When Rembric owns the
// memory slot, writes to OpenClaw's file-backed memory surfaces would bypass
// Rembric entirely. Block those tool calls at the SDK hook layer and force the
// model back through the registered `memory_save` tool.

function normalizePathForMatch(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isOpenClawMemoryPath(value) {
  const normalized = normalizePathForMatch(value);
  if (!normalized) return false;
  if (/(^|\/)MEMORY\.md$/.test(normalized)) return true;
  return /(^|\/)memory\/[^/]+\.md$/.test(normalized);
}

function collectStringPaths(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringPaths(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringPaths(item, out);
  }
  return out;
}

export function registerToolGuards(api) {
  if (typeof api.on !== 'function') {
    api.logger?.debug?.('rembric: api.on unavailable; tool guards not registered');
    return 0;
  }

  try {
    api.on('before_tool_call', (event) => {
      if (typeof event?.toolName === 'string' && event.toolName.startsWith('memory_')) {
        return undefined;
      }
      const paths = Array.isArray(event?.derivedPaths) ? [...event.derivedPaths] : [];
      if (event?.toolName === 'apply_patch') {
        paths.push(...collectStringPaths(event?.params));
      }
      if (!paths.some(isOpenClawMemoryPath)) return undefined;

      return {
        block: true,
        blockReason:
          'Rembric owns the OpenClaw memory slot. Do not write MEMORY.md or memory/*.md; call the `memory_save` tool instead so the memory is stored in Rembric.',
      };
    });
    return 1;
  } catch (err) {
    api.logger?.warn?.(`rembric: before_tool_call memory-file guard failed: ${String(err)}`);
    return 0;
  }
}

export { isOpenClawMemoryPath };
