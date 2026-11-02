import { useId, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { parseLatexQuestion, type ParsedLatexQuestion } from '../lib/latex';
import { RichText } from './RichText';
import { Button } from './ui/button';

/**
 * "Paste LaTeX": paste one question from a .tex file (\item … \begin{enumerate}
 * \item … \end{enumerate}, or the exam class's \question/\choice/\CorrectChoice)
 * and fill the form's question text and options from it.
 */
export function LatexPaste({ onParsed }: { onParsed: (q: ParsedLatexQuestion) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const parsed = parseLatexQuestion(src);
    if (!parsed || !parsed.text) {
      setError('Could not find a question in that LaTeX. Paste one \\item with its options list.');
      return;
    }
    onParsed(parsed);
    setOpen(false);
    setSrc('');
    setError(null);
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <FileCode2 className="size-4" aria-hidden="true" /> Paste LaTeX question
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card p-3">
      <label htmlFor={id} className="text-sm font-medium">
        Paste a LaTeX question
      </label>
      <p className="text-xs text-muted-foreground">
        One <code>\item</code> with a <code>\begin&#123;enumerate&#125;</code> list of options. Mark the right option with{' '}
        <code>\correct</code>, a <code>% correct</code> comment, or <code>\CorrectChoice</code> (exam class) to tick it
        automatically.
      </p>
      <textarea
        id={id}
        rows={7}
        value={src}
        onChange={(e) => setSrc(e.target.value)}
        className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-background p-2 font-mono text-xs"
        placeholder={'\\item Which page replacement algorithm suffers from \\textbf{Belady\'s Anomaly}?\n\\begin{enumerate}[label=(\\alph*)]\n    \\item LRU\n    \\item Optimal\n    \\item FIFO \\correct\n    \\item LFU\n\\end{enumerate}'}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={apply} disabled={!src.trim()}>
          Fill question from LaTeX
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Rendered preview of question text, readable in light, dark and high-contrast themes. */
export function RichPreview({ content, label = 'Preview' }: { content: string; label?: string }) {
  if (!content.trim()) return null;
  return (
    <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-foreground shadow-sm">
      <span className="mb-1 block font-mono text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-foreground/75">
        {label}
      </span>
      <RichText content={content} />
    </div>
  );
}
