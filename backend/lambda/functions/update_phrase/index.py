import json
import sys
from datetime import datetime

sys.path.insert(0, '/opt/python')

from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.dynamodb_client import DynamoDBClient
from shared.cors import cors_headers as _base_cors

logger = Logger()

UPDATABLE_FIELDS = {'meaning', 'tags', 'user_notes', 'audio'}


def _cors_headers(event: dict) -> dict:
    origin = (event.get('headers') or {}).get('origin') or (event.get('headers') or {}).get('Origin')
    return _base_cors(origin, methods='PATCH,OPTIONS')


@logger.inject_lambda_context
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    PATCH /phrases/{phraseId}

    Update editable fields on a saved phrase: meaning, tags, user_notes, audio.

    Request body (JSON, all fields optional):
        {
            "meaning":    "updated English gloss",
            "tags":       ["tag1", "tag2"],
            "user_notes": "my personal note",
            "audio":      "data:audio/mpeg;base64,..."
        }

    Response 200:
        { phrase_id, updated_fields: [...], updated_at: "..." }

    Response 404:
        { error: "Phrase not found" }
    """
    hdrs = _cors_headers(event)

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': hdrs, 'body': ''}

    try:
        phrase_id = (event.get('pathParameters') or {}).get('phraseId')
        if not phrase_id:
            return {'statusCode': 400, 'headers': hdrs,
                    'body': json.dumps({'error': 'phraseId path parameter required'})}

        body = json.loads(event.get('body') or '{}')
        updates = {k: v for k, v in body.items() if k in UPDATABLE_FIELDS}
        if not updates:
            return {'statusCode': 400, 'headers': hdrs,
                    'body': json.dumps({'error': f'No updatable fields provided. Allowed: {sorted(UPDATABLE_FIELDS)}'})}

        user_id = event['requestContext']['authorizer']['claims']['sub']
        logger.info(f'Updating phrase {phrase_id} for user {user_id}: {list(updates.keys())}')

        db = DynamoDBClient()
        phrase = db.get_phrase_by_id(user_id, phrase_id)
        if phrase is None:
            return {'statusCode': 404, 'headers': hdrs,
                    'body': json.dumps({'error': 'Phrase not found'})}

        now = datetime.utcnow().isoformat()
        updated = db.update_phrase_fields(user_id, phrase_id, updates, now)

        return {
            'statusCode': 200,
            'headers': hdrs,
            'body': json.dumps({
                'phrase_id': phrase_id,
                'updated_fields': list(updates.keys()),
                'updated_at': now,
            }),
        }

    except Exception as exc:
        logger.exception(f'Error updating phrase: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
