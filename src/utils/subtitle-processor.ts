import type { SubtitleChunk, MeaningfulSentence, SubPortions } from '../types/subtitle';
import { v4 as uuidv4 } from 'uuid';

/** Pause (ms) after a *complete* clause — likely next caption is a new sentence */
const GAP_SPLIT_WHEN_COMPLETE_MS = 2000;

/**
 * If text does NOT look like a full sentence end, only split after this long pause
 * (normal subtitle gaps are often 1–4s within the same utterance).
 */
const GAP_FORCE_SPLIT_INCOMPLETE_MS = 12000;

/**
 * If two captions are this close, keep merging when text looks incomplete even across
 * slightly longer micro-pauses (keep below typical “next line” pause ~3s to avoid over-merge).
 */
const GAP_ALWAYS_MERGE_INCOMPLETE_MS = 3200;

/**
 * At most this many raw subtitle **cues** per meaningful-sentence card (readability in the panel).
 * Continuation of an unfinished thought moves to the next card.
 */
const MAX_CHUNKS_PER_MEANINGFUL_SENTENCE = 5;

/**
 * Auto-generated YouTube captions often have no punctuation at all. Even when cue timing overlaps
 * (so pause detection is unavailable), keep the learning overlay to a readable amount of text.
 */
const MAX_WORDS_PER_UNPUNCTUATED_GROUP = 18;

/**
 * At most this many **complete** sentences (terminal . ! ? …) per card — avoids huge blocks of text.
 */
const MAX_COMPLETE_SENTENCES_PER_CARD = 2;

/**
 * Preferred max wall-clock span: `lastCue.endTime - firstCue.startTime`.
 * If the merged text does **not** end with a hard sentence end (`. ! ? …`), the card may extend
 * up to {@link MAX_GROUP_DURATION_INCOMPLETE_MS} so one utterance isn’t cut at 10s.
 */
const MAX_GROUP_DURATION_MS = 10_000;

/** Hard ceiling when waiting for sentence completion (incomplete tail). */
const MAX_GROUP_DURATION_INCOMPLETE_MS = 20_000;

/** Single letters / dashes that shouldn't end a group *unless* very long gap */
const SOFT_END_CHARS = /[,;:–—-]\s*$/;

