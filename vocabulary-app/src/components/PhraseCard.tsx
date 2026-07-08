import React, { useState } from 'react';
import type { PhraseItem } from '../types';
import { deletePhrase } from '../api';

interface Props {
  phrase: PhraseItem;
  onDeleted: (phraseId: string) => void;
}

const LANG_LABELS: Record<string, string> = {
  de: '🇩🇪 DE',
  en: '🇬🇧 EN',
  fr: '🇫🇷 FR',
  es: '🇪🇸 ES',
  it: '🇮🇹 IT',
  nl: '🇳🇱 NL',
  tr: '🇹🇷 TR',
  pt: '🇵🇹 PT',
  ru: '🇷🇺 RU',
  ja: '🇯🇵 JA',
  zh: '🇨🇳 ZH',
  ko: '🇰🇷 KO',
  ar: '🇸🇦 AR',
  pl: '🇵🇱 PL',
  sv: '🇸🇪 SV',
};

const KIND_COLORS: Record<string, { bg: string; text: string }> = {
  idiom:        { bg: '#fef3c7', text: '#92400e' },
  phrasal_verb: { bg: '#dbeafe', text: '#1e40af' },
  collocation:  { bg: '#f3e8ff', text: '#6b21a8' },
  connector:    { bg: '#dcfce7', text: '#14532d' },
  comparison:   { bg: '#fce7f3', text: '#9d174d' },
};

function kindStyle(kind: string) {
  return KIND_COLORS[kind.toLowerCase()] ?? { bg: '#e5e7eb', text: '#374151' };
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch {
    return iso;
  }
}

const PhraseCard: React.FC<Props> = ({ phrase, onDeleted }) => {
  const [deleting, setDeleting] = useState(false);
  const kStyle = kindStyle(phrase.kind);

  const handleDelete = async () => {
    if (!confirm(`Remove "${phrase.canonical_form}" from your vocabulary?`)) return;
    setDeleting(true);
    try {
      await deletePhrase(phrase.phrase_id);
      onDeleted(phrase.phrase_id);
    } catch (e) {
      alert(`Could not delete: ${e}`);
      setDeleting(false);
    }
  };

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>
          {phrase.canonical_form}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          background: kStyle.bg, color: kStyle.text,
          borderRadius: 4, padding: '2px 7px',
        }}>
          {phrase.kind.replace('_', ' ')}
        </span>
        {phrase.language && (
          <span style={{
            fontSize: 11, fontWeight: 600,
            background: '#f0f9ff', color: '#0369a1',
            borderRadius: 4, padding: '2px 6px',
            border: '1px solid #bae6fd',
          }}>
            {LANG_LABELS[phrase.language.toLowerCase()] ?? phrase.language.toUpperCase()}
          </span>
        )}
        <button
          title="Remove from vocabulary"
          onClick={handleDelete}
          disabled={deleting}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            cursor: deleting ? 'default' : 'pointer',
            color: '#94a3b8',
            fontSize: 17,
            padding: 4,
            lineHeight: 1,
          }}
        >
          {deleting ? '…' : '🗑'}
        </button>
      </div>

      {/* Found in text */}
      <div style={{ fontSize: 13, color: '#64748b', fontStyle: 'italic' }}>
        „{phrase.found_in_text}"
      </div>

      {/* Meaning */}
      <div style={{ fontSize: 14, color: '#1e293b' }}>{phrase.meaning}</div>

      {/* Examples */}
      {phrase.example && phrase.example.length > 0 && (
        <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12, color: '#64748b' }}>
          {phrase.example.map((ex, i) => <li key={i}>{ex}</li>)}
        </ul>
      )}

      {/* Audio */}
      {phrase.audio && (
        <audio
          src={phrase.audio}
          controls
          style={{ width: '100%', height: 32, marginTop: 4 }}
        />
      )}

      {/* Source */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        <a
          href={phrase.source_url}
          target="_blank"
          rel="noreferrer"
          title={phrase.video_title}
          style={{ fontSize: 11, color: '#6366f1', textDecoration: 'none', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          ▶ {phrase.video_title}
        </a>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
          {formatDate(phrase.saved_at)}
        </span>
      </div>
    </div>
  );
};

export default PhraseCard;
