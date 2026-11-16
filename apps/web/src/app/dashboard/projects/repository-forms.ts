export const CREATE_FORM = 'project.create';
export const BIND_FORM = 'repository.bind';
export const REMOVE_FORM = 'repository.remove';
export const ACCEPT_REMOTES_FORM = 'repository.accept-remotes';
export const DISCARD_FORM = 'repository.discard';
export const RESTORE_FORM = 'repository.restore';

export const REPOSITORY_PATHS = [
  '/dashboard/projects',
  '/dashboard/projects/repositories',
] as const;

export const FINGERPRINT_PATTERN = '[0-9a-f]{40}|[0-9a-f]{64}';
export const FINGERPRINT_FORMAT_MESSAGE =
  'A repository fingerprint is 40 or 64 lowercase hexadecimal characters: the root commit hash.';
