import React, { useCallback, useRef, useState } from 'react';
import JSZip from 'jszip';
import { savePhrase } from '../api';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'mapping' | 'preview';

interface ParsedNote {
  /** raw fields in deck order */
  fields: string[];
  tags: string;
  /** index inside `media` map → object URL (if audio found in that field) */
  audioUrl: string | null;
}

interface ParseResult {
  fieldNames: string[];
  notes: ParsedNote[];
  /** true when at least one note had a [sound:…] reference */
  hasAudio: boolean;
}

interface FieldMapping {
  item_key: number | null;           // field containing "WORD|streiten|de" / "PHRASE|…|de"
  canonical_form: number | null;
  word_translation: number | null;   // meaning for WORD items
  phrase_transliteration: number | null; // meaning for PHRASE items
  meaning: number | null;            // fallback meaning when no item_key
  example: number | null;
  audio: number | null;
}

type RowStatus = 'idle' | 'saving' | 'saved' | 'duplicate' | 'error';

interface PreviewRow {
  id: number;
  canonical_form: string;
  meaning: string;
  examples: string[];
  audioUrl: string | null;
  kind: string;
  language: string;
  checked: boolean;
  status: RowStatus;
  errorMsg?: string;
}

const ALL_KINDS = [
  { value: 'word',         label: 'Word' },
  { value: 'phrase',       label: 'Phrase' },
  { value: 'idiom',        label: 'Idiom' },
  { value: 'phrasal_verb', label: 'Phrasal Verb' },
  { value: 'collocation',  label: 'Collocation' },
  { value: 'connector',    label: 'Connector' },
  { value: 'comparison',   label: 'Comparison' },
  { value: 'other',        label: 'Other' },
];

const ALL_LANGUAGES = [
  { value: 'de', label: '🇩🇪 German (Deutsch)' },
  { value: 'en', label: '🇬🇧 English' },
  { value: 'fr', label: '🇫🇷 French (Français)' },
  { value: 'es', label: '🇪🇸 Spanish (Español)' },
  { value: 'it', label: '🇮🇹 Italian (Italiano)' },
  { value: 'nl', label: '🇳🇱 Dutch (Nederlands)' },
  { value: 'tr', label: '🇹🇷 Turkish (Türkçe)' },
  { value: 'pt', label: '🇵🇹 Portuguese' },
  { value: 'ru', label: '🇷🇺 Russian (Русский)' },
  { value: 'ja', label: '🇯🇵 Japanese (日本語)' },
  { value: 'zh', label: '🇨🇳 Chinese (中文)' },
  { value: 'ko', label: '🇰🇷 Korean (한국어)' },
  { value: 'ar', label: '🇸🇦 Arabic (العربية)' },
  { value: 'pl', label: '🇵🇱 Polish (Polski)' },
  { value: 'sv', label: '🇸🇪 Swedish (Svenska)' },
];

const FIELD_SEP = '\x1f'; // Anki uses ASCII unit separator between fields

// Convert a blob URL to a base64 data URL so it can be persisted in DynamoDB
async function blobUrlToDataUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Strip [sound:…] and HTML tags from a field value for display
function cleanFieldText(val: string): string {
  return val
    .replace(/\[sound:[^\]]+\]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// Extract sound filename from a field value, e.g. "[sound:word.mp3]" → "word.mp3"
function extractSoundFilename(val: string): string | null {
  const m = /\[sound:([^\]]+)\]/.exec(val);
  return m ? m[1] : null;
}

// ── Anki parsing ──────────────────────────────────────────────────────────────

