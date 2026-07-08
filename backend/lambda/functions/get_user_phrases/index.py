import json
import sys

sys.path.insert(0, '/opt/python')

from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.dynamodb_client import DynamoDBClient
from shared.cors import cors_headers as _base_cors

logger = Logger()

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


def _cors_headers(event: dict) -> dict:
    origin = (event.get('headers') or {}).get('origin') or (event.get('headers') or {}).get('Origin')
    return _base_cors(origin, methods='GET,OPTIONS')


@logger.inject_lambda_context
def lambda_handler(event: dict, context: LambdaContext) -> dict:
    """
    GET /phrases

    Query parameters (all optional):
      kind   — filter by phrase kind (idiom | phrasal_verb | collocation | …)
      limit  — page size (default 50, max 200)
      cursor — opaque pagination token from previous response next_cursor

    Response:
    {
        "phrases":     [ { ...PhraseItem fields... } ],
        "count":       42,
        "next_cursor": "<token or null>"
    }
    """
    hdrs = _cors_headers(event)

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': hdrs, 'body': ''}

    try:
        user_id = event['requestContext']['authorizer']['claims']['sub']
        qp = event.get('queryStringParameters') or {}

        kind = qp.get('kind') or None
        limit = min(int(qp.get('limit', DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
        cursor = qp.get('cursor') or None

        logger.info(f'Fetching phrases for user {user_id} kind={kind} limit={limit}')

        db = DynamoDBClient()
        phrases, next_cursor = db.get_user_phrases(
            raw_user_id=user_id,
            kind=kind,
            limit=limit,
            cursor=cursor
        )

        return {
            'statusCode': 200,
            'headers': hdrs,
            'body': json.dumps({
                'phrases': [json.loads(p.model_dump_json()) for p in phrases],
                'count': len(phrases),
                'next_cursor': next_cursor,
            }),
        }

    except Exception as exc:
        logger.exception(f'Error fetching phrases: {exc}')
        return {
            'statusCode': 500,
            'headers': hdrs,
            'body': json.dumps({'error': str(exc)}),
        }