/** Strong sentence / clause ending for German + subtitles */
function looksLikeHardSentenceEnd(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  // . ! ? … and optional closing quotes/brackets
  if (/[.!?]["'»”’)]?\s*$/.test(t)) return true;
  if (/…\s*$/.test(t) || /\.{3,}\s*$/.test(t)) return true;
  return false;
}

/** Starts with lowercase Latin / umlaut → likely mid-sentence (German) */
function startsWithLowercaseSentence(text: string): boolean {
  const m = text.trim().match(/^[\p{L}]/u);
  if (!m) return false;
  const c = m[0];
  if (c === c.toUpperCase() && /[A-ZÄÖÜ]/.test(c)) return false;
  return /[a-zäöüß]/.test(c);
}

const CONTINUATION_LAST_WORD = new Set(
  [
    // English conjunctions, function words, and auxiliaries. These are especially important for
    // YouTube ASR, where a cue can end in the middle of a verb phrase ("has" + "to encounter").
    'and',
    'or',
    'but',
    'because',
    'if',
    'unless',
    'although',
    'though',
    'which',
    'who',
    'whom',
    'whose',
    'when',
    'while',
    'as',
    'to',
    'of',
    'for',
    'from',
    'with',
    'without',
    'at',
    'by',
    'into',
    'onto',
    'about',
    'over',
    'under',
    'a',
    'the',
    'my',
    'your',
    'his',
    'her',
    'our',
    'their',
    'am',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'can',
    'could',
    'will',
    'would',
    'shall',
    'should',
    'may',
    'might',
    'must',
    'not',
    'und',
    'oder',
    'aber',
    'sondern',
    'denn',
    'weil',
    'wenn',
    'dass',
    'daß',
    'ob',
    'doch',
    'also',
    'dann',
    'sowie',
    'sowohl',
    'weder',
    'beziehungsweise',
    'bzw',
    'bzw.',
    'an',
    'in',
    'auf',
    'mit',
    'von',
    'zu',
    'zum',
    'zur',
    'bei',
    'nach',
    'aus',
    'um',
    'für',
    'gegen',
    'ohne',
    'durch',
    'gegenüber',
    'trotz',
    'während',
    'statt',
    'anstatt',
    'innerhalb',
    'außerhalb',
    'der',
    'die',
    'das',
    'den',
    'dem',
    'des',
    'ein',
    'eine',
    'einer',
    'einem',
    'einen',
    'eines',
    'kein',
    'keine',
    'keinem',
    'keinen',
    'keiner',
    'keines',
    'mein',
    'dein',
    'sein',
    'ihr',
    'ihre',
    'ihren',
    'unser',
    'euer',
    'dieser',
    'diese',
    'dieses',
    'diesen',
    'diesem',
    'jener',
    'welcher',
    'welche',
    'welches',
    'manch',
    'solch',
    'alle',
    'alles',
    'viel',
    'wenig',
    'etwas',
    'nichts',
    'noch',
    'mal',
    'halt',
    'eben',
    'nur',
    'gar',
    'etwa',
    'besonders',
    'wie',
    'als',
    'damit',
    'sodass',
    'bevor',
    'nachdem',
    'solange',
    'sobald', // often clause continues
    'darum',
    'deswegen',
    'trotzdem',
    'jedoch',
    'dennoch'
  ].map((s) => s.toLowerCase())
);

function lastWordLower(text: string): string {
  const words = text
    .trim()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words[words.length - 1].toLowerCase();
}

/**
 * True when this chunk should probably be glued to the next one.
 */
function looksIncompleteUtterance(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (looksLikeHardSentenceEnd(t)) return false;
  if (SOFT_END_CHARS.test(t)) return true;
  const lw = lastWordLower(t);
  if (lw && CONTINUATION_LAST_WORD.has(lw)) return true;
  // Very short tail without punctuation — likely fragment ("Also," / "Dann")
  if (t.length <= 3 && !/[.!?]/.test(t)) return true;
  return true;
}

/**
 * Detect only high-confidence sentence starts that survive unpunctuated English ASR. This is kept
 * deliberately conservative: it is a fallback for missing punctuation, not a grammar rewriter.
 */
function looksLikeUnpunctuatedSentenceStart(currentText: string, nextText: string): boolean {
  if (looksLikeHardSentenceEnd(currentText) || countWords(currentText) < 3) return false;

  const next = normalizeInlineSpacing(nextText).toLowerCase();
  if (!next) return false;

  // A determiner-led subject followed by a finite auxiliary is a strong new-clause signal, e.g.
  // "the main character has ...". Limit the words between them to avoid splitting complements such
  // as "the best thing I have ...".
  if (/^(?:the|a|an)\s+(?:[\p{L}\p{N}'-]+\s+){0,2}(?:is|are|was|were|has|have|had|does|do|did|can|could|will|would|should|must|needs?|gets?|goes|wants?|says?)\b/u.test(next)) {
    return true;
  }

  if (CONTINUATION_LAST_WORD.has(lastWordLower(currentText))) return false;

  return /^(?:i(?:'m|'d|'ll|'ve)?|we(?:'re|'d|'ll|'ve)?|he(?:'s|'d|'ll)?|she(?:'s|'d|'ll)?|they(?:'re|'d|'ll|'ve)?|this|these|those|okay|ok|alright|meanwhile|finally|time\s+to|that's)\b/u.test(next);
}

function shouldBreakBeforeNext(
  current: SubtitleChunk,
  next: SubtitleChunk | undefined
): boolean {
  if (!next) return true;

  const gap = next.startTime - current.endTime;
  const cur = current.text.trim();
  const hardEnd = looksLikeHardSentenceEnd(cur);

  // Long pause → speaker / topic change; start a new unit even if punctuation is messy
  if (gap > GAP_FORCE_SPLIT_INCOMPLETE_MS) return true;

  // Clear sentence end → always start a new meaningful sentence
  if (hardEnd) return true;

  // YouTube ASR frequently omits every punctuation mark and uses overlapping cue timings. In that
  // case timing gaps are always zero, so use a few high-confidence textual starts as boundaries.
  if (looksLikeUnpunctuatedSentenceStart(cur, next.text)) return true;

  // No . ! ? … — treat as same utterance if gaps are typical for YouTube (often 1–4 s)
  if (gap <= GAP_ALWAYS_MERGE_INCOMPLETE_MS) return false;

  // Next cue starts lowercase → almost certainly continuation
  if (startsWithLowercaseSentence(next.text)) return false;

  // Trailing comma, dangling article/preposition, etc.
  if (looksIncompleteUtterance(cur) && gap < 6000) return false;

  // Medium gap & next looks like a new sentence — split
  return gap > GAP_SPLIT_WHEN_COMPLETE_MS;
}

function normalizeInlineSpacing(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,.;!?])(?=\S)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  const words = text.match(/\p{L}[\p{L}\p{N}'-]*/gu) || [];
  return words.length;
}

function looksLikeAsrSpaghetti(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const wordCount = countWords(normalized);
  if (wordCount < 3) return false;

  // If punctuation already exists, keep source formatting untouched.
  if (/[.!?]/.test(normalized)) return false;

  return true;
}

function capitalizeSentenceStarts(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let capNext = true;

  for (const ch of chars) {
    if (capNext && /\p{L}/u.test(ch)) {
      out.push(ch.toLocaleUpperCase('de-DE'));
      capNext = false;
      continue;
    }

    out.push(ch);

    if (/[.!?]/.test(ch)) {
      capNext = true;
      continue;
    }

    if (!/[\s"'«»“”„()[\]{}]/.test(ch)) {
      capNext = false;
    }
  }

  return out.join('');
}

function prettifyAsrGroup(chunks: SubtitleChunk[]): string {
  if (chunks.length === 0) return '';

  const pieces: string[] = [];
  const clauseGapMs = 900;
  const sentenceGapMs = 1800;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const cleanText = normalizeInlineSpacing(chunk.text);
    if (!cleanText) continue;

    pieces.push(cleanText);

    const next = chunks[i + 1];
    if (!next) continue;

    if (looksLikeHardSentenceEnd(cleanText) || SOFT_END_CHARS.test(cleanText)) {
      continue;
    }

    const gap = Math.max(0, next.startTime - chunk.endTime);
    if (gap >= sentenceGapMs) {
      pieces.push('.');
    } else if (gap >= clauseGapMs) {
      pieces.push(',');
    }
  }

  let text = normalizeInlineSpacing(pieces.join(' '));
  text = capitalizeSentenceStarts(text);
  if (text && !/[.!?]["'»”’)]?\s*$/.test(text)) {
    text += '.';
  }
  return text;
}

/**
 * From every group **except the last**, carry trailing cues after its last completed sentence into
 * the next group. Groups with no completed boundary are preserved because they were split by a
 * hard readability limit.
 *
 * - Moves one trailing cue **or** several after a `.?!` boundary.
 * - Never moves an entirely unpunctuated group; doing so caused every YouTube ASR cue to cascade
 *   into one giant final card.
 * - The **final** group is never peeled (no successor).
 */
function peelIncompleteTailsForward(groups: SubtitleChunk[][]): SubtitleChunk[][] {
  if (groups.length <= 1) return groups;

  const working = groups.map((g) => [...g]);
  const out: SubtitleChunk[][] = [];

  for (let i = 0; i < working.length; i++) {
    const current = working[i];

    if (i < working.length - 1 && current.length > 0) {
      // A group with no completed sentence was created by a hard readability limit (cue count,
      // duration, or word count). Moving the whole group forward would erase that limit and cascade
      // every unpunctuated ASR cue into the final card.
      let lastCompleteIndex = -1;
      for (let j = current.length - 1; j >= 0; j -= 1) {
        if (looksLikeHardSentenceEnd(current[j].text.trim())) {
          lastCompleteIndex = j;
          break;
        }
      }
      const peeled: SubtitleChunk[] = [];
      while (lastCompleteIndex >= 0 && current.length - 1 > lastCompleteIndex) {
        peeled.push(current.pop()!);
      }
      if (peeled.length > 0) {
        peeled.reverse();
        working[i + 1] = [...peeled, ...working[i + 1]];
      }
    }

    if (current.length > 0) {
      out.push(current);
    }
  }

  return out;
}

function splitUnpunctuatedGroupByWordCap(chunks: SubtitleChunk[]): SubtitleChunk[][] {
  if (chunks.length <= 1 || /[.!?]/.test(mergeChunkTexts(chunks))) return [chunks];

  const out: SubtitleChunk[][] = [];
  let acc: SubtitleChunk[] = [];
  let accWords = 0;

  for (const chunk of chunks) {
    const chunkWords = countWords(chunk.text);
    if (acc.length > 0 && accWords + chunkWords > MAX_WORDS_PER_UNPUNCTUATED_GROUP) {
      out.push(acc);
      acc = [];
      accWords = 0;
    }

    acc.push(chunk);
    accWords += chunkWords;
  }

  if (acc.length > 0) out.push(acc);
  return out;
}

function applyUnpunctuatedWordCapToGroups(groups: SubtitleChunk[][]): SubtitleChunk[][] {
  return groups.flatMap(splitUnpunctuatedGroupByWordCap);
}

/**
 * How many "complete sentence" boundaries to count **for the 2-sentence cap**.
 *
 * We only use **one count per subtitle cue** (`0` or `1`) and test the **whole line** with
 * `looksLikeHardSentenceEnd`. Splitting on every `.` falsely treats German abbreviations
 * (`z. B.`, `Dr.`, `Nr.`, etc.) as sentence ends, which over-splits into one-cue cards that
 * rarely end with punctuation — everything looks incomplete.
 *
 * Cues that genuinely pack two sentences in one line still cap as one boundary here (rare in YT);
 * the card may then hold two periods in one cue, which is acceptable.
 */
function sentenceCapWeightForChunk(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return looksLikeHardSentenceEnd(t) ? 1 : 0;
}

/**
 * Split one group into several cards so each has at most MAX_COMPLETE_SENTENCES_PER_CARD
 * **cue lines** that end like a full sentence (see `sentenceCapWeightForChunk`). Trailing
 * fragments without `.?!` stay on the same card after the last counted cue.
 */
function splitGroupBySentenceCap(chunks: SubtitleChunk[]): SubtitleChunk[][] {
  const MAX = MAX_COMPLETE_SENTENCES_PER_CARD;
  const out: SubtitleChunk[][] = [];
  let acc: SubtitleChunk[] = [];
  let sentCount = 0;

  const flush = () => {
    if (acc.length > 0) {
      out.push(acc);
      acc = [];
      sentCount = 0;
    }
  };

  for (const chunk of chunks) {
    const k = sentenceCapWeightForChunk(chunk.text);

    if (sentCount + k > MAX) {
      flush();
    }

    acc.push(chunk);
    sentCount += k;
  }

  flush();
  return out;
}

function applySentenceCapToGroups(groups: SubtitleChunk[][]): SubtitleChunk[][] {
  const out: SubtitleChunk[][] = [];
  for (const g of groups) {
    out.push(...splitGroupBySentenceCap(g));
  }
  return out;
}

function mergeChunkTexts(chunks: SubtitleChunk[]): string {
  return chunks
    .map((c) => c.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Largest index `i` such that merging `chunks[0..i]` ends with a hard sentence end;
 * i.e. the group seen so far contains at least one completed sentence ending at that boundary.
 */
function lastIndexWhereMergedPrefixEndsComplete(chunks: SubtitleChunk[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const merged = mergeChunkTexts(chunks.slice(0, i + 1));
    if (looksLikeHardSentenceEnd(merged)) {
      best = i;
    }
  }
  return best;
}

/** Single-letter + `.` at end of prefix → e.g. `… z.` in `z. B.`; not a sentence for peeling. */
function isLikelyAbbreviationSentenceTail(prefixTrimmed: string): boolean {
  return /\b[\p{L}]\.\s*$/u.test(prefixTrimmed.trimEnd());
}

/**
 * If one timedtext line holds a full stop then more text (e.g. `… habe. Und noch …`), split there so
 * duration limits don’t cut the *next* sentence across two cards at the following cue boundary.
 */
function splitAfterLastCompleteSentenceInCue(text: string): { prefix: string; suffix: string } | null {
  const t = text.trim();
  if (!t) return null;

  let lastGoodEnd = -1;
  // After `.` there may be a space, start of next sentence (`Und`), or line end (YouTube cues vary).
  const re = /[.!?…]+["'»”’)]*(?=\s+\S|\s*[\p{Lu}]|\s*$)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const end = m.index + m[0].length;
    const prefix = t.slice(0, end).trim();
    if (!prefix || isLikelyAbbreviationSentenceTail(prefix)) continue;
    if (!looksLikeHardSentenceEnd(prefix)) continue;
    const suffix = t.slice(end).trim();
    if (!suffix) continue;
    lastGoodEnd = end;
  }

  if (lastGoodEnd < 0) return null;
  return {
    prefix: t.slice(0, lastGoodEnd).trim(),
    suffix: t.slice(lastGoodEnd).trim()
  };
}

function splitSubtitleChunkAtPrefixSuffix(
  chunk: SubtitleChunk,
  prefix: string,
  suffix: string
): [SubtitleChunk, SubtitleChunk] {
  const full = chunk.text.trim();
  const p = prefix.trim();
  const s = suffix.trim();
  const denom = full.length > 0 ? full.length : p.length + s.length;
  const ratio = denom > 0 ? p.length / denom : 0.5;
  const splitTime =
    chunk.startTime + Math.round(Math.max((chunk.endTime - chunk.startTime) * ratio, 0));
  return [
    { ...chunk, text: p, endTime: splitTime },
    { ...chunk, text: s, startTime: splitTime }
  ];
}

/**
 * Emit a completed prefix as its own card; carry incomplete tail forward (next card starts with it).
 * Uses chunk boundaries first, then splits the **last** cue inside the line if needed.
 */
function tryPeelCompletePrefixFromAcc(
  acc: SubtitleChunk[]
): { prefix: SubtitleChunk[]; tail: SubtitleChunk[] } | null {
  const idx = lastIndexWhereMergedPrefixEndsComplete(acc);
  if (idx !== null && idx < acc.length - 1) {
    return { prefix: acc.slice(0, idx + 1), tail: acc.slice(idx + 1) };
  }

  const last = acc[acc.length - 1];
  const intra = splitAfterLastCompleteSentenceInCue(last.text);
  if (!intra) return null;

  const [first, second] = splitSubtitleChunkAtPrefixSuffix(last, intra.prefix, intra.suffix);
  return {
    prefix: [...acc.slice(0, -1), first],
    tail: [second]
  };
}

/**
 * Split on time: target ≤ {@link MAX_GROUP_DURATION_MS}; if the running merge still has no hard
 * sentence end, allow up to {@link MAX_GROUP_DURATION_INCOMPLETE_MS}. After a complete sentence,
 * the next cue starts a fresh window (10s again).
 *
 * When span is already > 10s and the card is still incomplete, **peel** a completed prefix (including
 * splitting one cue after `… .` when two sentences share the same timedtext line) so the following
 * incomplete sentence is not broken at the **next** cue boundary under the 20s hard ceiling.
 */
function splitGroupByMaxDuration(chunks: SubtitleChunk[]): SubtitleChunk[][] {
  if (chunks.length === 0) return [];

  const out: SubtitleChunk[][] = [];
  let acc: SubtitleChunk[] = [];

  for (const chunk of chunks) {
    if (acc.length === 0) {
      acc.push(chunk);
      continue;
    }

    const spanStart = acc[0].startTime;
    const spanEndIfMerged = Math.max(acc[acc.length - 1].endTime, chunk.endTime);
    const spanMs = spanEndIfMerged - spanStart;

    if (spanMs <= MAX_GROUP_DURATION_MS) {
      acc.push(chunk);
      continue;
    }

    const accEndsComplete = looksLikeHardSentenceEnd(mergeChunkTexts(acc));

    if (accEndsComplete) {
      out.push(acc);
      acc = [chunk];
      continue;
    }

    // span > 10s and merge still incomplete — peel “… complete.” off so the rest stays one unit
    const peeled = tryPeelCompletePrefixFromAcc(acc);
    if (peeled) {
      out.push(peeled.prefix);
      acc = [...peeled.tail, chunk];
      continue;
    }

    if (spanMs <= MAX_GROUP_DURATION_INCOMPLETE_MS) {
      acc.push(chunk);
      continue;
    }

    out.push(acc);
    acc = [chunk];
  }

  if (acc.length > 0) {
    out.push(acc);
  }

  return out;
}

function applyDurationCapToGroups(groups: SubtitleChunk[][]): SubtitleChunk[][] {
  const out: SubtitleChunk[][] = [];
  for (const g of groups) {
    out.push(...splitGroupByMaxDuration(g));
  }
  return out;
}

export class SubtitleProcessor {
  /**
   * Group raw subtitle chunks into sentence-like units.
   * Does NOT split on short timing gaps when the text clearly continues.
   */
  static groupSubtitlesByHeuristic(chunks: SubtitleChunk[]): SubtitleChunk[][] {
    if (chunks.length === 0) return [];

    const groups: SubtitleChunk[][] = [];
    let currentGroup: SubtitleChunk[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      currentGroup.push(chunk);

      const isLast = i === chunks.length - 1;
      const next = chunks[i + 1];

      if (isLast) {
        groups.push(currentGroup);
        break;
      }

      const atCueLimit = currentGroup.length >= MAX_CHUNKS_PER_MEANINGFUL_SENTENCE;
      if (atCueLimit || shouldBreakBeforeNext(chunk, next)) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    }

    const peeled = peelIncompleteTailsForward(groups);
    const wordCapped = applyUnpunctuatedWordCapToGroups(peeled);
    const durationCapped = applyDurationCapToGroups(wordCapped);
    return applySentenceCapToGroups(durationCapped);
  }

  static mergeChunksIntoText(chunks: SubtitleChunk[]): string {
    const merged = chunks
      .map((chunk) => chunk.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!looksLikeAsrSpaghetti(merged)) {
      return merged;
    }

    return prettifyAsrGroup(chunks);
  }

  static createMeaningfulSentence(
    group: SubtitleChunk[],
    processedText: string,
    aiConfidence: number = 0.8
  ): MeaningfulSentence {
    const startTime = group[0].startTime;
    const endTime = group[group.length - 1].endTime;

    const subPortions: SubPortions[] = group.map((chunk) => ({
      text: chunk.text,
      startTime: chunk.startTime,
      endTime: chunk.endTime
    }));

    return {
      id: uuidv4(),
      text: processedText,
      startTime,
      endTime,
      subPortions,
      confidence: aiConfidence
    };
  }

  static async groupAndProcessWithAI(
    chunks: SubtitleChunk[],
    aiProcessor?: (text: string) => Promise<string>
  ): Promise<MeaningfulSentence[]> {
    const heuristicGroups = this.groupSubtitlesByHeuristic(chunks);

    const meaningfulSentences: MeaningfulSentence[] = [];

    for (const group of heuristicGroups) {
      const mergedText = this.mergeChunksIntoText(group);

      let finalText = mergedText;
      let confidence = 0.8;

      if (aiProcessor) {
        try {
          finalText = await aiProcessor(mergedText);
          confidence = 0.95;
        } catch (error) {
          console.error('AI processing failed, using heuristic result:', error);
        }
      }

      const sentence = this.createMeaningfulSentence(group, finalText, confidence);
      meaningfulSentences.push(sentence);
    }

    return meaningfulSentences;
  }

  static findPhrasePosition(
    sentence: string,
    phrase: string
  ): { startPos: number; endPos: number } | null {
    const normalizedSentence = sentence.toLowerCase();
    const normalizedPhrase = phrase.toLowerCase();

    const startPos = normalizedSentence.indexOf(normalizedPhrase);

    if (startPos === -1) {
      return null;
    }

    return {
      startPos,
      endPos: startPos + phrase.length
    };
  }

  static extractSubtitlesFromVTT(vttContent: string): SubtitleChunk[] {
    const lines = vttContent.split('\n');
    const chunks: SubtitleChunk[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      const timeMatch = line.match(
        /^(\d{2}:\d{2}:\d{2}\.\d{3}|0{0,2}\d{1,2}:\d{2})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|0{0,2}\d{1,2}:\d{2})/
      );

      if (timeMatch) {
        const startTime = this.timeToMs(timeMatch[1]);
        const endTime = this.timeToMs(timeMatch[2]);

        let text = '';
        i++;

        while (i < lines.length && lines[i].trim() !== '') {
          text += lines[i] + ' ';
          i++;
        }

        if (text.trim()) {
          chunks.push({
            text: text.trim(),
            startTime,
            endTime
          });
        }
      }

      i++;
    }

    return chunks;
  }

  private static timeToMs(timeStr: string): number {
    const parts = timeStr.includes(':') ? timeStr.split(':') : [timeStr];

    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts.map((p) => parseFloat(p));
      return (hours * 3600 + minutes * 60 + seconds) * 1000;
    } else if (parts.length === 2) {
      const [minutes, seconds] = parts.map((p) => parseFloat(p));
      return (minutes * 60 + seconds) * 1000;
    }

    return 0;
  }
}

// Export a simple function for background service worker
export function groupAndProcessSubtitles(chunks: SubtitleChunk[]): MeaningfulSentence[] {
  const groups = SubtitleProcessor.groupSubtitlesByHeuristic(chunks);

  const sentences: MeaningfulSentence[] = [];
  for (const group of groups) {
    const mergedText = SubtitleProcessor.mergeChunksIntoText(group);
    const sentence = SubtitleProcessor.createMeaningfulSentence(group, mergedText, 0.8);
    sentences.push(sentence);
  }

  return sentences;
}