async function parseApkg(file: File): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(file);

  // Find the SQLite collection (prefer .anki21, fallback .anki2)
  const dbEntry =
    zip.file('collection.anki21') ??
    zip.file('collection.anki2') ??
    zip.file(/collection\.anki2?1?$/)[0];

  if (!dbEntry) throw new Error('No collection database found inside the .apkg file.');

  const dbBuffer = await dbEntry.async('arraybuffer');

  // Load sql.js (WASM from CDN to avoid bundler complexity)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs = (await import('sql.js')).default as any;
  const SQL = await initSqlJs({
    locateFile: () => 'https://sql.js.org/dist/sql-wasm.wasm',
  });
  const db = new SQL.Database(new Uint8Array(dbBuffer));

  // ── Resolve field names ───────────────────────────────────────────────────

  let fieldNames: string[] = [];

  // Try modern schema (Anki 2.1.28+): table "notetypes" + "fields"
  try {
    const tablesResult = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='fields'"
    );
    if (tablesResult.length > 0 && tablesResult[0].values.length > 0) {
      const fieldsResult = db.exec('SELECT name FROM fields ORDER BY ord');
      if (fieldsResult.length > 0) {
        fieldNames = (fieldsResult[0].values as string[][]).map(r => r[0]);
      }
    }
  } catch {
    // fall through to legacy
  }

  // Legacy schema: field names are in col.models JSON
  if (fieldNames.length === 0) {
    try {
      const colResult = db.exec('SELECT models FROM col LIMIT 1');
      if (colResult.length > 0 && colResult[0].values[0][0]) {
        const models = JSON.parse(colResult[0].values[0][0] as string) as Record<
          string,
          { flds: Array<{ name: string }> }
        >;
        const firstModel = Object.values(models)[0];
        if (firstModel?.flds) {
          fieldNames = firstModel.flds.map(f => f.name);
        }
      }
    } catch {
      // ignore
    }
  }

  // Last resort: generic names
  if (fieldNames.length === 0) fieldNames = ['Field 1', 'Field 2', 'Field 3'];

  // ── Read notes ────────────────────────────────────────────────────────────

  const notesResult = db.exec('SELECT flds, tags FROM notes');
  db.close();

  const rawNotes: Array<{ flds: string; tags: string }> =
    notesResult.length > 0
      ? (notesResult[0].values as string[][]).map(r => ({ flds: r[0], tags: r[1] }))
      : [];

  // ── Extract media map ─────────────────────────────────────────────────────

  const mediaEntry = zip.file('media');
  let mediaMap: Record<string, string> = {};
  if (mediaEntry) {
    try {
      mediaMap = JSON.parse(await mediaEntry.async('text')) as Record<string, string>;
    } catch {
      // ignore corrupt media map
    }
  }

  // Build reverse map: filename → object URL
  const filenameToUrl: Record<string, string> = {};
  for (const [idx, filename] of Object.entries(mediaMap)) {
    const entry = zip.file(idx);
    if (entry) {
      const blob = await entry.async('blob');
      filenameToUrl[filename] = URL.createObjectURL(blob);
    }
  }

  // ── Build parsed notes ────────────────────────────────────────────────────

  let hasAudio = false;
  const notes: ParsedNote[] = rawNotes.map(raw => {
    const fields = raw.flds.split(FIELD_SEP);
    // Ensure we always have at least fieldNames.length slots
    while (fields.length < fieldNames.length) fields.push('');

    // Find audio in any field
    let audioUrl: string | null = null;
    for (const f of fields) {
      const fname = extractSoundFilename(f);
      if (fname && filenameToUrl[fname]) {
        audioUrl = filenameToUrl[fname];
        hasAudio = true;
        break;
      }
    }

    return { fields, tags: (raw.tags ?? '').trim(), audioUrl };
  });

  return { fieldNames, notes, hasAudio };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

