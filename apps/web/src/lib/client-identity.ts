import { isIP } from 'node:net';

export const UNKNOWN_CLIENT = '0.0.0.0';

export function clientIdentity(request: Request): string {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return isIP(first) === 0 ? UNKNOWN_CLIENT : first;
}
