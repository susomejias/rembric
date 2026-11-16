import { describe, expect, it } from 'vitest';

import { unboundMessage } from './_shared.js';

describe('the project_unbound message', () => {
  const fingerprint = 'ab'.repeat(20);

  it('does not claim every repository used the default project before this version', () => {
    for (const scope of ['*', 'project:p1'] as const) {
      const message = unboundMessage(scope, fingerprint);
      expect(message).toContain('a repository without a .rembric file used the default project');
      expect(message).toContain('the project its earlier sessions used');
      expect(message).not.toContain('Sessions in this repository used the default project');
    }
  });

  it('control: still names the remedy the token can perform and when it applies', () => {
    expect(unboundMessage('*', fingerprint)).toContain('project.bind_repository');
    expect(unboundMessage('project:p1', fingerprint)).not.toContain('project.bind_repository');
    expect(unboundMessage('*', fingerprint)).toContain('A binding applies from the next session');
  });
});
