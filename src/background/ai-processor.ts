import type { AIConfig } from '../types/api';
import type { PhraseAnalysis, MeaningfulSentence } from '../types/subtitle';
import { StorageManager } from './storage-manager';

export class AIProcessor {
  private static config: AIConfig | null = null;

  static async initialize(): Promise<void> {
    try {
      const preferences = await StorageManager.getPreferences();
      this.config = {
        provider: 'custom',
        endpoint: preferences.llmEndpoint || '',
        apiKey: preferences.llmApiKey || '',
        model: preferences.llmModel || 'gpt-4',
        maxTokens: 1000
      };
    } catch (error) {
      console.error('Error initializing AI processor:', error);
      this.config = {
        provider: 'custom',
        endpoint: '',
        apiKey: '',
        model: 'gpt-4',
        maxTokens: 1000
      };
    }
  }

  static async groupMeaningfulSentences(
    mergedText: string
  ): Promise<string> {
    if (!this.config || !this.config.endpoint) {
      return mergedText;
    }

    try {
      const prompt = `You are a language learning assistant. Take these subtitle chunks and group them into coherent, meaningful sentences. Preserve the meaning and ensure each sentence is complete.

Subtitle chunks:
${mergedText}

Return only the grouped sentences, one per line. Do not add explanations or numbering.`;

      const response = await this.callLLM(prompt);
      return response.trim();
    } catch (error) {
      console.error('Error grouping meaningful sentences:', error);
      return mergedText;
    }
  }

  static async analyzeGrammarAndPhrases(
    sentence: string
  ): Promise<PhraseAnalysis> {
    if (!this.config || !this.config.endpoint) {
      return this.getDefaultAnalysis(sentence);
    }

    try {
      const prompt = `You are an expert English language teacher. Analyze the following sentence for grammar structure and identify key phrases.

Sentence: "${sentence}"

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

Important: For phrasal verbs like "get up", "get off", identify them as single units, not separate words. Include all significant phrases and words.`;

      const response = await this.callLLM(prompt);
      const parsed = JSON.parse(response);

      return {
        sentence,
        grammaticalStructure: parsed.grammaticalStructure || '',
        phrases: parsed.phrases || [],
        difficulty: parsed.difficulty || 'intermediate',
        explanation: parsed.explanation
      };
    } catch (error) {
      console.error('Error analyzing grammar:', error);
      return this.getDefaultAnalysis(sentence);
    }
  }

  static async generateDetailedExplanation(
    phrase: string,
    context: string
  ): Promise<string> {
    if (!this.config || !this.config.endpoint) {
      return `${phrase} is used in the context of: "${context}"`;
    }

    try {
      const prompt = `You are a language learning assistant. Provide a concise but detailed explanation of the phrase or word, including its usage, common examples, and any related expressions.

Phrase/Word: "${phrase}"
Context: "${context}"

Provide a clear, student-friendly explanation in 2-3 sentences.`;

      return await this.callLLM(prompt);
    } catch (error) {
      console.error('Error generating explanation:', error);
      return `${phrase} is used in the context of: "${context}"`;
    }
  }

  private static async callLLM(prompt: string): Promise<string> {
    if (!this.config || !this.config.endpoint || !this.config.apiKey) {
      throw new Error('LLM not configured');
    }

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful language learning assistant.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: this.config.maxTokens,
        temperature: 0.7
      })
    });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

    const data = await response.json();
    
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content;
    }

    throw new Error('Invalid LLM response format');
  }

  private static getDefaultAnalysis(sentence: string): PhraseAnalysis {
    const words = sentence.split(/\s+/);
    const phrases = words.map((word, index) => ({
      text: word.replace(/[.,!?;:]/g, ''),
      startPos: sentence.indexOf(word),
      endPos: sentence.indexOf(word) + word.length,
      type: 'single_word' as const,
      partOfSpeech: 'unknown',
      explanation: `Word: ${word}`
    }));

    return {
      sentence,
      grammaticalStructure: `Sentence with ${words.length} words`,
      phrases,
      difficulty: 'beginner',
      explanation: 'Analysis not available - LLM not configured'
    };
  }
}
