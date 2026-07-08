import json
import sys

sys.path.insert(0, '/opt/python')

from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.dynamodb_client import DynamoDBClient
from shared.cors import cors_headers as _base_cors

logger = Logger()


def _cors_headers(event: dict) -> dict:
    origin = (event.get('headers') or {}).get('origin') or (event.get('headers') or {}).get('Origin')
    return _base_cors(origin, methods='GET,OPTIONS')


@logger.inject_lambda_context
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    GET /phrases/{phraseId}

    Returns the full PhraseItem for the authenticated user's phrase.

    Response 200:
        { phrase_id, canonical_form, kind, meaning, example, audio,
          source_sentence, source_url, video_title, saved_at, tags, user_notes, language }

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

        user_id = event['requestContext']['authorizer']['claims']['sub']
        logger.info(f'Getting phrase {phrase_id} for user {user_id}')

        db = DynamoDBClient()
        phrase = db.get_phrase_by_id(user_id, phrase_id)

        if phrase is None:
            return {'statusCode': 404, 'headers': hdrs,
                    'body': json.dumps({'error': 'Phrase not found'})}

        return {
            'statusCode': 200,
            'headers': hdrs,
            'body': json.dumps(phrase.model_dump()),
        }

    except Exception as exc:
        logger.exception(f'Error getting phrase: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
