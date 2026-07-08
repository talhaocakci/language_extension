import React, { useCallback, useRef, useState } from 'react';
import type { PhraseItem } from '../types';
import { generateStory } from '../api';
import type { StoryResult } from '../api';

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'config' | 'playing' | 'evaluated';
type Mode  = 'quiz' | 'story';

interface TextSeg  { type: 'text';  text: string; }
interface BlankSeg { type: 'blank'; id: string; answer: string; }
type Segment = TextSeg | BlankSeg;

interface QuizBlank {
  id: string;
  answer: string;       // canonical_form to match
  hint: string;         // meaning as hint
  contextBefore: string;
  contextAfter: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

function pickRandom<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, Math.min(n, arr.length));
}

function buildQuizBlanks(phrases: PhraseItem[]): QuizBlank[] {
  return phrases.map((p, i) => {
    const sentence    = p.source_sentence || '';
    const targetWord  = p.found_in_text   || p.canonical_form;
    const idx         = sentence.indexOf(targetWord);

    let contextBefore = sentence;
    let contextAfter  = '';

    if (idx >= 0) {
      contextBefore = sentence.slice(0, idx);
      contextAfter  = sentence.slice(idx + targetWord.length);
    } else {
      // Fallback: show meaning and leave a naked blank
      contextBefore = '';
    }

    return {
      id: `q-${i}-${p.phrase_id}`,
      answer: p.canonical_form,
      hint: p.meaning,
      contextBefore,
      contextAfter,
    };
  });
}

function parseStory(text: string): Segment[] {
  const parts = text.split(/\[\[(.+?)\]\]/g);
  const out: Segment[] = [];
  let bi = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out.push({ type: 'text', text: parts[i] });
    } else {
      out.push({ type: 'blank', id: `sb-${bi++}`, answer: parts[i] });
    }
  }
  return out;
}

// ── Drag-drop helpers ─────────────────────────────────────────────────────────

type DragSource =
  | { from: 'bank'; word: string }
  | { from: 'blank'; blankId: string; word: string };

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  phrases: PhraseItem[];
  onClose: () => void;
}

