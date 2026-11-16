import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CreateProjectSheet, RenameProjectSheet } from './projects-sheets';
import {
  CreateRepositoryFields,
  RepositoriesSection,
  type PendingRepository,
  type ProjectRepositories,
  type RepositoryActions,
} from './repositories-section';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/ui/sheet', () => {
  const children = ({ children }: { children: ReactNode }) => children;
  return {
    Sheet: children,
    SheetContent: children,
    SheetDescription: children,
    SheetFooter: children,
    SheetHeader: children,
    SheetTitle: children,
    SheetTrigger: children,
  };
});
vi.mock('@/components/dashboard/confirm-submit', () => ({
  ConfirmSubmit: ({
    tone,
    title,
    description,
    children,
  }: {
    tone: string;
    title: ReactNode;
    description: ReactNode;
    children: ReactNode;
  }) => (
    <div data-confirm-tone={tone} data-confirm-title={title} data-confirm-description={description}>
      {children}
    </div>
  ),
}));

const SHOP = { id: 'shop-id', slug: 'shop' };
const STORE = { id: 'store-id', slug: 'store' };
const noop = () => Promise.resolve({ error: null });
const ACTIONS: RepositoryActions = {
  bind: noop,
  remove: noop,
  acceptRemotes: noop,
  discard: noop,
  restore: noop,
};
const CSRF = { bind: 'b', remove: 'r', acceptRemotes: 'a', discard: 'd', restore: 's' };

function pending(overrides: Partial<PendingRepository>): PendingRepository {
  return {
    id: 'p1',
    kind: 'unbound',
    fingerprint: 'f'.repeat(40),
    fingerprintPrefix: 'f'.repeat(12),
    remotes: ['github.com/acme/shop'],
    rootName: null,
    project: null,
    unseenRemotes: [],
    bindings: [],
    tokens: ['laptop'],
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
    discardedAt: null,
    ...overrides,
  };
}

function render(data: Partial<ProjectRepositories>, archived = false): string {
  return renderToStaticMarkup(
    <RepositoriesSection
      project={{ ...SHOP, archived }}
      data={{ bound: [], pending: [], conflicts: [], ...data }}
      actions={ACTIONS}
      csrf={CSRF}
    />,
  ).replaceAll('<!-- -->', '');
}

const BOUND = {
  fingerprint: 'e'.repeat(40),
  fingerprintPrefix: 'e'.repeat(12),
  remotes: ['github.com/acme/shop'],
  createdAt: new Date(0),
  createdBy: 'admin (dashboard)',
};

