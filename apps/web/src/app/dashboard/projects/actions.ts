'use server';

import {
  type DomainError,
  REPOSITORY_FINGERPRINT_RE,
  type RepositoryBindingsService,
} from '@rembric/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  ACCEPT_REMOTES_FORM,
  BIND_FORM,
  CREATE_FORM,
  DISCARD_FORM,
  FINGERPRINT_FORMAT_MESSAGE,
  REMOVE_FORM,
  REPOSITORY_PATHS,
  RESTORE_FORM,
} from './repository-forms';

import type { ActionState } from '@/components/dashboard/action-form';
import type { BindState, ProjectRef } from '@/components/dashboard/repositories-section';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { isDomainError } from '@/lib/auth';

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

function revalidateRepositories(): void {
  for (const path of REPOSITORY_PATHS) revalidatePath(path);
}

function boundProjects(err: DomainError): ProjectRef[] | null {
  const raw = err.details?.['boundProjects'];
  return Array.isArray(raw) ? (raw as ProjectRef[]) : null;
}

export async function createProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const guard = await guardAction(formData, CREATE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const slug = readField(formData, 'slug');
  const displayNameInput = readField(formData, 'displayName');
  const displayName = displayNameInput.length > 0 ? displayNameInput : null;
  if (!slug) return { error: 'Slug is required.' };
  const fingerprint = readField(formData, 'fingerprint');
  if (fingerprint && !REPOSITORY_FINGERPRINT_RE.test(fingerprint)) {
    return { error: FINGERPRINT_FORMAT_MESSAGE };
  }
  const pendingIds = formData
    .getAll('pendingId')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  const { projects, repositoryBindings } = guard.services;
  let created: { id: string; slug: string };
  try {
    created = projects.create({ slug, displayName });
  } catch (err) {
    if (isDomainError(err)) return { error: err.message };
    throw err;
  }

  const createdBy = `dashboard:${guard.session.tokenId}`;
  const targets = [
    ...pendingIds.map((pendingId) => ({ pendingId })),
    ...(fingerprint ? [{ fingerprint }] : []),
  ];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      repositoryBindings.bindWithChoice({ ...target, projectId: created.id, createdBy });
    } catch (err) {
      if (!isDomainError(err)) throw err;
      failures.push(err.message);
    }
  }
  if (targets.length > 0) revalidateRepositories();

  const query = new URLSearchParams({ created: created.slug });
  if (failures.length > 0) {
    query.set(
      'error',
      `The project was created, but a repository was not bound: ${failures.join('; ')}`,
    );
  }
  redirect(`/dashboard/projects?${query.toString()}`);
}

export async function bindRepository(_prev: BindState, formData: FormData): Promise<BindState> {
  const guard = await guardAction(formData, BIND_FORM);
  if (!guard.ok) return guardFailure(guard);

  const projectId = readField(formData, 'projectId');
  if (!projectId) return { error: 'Choose a project to bind the repository to.' };
  const pendingId = readField(formData, 'pendingId');
  const fingerprint = readField(formData, 'fingerprint');
  const moveFrom = readField(formData, 'moveFrom');
  const choice = moveFrom
    ? { moveFrom }
    : readField(formData, 'choice') === 'add'
      ? ('add' as const)
      : undefined;

  try {
    guard.services.repositoryBindings.bindWithChoice({
      projectId,
      createdBy: `dashboard:${guard.session.tokenId}`,
      ...(pendingId ? { pendingId } : { fingerprint }),
      ...(choice === undefined ? {} : { choice }),
    });
  } catch (err) {
    if (!isDomainError(err)) throw err;
    if (err.code === 'invalid_repository_fingerprint') return { error: FINGERPRINT_FORMAT_MESSAGE };
    const bound = err.code === 'repository_already_bound' ? boundProjects(err) : null;
    return bound === null ? { error: err.message } : { error: err.message, conflict: { bound } };
  }
  revalidateRepositories();
  return { error: null };
}

export async function removeRepositoryBinding(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const guard = await guardAction(formData, REMOVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const removed = guard.services.repositoryBindings.remove({
    fingerprint: readField(formData, 'fingerprint'),
    projectId: readField(formData, 'projectId'),
  });
  if (!removed) return { error: 'This binding no longer exists.' };
  revalidateRepositories();
  return { error: null };
}

async function pendingAction(
  formData: FormData,
  formName: string,
  run: (service: RepositoryBindingsService, pendingId: string) => boolean,
): Promise<ActionState> {
  const guard = await guardAction(formData, formName);
  if (!guard.ok) return guardFailure(guard);

  if (!run(guard.services.repositoryBindings, readField(formData, 'pendingId'))) {
    return { error: 'This pending repository no longer exists.' };
  }
  revalidateRepositories();
  return { error: null };
}

export async function acceptRepositoryRemotes(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return pendingAction(formData, ACCEPT_REMOTES_FORM, (service, id) => service.acceptRemotes(id));
}

export async function discardPendingRepository(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return pendingAction(formData, DISCARD_FORM, (service, id) => service.discard(id));
}

export async function restorePendingRepository(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return pendingAction(formData, RESTORE_FORM, (service, id) => service.restore(id));
}
