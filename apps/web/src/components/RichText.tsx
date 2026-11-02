import React, { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import { renderRichHtml } from '../lib/latex';

interface RichTextProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Question text / options with LaTeX (KaTeX math, \textbf, lists, …) and the
 * Markdown shorthands **bold**, *italic*, `code`. Output is built from escaped
 * text, so it is safe to inject. See lib/latex.ts.
 */
export const RichText: React.FC<RichTextProps> = ({ content, className = '', style }) => {
  const html = useMemo(() => renderRichHtml(content ?? ''), [content]);
  if (!content) return null;
  return (
    <div
      className={`rich-text-content ${className}`}
      style={{ wordBreak: 'break-word', ...style }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
