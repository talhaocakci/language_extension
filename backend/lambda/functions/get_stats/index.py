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
    GET /stats

    Returns the authenticated student's learning stats, derived from
    their UserMetaItem and a kind_index query breakdown.

    Response 200:
        {
            "total_phrases": 42,
            "by_kind": {
                "idiom": 18,
                "phrasal_verb": 12,
                "collocation": 8,
                "connector": 4
            },
            "created_at": "...",
            "updated_at": "..."
        }
    """
    hdrs = _cors_headers(event)

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': hdrs, 'body': ''}

    try:
        user_id = event['requestContext']['authorizer']['claims']['sub']
        logger.info(f'Getting stats for user {user_id}')

        db = DynamoDBClient()
        meta = db.get_user_meta(user_id)

        if meta is None:
            return {
                'statusCode': 200,
                'headers': hdrs,
                'body': json.dumps({
                    'total_phrases': 0,
                    'by_kind': {},
                    'created_at': None,
                    'updated_at': None,
                }),
            }

        by_kind = db.get_phrase_count_by_kind(user_id)

        return {
            'statusCode': 200,
            'headers': hdrs,
            'body': json.dumps({
                'total_phrases': meta.total_phrases,
                'by_kind': by_kind,
                'created_at': meta.created_at,
                'updated_at': meta.updated_at,
            }),
        }

    except Exception as exc:
        logger.exception(f'Error getting stats: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
