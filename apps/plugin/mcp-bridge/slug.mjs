export function resolveProjectDirectory(env = process.env, cwd = process.cwd()) {
  if (env.CLAUDE_PROJECT_DIR || env.PWD) {
    return env.CLAUDE_PROJECT_DIR || env.PWD;
  }
  return cwd;
}

export function projectDirectorySource(env = process.env) {
  if (env.CLAUDE_PROJECT_DIR) return 'CLAUDE_PROJECT_DIR';
  if (env.PWD) return 'PWD';
  return 'process.cwd()';
}