describe('the Repositories section of the project edit surface', () => {
  it('gates removal of a binding behind a warn-tone confirmation that explains what stays', () => {
    const html = render({ bound: [BOUND] });
    expect(html).toContain('data-confirm-tone="warn"');
    expect(html).toContain('data-confirm-title="Disconnect github.com/acme/shop?"');
    expect(html).toContain('Memories and sessions already written stay in shop.');
    expect(html).toContain('Later sessions from this repository stop resolving here');
    const removeForm = html.split('name="csrf" value="r"')[1]!.split('</form>')[0]!;
    expect(removeForm).toContain(`name="fingerprint" value="${BOUND.fingerprint}"`);
    expect(removeForm).toContain('>Disconnect</button>');
    const trigger = /<button[^>]*>Disconnect/.exec(removeForm)?.[0] ?? '';
    expect(trigger).toContain('type="button"');
    expect(trigger).toContain('data-variant="warn"');
    expect(removeForm).not.toContain('type="submit"');
  });

  it('renders the bound time through <Time> and names who bound it', () => {
    const html = render({ bound: [BOUND] });
    expect(html).toContain('data-rembric-ts');
    expect(html).toContain('by admin (dashboard)');
  });

  it('falls back to the fingerprint prefix for a binding without remotes', () => {
    const html = render({ bound: [{ ...BOUND, remotes: [] }] });
    expect(html).toContain(`>repository ${BOUND.fingerprintPrefix}</span>`);
    expect(html).toContain(`fingerprint ${BOUND.fingerprintPrefix}`);
  });

  it('offers a pending row a bind action to this project', () => {
    const html = render({ pending: [pending({})] });
    expect(html).toContain('name="pendingId" value="p1"');
    expect(html).toContain('name="projectId" value="shop-id"');
    expect(html).toContain('>Connect here</button>');
  });

  it('asks to move or add when the pending repository is bound elsewhere', () => {
    const html = render({
      pending: [pending({ kind: 'suggestion', project: SHOP, bindings: [STORE] })],
    });
    expect(html).toContain('Move from store');
    expect(html).toContain('>Keep both</button>');
    expect(html).not.toContain('>Connect here</button>');
  });

  it('offers accepting an unseen remote for an unknown-remote row naming this project', () => {
    const html = render({
      pending: [
        pending({
          kind: 'unknown_remote',
          project: SHOP,
          bindings: [SHOP],
          unseenRemotes: ['github.com/other/store'],
        }),
      ],
    });
    expect(html).toContain('seen at github.com/other/store, a remote shop has never seen');
    expect(html).toContain('>Trust remote</button>');
  });

  it('shows a conflict notice when a root .rembric selects another project', () => {
    const html = render({
      conflicts: [pending({ kind: 'suggestion', project: STORE, bindings: [SHOP] })],
    });
    expect(html).toContain('data-repository-conflict');
    expect(html).toContain('asks for store through its root .rembric');
  });

  it('validates a pasted fingerprint against the 40- or 64-character hexadecimal format', () => {
    const html = render({});
    const input = /<input[^>]*name="fingerprint"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('pattern="[0-9a-f]{40}|[0-9a-f]{64}"');
    expect(input).toContain('required');
    expect(html).toContain('40 or 64 lowercase hexadecimal characters');
  });

  it('offers no new binding on an archived project but keeps removal', () => {
    const html = render({ bound: [BOUND], pending: [pending({})] }, true);
    expect(html).toContain('>Disconnect</button>');
    expect(html).not.toContain('name="pendingId"');
    expect(html).not.toContain('pattern=');
    expect(html).toContain('An archived project accepts no new repository.');
  });
});

describe('the Repositories fields of the create surface', () => {
  it('lets the admin pick pending rows and paste a fingerprint', () => {
    const html = renderToStaticMarkup(<CreateRepositoryFields pending={[pending({})]} />);
    expect(html).toMatch(/<input type="checkbox"[^>]*name="pendingId"[^>]*value="p1"/);
    expect(html).toContain('github.com/acme/shop');
    const input = /<input[^>]*name="fingerprint"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('pattern="[0-9a-f]{40}|[0-9a-f]{64}"');
    expect(input).not.toContain('required');
  });
});

describe('the project sheets carry the Repositories section', () => {
  it('renders the section on the edit surface after the display-name form', () => {
    const html = renderToStaticMarkup(
      <RenameProjectSheet
        target={{
          id: SHOP.id,
          slug: SHOP.slug,
          label: 'Shop',
          displayName: 'Shop',
          archived: false,
          repositories: { bound: [BOUND], pending: [], conflicts: [] },
        }}
        open
        onOpenChange={() => {}}
        action={noop}
        csrf="rename"
        repositoryActions={ACTIONS}
        repositoryCsrf={CSRF}
      />,
    );
    expect(html).toContain('Edit project');
    expect(html).toContain('name="displayName"');
    expect(html.indexOf('name="displayName"')).toBeLessThan(html.indexOf('>Repositories</h3>'));
    expect(html).toContain('github.com/acme/shop');
  });

  it('keeps the rename form alone when no repository data is given', () => {
    const html = renderToStaticMarkup(
      <RenameProjectSheet
        target={{ id: SHOP.id, slug: SHOP.slug, label: 'Shop', displayName: null }}
        open
        onOpenChange={() => {}}
        action={noop}
        csrf="rename"
      />,
    );
    expect(html).toContain('name="displayName"');
    expect(html).not.toContain('>Repositories</h3>');
  });

  it('puts the repository fields inside the create form, in the same submission', () => {
    const html = renderToStaticMarkup(
      <CreateProjectSheet action={noop} csrf="create" pending={[pending({})]} />,
    );
    const createForm = html.split('<form')[1]!.split('</form>')[0]!;
    expect(createForm).toContain('name="slug"');
    expect(createForm).toMatch(/name="pendingId"[^>]*value="p1"/);
    expect(createForm).toMatch(/<input[^>]*name="fingerprint"/);
    expect(createForm).toContain('>Create project</button>');
  });
});