const PracticeMode: React.FC<Props> = ({ phrases, onClose }) => {
  const [phase,   setPhase]   = useState<Phase>('config');
  const [mode,    setMode]    = useState<Mode | null>(null);
  const [count,   setCount]   = useState(Math.min(5, phrases.length));

  // Shared state for the active exercise
  const [wordBank,  setWordBank]   = useState<string[]>([]);      // canonical forms, shuffled
  const [placed,    setPlaced]     = useState<Record<string, string>>({}); // blankId→word
  const [quizItems, setQuizItems]  = useState<QuizBlank[]>([]);

  // Story-specific
  const [segments,    setSegments]    = useState<Segment[]>([]);
  const [translation, setTranslation] = useState('');
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError,   setStoryError]   = useState('');
  const [showTranslation, setShowTranslation] = useState(false);

  const dragRef = useRef<DragSource | null>(null);

  // ── Start handlers ────────────────────────────────────────────────────────

  const startQuiz = useCallback(() => {
    const sel = pickRandom(phrases, count);
    const blanks = buildQuizBlanks(sel);
    const bank = shuffle(sel.map(p => p.canonical_form));
    setQuizItems(blanks);
    setWordBank(bank);
    setPlaced({});
    setMode('quiz');
    setPhase('playing');
  }, [phrases, count]);

  const startStory = useCallback(async () => {
    const sel = pickRandom(phrases, count);
    setMode('story');
    setPhase('playing');
    setStoryLoading(true);
    setStoryError('');
    setSegments([]);
    setTranslation('');
    setPlaced({});
    setShowTranslation(false);

    try {
      const result: StoryResult = await generateStory(sel);
      const segs = parseStory(result.text);
      const bank  = shuffle(sel.map(p => p.canonical_form));

      // Guard: make sure every blank in the story is recognisable
      const blankAnswers = segs
        .filter((s): s is BlankSeg => s.type === 'blank')
        .map(s => s.answer);

      // If OpenAI used slightly different forms, still show the bank
      if (blankAnswers.length === 0) {
        throw new Error('No blanks found in generated story — try again.');
      }

      setSegments(segs);
      setTranslation(result.translation);
      setWordBank(bank);
    } catch (e: unknown) {
      setStoryError(e instanceof Error ? e.message : 'Story generation failed.');
    } finally {
      setStoryLoading(false);
    }
  }, [phrases, count]);

  const handleReset = useCallback(() => {
    setPhase('config');
    setMode(null);
    setPlaced({});
    setSegments([]);
    setWordBank([]);
    setQuizItems([]);
    setStoryError('');
    setShowTranslation(false);
  }, []);

  const handleTryAgain = useCallback(() => {
    setPlaced({});
    setPhase('playing');
  }, []);

  // ── Evaluate ──────────────────────────────────────────────────────────────

  const handleEvaluate = useCallback(() => setPhase('evaluated'), []);

  const allBlanks: BlankSeg[] = mode === 'story'
    ? segments.filter((s): s is BlankSeg => s.type === 'blank')
    : quizItems.map(q => ({ type: 'blank' as const, id: q.id, answer: q.answer }));

  const score = allBlanks.filter(
    b => (placed[b.id] ?? '').toLowerCase().trim() === b.answer.toLowerCase().trim()
  ).length;

  // ── Drag / drop ───────────────────────────────────────────────────────────

  const onDragStartBank = (word: string) => {
    dragRef.current = { from: 'bank', word };
  };

  const onDragStartBlank = (blankId: string, word: string) => {
    dragRef.current = { from: 'blank', blankId, word };
  };

  const onDropBlank = (targetBlankId: string) => {
    const src = dragRef.current;
    if (!src) return;

    setPlaced(prev => {
      const next = { ...prev };
      const displaced = next[targetBlankId]; // word that was already here (if any)

      // Place the dragged word
      next[targetBlankId] = src.word;

      // Clear the source blank if dragging blank→blank
      if (src.from === 'blank' && src.blankId !== targetBlankId) {
        if (displaced) {
          // Swap: put the displaced word in the source blank
          next[src.blankId] = displaced;
        } else {
          delete next[src.blankId];
        }
      }

      return next;
    });

    dragRef.current = null;
  };

  const onDropBank = () => {
    const src = dragRef.current;
    if (!src || src.from !== 'blank') { dragRef.current = null; return; }

    // Return word from blank to bank
    setPlaced(prev => {
      const next = { ...prev };
      delete next[src.blankId];
      return next;
    });
    dragRef.current = null;
  };

  const allowDrop = (e: React.DragEvent) => e.preventDefault();

  // ── Derived ───────────────────────────────────────────────────────────────

  const usedWords = new Set(Object.values(placed));
  const bankWords = wordBank.filter(w => !usedWords.has(w));

  // ── Renders ───────────────────────────────────────────────────────────────

  const renderBlankBox = (blankId: string, answer: string) => {
    const dropped = placed[blankId] ?? null;
    const isCorrect = dropped?.toLowerCase().trim() === answer.toLowerCase().trim();

    let bg = '#f8fafc';
    let border = '2px dashed #94a3b8';
    let color = '#0f172a';

    if (dropped) {
      bg = '#eef2ff';
      border = '2px solid #6366f1';
    }
    if (phase === 'evaluated') {
      if (dropped) {
        bg    = isCorrect ? '#dcfce7' : '#fee2e2';
        border = isCorrect ? '2px solid #16a34a' : '2px solid #dc2626';
        color  = isCorrect ? '#15803d' : '#b91c1c';
      } else {
        bg = '#fef9c3';
        border = '2px dashed #ca8a04';
      }
    }

    return (
      <span
        key={blankId}
        onDrop={() => onDropBlank(blankId)}
        onDragOver={allowDrop}
        draggable={!!dropped && phase !== 'evaluated'}
        onDragStart={() => dropped && onDragStartBlank(blankId, dropped)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          minWidth: Math.max(80, (answer.length + 2) * 10),
          height: 30,
          margin: '0 4px',
          padding: '2px 8px',
          background: bg,
          border,
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 600,
          color,
          cursor: dropped && phase !== 'evaluated' ? 'grab' : 'default',
          verticalAlign: 'middle',
          justifyContent: 'center',
          transition: 'background 0.2s',
        }}
        title={phase === 'evaluated' && !isCorrect && dropped ? `Correct: ${answer}` : ''}
      >
        {dropped
          ? (
            <>
              {dropped}
              {phase === 'evaluated' && !isCorrect && (
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: '#b91c1c' }}>
                  ({answer})
                </span>
              )}
            </>
          )
          : <span style={{ color: '#94a3b8', fontSize: 12 }}>drop here</span>
        }
      </span>
    );
  };

  const renderWordBank = () => (
    <div
      onDrop={onDropBank}
      onDragOver={allowDrop}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: '12px 16px',
        background: '#f1f5f9',
        borderRadius: 10,
        border: '2px dashed #cbd5e1',
        minHeight: 52,
        marginBottom: 20,
      }}
    >
      <div style={{ width: '100%', fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
        WORD BANK — drag to blanks
      </div>
      {bankWords.length === 0 && (
        <span style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>
          All words placed
        </span>
      )}
      {bankWords.map(word => (
        <span
          key={word}
          draggable={phase !== 'evaluated'}
          onDragStart={() => onDragStartBank(word)}
          style={{
            padding: '5px 14px',
            background: '#6366f1',
            color: '#fff',
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            cursor: phase !== 'evaluated' ? 'grab' : 'default',
            userSelect: 'none',
            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        >
          {word}
        </span>
      ))}
    </div>
  );

  const renderScoreBadge = () => (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 20px',
      background: score === allBlanks.length ? '#dcfce7' : '#fef9c3',
      border: `2px solid ${score === allBlanks.length ? '#16a34a' : '#ca8a04'}`,
      borderRadius: 10,
      marginBottom: 16,
    }}>
      <span style={{ fontSize: 22 }}>
        {score === allBlanks.length ? '🎉' : '📝'}
      </span>
      <span style={{ fontWeight: 700, fontSize: 16 }}>
        {score} / {allBlanks.length} correct
      </span>
    </div>
  );

  const renderControls = () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
      {phase === 'playing' && (
        <button style={s.btnPrimary} onClick={handleEvaluate}>
          ✓ Evaluate
        </button>
      )}
      {phase === 'evaluated' && (
        <>
          <button style={s.btnSecondary} onClick={handleTryAgain}>
            ↺ Try again
          </button>
          {mode === 'quiz' && (
            <button style={s.btnPrimary} onClick={startQuiz}>
              New quiz (same settings)
            </button>
          )}
        </>
      )}
      <button style={s.btnGhost} onClick={handleReset}>
        ← Back to menu
      </button>
    </div>
  );

  // ── Quiz render ───────────────────────────────────────────────────────────

  const renderQuiz = () => (
    <>
      <h3 style={s.sectionTitle}>Fill in the blanks — Quiz</h3>
      {renderWordBank()}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {quizItems.map(qi => (
          <div key={qi.id} style={s.quizCard}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
              <em>{qi.hint}</em>
            </div>
            <div style={{ fontSize: 15, lineHeight: 1.7 }}>
              {qi.contextBefore || qi.contextAfter
                ? (
                  <>
                    <span>{qi.contextBefore}</span>
                    {renderBlankBox(qi.id, qi.answer)}
                    <span>{qi.contextAfter}</span>
                  </>
                )
                : (
                  <>
                    <span style={{ color: '#94a3b8' }}>Context: </span>
                    {renderBlankBox(qi.id, qi.answer)}
                  </>
                )
              }
            </div>
          </div>
        ))}
      </div>
    </>
  );

  // ── Story render ──────────────────────────────────────────────────────────

  const renderStory = () => {
    if (storyLoading) {
      return (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>✍️</div>
          Generating your story with OpenAI…
        </div>
      );
    }

    if (storyError) {
      return (
        <div style={{ color: '#dc2626', background: '#fee2e2', padding: 14, borderRadius: 8 }}>
          <strong>Error:</strong> {storyError}
          <br />
          <button style={{ ...s.btnSecondary, marginTop: 10 }} onClick={() => void startStory()}>
            Retry
          </button>
        </div>
      );
    }

    return (
      <>
        <h3 style={s.sectionTitle}>Story / Dialogue</h3>
        {renderWordBank()}

        <div style={s.storyBox}>
          <p style={{ lineHeight: 2, fontSize: 15, margin: 0 }}>
            {segments.map((seg, i) =>
              seg.type === 'text'
                ? <span key={`t-${i}`}>{seg.text}</span>
                : renderBlankBox(seg.id, seg.answer)
            )}
          </p>
        </div>

        {translation && (
          <div style={{ marginTop: 12 }}>
            <button
              style={s.btnGhost}
              onClick={() => setShowTranslation(t => !t)}
            >
              {showTranslation ? 'Hide translation' : 'Show translation'}
            </button>
            {showTranslation && (
              <div style={s.translationBox}>{translation}</div>
            )}
          </div>
        )}
      </>
    );
  };

  // ── Config render ─────────────────────────────────────────────────────────

  const renderConfig = () => (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <h2 style={{ fontWeight: 800, fontSize: 22, margin: '0 0 6px', color: '#0f172a' }}>
        Practice
      </h2>
      <p style={{ color: '#64748b', marginBottom: 28, fontSize: 14 }}>
        Choose how many phrases to practice, then pick your exercise type.
      </p>

      {phrases.length === 0 ? (
        <p style={{ color: '#94a3b8' }}>
          No saved phrases yet — save some from the extension first.
        </p>
      ) : (
        <>
          <div style={s.countRow}>
            <label style={s.countLabel}>Number of phrases</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                min={1}
                max={phrases.length}
                value={count}
                onChange={e => setCount(Number(e.target.value))}
                style={{ width: 180, accentColor: '#6366f1' }}
              />
              <span style={s.countBadge}>{count}</span>
            </div>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>
              of {phrases.length} saved
              {count < phrases.length ? ' (randomly selected)' : ''}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap' }}>
            <button style={s.modeBtn} onClick={startQuiz}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>🧩</span>
              <strong>Quiz</strong>
              <p style={s.modeBtnSub}>
                Fill-in-the-blank using your saved sentences as context.
                Drag words from the word bank.
              </p>
            </button>

            <button style={s.modeBtn} onClick={() => void startStory()}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>📖</span>
              <strong>Story / Dialogue</strong>
              <p style={s.modeBtnSub}>
                OpenAI crafts a short German story that weaves in your phrases.
                Drag the words into the blanks.
              </p>
            </button>
          </div>
        </>
      )}

      <div style={{ marginTop: 24 }}>
        <button style={s.btnGhost} onClick={onClose}>
          ← Back to vocabulary list
        </button>
      </div>
    </div>
  );

  // ── Root render ───────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 0' }}>
      {phase === 'config' && renderConfig()}

      {phase !== 'config' && (
        <>
          {phase === 'evaluated' && (
            <div style={{ marginBottom: 16 }}>
              {renderScoreBadge()}
            </div>
          )}

          {mode === 'quiz'  && renderQuiz()}
          {mode === 'story' && renderStory()}

          {/* Controls */}
          {!(mode === 'story' && (storyLoading || storyError)) && renderControls()}
        </>
      )}
    </div>
  );
};

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  btnPrimary: {
    padding: '9px 22px',
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '9px 22px',
    background: '#f1f5f9',
    color: '#334155',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnGhost: {
    padding: '8px 16px',
    background: 'none',
    color: '#64748b',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
  },
  modeBtn: {
    flex: 1,
    minWidth: 200,
    padding: '22px 18px',
    background: '#fff',
    border: '2px solid #e2e8f0',
    borderRadius: 12,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    fontSize: 16,
  },
  modeBtnSub: {
    fontWeight: 400,
    fontSize: 13,
    color: '#64748b',
    marginTop: 6,
    marginBottom: 0,
    lineHeight: 1.5,
  },
  countRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '16px 18px',
    background: '#f8fafc',
    borderRadius: 10,
    border: '1px solid #e2e8f0',
  },
  countLabel: {
    fontWeight: 600,
    fontSize: 14,
    color: '#334155',
  },
  countBadge: {
    display: 'inline-block',
    minWidth: 36,
    padding: '3px 8px',
    background: '#6366f1',
    color: '#fff',
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 700,
    textAlign: 'center',
  },
  quizCard: {
    padding: '14px 18px',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  storyBox: {
    padding: '18px 22px',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  translationBox: {
    marginTop: 10,
    padding: '12px 16px',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    color: '#475569',
    fontSize: 14,
    lineHeight: 1.6,
  },
  sectionTitle: {
    fontWeight: 700,
    fontSize: 16,
    color: '#0f172a',
    marginBottom: 14,
    marginTop: 0,
  },
};

export default PracticeMode;
