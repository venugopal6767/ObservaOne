// "Ask in plain English" bar: sends the question to the Explorer, which turns it into a chart.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { QUICK_QUESTIONS } from '@/lib/ask';

export function AskBar({ compact = false, initial = '', onAsk }: { compact?: boolean; initial?: string; onAsk?: (q: string) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const ask = (q: string) => {
    const v = q.trim();
    if (!v) return;
    if (onAsk) onAsk(v); else navigate(`/metrics/explore?ask=${encodeURIComponent(v)}`);
  };
  return (
    <section className={`ask-bar ${compact ? 'compact' : ''}`} aria-label="Ask a question">
      <form className="ask-row" onSubmit={(e) => { e.preventDefault(); ask(text); }}>
        <Sparkles size={17} className="ask-ic" aria-hidden />
        <label htmlFor="ask-input" className="sr-only">Ask about your metrics in plain English</label>
        <input id="ask-input" value={text} onChange={(e) => setText(e.target.value)} placeholder='Ask in plain English, e.g. "Show CPU usage of windows servers" or "disk space less than 20%"' autoComplete="off" />
        <button type="submit" className="btn btn-primary">Ask</button>
      </form>
      {!compact && (
        <div className="ask-chips">
          <span className="dim">Try:</span>
          {QUICK_QUESTIONS.map((q) => <button key={q} type="button" className="ask-chip" onClick={() => { setText(q); ask(q); }}>{q}</button>)}
        </div>
      )}
    </section>
  );
}