const AnkiImport: React.FC<Props> = ({ onClose }) => {
  const [step, setStep] = useState<Step>('upload');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({
    item_key: null,
    canonical_form: null,
    word_translation: null,
    phrase_transliteration: null,
    meaning: null,
    example: null,
    audio: null,
  });
  const [defaultKind, setDefaultKind] = useState('other');
  const [defaultLanguage, setDefaultLanguage] = useState('de');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File handling ────────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.apkg')) {
      setParseError('Please select a valid .apkg file.');
      return;
    }
    setParsing(true);
    setParseError('');
    try {
      const result = await parseApkg(file);
      setParseResult(result);

      // Auto-map common field names
      const names = result.fieldNames.map(n => n.toLowerCase());
      const guess = (candidates: string[]) => {
        for (const c of candidates) {
          const i = names.findIndex(n => n.includes(c));
          if (i >= 0) return i;
        }
        return null;
      };

      // Detect item_key field by scanning the first few note values for WORD|…|… / PHRASE|…|…
      const ITEM_KEY_RE = /^(WORD|PHRASE)\|/i;
      let detectedItemKey: number | null = null;
      const sampleNotes = result.notes.slice(0, 10);
      outer: for (let col = 0; col < result.fieldNames.length; col++) {
        for (const note of sampleNotes) {
          if (ITEM_KEY_RE.test(cleanFieldText(note.fields[col] ?? ''))) {
            detectedItemKey = col;
            break outer;
          }
        }
      }

      // Resolve canonical_form first so meaning can share the same index as fallback
      const cfIdx = guess(['subtitle', 'context', 'front', 'word', 'german', 'deutsch', 'term', 'expression', 'vocab']) ?? 0;

      setMapping({
        item_key: detectedItemKey,
        canonical_form: cfIdx,
        // 'translation' field → used as meaning for PHRASE cards
        word_translation:       guess(['translation', 'word translation', 'word_translation', 'wordtranslation', 'word meaning']),
        // 'transliteration' field → used as meaning for WORD cards
        phrase_transliteration: guess(['transliteration', 'phrase translation', 'romanization', 'romaji', 'pinyin']),
        // always pre-select a meaning fallback field; used for cards that have no item_key
        // defaults to the same field as canonical_form when no named match is found
        meaning: guess(['subtitle', 'back', 'meaning', 'english', 'definition', 'answer']) ?? cfIdx,
        example:                guess(['example', 'sentence', 'usage', 'beispiel', 'satz']),
        audio:                  result.hasAudio ? guess(['audio', 'sound', 'pronunciation', 'aussprache']) : null,
      });

      setStep('mapping');
    } catch (e: unknown) {
      setParseError(e instanceof Error ? e.message : 'Failed to parse file.');
    } finally {
      setParsing(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  // ── Mapping → Preview ────────────────────────────────────────────────────

  const handleBuildPreview = useCallback(() => {
    if (!parseResult) return;
    const { notes } = parseResult;

    const fieldOf = (note: ParsedNote, idx: number | null): string =>
      idx !== null && idx < note.fields.length
        ? cleanFieldText(note.fields[idx])
        : '';

    const built: PreviewRow[] = notes
      .map((note, i) => {
        // Parse the item_key field if mapped: "WORD|streiten|de" or "PHRASE|...|de"
        let canonical_form = fieldOf(note, mapping.canonical_form);
        let kind           = defaultKind;
        let language       = defaultLanguage;

        if (mapping.item_key !== null) {
          const raw   = cleanFieldText(note.fields[mapping.item_key] ?? '');
          const parts = raw.split('|');
          const prefix = parts[0]?.toUpperCase();

          if (prefix === 'WORD') {
            // WORD|streiten|de → canonical_form from 2nd segment, language from 3rd
            // The subtitle field (canonical_form mapping) becomes the example sentence
            canonical_form = parts[1]?.trim() || canonical_form;
            language       = parts[2]?.trim() || language;
            kind           = 'word';
          } else if (prefix === 'PHRASE') {
            // PHRASE|de|… → language is 2nd segment, canonical_form from subtitle field, no example
            language = parts[1]?.trim() || language;
            kind     = 'phrase';
            // canonical_form stays as the mapped subtitle/context field
          }
        }

        // Meaning: per-type fields when item_key is active
        let meaning: string;
        // Example: for WORD = subtitle field; for PHRASE = none; fallback = example field
        let example: string;

        if (mapping.item_key !== null) {
          const prefix = cleanFieldText(note.fields[mapping.item_key] ?? '').split('|')[0]?.toUpperCase();
          if (prefix === 'WORD') {
            // WORD: meaning = transliteration field; fallback = word_translation
            meaning  = fieldOf(note, mapping.phrase_transliteration) || fieldOf(note, mapping.word_translation);
            example  = fieldOf(note, mapping.canonical_form); // subtitle = example sentence
          } else {
            // PHRASE: meaning = translation field; fallback = phrase_transliteration
            meaning  = fieldOf(note, mapping.word_translation) || fieldOf(note, mapping.phrase_transliteration);
            example  = ''; // phrases don't need an example
          }
        } else {
          meaning  = fieldOf(note, mapping.meaning);
          example  = fieldOf(note, mapping.example);
        }

        const examples = example ? [example] : [];

        return {
          id: i,
          canonical_form,
          meaning,
          examples,
          audioUrl: note.audioUrl,
          kind,
          language,
          checked:  true,
          status:   'idle' as RowStatus,
        };
      })
      .filter(r => r.canonical_form.length > 0);

    setRows(built);
    setStep('preview');
  }, [parseResult, mapping, defaultKind, defaultLanguage]);

  // ── Select all/none ──────────────────────────────────────────────────────

  const checkedCount = rows.filter(r => r.checked).length;
  const allChecked   = checkedCount === rows.length && rows.length > 0;

  const toggleAll = () =>
    setRows(prev => prev.map(r => ({ ...r, checked: !allChecked })));

  const toggleRow = (id: number) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, checked: !r.checked } : r));

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    const toSave = rows.filter(r => r.checked && r.status === 'idle');
    if (toSave.length === 0) return;
    setSaving(true);
    setSaveProgress(0);

    for (let i = 0; i < toSave.length; i++) {
      const row = toSave[i];
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: 'saving' } : r));
      try {
        const audioDataUrl = row.audioUrl
          ? await blobUrlToDataUrl(row.audioUrl)
          : undefined;
        const result = await savePhrase({
          canonical_form: row.canonical_form,
          kind:           row.kind,
          meaning:        row.meaning,
          example:        row.examples.length > 0 ? row.examples : undefined,
          language:       row.language,
          audio:          audioDataUrl,
          source_url:     '',
          video_title:    'Anki import',
        });
        setRows(prev =>
          prev.map(r =>
            r.id === row.id
              ? { ...r, status: result.already_exists ? 'duplicate' : 'saved' }
              : r
          )
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Error';
        setRows(prev => prev.map(r => r.id === row.id ? { ...r, status: 'error', errorMsg: msg } : r));
      }
      setSaveProgress(i + 1);
    }

    setSaving(false);
  }, [rows, defaultKind]);

  // ── Render helpers ────────────────────────────────────────────────────────

  const fieldSelect = (
    label: string,
    key: keyof FieldMapping,
    required: boolean,
  ) => {
    const names = parseResult?.fieldNames ?? [];
    return (
      <div style={s.mapRow}>
        <label style={s.mapLabel}>
          {label}
          {required && <span style={{ color: '#dc2626' }}> *</span>}
        </label>
        <select
          style={s.select}
          value={mapping[key] ?? ''}
          onChange={e =>
            setMapping(prev => ({
              ...prev,
              [key]: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        >
          <option value="">— none —</option>
          {names.map((n, i) => (
            <option key={i} value={i}>{n}</option>
          ))}
        </select>
      </div>
    );
  };

  const statusIcon = (status: RowStatus) => {
    if (status === 'saving')    return <span style={{ color: '#6366f1' }}>⟳</span>;
    if (status === 'saved')     return <span style={{ color: '#16a34a' }}>✓</span>;
    if (status === 'duplicate') return <span style={{ color: '#d97706' }} title="Already in vocabulary">≈</span>;
    if (status === 'error')     return <span style={{ color: '#dc2626' }}>✗</span>;
    return null;
  };

  // ── Step renders ──────────────────────────────────────────────────────────

  const renderUpload = () => (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
      <h2 style={s.title}>Import from Anki</h2>
      <p style={s.subtitle}>
        Upload an <code>.apkg</code> file exported from Anki. Your cards will be
        parsed entirely in the browser — nothing is uploaded except the final save.
      </p>

      <div
        style={{
          ...s.dropZone,
          ...(dragOver ? s.dropZoneActive : {}),
        }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        {parsing ? (
          <div style={{ textAlign: 'center', color: '#6366f1' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>⏳</div>
            Parsing Anki file…
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>📦</div>
            <strong>Drop your .apkg file here</strong>
            <p style={{ margin: '6px 0 0', fontSize: 13 }}>or click to browse</p>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".apkg"
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />

      {parseError && (
        <p style={{ color: '#dc2626', marginTop: 12, fontSize: 14 }}>{parseError}</p>
      )}

      <div style={{ marginTop: 20 }}>
        <button style={s.btnGhost} onClick={onClose}>← Back to vocabulary</button>
      </div>
    </div>
  );

  const renderMapping = () => {
    const canAdvance = mapping.canonical_form !== null && mapping.meaning !== null;
    const fieldNames  = parseResult?.fieldNames ?? [];
    const allNotes    = parseResult?.notes ?? [];
    const PREVIEW_LIMIT = 200;
    const visibleNotes  = allNotes.slice(0, PREVIEW_LIMIT);

    return (
      <div style={{ maxWidth: '100%', margin: '0 auto' }}>
        <h2 style={s.title}>Map Fields</h2>
        <p style={s.subtitle}>
          {allNotes.length} notes found.
          Scroll through the raw data below to identify which column is which,
          then set the mappings underneath.
        </p>

        {/* ── Full raw-data table ────────────────────────────────────── */}
        {allNotes.length > 0 && (
          <div style={{
            marginBottom: 24,
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            overflow: 'hidden',
          }}>
            <div style={{
              background: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 700,
              color: '#475569',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>All fields — raw card data</span>
              {allNotes.length > PREVIEW_LIMIT && (
                <span style={{ fontWeight: 400, color: '#94a3b8' }}>
                  showing first {PREVIEW_LIMIT} of {allNotes.length}
                </span>
              )}
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap', width: '100%' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr>
                    <th style={s.rawTh}>#</th>
                    {fieldNames.map((name, i) => (
                      <th key={i} style={s.rawTh}>{name}</th>
                    ))}
                    <th style={s.rawTh}>audio</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleNotes.map((note, rowIdx) => (
                    <tr key={rowIdx} style={{ background: rowIdx % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...s.rawTd, color: '#94a3b8', minWidth: 32 }}>{rowIdx + 1}</td>
                      {fieldNames.map((_, colIdx) => {
                        const raw   = note.fields[colIdx] ?? '';
                        const clean = cleanFieldText(raw);
                        return (
                          <td key={colIdx} style={{ ...s.rawTd, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {clean || <em style={{ color: '#cbd5e1' }}>—</em>}
                          </td>
                        );
                      })}
                      <td style={{ ...s.rawTd, textAlign: 'center' }}>
                        {note.audioUrl
                          ? <audio src={note.audioUrl} controls style={{ height: 22, width: 120 }} />
                          : <span style={{ color: '#cbd5e1' }}>—</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={s.mapCard}>
          {/* Item key auto-detects WORD|…|lang and PHRASE|…|lang patterns */}
          <div style={{ ...s.mapRow, paddingBottom: 14, borderBottom: '1px solid #e2e8f0', marginBottom: 2 }}>
            <label style={s.mapLabel}>
              Item Key field
              <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>
                (e.g. field containing <code style={{ fontSize: 11 }}>WORD|streiten|de</code>)
              </span>
            </label>
            <select
              style={s.select}
              value={mapping.item_key ?? ''}
              onChange={e =>
                setMapping(prev => ({
                  ...prev,
                  item_key: e.target.value === '' ? null : Number(e.target.value),
                }))
              }
            >
              <option value="">— not present in this deck —</option>
              {(parseResult?.fieldNames ?? []).map((n, i) => (
                <option key={i} value={i}>{n}</option>
              ))}
            </select>
            {mapping.item_key !== null && (
              <div style={{ fontSize: 12, color: '#16a34a', marginTop: 4 }}>
                ✓ Kind and language will be extracted automatically per card.
                &nbsp;WORD cards use the 2nd segment as canonical form; PHRASE cards use the field below.
              </div>
            )}
          </div>

          {fieldSelect('Word / Idiom — subtitle field (PHRASE canonical form + WORD example)', 'canonical_form', true)}
          {fieldSelect('Word Translation — meaning for WORD cards', 'word_translation', false)}
          {fieldSelect('Phrase Transliteration — meaning for PHRASE cards', 'phrase_transliteration', false)}
          {fieldSelect('Meaning (fallback when no item key)', 'meaning', false)}
          {fieldSelect('Example sentence', 'example', false)}
          {parseResult?.hasAudio && fieldSelect('Audio field', 'audio', false)}

          <div style={s.mapRow}>
            <label style={s.mapLabel}>Language of the word / idiom column</label>
            <select
              style={s.select}
              value={defaultLanguage}
              onChange={e => setDefaultLanguage(e.target.value)}
            >
              {ALL_LANGUAGES.map(l => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
              The language your words/idioms are written in
            </span>
          </div>

          <div style={s.mapRow}>
            <label style={s.mapLabel}>Category (kind)</label>
            <select
              style={s.select}
              value={defaultKind}
              onChange={e => setDefaultKind(e.target.value)}
            >
              {ALL_KINDS.map(k => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
              Applied to all imported cards
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button
            style={canAdvance ? s.btnPrimary : { ...s.btnPrimary, opacity: 0.5, cursor: 'not-allowed' }}
            disabled={!canAdvance}
            onClick={handleBuildPreview}
          >
            Preview cards →
          </button>
          <button style={s.btnGhost} onClick={() => setStep('upload')}>
            ← Back
          </button>
        </div>
      </div>
    );
  };

  const renderPreview = () => {
    const savedCount    = rows.filter(r => r.status === 'saved').length;
    const duplicateCount = rows.filter(r => r.status === 'duplicate').length;
    const errorCount    = rows.filter(r => r.status === 'error').length;
    const doneCount     = savedCount + duplicateCount + errorCount;
    const allDone       = doneCount === rows.length;
    const hasAudio      = rows.some(r => r.audioUrl !== null);

    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
          <h2 style={{ ...s.title, margin: 0 }}>Preview</h2>
          <span style={s.countBadge}>
            {checkedCount} / {rows.length} selected
          </span>
          {saving && (
            <span style={{ fontSize: 13, color: '#6366f1', fontWeight: 600 }}>
              Saving {saveProgress} / {rows.filter(r => r.checked && r.status !== 'idle').length + saveProgress}…
            </span>
          )}
          {doneCount > 0 && !saving && (
            <span style={{ fontSize: 13, color: '#64748b' }}>
              {savedCount > 0 && <span style={{ color: '#16a34a', marginRight: 8 }}>✓ {savedCount} saved</span>}
              {duplicateCount > 0 && <span style={{ color: '#d97706', marginRight: 8 }}>≈ {duplicateCount} already existed</span>}
              {errorCount > 0 && <span style={{ color: '#dc2626' }}>✗ {errorCount} errors</span>}
            </span>
          )}
        </div>

        {hasAudio && (
          <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
            Audio will be saved alongside each card for in-app playback.
          </p>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    title="Select all / none"
                  />
                </th>
                <th style={s.th}>Kind</th>
                <th style={s.th}>Lang</th>
                <th style={s.th}>Word / Idiom</th>
                <th style={s.th}>Meaning</th>
                <th style={s.th}>Example</th>
                {hasAudio && <th style={s.th}>Audio</th>}
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  style={{
                    ...s.tr,
                    background: row.status === 'saved'     ? '#f0fdf4'
                               : row.status === 'duplicate' ? '#fffbeb'
                               : row.status === 'error'     ? '#fef2f2'
                               : undefined,
                  }}
                >
                  <td style={s.td}>
                    <input
                      type="checkbox"
                      checked={row.checked}
                      disabled={saving || row.status !== 'idle'}
                      onChange={() => toggleRow(row.id)}
                    />
                  </td>
                  <td style={{ ...s.td, fontSize: 11 }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: row.kind === 'word' ? '#dbeafe' : row.kind === 'phrase' ? '#f3e8ff' : '#f1f5f9',
                      color:      row.kind === 'word' ? '#1e40af' : row.kind === 'phrase' ? '#6b21a8' : '#475569',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                    }}>
                      {row.kind}
                    </span>
                  </td>
                  <td style={{ ...s.td, fontSize: 11, color: '#0369a1' }}>
                    {row.language}
                  </td>
                  <td style={{ ...s.td, fontWeight: 600, maxWidth: 180 }}>
                    {row.canonical_form}
                  </td>
                  <td style={{ ...s.td, maxWidth: 220 }}>{row.meaning}</td>
                  <td style={{ ...s.td, maxWidth: 200, color: '#64748b', fontSize: 12 }}>
                    {row.examples.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {row.examples.map((ex, i) => <li key={i}>{ex}</li>)}
                      </ul>
                    ) : <em>—</em>}
                  </td>
                  {hasAudio && (
                    <td style={s.td}>
                      {row.audioUrl
                        ? <audio src={row.audioUrl} controls style={{ width: 140, height: 28 }} />
                        : <span style={{ color: '#cbd5e1' }}>—</span>
                      }
                    </td>
                  )}
                  <td style={{ ...s.td, minWidth: 24, textAlign: 'center' }}>
                    {statusIcon(row.status)}
                    {row.status === 'error' && row.errorMsg && (
                      <span title={row.errorMsg} style={{ cursor: 'help', marginLeft: 4 }}>ℹ</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          {!allDone && (
            <button
              style={saving || checkedCount === 0 ? { ...s.btnPrimary, opacity: 0.5, cursor: 'not-allowed' } : s.btnPrimary}
              disabled={saving || checkedCount === 0}
              onClick={() => void handleSave()}
            >
              {saving ? `Saving…` : `Import ${checkedCount} selected`}
            </button>
          )}
          {allDone && (
            <button style={s.btnPrimary} onClick={onClose}>
              Done — back to vocabulary
            </button>
          )}
          <button style={s.btnGhost} onClick={() => setStep('mapping')} disabled={saving}>
            ← Remap fields
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '24px 0' }}>
      {step === 'upload'  && renderUpload()}
      {step === 'mapping' && renderMapping()}
      {step === 'preview' && renderPreview()}
    </div>
  );
};

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  title: {
    fontWeight: 800,
    fontSize: 22,
    color: '#0f172a',
    margin: '0 0 6px',
  },
  subtitle: {
    color: '#64748b',
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 1.6,
  },
  dropZone: {
    border: '2px dashed #cbd5e1',
    borderRadius: 12,
    padding: '40px 24px',
    cursor: 'pointer',
    background: '#f8fafc',
    transition: 'border-color 0.2s, background 0.2s',
  },
  dropZoneActive: {
    borderColor: '#6366f1',
    background: '#eef2ff',
  },
  mapCard: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: '18px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  mapRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  mapLabel: {
    fontWeight: 600,
    fontSize: 13,
    color: '#334155',
  },
  select: {
    padding: '7px 10px',
    fontSize: 14,
    border: '1px solid #cbd5e1',
    borderRadius: 7,
    background: '#fff',
    color: '#0f172a',
    outline: 'none',
  },
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
  btnGhost: {
    padding: '8px 16px',
    background: 'none',
    color: '#64748b',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 13,
    cursor: 'pointer',
  },
  countBadge: {
    display: 'inline-block',
    padding: '3px 12px',
    background: '#eef2ff',
    color: '#4338ca',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
    minWidth: 600,
  },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: '2px solid #e2e8f0',
    fontWeight: 600,
    color: '#475569',
    background: '#f8fafc',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '8px 10px',
    borderBottom: '1px solid #f1f5f9',
    verticalAlign: 'top',
    wordBreak: 'break-word',
  },
  tr: {
    transition: 'background 0.15s',
  },
  rawTh: {
    padding: '6px 12px',
    textAlign: 'left' as const,
    fontWeight: 700,
    color: '#475569',
    background: '#f1f5f9',
    borderBottom: '2px solid #e2e8f0',
    whiteSpace: 'nowrap' as const,
    fontSize: 12,
  },
  rawTd: {
    padding: '5px 12px',
    borderBottom: '1px solid #f1f5f9',
    verticalAlign: 'top' as const,
    fontSize: 12,
    color: '#0f172a',
    whiteSpace: 'nowrap' as const,
  },
};

export default AnkiImport;
