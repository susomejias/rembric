import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';

describe('shared detail layout', () => {
  it('opts into Ficha with compositional header slots and a single action region', () => {
    const html = renderToStaticMarkup(
      <DetailLayout
        presentation="ficha"
        title="Record"
        backHref="/dashboard/memories"
        backLabel="Memories"
        topic="topic/key"
        badges={<span>Byline</span>}
        tags={<span>Tags slot</span>}
        primaryActions={<button>Copy</button>}
        actions={<button>Archive</button>}
        actionsLabel="Record actions"
        metadata={<p>Properties slot</p>}
        secondary={<p>History slot</p>}
      >
        <p>Document</p>
      </DetailLayout>,
    );
    expect(html).toContain('detail-ficha');
    expect(html).toContain('topic/key');
    expect(html.indexOf('Byline')).toBeLessThan(html.indexOf('Tags slot'));
    expect(html.indexOf('Document')).toBeLessThan(html.indexOf('History slot'));
    expect(html.indexOf('History slot')).toBeLessThan(html.indexOf('Properties slot'));
    expect(html.match(/>Copy</g)).toHaveLength(1);
    expect(html.match(/>Archive</g)).toHaveLength(1);
  });
  it.each(['primary', 'overflow'] as const)(
    'keeps a Ficha action region with only %s controls',
    (kind) => {
      const control = <button>Applicable action</button>;
      const html = renderToStaticMarkup(
        <DetailLayout
          presentation="ficha"
          title="Record"
          backHref="/dashboard/judgments"
          backLabel="Judgments"
          actionsLabel="Record actions"
          metadata={<p>Properties</p>}
          primaryActions={kind === 'primary' ? control : undefined}
          actions={kind === 'overflow' ? control : undefined}
        >
          <p>Compared content</p>
        </DetailLayout>,
      );
      expect(html).toContain('role="group" aria-label="Record actions"');
      expect(html.match(/>Applicable action<\/button>/g)).toHaveLength(1);
    },
  );
  it('omits an empty Ficha action bar when there are no applicable controls', () => {
    const html = renderToStaticMarkup(
      <DetailLayout
        presentation="ficha"
        title="Closed record"
        backHref="/dashboard/judgments"
        backLabel="Judgments"
        actionsLabel="Judgment actions"
        metadata={<p>Properties</p>}
      >
        <p>Compared content remains available</p>
      </DetailLayout>,
    );
    expect(html).toContain('Compared content remains available');
    expect(html).not.toContain('ficha-actions');
    expect(html).not.toContain('aria-label="Judgment actions"');
  });
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
