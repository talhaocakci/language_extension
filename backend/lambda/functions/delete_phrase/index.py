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
    return _base_cors(origin, methods='DELETE,OPTIONS')


@logger.inject_lambda_context
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    DELETE /phrases/{phraseId}

    Returns 204 on success, 404 if phrase not found.
    """
    hdrs = _cors_headers(event)

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': hdrs, 'body': ''}

    try:
        user_id = event['requestContext']['authorizer']['claims']['sub']
        phrase_id = (event.get('pathParameters') or {}).get('phraseId')

        if not phrase_id:
            return {
                'statusCode': 400,
                'headers': hdrs,
                'body': json.dumps({'error': 'phraseId path parameter is required'}),
            }

        logger.info(f'Deleting phrase {phrase_id} for user {user_id}')

        db = DynamoDBClient()
        deleted = db.delete_phrase(user_id, phrase_id)

        if not deleted:
            return {
                'statusCode': 404,
                'headers': hdrs,
                'body': json.dumps({'error': 'Phrase not found'}),
            }

        return {'statusCode': 204, 'headers': hdrs, 'body': ''}

    except Exception as exc:
        logger.exception(f'Error deleting phrase: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
