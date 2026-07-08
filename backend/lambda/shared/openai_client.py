import os
import json
from openai import OpenAI
from typing import Dict, Any, Optional


class OpenAIClient:
    """Handle all OpenAI API interactions"""
    
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv('OPENAI_API_KEY'))
        self.model = os.getenv('OPENAI_MODEL', 'gpt-4')
    
    def analyze_phrase(
        self,
        phrase: str,
        meaningful_sentence: str,
        context: Optional[str] = None
    ) -> Dict[str, Any]:
        """Analyze a phrase for grammar, meaning, and usage"""
        prompt = f"""Analyze the following phrase in detail:

Phrase: "{phrase}"
Context sentence: "{meaningful_sentence}"
{f'Additional context: {context}' if context else ''}

Provide a comprehensive analysis in JSON format with the following structure:
{{
    "analysis": {{
        "grammatical_structure": "description of grammar",
        "parts_of_speech": {{"word": "POS"}},
        "is_phrasal_verb": boolean,
        "is_compound_word": boolean,
        "is_prepositional_phrase": boolean
    }},
    "vocabulary": {{
        "word_explanations": {{"word": "explanation"}},
        "synonyms": ["list", "of", "synonyms"],
        "antonyms": ["list", "of", "antonyms"]
    }},
    "usage": {{
        "example_sentences": ["example 1", "example 2", "example 3"],
        "common_collocations": ["collocation 1", "collocation 2"],
        "register": "formal/informal/neutral"
    }},
    "learning": {{
        "memory_tips": ["tip 1", "tip 2"],
        "related_phrases": ["phrase 1", "phrase 2"],
        "difficulty_level": "beginner/intermediate/advanced"
    }}
}}"""
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert language learning assistant. Provide detailed, accurate, and helpful analysis of English phrases and vocabulary. Always respond with valid JSON."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.7,
                max_tokens=1500
            )
            
            content = response.choices[0].message.content
            return json.loads(content)
        except json.JSONDecodeError:
            return {"error": "Failed to parse response", "raw_response": content}
        except Exception as e:
            return {"error": f"OpenAI API error: {str(e)}"}
    
    def generate_exercises(
        self,
        phrase: str,
        meaningful_sentence: str,
        difficulty: str
    ) -> Dict[str, Any]:
        """Generate practice exercises for a phrase"""
        prompt = f"""Generate practice exercises for learning this phrase:

Phrase: "{phrase}"
Context: "{meaningful_sentence}"
Difficulty level: {difficulty}

Create 3-4 exercises in JSON format:
{{
    "exercises": [
        {{
            "type": "fill_blank",
            "question": "sentence with blank",
            "answer": "correct answer",
            "alternatives": ["wrong1", "wrong2", "wrong3"]
        }},
        {{
            "type": "multiple_choice",
            "question": "question about the phrase",
            "answer": "correct answer",
            "alternatives": ["wrong1", "wrong2", "wrong3"]
        }},
        {{
            "type": "translation",
            "source_language": "English",
            "target_language": "Your learning language if known",
            "question": "sentence to translate",
            "answer": "translation"
        }}
    ]
}}"""
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert language teacher. Create effective practice exercises that help reinforce vocabulary and grammar. Always respond with valid JSON."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.8,
                max_tokens=1200
            )
            
            content = response.choices[0].message.content
            return json.loads(content)
        except json.JSONDecodeError:
            return {"error": "Failed to parse response", "raw_response": content}
        except Exception as e:
            return {"error": f"OpenAI API error: {str(e)}"}
    
    def generate_quiz(
        self,
        phrases: list,
        quiz_type: str = "mixed"
    ) -> Dict[str, Any]:
        """Generate a quiz from multiple phrases (for quiz/video generation later)"""
        phrases_text = "\n".join([f"- {p.get('phrase_text', p)}" for p in phrases[:10]])
        
        prompt = f"""Create a quiz based on these learned phrases:

{phrases_text}

Generate a quiz in JSON format:
{{
    "quiz_title": "Quiz Title",
    "quiz_type": "{quiz_type}",
    "questions": [
        {{
            "id": "q1",
            "type": "multiple_choice",
            "question": "question text",
            "answer": "correct answer",
            "alternatives": ["wrong1", "wrong2", "wrong3"],
            "explanation": "why this is correct"
        }}
    ],
    "total_questions": number
}}

Create 5-10 questions that progressively increase in difficulty."""
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert assessment designer. Create engaging, fair quizzes that test real language understanding. Always respond with valid JSON."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.7,
                max_tokens=2000
            )
            
            content = response.choices[0].message.content
            return json.loads(content)
        except json.JSONDecodeError:
            return {"error": "Failed to parse response", "raw_response": content}
        except Exception as e:
            return {"error": f"OpenAI API error: {str(e)}"}
    
    def generate_video_script(
        self,
        phrases: list,
        video_duration: int = 5
    ) -> Dict[str, Any]:
        """Generate a video script for learning materials"""
        phrases_text = "\n".join([f"- {p.get('phrase_text', p)}: {p.get('ai_explanation', '')}" for p in phrases[:5]])
        
        prompt = f"""Create a short educational video script (~{video_duration} minutes) teaching these phrases:

{phrases_text}

Generate script in JSON format:
{{
    "video_title": "title",
    "duration_minutes": {video_duration},
    "sections": [
        {{
            "timestamp": "0:00-1:00",
            "title": "section title",
            "script": "what the narrator should say",
            "visual_suggestions": ["visual idea 1", "visual idea 2"],
            "phrases_covered": ["phrase1", "phrase2"]
        }}
    ],
    "key_takeaways": ["takeaway 1", "takeaway 2"]
}}"""
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert educational video scriptwriter. Create engaging, clear scripts that teach language effectively. Always respond with valid JSON."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.8,
                max_tokens=2500
            )
            
            content = response.choices[0].message.content
            return json.loads(content)
        except json.JSONDecodeError:
            return {"error": "Failed to parse response", "raw_response": content}
        except Exception as e:
            return {"error": f"OpenAI API error: {str(e)}"}
