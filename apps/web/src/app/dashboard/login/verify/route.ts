import { NextResponse, type NextRequest } from 'next/server';

import { safeNext, type LoginErrorCode } from '../clients';

import { isDomainError } from '@/lib/auth';
import { getServices } from '@/lib/services';
import { createSessionCookie } from '@/lib/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const services = getServices();
  const form = await readForm(request);
  const tokenPlain = stringField(form.get('token'));
  const next = safeNext(stringField(form.get('next')));

  const identity = networkIdentity(request);
  const locked = services.authLockout.check(identity);
  if (locked.locked) return backToLogin(request, 'locked', next);

  if (tokenPlain.length === 0) return backToLogin(request, 'missing', next);

  let resolved: Awaited<ReturnType<typeof services.tokens.authenticate>>;
  try {
    resolved = await services.tokens.authenticate(tokenPlain);
  } catch (err) {
    if (!isDomainError(err)) throw err;
    services.authLockout.recordFailure(identity);
    return backToLogin(request, 'invalid', next);
  }

  if (resolved.scope !== '*') {
    services.authLockout.recordFailure(identity);
    return backToLogin(request, 'invalid', next);
  }
  services.authLockout.recordSuccess(identity);

  const cookie = createSessionCookie(resolved.token.id);
  if (cookie === null) return backToLogin(request, 'unavailable', next);

  const response = NextResponse.redirect(new URL(next ?? '/dashboard', request.url), 302);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

function stringField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

function backToLogin(
  request: NextRequest,
  code: LoginErrorCode,
  next: string | null,
): NextResponse {
  const url = new URL('/dashboard/login', request.url);
  url.searchParams.set('error', code);
  if (next !== null) url.searchParams.set('next', next);
  return NextResponse.redirect(url, 302);
}

function networkIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
