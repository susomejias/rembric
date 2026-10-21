import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DetailShareData } from './detail-image';
import { DetailImageCard } from './detail-image-card';

const data: DetailShareData = {
  kind: 'memory',
  label: 'Memory',
  title: 'Shared card',
  date: new Date('2026-10-20'),
  byline: 'Saved by pi',
  projectName: 'private-project',
  content: {
    text: '| Name | Count |\n| --- | ---: |\n| Alpha | 12 |\n\nLAST LINE',
    mode: 'markdown',
    label: 'Full content',
  },
  tags: ['dashboard'],
};
const settings = { content: true, project: true, stats: true };
describe('DetailImageCard', () => {
  it('renders the approved composition using the same semantic markdown as views', () => {
    const html = renderToStaticMarkup(
      <DetailImageCard data={data} options={settings} logo="data:image/png;base64,AA==" />,
    );
    expect(html).toContain('detail-image-card');
    expect(html).toContain('<table');
    expect(html).toContain('Alpha');
    expect(html).toContain('LAST LINE');
    expect(html.indexOf('dashboard')).toBeLessThan(html.indexOf('<table'));
    expect(html).toContain('private-project');
    expect(html).not.toMatch(/Square|Story|canvas/);
  });
  it('keeps attribution toggles independent of content and hides all optional stats metadata', () => {
    const session: DetailShareData = {
      ...data,
      kind: 'session',
      label: 'Session',
      tags: [],
      duration: '1h 2m',
      stats: [
        { label: 'memories', value: '12' },
        { label: 'prompts', value: '2' },
        { label: 'duration', value: '1h 2m' },
      ],
      content: { text: '<img>\n**literal**', mode: 'literal', label: 'Full summary' },
    };
    const html = renderToStaticMarkup(
      <DetailImageCard
        data={session}
        options={{ ...settings, project: false, stats: false }}
        logo="data:image/png;base64,AA=="
      />,
    );
    expect(html).not.toMatch(/private-project|1h 2m|memories|prompts|<table/);
    expect(html).toContain('&lt;img&gt;');
    expect(html).toContain('**literal**');
    const hidden = renderToStaticMarkup(
      <DetailImageCard
        data={data}
        options={{ ...settings, content: false }}
        logo="data:image/png;base64,AA=="
      />,
    );
    expect(hidden).not.toContain('LAST LINE');
    expect(hidden).toContain('dashboard');
  });
});
