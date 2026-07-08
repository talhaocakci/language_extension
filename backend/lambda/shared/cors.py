"""
CORS helpers shared across all Lambda functions.

Set the ALLOWED_ORIGINS environment variable to a comma-separated list of
origins that are allowed to call the API:

  ALLOWED_ORIGINS=https://your-vocab-app.com,chrome-extension://your-ext-id

If you want to allow all origins during local testing you can set it to '*',
but for production always restrict it to exact origins.
"""
import os

_raw = os.getenv('ALLOWED_ORIGINS', '*')
_allowed_set = {o.strip() for o in _raw.split(',') if o.strip()}


def cors_headers(request_origin: str | None = None, methods: str = 'GET,OPTIONS') -> dict:
    """
    Return CORS response headers.
    If request_origin is in the allowed set, reflect it back (allows credentials).
    If ALLOWED_ORIGINS is '*', always return '*'.
    """
    if _raw == '*':
        origin = '*'
    elif request_origin and request_origin in _allowed_set:
        origin = request_origin
    else:
        origin = list(_allowed_set)[0] if _allowed_set else ''

    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': methods,
    }
