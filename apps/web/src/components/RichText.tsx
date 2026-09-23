import React from 'react';

interface RichTextProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
}

// Convert common LaTeX math formulas into readable formatted HTML/math elements
function formatMathLatex(latex: string): string {
  let res = latex.trim();
  // Basic symbols
  res = res
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\pm/g, '±')
    .replace(/\\neq/g, '≠')
    .replace(/\\le/g, '≤')
    .replace(/\\ge/g, '≥')
    .replace(/\\approx/g, '≈')
    .replace(/\\infty/g, '∞')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\lambda/g, 'λ')
    .replace(/\\mu/g, 'μ')
    .replace(/\\pi/g, 'π')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\sum/g, '∑')
    .replace(/\\prod/g, '∏')
    .replace(/\\int/g, '∫')
    .replace(/\\sqrt\{([^}]+)\}/g, '√($1)')
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)');

  // Superscripts & Subscripts: x^{2} or x^2
  res = res.replace(/\^\{([^}]+)\}/g, '<sup>$1</sup>');
  res = res.replace(/\^([0-9a-zA-Z+-]+)/g, '<sup>$1</sup>');
  res = res.replace(/_\{([^}]+)\}/g, '<sub>$1</sub>');
  res = res.replace(/_([0-9a-zA-Z+-]+)/g, '<sub>$1</sub>');

  return res;
}

export const RichText: React.FC<RichTextProps> = ({ content, className = '', style }) => {
  if (!content) return null;

  // Split by math blocks $$ ... $$ and inline math $ ... $
  const renderFormatted = (text: string) => {
    // Escape HTML first to prevent XSS
    const escapeHtml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Handle display math $$ ... $$
    const parts = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);

    return parts.map((part, i) => {
      if (part.startsWith('$$') && part.endsWith('$$')) {
        const math = part.slice(2, -2);
        return (
          <div
            key={i}
            className="rich-math-block"
            style={{
              textAlign: 'center',
              margin: '12px 0',
              padding: '8px 12px',
              background: 'var(--bg-muted, #f8fafc)',
              borderRadius: '6px',
              fontFamily: 'serif',
              fontSize: '1.15em',
              fontStyle: 'italic',
            }}
            dangerouslySetInnerHTML={{ __html: formatMathLatex(escapeHtml(math)) }}
          />
        );
      }
      if (part.startsWith('$') && part.endsWith('$')) {
        const math = part.slice(1, -1);
        return (
          <span
            key={i}
            className="rich-math-inline"
            style={{
              fontFamily: 'serif',
              fontSize: '1.05em',
              fontStyle: 'italic',
              padding: '0 2px',
            }}
            dangerouslySetInnerHTML={{ __html: formatMathLatex(escapeHtml(math)) }}
          />
        );
      }

      // Handle simple markdown inline formatting: **bold**, *italic*, `code`, and newlines
      const lines = part.split('\n');
      return (
        <React.Fragment key={i}>
          {lines.map((line, lIdx) => {
            // Process markdown tokens
            let renderedLine = escapeHtml(line);
            renderedLine = renderedLine.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            renderedLine = renderedLine.replace(/\*(.*?)\*/g, '<em>$1</em>');
            renderedLine = renderedLine.replace(/`([^`]+)`/g, '<code>$1</code>');

            return (
              <React.Fragment key={lIdx}>
                {lIdx > 0 && <br />}
                <span dangerouslySetInnerHTML={{ __html: renderedLine }} />
              </React.Fragment>
            );
          })}
        </React.Fragment>
      );
    });
  };

  return (
    <div className={`rich-text-content ${className}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }}>
      {renderFormatted(content)}
    </div>
  );
};
