import * as z from 'zod';

export {
  OAuthClientMetadataSchema,
  OAuthTokenRevocationRequestSchema,
} from '@modelcontextprotocol/core';

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
