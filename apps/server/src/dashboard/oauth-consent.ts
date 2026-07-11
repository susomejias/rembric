import { Hono } from 'hono';

import { verifyAuthRequest } from '../services/oauth-areq.js';
import { grantedOAuthScope, resolveGrantedScope, type OAuthService } from '../services/oauth.js';
import type { SessionsService } from '../services/sessions.js';

import { btn, flash } from './components.js';
import { csrfInput, readFormAndVerifyCsrf } from './csrf.js';
import { html, shell } from './templates.js';
import type { ResolvedSession } from './types.js';

/**
 * OAuth consent screen, mounted under the dashboard so it inherits the
 * signed-session auth (the operator must be logged in) and CSRF helpers.
 *
 * `provider.authorize` (which has no request access) signs the SDK-validated
 * authorization request and redirects here; on approval we issue the code and
 * redirect back to the client's registered redirect_uri with `code`+`state`.
 */

export interface OAuthConsentDeps {
  oauth: OAuthService;
  /** HMAC key for verifying the signed authorization request. */
  areqKey: Buffer;
  sessions: SessionsService;
}

const FORM = 'oauth.consent';

export function createOAuthConsentRouter(deps: OAuthConsentDeps): Hono {
  const app = new Hono();

  app.get('/consent', (c) => {
    const blob = c.req.query('areq') ?? '';
    const areq = verifyAuthRequest(blob, deps.areqKey, Date.now());
    if (!areq) return c.html(renderError('This authorization request is invalid or expired.'), 400);
    const client = deps.oauth.findClient(areq.clientId);
    if (!client) return c.html(renderError('Unknown OAuth client.'), 400);

    const session = c.get('session' as never) as ResolvedSession;
    return c.html(
      renderConsent({
        blob,
        clientName: client.clientName ?? areq.clientId,
        redirectHost: safeHost(areq.redirectUri),
        grantedScope: grantedOAuthScope(areq.scope),
        csrf: csrfInput(session.session, deps.sessions, FORM),
      }),
    );
  });

  app.post('/consent', async (c) => {
    const session = c.get('session' as never) as ResolvedSession;
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, FORM);
    if (form instanceof Response) return form;

    const blob = strField(form, 'areq');
    const areq = verifyAuthRequest(blob, deps.areqKey, Date.now());
    if (!areq) return c.html(renderError('This authorization request is invalid or expired.'), 400);

    if (strField(form, 'decision') !== 'approve') {
      return c.redirect(
        buildRedirect(areq.redirectUri, { error: 'access_denied', state: areq.state }),
      );
    }

    const code = deps.oauth.issueCode({
      clientId: areq.clientId,
      redirectUri: areq.redirectUri,
      codeChallenge: areq.codeChallenge,
      scope: grantedOAuthScope(areq.scope),
      subject: session.tokenId,
      projectId: areq.projectId ?? null,
    });
    return c.redirect(buildRedirect(areq.redirectUri, { code, state: areq.state }));
  });

  return app;
}

function strField(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.href;
}

function consentShell(inner: ReturnType<typeof html>): string {
  return shell(html`<div class="consent-stage"><div class="consent-card">${inner}</div></div>`, {
    title: 'Authorize',
    view: 'oauth-consent',
  });
}

function consentBrand(): ReturnType<typeof html> {
  return html`
    <div class="brand">
      <img src="/dashboard/assets/logo-transparent.png" alt="" aria-hidden="true" />
      <span class="wordmark">Rembric · Authorize</span>
    </div>
  `;
}

function renderConsent(o: {
  blob: string;
  clientName: string;
  redirectHost: string;
  grantedScope: string;
  csrf: ReturnType<typeof csrfInput>;
}): string {
  // `html` escapes every interpolated string once — do NOT pre-escape here
  // (that double-encodes, e.g. "&" → "&amp;amp;").
  const access = resolveGrantedScope(o.grantedScope) === 'read:*' ? 'Read-only' : 'Read & write';
  return consentShell(html`
    ${consentBrand()}
    <h1><span class="hl-lime">Authorize</span> Application.</h1>
    <p class="lead">
      <b>${o.clientName}</b> wants to connect to your Rembric memory and will redirect to
      <code>${o.redirectHost}</code>.
    </p>
    <div class="consent-grant">
      <span class="lbl">Granted access</span>
      <span class="val"
        ><span style="color:var(--lime)">${access}</span> · scope
        <code>${o.grantedScope}</code></span
      >
    </div>
    <p class="consent-note">
      Project scope, if any, is bound by the connector path <code>/mcp/&lt;slug&gt;</code>.
    </p>
    <div class="consent-actions">
      <form action="/dashboard/oauth/consent" method="post">
        ${o.csrf}
        <input type="hidden" name="areq" value="${o.blob}" />
        <input type="hidden" name="decision" value="approve" />
        ${btn({ variant: 'primary', label: 'AUTHORIZE →', type: 'submit' })}
      </form>
      <form action="/dashboard/oauth/consent" method="post">
        ${o.csrf}
        <input type="hidden" name="areq" value="${o.blob}" />
        <input type="hidden" name="decision" value="deny" />
        ${btn({ variant: 'secondary', label: 'DENY', type: 'submit' })}
      </form>
    </div>
  `);
}

function renderError(message: string): string {
  return consentShell(html`
    ${consentBrand()}
    <h1><span class="hl-lime">Authorization</span> Error.</h1>
    ${flash({ tone: 'danger', label: 'ERROR', body: message })}
    <p class="lead">Return to the application and start the connection again.</p>
  `);
}
