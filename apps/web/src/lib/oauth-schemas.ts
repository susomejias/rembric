import * as z from 'zod';

const SafeUrlSchema = z
  .url()
  .superRefine((val, ctx) => {
    if (!URL.canParse(val)) {
      ctx.addIssue({ code: 'custom', message: 'URL must be parseable', fatal: true });
      return z.NEVER;
    }
  })
  .refine(
    (url) => {
      const u = new URL(url);
      return u.protocol !== 'javascript:' && u.protocol !== 'data:' && u.protocol !== 'vbscript:';
    },
    { message: 'URL cannot use javascript:, data:, or vbscript: scheme' },
  );

const OptionalSafeUrlSchema = SafeUrlSchema.optional().or(z.literal('').transform(() => undefined));

export const OAuthClientMetadataSchema = z
  .object({
    redirect_uris: z.array(SafeUrlSchema),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_name: z.string().optional(),
    client_uri: SafeUrlSchema.optional(),
    logo_uri: OptionalSafeUrlSchema,
    scope: z.string().optional(),
    contacts: z.array(z.string()).optional(),
    tos_uri: OptionalSafeUrlSchema,
    policy_uri: z.string().optional(),
    jwks_uri: SafeUrlSchema.optional(),
    jwks: z.any().optional(),
    software_id: z.string().optional(),
    software_version: z.string().optional(),
    software_statement: z.string().optional(),
  })
  .strip();

export const OAuthTokenRevocationRequestSchema = z
  .object({
    token: z.string(),
    token_type_hint: z.string().optional(),
  })
  .strip();

export const ClientAuthorizationParamsSchema = z.object({
  client_id: z.string(),
  redirect_uri: z
    .string()
    .optional()
    .refine((value) => value === undefined || URL.canParse(value), {
      message: 'redirect_uri must be a valid URL',
    }),
});

export const RequestAuthorizationParamsSchema = z.object({
  response_type: z.literal('code'),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  scope: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().url().optional(),
});

export const ClientAuthenticatedRequestSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
});

export const TokenRequestSchema = z.object({
  grant_type: z.string(),
});

export const AuthorizationCodeGrantSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string().optional(),
  resource: z.string().url().optional(),
});

export const RefreshTokenGrantSchema = z.object({
  refresh_token: z.string(),
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});
