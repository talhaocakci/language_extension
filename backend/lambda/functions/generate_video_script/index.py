import json
import os
import uuid
from datetime import datetime
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext

import sys
sys.path.insert(0, '/opt/python')
from shared.dynamodb_client import DynamoDBClient
from shared.openai_client import OpenAIClient

logger = Logger()
tracer = Tracer()


def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    Lambda function to generate a video script from user's learned phrases
    
    Expected input:
    {
        "num_phrases": optional (default: 5, max: 10),
        "video_duration": optional (2-10 minutes, default: 5),
        "difficulty": optional (beginner|intermediate|advanced|all),
        "tags": optional (comma-separated tags to filter by)
    }
    """
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        
        # Get user from authorizer context
        user_id = event['requestContext']['authorizer']['claims']['sub']
        
        num_phrases = min(int(body.get('num_phrases', 5)), 10)
        video_duration = min(int(body.get('video_duration', 5)), 10)
        video_duration = max(video_duration, 2)
        difficulty = body.get('difficulty', 'all')
        tags_str = body.get('tags')
        
        logger.info(f"Generating video script for user {user_id}")
        
        # Initialize DynamoDB client
        db = DynamoDBClient()
        
        # Get user's phrases
        if difficulty == 'all':
            phrases = db.get_user_phrases(user_id)
        else:
            phrases = db.get_phrases_by_difficulty(user_id, difficulty)
        
        # Filter by tags if provided
        if tags_str:
            tags = [t.strip() for t in tags_str.split(',')]
            phrases = [
                p for p in phrases 
                if any(tag in p.tags for tag in tags)
            ]
        
        # Limit phrases
        phrases = phrases[:num_phrases]
        
        if not phrases:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'No phrases found matching criteria'})
            }
        
        # Prepare phrase data for OpenAI
        phrases_data = [
            {
                'phrase_text': p.phrase_text,
                'ai_explanation': p.ai_explanation,
                'meaningful_sentence': p.meaningful_sentence,
                'difficulty': p.grammar_analysis.difficulty
            }
            for p in phrases
        ]
        
        # Generate video script using OpenAI
        ai_client = OpenAIClient()
        video_script = ai_client.generate_video_script(phrases_data, video_duration)
        
        if 'error' in video_script:
            return {
                'statusCode': 500,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(video_script)
            }
        
        # Add metadata
        video_script['video_id'] = str(uuid.uuid4())
        video_script['generated_at'] = datetime.utcnow().isoformat()
        video_script['phrases_used'] = len(phrases)
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': os.getenv('ALLOWED_ORIGINS', '*')
            },
            'body': json.dumps(video_script)
        }
    
    except Exception as e:
        logger.exception(f"Error generating video script: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
