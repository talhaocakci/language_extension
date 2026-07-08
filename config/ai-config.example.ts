/**
 * AI/LLM Configuration Example
 * 
 * The extension uses a configurable LLM endpoint for:
 * - Grouping subtitles into meaningful sentences
 * - Analyzing grammar and phrase structures
 * - Detecting phrasal verbs and compound expressions
 */

/**
 * OpenAI Configuration Example
 */
export const OPENAI_CONFIG = {
  provider: 'custom',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'sk-...',
  model: 'gpt-4',
  maxTokens: 1000
};

/**
 * Anthropic Claude Configuration Example
 */
export const ANTHROPIC_CONFIG = {
  provider: 'custom',
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiKey: 'sk-ant-...',
  model: 'claude-3-opus-20240229',
  maxTokens: 1000
};

/**
 * Ollama (Local LLM) Configuration Example
 * 
 * Install Ollama from https://ollama.ai
 * Run: ollama pull mistral
 * Then: ollama serve (default runs on http://localhost:11434)
 */
export const OLLAMA_CONFIG = {
  provider: 'custom',
  endpoint: 'http://localhost:11434/api/chat',
  apiKey: '', // Usually empty for local Ollama
  model: 'mistral',
  maxTokens: 1000
};

/**
 * LocalAI Configuration Example
 * 
 * LocalAI provides local API compatible with OpenAI
 * https://localai.io/
 */
export const LOCALAI_CONFIG = {
  provider: 'custom',
  endpoint: 'http://localhost:8080/v1/chat/completions',
  apiKey: 'test', // Usually 'test' for local setups
  model: 'ggml-model-name',
  maxTokens: 1000
};

/**
 * LLM Prompt Examples
 * 
 * The extension uses these prompts internally:
 */

export const PROMPTS = {
  GROUP_SENTENCES: `You are a language learning assistant. Take these subtitle chunks and group them into coherent, meaningful sentences. Preserve the meaning and ensure each sentence is complete.

Subtitle chunks:
{text}

Return only the grouped sentences, one per line. Do not add explanations or numbering.`,

  ANALYZE_GRAMMAR: `You are an expert English language teacher. Analyze the following sentence for grammar structure and identify key phrases.

Sentence: "{sentence}"

Provide a JSON response with this exact structure:
{
  "grammaticalStructure": "Brief description of the sentence structure",
  "phrases": [
    {
      "text": "phrase text",
      "type": "phrasal_verb" or "prepositional" or "compound" or "single_word",
      "partOfSpeech": "noun/verb/adjective/adverb/etc",
      "explanation": "detailed explanation of the phrase"
    }
  ],
  "difficulty": "beginner" or "intermediate" or "advanced"
}

Important: For phrasal verbs like "get up", "get off", identify them as single units, not separate words. Include all significant phrases and words.`,

  EXPLAIN_PHRASE: `You are a language learning assistant. Provide a concise but detailed explanation of the phrase or word, including its usage, common examples, and any related expressions.

Phrase/Word: "{phrase}"
Context: "{context}"

Provide a clear, student-friendly explanation in 2-3 sentences.`
};

/**
 * Recommendations:
 * 
 * For Production:
 * - OpenAI GPT-4: Best quality, costs money, reliable
 * - Claude 3 Opus: Excellent quality, costs money, good for linguistics
 * 
 * For Local/Free:
 * - Mistral 7B (via Ollama): Good balance, free, runs locally
 * - Neural Chat: Fast, good for learning tasks
 * - Openchat: Good alternative
 * 
 * For Testing:
 * - Any small local model via Ollama (3.5B parameter models)
 */
