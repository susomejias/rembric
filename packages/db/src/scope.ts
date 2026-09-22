export type Scope = { kind: 'project'; projectId: string };

export type SearchScope =
  | Scope
  | {
      kind: 'authorized-projects';
      /** Each id was admitted by `isAuthorized(…, 'read', …)` at the one site that builds this. */
      projectIds: readonly string[];
      /** The scope the connection resolved to; always a member of `projectIds`. */
      homeProjectId: string;
    };

/** Scope a project by id. */
export function projectScope(projectId: string): Scope {
  return { kind: 'project', projectId };
}

export function homeScope(scope: SearchScope): Scope {
  return scope.kind === 'project' ? scope : projectScope(scope.homeProjectId);
}

export function memoryMatchesScope(
  memory: { scope: 'global' | 'project'; projectId: string | null },
  scope: Scope,
): boolean {
  return memory.scope === 'project' && memory.projectId === scope.projectId;
}
