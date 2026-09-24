import { describe, expect, it } from 'vitest';

import { CHROME_FREE_PATHS, isChromeFreePath } from '@/lib/nav';

describe('chrome-free paths', () => {
  it('marks the login and oauth consent screens chrome-free', () => {
    expect(CHROME_FREE_PATHS).toContain('/dashboard/login');
    expect(CHROME_FREE_PATHS).toContain('/dashboard/oauth-consent');
    expect(isChromeFreePath('/dashboard/login')).toBe(true);
    expect(isChromeFreePath('/dashboard/oauth-consent')).toBe(true);
  });

  it('keeps subpaths chrome-free (verify subflow, error states)', () => {
    expect(isChromeFreePath('/dashboard/login/verify')).toBe(true);
    expect(isChromeFreePath('/dashboard/oauth-consent/')).toBe(true);
  });

  it('keeps the shell on dashboard pages', () => {
    expect(isChromeFreePath('/dashboard')).toBe(false);
    expect(isChromeFreePath('/dashboard/memories')).toBe(false);
    expect(isChromeFreePath('/dashboard/sessions/S1')).toBe(false);
    expect(isChromeFreePath(null)).toBe(false);
    expect(isChromeFreePath(undefined)).toBe(false);
  });
});
