import { useId } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { LABEL } from './ui';

const IMAGE_EXPORT_CLASSES = [
  'detail-image-markdown relative mt-[38px] text-[34px] leading-[53px] text-[#d4d4d8]',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:mx-0 [&_:is(h1,h2,h3,h4,h5,h6)]:my-[24px] [&_:is(h1,h2,h3,h4,h5,h6)]:text-[#fafafa]',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:[font-family:var(--font-geist),sans-serif] [&_:is(h1,h2,h3,h4,h5,h6)]:text-[38px] [&_:is(h1,h2,h3,h4,h5,h6)]:leading-[53px] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:tracking-normal [&_:is(h1,h2,h3,h4,h5,h6)]:normal-case',
  '[&_:is(p,ul,ol,blockquote)]:m-0 [&_:is(p,ul,ol,blockquote)]:mb-[24px] [&_:is(p,ul,ol,blockquote)]:leading-[inherit] [&_li]:leading-[inherit]',
  '[&_:is(ul,ol)]:ml-0 [&_:is(ul,ol)]:pl-[32px] [&_li+li]:mt-[12px] [&_ul]:list-disc [&_ol]:list-decimal',
  '[&_strong]:text-[#fafafa] [&_strong]:font-semibold [&_a]:text-[#c6f24e] [&_a]:no-underline [&_a:hover]:no-underline',
  '[&_code]:border-0 [&_code]:rounded-[8px] [&_code]:px-[8px] [&_code]:py-[2px] [&_code]:text-[#fafafa] [&_code]:bg-[#18181b]',
  '[&_code]:[font-family:var(--font-geist-mono),monospace] [&_code]:text-[28px] [&_code]:leading-[1.6] [&_code]:font-normal [&_code]:whitespace-pre-wrap',
  '[&_pre]:m-0 [&_pre]:mb-[24px] [&_pre]:border-2 [&_pre]:border-[#1f1f23] [&_pre]:rounded-[20px] [&_pre]:p-[24px] [&_pre]:text-[#a1a1aa] [&_pre]:bg-[#101012]',
  '[&_pre]:[font-family:var(--font-geist-mono),monospace] [&_pre]:text-[26px] [&_pre]:leading-[42px] [&_pre]:font-normal [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:overflow-visible',
  '[&_pre_code]:block [&_pre_code]:border-0 [&_pre_code]:rounded-none [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_pre_code]:bg-transparent [&_pre_code]:[font:inherit]',
  '[&_blockquote]:pl-[24px] [&_blockquote]:border-l-2 [&_blockquote]:border-l-[#3f3f46] [&_.sr-only]:not-sr-only',
  '[&_hr]:mx-0 [&_hr]:my-[24px] [&_hr]:border-[#2a2a30]',
  '[&_.markdown-table]:mb-[24px] [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:mb-0 [&_table]:text-[28px] [&_table]:leading-[42px]',
  '[&_:is(th,td)]:border-2 [&_:is(th,td)]:border-[#2a2a30] [&_:is(th,td)]:p-[16px] [&_:is(th,td)]:align-top [&_th]:bg-[#101012] [&_th]:text-[#fafafa] [&_th]:font-semibold',
  '[&_input[type=checkbox]]:appearance-none [&_input[type=checkbox]]:inline-block [&_input[type=checkbox]]:size-[24px] [&_input[type=checkbox]]:border-2 [&_input[type=checkbox]]:border-[#71717a] [&_input[type=checkbox]]:rounded-[5px] [&_input[type=checkbox]]:align-middle',
  '[&_input[type=checkbox]:checked]:bg-[#c6f24e] [&_input[type=checkbox]:checked]:border-[#c6f24e]',
  '[&>:first-child]:mt-0 [&>div>:first-child]:mt-0 [&>:last-child]:mb-0 [&>div>:last-child]:mb-0',
].join(' ');

function rejectUnsupportedExport() {
  return function visit(node: { type: string; children?: Parameters<typeof visit>[0][] }): void {
    if (node.type === 'image' || node.type === 'imageReference' || node.type === 'html') {
      throw new Error(
        `Unsupported ${node.type === 'html' ? 'HTML' : 'image'} in image export. Remove it before exporting.`,
      );
    }
    node.children?.forEach(visit);
  };
}

function scopeFootnotes({ prefix }: { prefix: string }) {
  return function visit(node: {
    properties?: { id?: string; href?: string; ariaDescribedBy?: string[] };
    children?: Parameters<typeof visit>[0][];
  }): void {
    const props = node.properties;
    if (props?.id) props.id = `${prefix}-${props.id}`;
    if (props?.href?.startsWith('#user-content-fn')) {
      props.href = `#${prefix}-${props.href.slice(1)}`;
    }
    if (props?.ariaDescribedBy) {
      props.ariaDescribedBy = props.ariaDescribedBy.map((id) => `${prefix}-${id}`);
    }
    node.children?.forEach(visit);
  };
}

export function MarkdownContent({
  markdown,
  imageExport = false,
}: {
  markdown: string;
  imageExport?: boolean;
}) {
  const prefix = useId();
  return (
    <div
      className={
        imageExport
          ? IMAGE_EXPORT_CLASSES
          : 'markdown-content in-[.detail-ficha]:[&_h3]:font-sans in-[.detail-ficha]:[&_h3]:text-[20px] in-[.detail-ficha]:[&_h3]:leading-[1.4] in-[.detail-ficha]:[&_h3]:font-semibold in-[.detail-ficha]:[&_h3]:tracking-normal in-[.detail-ficha]:[&_h3]:text-foreground in-[.detail-ficha]:[&_h3]:normal-case in-[.detail-ficha]:[&>:first-child]:mt-0'
      }
    >
      <ReactMarkdown
        remarkPlugins={imageExport ? [remarkGfm, rejectUnsupportedExport] : [remarkGfm]}
        rehypePlugins={[[scopeFootnotes, { prefix }]]}
        components={MARKDOWN_COMPONENTS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function cellAlignment(align?: string): string {
  return align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h3 className="mb-3 text-lg font-medium tracking-[-.03em] text-foreground">{children}</h3>
  ),
  h2: ({ children, id, className }) => (
    <h3 id={id} className={`mt-5 mb-3 text-primary ${LABEL}${className ? ` ${className}` : ''}`}>
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mt-4 mb-2 text-sm font-medium text-foreground">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-3 leading-7 last:mb-0">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={`mb-3 ml-5 list-disc space-y-1${className ? ` ${className}` : ''}`}>
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="mb-3 ml-5 list-decimal space-y-1">
      {children}
    </ol>
  ),
  li: ({ children, className, id }) => (
    <li id={id} className={className ? `leading-6 ${className}` : 'leading-6'}>
      {children}
    </li>
  ),
  strong: ({ children }) => <strong className="font-medium text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href, node: _node, ...attributes }) => {
    return (
      <a
        {...attributes}
        href={href}
        className="text-primary underline-offset-4 hover:underline"
        rel="noreferrer noopener"
      >
        {children}
      </a>
    );
  },
  code: ({ children, className }) => (
    <code
      className={`rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[.8em] text-foreground${className ? ` ${className}` : ''}`}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      tabIndex={0}
      className="mb-3 overflow-x-auto rounded-xl border border-border bg-muted p-3 font-mono text-xs leading-5 [&>code]:rounded-none [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0"
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div
      tabIndex={0}
      role="region"
      aria-label="Markdown table"
      className="markdown-table mb-3 overflow-x-auto"
    >
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      className={`border border-border bg-muted px-3 py-2 font-medium ${cellAlignment(style?.textAlign)}`}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={`border border-border px-3 py-2 align-top ${cellAlignment(style?.textAlign)}`}>
      {children}
    </td>
  ),
  hr: () => <hr className="my-4 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-primary/30 pl-4 text-foreground">
      {children}
    </blockquote>
  ),
};
