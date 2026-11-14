import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

export type ReplyHeaders = Map<string, string>;

export interface OAuthReply {
  status: number;
  headers: ReplyHeaders;
  body: string | null;
}

export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyParseError';
  }
}

export type BodyKind = 'json' | 'form';

const BODY_LIMIT_BYTES = 100 * 1024;
const PARAMETER_LIMIT = 1000;
const MEDIA_TYPE: Record<BodyKind, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
};
const CORS_ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

export function jsonReply(status: number, headers: ReplyHeaders, value: unknown): OAuthReply {
  headers.set('content-type', 'application/json; charset=utf-8');
  return { status, headers, body: JSON.stringify(value) };
}

export function redirectReply(headers: ReplyHeaders, location: string): OAuthReply {
  headers.set('location', location);
  return { status: 302, headers, body: null };
}

export function oauthErrorReply(headers: ReplyHeaders, err: unknown): OAuthReply {
  const error = OAuthError.isInstance(err)
    ? err
    : new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
  const status = error.code === String(OAuthErrorCode.ServerError) ? 500 : 400;
  return jsonReply(status, headers, error.toResponseObject());
}

export function corsPreflight(request: Request, headers: ReplyHeaders): OAuthReply | null {
  headers.set('access-control-allow-origin', '*');
  if (request.method.toUpperCase() !== 'OPTIONS') return null;
  headers.set('access-control-allow-methods', CORS_ALLOWED_METHODS);
  headers.set('vary', 'Access-Control-Request-Headers');
  const requested = request.headers.get('access-control-request-headers');
  if (requested !== null && requested.length > 0) {
    headers.set('access-control-allow-headers', requested);
  }
  headers.set('content-length', '0');
  return { status: 204, headers, body: null };
}

export function refuseMethod(
  request: Request,
  headers: ReplyHeaders,
  allowed: readonly string[],
): OAuthReply | null {
  if (allowed.includes(request.method)) return null;
  headers.set('allow', allowed.join(', '));
  const error = new OAuthError(
    OAuthErrorCode.MethodNotAllowed,
    `The method ${request.method} is not allowed for this endpoint`,
  );
  return jsonReply(405, headers, error.toResponseObject());
}

export function queryParams(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    query[name] = value;
  });
  return query;
}

export async function readBody(request: Request, kind: BodyKind): Promise<unknown> {
  const headers = request.headers;
  const declared = headers.get('content-length');
  const bodyless = request.method === 'GET' || request.method === 'HEAD';
  const lengthHeader = declared ?? (bodyless ? null : '');
  const hasBody = lengthHeader !== null && !Number.isNaN(Number(lengthHeader));
  if (!hasBody || mediaType(headers.get('content-type')) !== MEDIA_TYPE[kind]) return undefined;

  const charset = requestCharset(headers.get('content-type')) || 'utf-8';
  if (kind === 'json' ? charset !== 'utf-8' : charset !== 'utf-8' && charset !== 'iso-8859-1') {
    throw new BodyParseError(`unsupported charset "${charset.toUpperCase()}"`);
  }

  const raw = bodyless ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());
  const bytes = decodeContent(raw, headers.get('content-encoding'), declared);
  const text =
    charset === 'utf-8'
      ? new TextDecoder('utf-8').decode(bytes)
      : Buffer.from(bytes).toString('latin1');

  return kind === 'json' ? parseJson(text) : parseForm(text, charset);
}

function mediaType(header: string | null): string | null {
  if (header === null || header.length === 0) return null;
  const semicolon = header.indexOf(';');
  const type = (semicolon === -1 ? header : header.slice(0, semicolon))
    .replace(/^[ \t]+|[ \t]+$/g, '')
    .toLowerCase();
  return MEDIA_TYPE_RE.test(type) ? type : null;
}

