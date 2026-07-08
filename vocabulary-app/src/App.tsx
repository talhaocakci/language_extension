import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getIdToken, redirectToLogin, handleCallback, clearTokens } from './auth';
import { fetchPhrases } from './api';
import PhraseCard from './components/PhraseCard';
import PracticeMode from './components/PracticeMode';
import AnkiImport from './components/AnkiImport';
import type { PhraseItem } from './types';

const ALL_KINDS = [
  { label: 'All',           value: '' },
  { label: 'Idioms',        value: 'idiom' },
  { label: 'Phrasal Verbs', value: 'phrasal_verb' },
  { label: 'Collocations',  value: 'collocation' },
  { label: 'Connectors',    value: 'connector' },
  { label: 'Comparisons',   value: 'comparison' },
];

const App: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [phrases, setPhrases] = useState<PhraseItem[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [activeKind, setActiveKind] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [ankiOpen, setAnkiOpen] = useState(false);

  const loadedKindRef = useRef('');

  // Handle OAuth callback or check existing session
  useEffect(() => {
    (async () => {
      if (window.location.pathname === '/callback' || window.location.search.includes('code=')) {
        const ok = await handleCallback();
        window.history.replaceState({}, '', '/');
        if (ok) { setAuthed(true); } else { setAuthed(false); }
      } else {
        setAuthed(!!getIdToken());
      }
      setReady(true);
    })();
  }, []);

  const loadPhrases = useCallback(async (kind: string, cursor: string | null, append: boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchPhrases({ kind: kind || undefined, cursor, limit: 50 });
      setPhrases(prev => append ? [...prev, ...data.phrases] : data.phrases);
      setNextCursor(data.next_cursor);
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load when auth ready or kind changes
  useEffect(() => {
    if (!authed) return;
    loadedKindRef.current = activeKind;
    setPhrases([]);
    setNextCursor(null);
    setSearchQ('');
    void loadPhrases(activeKind, null, false);
  }, [authed, activeKind, loadPhrases]);

  const handleLoadMore = () => {
    if (!nextCursor || loading) return;
    void loadPhrases(activeKind, nextCursor, true);
  };

  const handleDeleted = (phraseId: string) => {
    setPhrases(prev => prev.filter(p => p.phrase_id !== phraseId));
  };

  const displayed = searchQ.trim()
    ? phrases.filter(p => {
        const q = searchQ.toLowerCase();
        return (
          p.canonical_form.toLowerCase().includes(q) ||
          p.meaning.toLowerCase().includes(q) ||
          (p.example ?? []).some(ex => ex.toLowerCase().includes(q))
        );
      })
    : phrases;

  if (!ready) return null;

  if (!authed) {
    return (
      <div style={s.loginWrap}>
        <h1 style={s.appTitle}>My Vocabulary</h1>
        <p style={s.loginSub}>Sign in to view your saved idioms and phrases.</p>
        <button style={s.loginBtn} onClick={redirectToLogin}>Sign in</button>
      </div>
    );
  }

  return (
    <div style={s.root}>
      {/* Header */}
      <header style={s.header}>
        <span style={s.logo}>📖 My Vocabulary</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            style={{
              ...s.practiceBtn,
              ...(practiceOpen ? s.practiceBtnActive : {}),
            }}
            onClick={() => { setPracticeOpen(o => !o); setAnkiOpen(false); }}
          >
            🎓 Practice
          </button>
          <button
            style={{
              ...s.importBtn,
              ...(ankiOpen ? s.importBtnActive : {}),
            }}
            onClick={() => { setAnkiOpen(o => !o); setPracticeOpen(false); }}
          >
            📥 Import Anki
          </button>
          <button style={s.logoutBtn} onClick={() => { clearTokens(); setAuthed(false); }}>
            Sign out
          </button>
        </div>
      </header>

      {/* Practice mode overlay */}
      {practiceOpen && (
        <PracticeMode
          phrases={phrases}
          onClose={() => setPracticeOpen(false)}
        />
      )}

      {/* Anki import overlay */}
      {ankiOpen && (
        <AnkiImport onClose={() => setAnkiOpen(false)} />
      )}

      {!practiceOpen && !ankiOpen && (
        <>
          {/* Filter chips */}
          <div style={s.chips}>
            {ALL_KINDS.map(k => (
              <button
                key={k.value}
                style={{
                  ...s.chip,
                  ...(activeKind === k.value ? s.chipActive : {}),
                }}
                onClick={() => setActiveKind(k.value)}
              >
                {k.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={s.searchRow}>
            <input
              style={s.searchInput}
              type="search"
              placeholder="Search canonical form, meaning…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
            {phrases.length > 0 && (
              <span style={s.countLabel}>{displayed.length} / {phrases.length}</span>
            )}
          </div>

          {/* Error */}
          {loadError && <p style={s.error}>Error: {loadError}</p>}

          {/* Grid */}
          {displayed.length === 0 && !loading && !loadError && (
            <p style={s.empty}>
              {searchQ ? 'No matches for your search.' : 'No saved phrases yet — use ＋ in the extension panel.'}
            </p>
          )}

          <div style={s.grid}>
            {displayed.map(p => (
              <PhraseCard key={p.phrase_id} phrase={p} onDeleted={handleDeleted} />
            ))}
          </div>

          {/* Load more */}
          {nextCursor && !searchQ && (
            <div style={s.loadMoreRow}>
              <button style={s.loadMoreBtn} onClick={handleLoadMore} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}

          {loading && phrases.length === 0 && (
            <p style={s.empty}>Loading…</p>
          )}
        </>
      )}
    </div>
  );
};

// ── Inline styles ─────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    maxWidth: 960,
    margin: '0 auto',
    padding: '0 16px 60px',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 0 12px',
    borderBottom: '1px solid #e2e8f0',
    marginBottom: 20,
  },
  logo: { fontWeight: 700, fontSize: 20, color: '#0f172a' },
  logoutBtn: {
    background: 'none', border: '1px solid #cbd5e1',
    borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
    color: '#475569', fontSize: 13,
  },
  practiceBtn: {
    background: '#f0fdf4', border: '1px solid #86efac',
    borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
    color: '#15803d', fontSize: 13, fontWeight: 600,
  },
  practiceBtnActive: {
    background: '#6366f1', border: '1px solid #6366f1',
    color: '#fff',
  },
  importBtn: {
    background: '#fdf4ff', border: '1px solid #e9d5ff',
    borderRadius: 6, padding: '5px 14px', cursor: 'pointer',
    color: '#7e22ce', fontSize: 13, fontWeight: 600,
  },
  importBtnActive: {
    background: '#7e22ce', border: '1px solid #7e22ce',
    color: '#fff',
  },
  chips: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  chip: {
    background: '#f1f5f9', border: '1px solid #e2e8f0',
    borderRadius: 20, padding: '5px 14px',
    fontSize: 13, cursor: 'pointer', color: '#475569',
  },
  chipActive: {
    background: '#6366f1', border: '1px solid #6366f1',
    color: '#fff',
  },
  searchRow: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
  },
  searchInput: {
    flex: 1, padding: '9px 14px', fontSize: 14,
    border: '1px solid #cbd5e1', borderRadius: 8, outline: 'none',
  },
  countLabel: { fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 14,
  },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 60, fontSize: 15 },
  error: { color: '#dc2626', marginBottom: 12, fontSize: 14 },
  loadMoreRow: { display: 'flex', justifyContent: 'center', marginTop: 28 },
  loadMoreBtn: {
    padding: '9px 28px', background: '#6366f1', color: '#fff',
    border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer',
  },
  loginWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100vh', gap: 16,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  appTitle: { fontWeight: 700, fontSize: 28, color: '#0f172a', margin: 0 },
  loginSub: { color: '#64748b', margin: 0 },
  loginBtn: {
    padding: '12px 32px', background: '#6366f1', color: '#fff',
    border: 'none', borderRadius: 8, fontSize: 15, cursor: 'pointer',
  },
};

export default App;
