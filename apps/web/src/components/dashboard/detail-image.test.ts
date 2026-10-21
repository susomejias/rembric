import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDetailImage, type DetailShareData } from './detail-image';

const boundary = vi.hoisted(() => ({
  capture: vi.fn<() => Promise<Blob | null>>(),
  embed: vi.fn<() => Promise<string>>(),
  unmount: vi.fn(),
  renderError: undefined as Error | undefined,
}));
vi.mock('html-to-image', () => ({ toBlob: boundary.capture, getFontEmbedCSS: boundary.embed }));
vi.mock('react-dom', () => ({ flushSync: (run: () => void) => run() }));
vi.mock('react-dom/client', () => ({
  createRoot: (host: ElementStub, options: { onUncaughtError: (error: unknown) => void }) => ({
    render: () => {
      if (boundary.renderError) options.onUncaughtError(boundary.renderError);
      else host.firstElementChild = card;
    },
    unmount: boundary.unmount,
  }),
}));
class ElementStub {
  tagName = 'DIV';
  nodeName = 'DIV';
  firstElementChild: ElementStub | null = null;
  className = '';
  inert = false;
  offsetWidth = 1080;
  height = 1400;
  clientWidth = 1080;
  scrollWidth = 1080;
  children: ElementStub[] = [];
  setAttribute = vi.fn();
  getAttributeNames() {
    return [];
  }
  remove = vi.fn();
  getBoundingClientRect() {
    return { height: this.height };
  }
  querySelectorAll(selector: string) {
    return selector === 'img' ? [] : this.children;
  }
}
let card: ElementStub;
let host: ElementStub;
const append = vi.fn();
const load = vi.fn<() => Promise<object[]>>();
const check = vi.fn<() => boolean>();
const fetchLogo = vi.fn<typeof fetch>();
const data: DetailShareData = {
  kind: 'memory',
  label: 'Memory',
  title: 'Title',
  date: new Date(0),
  byline: 'Saved by pi',
  projectName: 'p',
  content: { text: 'Body', mode: 'markdown', label: 'Full content' },
};
beforeEach(() => {
  card = new ElementStub();
  host = new ElementStub();
  boundary.capture.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  boundary.embed
    .mockReset()
    .mockResolvedValue('@font-face {font-family:Geist;src:url("data:font/woff2;base64,AA==")}');
  boundary.unmount.mockReset();
  boundary.renderError = undefined;
  append.mockReset();
  load.mockReset().mockResolvedValue([{}]);
  check.mockReset().mockReturnValue(true);
  fetchLogo
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve(new Response(new Blob(['logo'], { type: 'image/png' }))),
    );
  vi.stubGlobal('fetch', fetchLogo);
  vi.stubGlobal('HTMLElement', ElementStub);
  vi.stubGlobal('document', {
    documentElement: {},
    fonts: { load, check, ready: Promise.resolve() },
    createElement: () => host,
    body: { append },
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--font-geist' ? 'Geist' : 'GeistMono'),
  }));
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/png;base64,bG9nbw==';
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('createDetailImage DOM capture', () => {
  it('captures the measured card at exact dimensions with fonts embedded and cleans up its inaccessible stage', async () => {
    const result = await createDetailImage(data);
    expect(result).toMatchObject({ width: 1080, height: 1400 });
    expect(result.blob.type).toBe('image/png');
    expect(host.className).toContain('detail-image-stage');
    expect(host.inert).toBe(true);
    expect(host.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    expect(fetchLogo).toHaveBeenCalledWith('/dashboard/assets/logo-transparent.png', {
      mode: 'same-origin',
      credentials: 'same-origin',
    });
    expect(boundary.capture).toHaveBeenCalledWith(
      card,
      expect.objectContaining({
        width: 1080,
        height: 1400,
        pixelRatio: 1,
        skipAutoScale: true,
        fontEmbedCSS: '@font-face {font-family:Geist;src:url("data:font/woff2;base64,AA==")}',
      }),
    );
    expect(boundary.unmount).toHaveBeenCalledOnce();
    expect(host.remove).toHaveBeenCalledOnce();
  });
  it('fails before capture for missing fonts or a failed local asset', async () => {
    load.mockResolvedValueOnce([]);
    await expect(createDetailImage(data)).rejects.toThrow(/fonts/i);
    expect(append).not.toHaveBeenCalled();
    fetchLogo.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(createDetailImage(data)).rejects.toThrow(/logo could not be loaded/);
    expect(boundary.capture).not.toHaveBeenCalled();
  });
  it.each(['--font-geist', '--font-geist-mono'])(
    'rejects a missing %s variable before drawing',
    async (missing) => {
      vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (name: string) => (name === missing ? '' : 'Geist'),
      }));
      await expect(createDetailImage(data)).rejects.toThrow(/fonts are not ready/);
      expect(boundary.capture).not.toHaveBeenCalled();
    },
  );
  it('rejects unavailable font faces and an invalid local logo MIME type', async () => {
    check.mockReturnValueOnce(false);
    await expect(createDetailImage(data)).rejects.toThrow(/fonts could not be loaded/);
    fetchLogo.mockResolvedValueOnce(
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(createDetailImage(data)).rejects.toThrow(/logo is not a PNG/);
    expect(boundary.capture).not.toHaveBeenCalled();
  });
  it.each([{ offsetWidth: 900 }, { height: 900 }])(
    'rejects an unready card layout %j',
    async (size) => {
      Object.assign(card, size);
      await expect(createDetailImage(data)).rejects.toThrow(/layout is not ready/);
      expect(boundary.capture).not.toHaveBeenCalled();
      expect(host.remove).toHaveBeenCalledOnce();
    },
  );
  it('rejects unsupported content render errors without leaving mounted content', async () => {
    boundary.renderError = new Error('Unsupported image in image export');
    await expect(createDetailImage(data)).rejects.toThrow(/Unsupported image/);
    expect(boundary.capture).not.toHaveBeenCalled();
    expect(boundary.unmount).toHaveBeenCalledOnce();
    expect(host.remove).toHaveBeenCalledOnce();
  });
  it('rejects height limits and horizontal overflow before encoding', async () => {
    card.height = 15000;
    await expect(createDetailImage(data)).rejects.toThrow(/16 megapixel/);
    card.height = 1400;
    card.children = [Object.assign(new ElementStub(), { clientWidth: 900, scrollWidth: 950 })];
    await expect(createDetailImage(data)).rejects.toThrow(/width.*Nothing was truncated/);
    expect(boundary.capture).not.toHaveBeenCalled();
    expect(boundary.unmount).toHaveBeenCalledTimes(2);
    expect(host.remove).toHaveBeenCalledTimes(2);
  });
  it('rejects incomplete embedded fonts and failed PNG encoding, still cleaning up', async () => {
    boundary.embed.mockResolvedValueOnce('');
    await expect(createDetailImage(data)).rejects.toThrow(/embedded/);
    boundary.embed.mockResolvedValueOnce('@font-face {src:url(/missing.woff2)}');
    await expect(createDetailImage(data)).rejects.toThrow(/embedded/);
    boundary.embed.mockResolvedValueOnce(
      '@font-face {src:url("data:font/woff2;base64,AA==")} @font-face {src:url(/missing.woff2)}',
    );
    await expect(createDetailImage(data)).rejects.toThrow(/embedded/);
    boundary.capture.mockResolvedValueOnce(null);
    await expect(createDetailImage(data)).rejects.toThrow(/PNG encoding/);
    boundary.capture.mockResolvedValueOnce(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await expect(createDetailImage(data)).rejects.toThrow(/PNG encoding/);
    boundary.capture.mockRejectedValueOnce(new Error('Rasterization failed'));
    await expect(createDetailImage(data)).rejects.toThrow(/Rasterization failed/);
    expect(boundary.unmount).toHaveBeenCalledTimes(6);
    expect(host.remove).toHaveBeenCalledTimes(6);
  });
});
