import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Box from '@mui/material/Box';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { MermaidDiagram } from './Mermaid';

/** ```mermaid fenced blocks become diagrams; all other code stays code. */
const COMPONENTS: Components = {
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as ReactNode;
    if (isValidElement(child)) {
      const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
      if (/\blanguage-mermaid\b/.test(props.className ?? '')) return <MermaidDiagram code={String(props.children ?? '').trimEnd()} />;
    }
    return <pre>{children}</pre>;
  },
};

/** Safe Markdown rendering (no raw HTML) with GitHub-flavoured tables and Mermaid diagrams. */
export function Markdown({ children }: { children: string }) {
  return (
    <Box
      sx={{
        typography: 'body2',
        '& h1': { typography: 'h5', mt: 1, mb: 1.5 },
        '& h2': { typography: 'h6', mt: 2, mb: 1 },
        '& h3': { typography: 'subtitle1', fontWeight: 600, mt: 2, mb: 1 },
        '& p, & ul, & ol': { my: 1 },
        '& code': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '0.85em', bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 },
        '& pre': { bgcolor: 'action.hover', p: 1.5, borderRadius: 1, overflow: 'auto' },
        '& pre code': { bgcolor: 'transparent', p: 0 },
        '& table': { borderCollapse: 'collapse', my: 1.5, display: 'block', overflowX: 'auto' },
        '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left' },
        '& th': { bgcolor: 'action.hover' },
        '& blockquote': { borderLeft: 4, borderColor: 'divider', m: 0, pl: 2, color: 'text.secondary' },
        '& a': { color: 'primary.main' },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
