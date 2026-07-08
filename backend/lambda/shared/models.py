from typing import List, Dict, Optional, Literal, Union
from datetime import datetime
from pydantic import BaseModel, Field, field_validator


# ── DynamoDB item models ───────────────────────────────────────────────────────

class UserMetaItem(BaseModel):
    """META item stored at sort_key='META' — lightweight user profile / stats."""
    user_id: str          # PK  e.g. "u#<cognito-sub>"
    sort_key: str = "META"
    email: str
    total_phrases: int = 0
    preferences: Dict = Field(default_factory=dict)
    created_at: str
    updated_at: str


class PhraseItem(BaseModel):
    """One saved idiom / phrasal verb / fixed phrase — stored at sort_key='phrase#<uuid>'."""
    user_id: str          # PK  e.g. "u#<cognito-sub>"
    sort_key: str         # SK  "phrase#<uuid>"
    phrase_id: str        # same UUID as in sort_key (convenience)

    # Core linguistic data (from OpenAI Explain result)
    canonical_form: str   # GSI1 PK — deduplication key, e.g. "auf Watte gehen"
    found_in_text: str    # exact substring in source sentence
    kind: str             # GSI2 SK — "idiom" | "phrasal_verb" | "collocation" | "connector" | …
    meaning: str          # English gloss
    example: Optional[List[str]] = None

    @field_validator('example', mode='before')
    @classmethod
    def coerce_example_to_list(cls, v: Union[str, List, None]) -> Optional[List[str]]:
        """Accept legacy string values stored before the list migration."""
        if v is None:
            return None
        if isinstance(v, str):
            stripped = v.strip()
            return [stripped] if stripped else None
        return [s for s in v if isinstance(s, str) and s.strip()] or None

    # Language of the canonical form (BCP-47 code, e.g. "de" for German)
    language: Optional[str] = 'de'

    # Pronunciation audio stored as a base64 data URL (e.g. "data:audio/mpeg;base64,…")
    audio: Optional[str] = None

    # Context
    source_sentence: str
    source_url: str
    video_title: str

    # Metadata
    saved_at: str
    tags: List[str] = Field(default_factory=list)
    user_notes: Optional[str] = None


# ── Request / response models for Lambda I/O ──────────────────────────────────

class SavePhraseRequest(BaseModel):
    """Body of POST /phrases."""
    canonical_form: str
    found_in_text: str = ''
    kind: str
    meaning: str
    example: Optional[List[str]] = None
    # BCP-47 language code of the canonical form; defaults to German
    language: Optional[str] = 'de'

    # Pronunciation audio as a base64 data URL
    audio: Optional[str] = None

    @field_validator('example', mode='before')
    @classmethod
    def coerce_example_to_list(cls, v: Union[str, List, None]) -> Optional[List[str]]:
        """Accept a plain string (from extension/OpenAI) or legacy DB values."""
        if v is None:
            return None
        if isinstance(v, str):
            stripped = v.strip()
            return [stripped] if stripped else None
        return [s for s in v if isinstance(s, str) and s.strip()] or None
    source_sentence: str = ''
    source_url: str = ''
    video_title: str = ''
    tags: List[str] = Field(default_factory=list)


class SavePhraseResponse(BaseModel):
    phrase_id: str
    already_exists: bool
    saved_at: str


class GetPhrasesResponse(BaseModel):
    phrases: List[PhraseItem]
    count: int
    next_cursor: Optional[str] = None  # base64-encoded LastEvaluatedKey


# ── Legacy models kept for quiz / video-script Lambdas (not removed yet) ─────

class PhraseAnalysis(BaseModel):
    """Grammar and phrase analysis from AI — used by analyze_phrase Lambda."""
    sentence: str
    grammatical_structure: str
    phrases: List[Dict] = Field(default_factory=list)
    difficulty: Literal["beginner", "intermediate", "advanced"]
    vocabulary_explanations: Dict[str, str] = Field(default_factory=dict)


class SubtitleData(BaseModel):
    text: str
    meaningful_sentence: str
    start_time: int
    end_time: int
    sub_portions: List[Dict]
    source_url: str
    platform: Literal["youtube", "netflix"]
    video_title: str


class AnalysisRequest(BaseModel):
    phrase: str
    meaningful_sentence: str
    context: Optional[str] = None
    subtitle_data: Optional[SubtitleData] = None


class AnalysisResponse(BaseModel):
    analysis: Dict
    examples: List[str]
    related_vocabulary: List[Dict]
    exercises: List[Dict]
    learning_tips: List[str]
