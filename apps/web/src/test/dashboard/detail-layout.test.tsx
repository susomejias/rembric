import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';

describe('shared detail layout', () => {
  it('renders one header, notices, inspector before prose and secondary disclosures afterward', () => {
    const html = renderToStaticMarkup(
      <DetailLayout
        title="Unique title"
        backHref="/dashboard/memories"
        backLabel="Back"
        actionsLabel="Record actions"
        actions={<button>Archive</button>}
        notices={<p>Notice</p>}
        metadata={
          <DetailDisclosure title="Details" inspector>
            Metadata
          </DetailDisclosure>
        }
        secondary={<DetailDisclosure title="History">History body</DetailDisclosure>}
      >
        <p>Primary prose</p>
      </DetailLayout>,
    );
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/Unique title/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Record actions"');
    expect(html.indexOf('Notice')).toBeLessThan(html.indexOf('Metadata'));
    expect(html.indexOf('Metadata')).toBeLessThan(html.indexOf('Primary prose'));
    expect(html.indexOf('Primary prose')).toBeLessThan(html.indexOf('History body'));
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain('detail-secondary-body');
  });
});
