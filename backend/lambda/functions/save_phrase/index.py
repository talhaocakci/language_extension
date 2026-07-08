import json
import os
import sys

sys.path.insert(0, '/opt/python')

from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.dynamodb_client import DynamoDBClient
from shared.models import SavePhraseRequest
from shared.cors import cors_headers as _base_cors

logger = Logger()


def _cors_headers(event: dict) -> dict:
    origin = (event.get('headers') or {}).get('origin') or (event.get('headers') or {}).get('Origin')
    return _base_cors(origin, methods='POST,OPTIONS')


@logger.inject_lambda_context
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    POST /phrases

    Body (JSON):
    {
        "canonical_form":  "auf Watte gehen",
        "found_in_text":   "so wie auf Watte",
        "kind":            "idiom",
        "meaning":         "tread carefully",
        "example":         "...",           // optional
        "source_sentence": "Du gehst...",
        "source_url":      "https://youtube.com/watch?v=...",
        "video_title":     "...",
        "tags":            []               // optional
    }

    Response:
    {
        "phrase_id":     "<uuid>",
        "already_exists": false,
        "saved_at":      "..."
    }
    """
    hdrs = _cors_headers(event)

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': hdrs, 'body': ''}

    try:
        body = json.loads(event.get('body') or '{}')
        req = SavePhraseRequest(**body)

        user_id = event['requestContext']['authorizer']['claims']['sub']
        email = event['requestContext']['authorizer']['claims'].get('email', '')

        logger.info(f'Saving phrase for user {user_id}: {req.canonical_form}')

        db = DynamoDBClient()
        db.ensure_user_meta(user_id, email)
        phrase, already_exists = db.save_phrase(user_id, req)

        return {
            'statusCode': 200,
            'headers': hdrs,
            'body': json.dumps({
                'phrase_id': phrase.phrase_id,
                'already_exists': already_exists,
                'saved_at': phrase.saved_at,
            }),
        }

    except Exception as exc:
        logger.exception(f'Error saving phrase: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
