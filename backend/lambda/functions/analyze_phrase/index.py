import json
import os
import uuid
from datetime import datetime
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes.api_gateway_event import APIGatewayProxyEvent
from aws_lambda_powertools.utilities.data_classes.common import BaseProxyEvent
from aws_lambda_powertools.utilities.typing import LambdaContext

import sys
sys.path.insert(0, '/opt/python')
from shared.openai_client import OpenAIClient
from shared.models import AnalysisRequest

logger = Logger()
tracer = Tracer()


def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    Lambda function to analyze a phrase using OpenAI
    
    Expected input:
    {
        "phrase": "string",
        "meaningful_sentence": "string",
        "context": "optional string"
    }
    """
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        request = AnalysisRequest(**body)
        
        # Get user from authorizer context
        user_id = event['requestContext']['authorizer']['claims']['sub']
        
        logger.info(f"Analyzing phrase for user {user_id}: {request.phrase}")
        
        # Call OpenAI
        ai_client = OpenAIClient()
        analysis = ai_client.analyze_phrase(
            phrase=request.phrase,
            meaningful_sentence=request.meaningful_sentence,
            context=request.context
        )
        
        # Generate exercises
        exercises = ai_client.generate_exercises(
            phrase=request.phrase,
            meaningful_sentence=request.meaningful_sentence,
            difficulty=analysis.get('learning', {}).get('difficulty_level', 'intermediate')
        )
        
        response = {
            "analysis": analysis,
            "exercises": exercises.get('exercises', []),
            "timestamp": datetime.utcnow().isoformat()
        }
        
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': os.getenv('ALLOWED_ORIGINS', '*')
            },
            'body': json.dumps(response)
        }
    
    except Exception as e:
        logger.exception(f"Error analyzing phrase: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)})
        }