const MEDIA_TYPE_RE = /^ *([a-z0-9][a-z0-9!#$&^_-]{0,126})\/([a-z0-9][a-z0-9!#$&^_.+-]{0,126}) *$/;
const STRICT_TYPE_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const STRICT_PARAM_RE =
  // eslint-disable-next-line no-control-regex
  /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b !#-[]-~\u0080-ÿ]|\\[\u000b -ÿ])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
// eslint-disable-next-line no-control-regex
const QUOTED_ESCAPE_RE = /\\([\u000b -ÿ])/g;

function requestCharset(header: string | null): string | undefined {
  if (header === null || header.length === 0) return undefined;
  let index = header.indexOf(';');
  const type = index === -1 ? header.trim() : header.slice(0, index).trim();
  if (!STRICT_TYPE_RE.test(type)) return undefined;
  if (index === -1) return '';

  let charset = '';
  const params = new RegExp(STRICT_PARAM_RE.source, 'g');
  params.lastIndex = index;
  let match: RegExpExecArray | null;
  while ((match = params.exec(header)) !== null) {
    if (match.index !== index) return undefined;
    index += match[0].length;
    const key = (match[1] ?? '').toLowerCase();
    let value = match[2] ?? '';
    if (value.startsWith('"')) value = value.slice(1, -1).replace(QUOTED_ESCAPE_RE, '$1');
    if (key === 'charset') charset = value;
  }
  if (index !== header.length) return undefined;
  return charset.toLowerCase();
}

function decodeContent(raw: Uint8Array, encodingHeader: string | null, declared: string | null) {
  const encoding = (encodingHeader || 'identity').toLowerCase();
  if (encoding === 'identity') {
    const length =
      declared !== null && !Number.isNaN(Number(declared)) ? Number.parseInt(declared, 10) : null;
    if (length !== null && length > BODY_LIMIT_BYTES) throw new BodyParseError('entity too large');
    if (raw.byteLength > BODY_LIMIT_BYTES) throw new BodyParseError('entity too large');
    if (length !== null && length !== raw.byteLength) {
      throw new BodyParseError('request size did not match content length');
    }
    return raw;
  }
  const options = { maxOutputLength: BODY_LIMIT_BYTES };
  switch (encoding) {
    case 'deflate':
      return inflateSync(raw, options);
    case 'gzip':
      return gunzipSync(raw, options);
    case 'br':
      return brotliDecompressSync(raw, options);
    default:
      throw new BodyParseError(`unsupported content encoding "${encoding}"`);
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return {};
  const first = text.replace(/^[ \t\n\r]+/, '').charAt(0);
  if (first !== '{' && first !== '[') throw new BodyParseError('strict violation');
  return JSON.parse(text) as unknown;
}

function parseForm(text: string, charset: string): Record<string, string | string[]> {
  if (text.length === 0) return {};
  if (text.split('&').length > PARAMETER_LIMIT) throw new BodyParseError('too many parameters');

  const grouped = new Map<string, string[]>();
  for (const part of text.replace(/%5B/gi, '[').replace(/%5D/gi, ']').split('&')) {
    const bracketEquals = part.indexOf(']=');
    const pos = bracketEquals === -1 ? part.indexOf('=') : bracketEquals + 1;
    const key = decodeFormComponent(pos === -1 ? part : part.slice(0, pos), charset);
    const value = pos === -1 ? '' : decodeFormComponent(part.slice(pos + 1), charset);
    const values = grouped.get(key);
    if (values === undefined) grouped.set(key, [value]);
    else values.push(value);
  }

  const merged = new Map<string, string[]>();
  for (const [key, values] of grouped) {
    const name = key.startsWith('[') && key.endsWith(']') ? key.slice(1, -1) : key;
    const existing = merged.get(name);
    if (existing === undefined) merged.set(name, [...values]);
    else existing.push(...values);
  }

  return Object.fromEntries(
    [...merged].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? '') : values]),
  );
}

function decodeFormComponent(value: string, charset: string): string {
  const spaced = value.replace(/\+/g, ' ');
  if (charset === 'iso-8859-1') {
    return spaced.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}
