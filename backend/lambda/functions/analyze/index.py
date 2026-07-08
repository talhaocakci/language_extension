"""
LLM proxy Lambda — behind API Gateway with Cognito authorizer.

API Gateway validates the Cognito ID token and injects the user's claims
into event['requestContext']['authorizer']['claims'].
This Lambda just reads those claims, then forwards the request to OpenAI.
"""

import json
import os
import urllib.request
import urllib.error
import boto3

OPENAI_URL     = "https://api.openai.com/v1/chat/completions"
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
OPENAI_SECRET_NAME = os.environ.get("OPENAI_SECRET_NAME", "getfluentfast/secrets")
OPENAI_SECRET_KEY_NAME = os.environ.get("OPENAI_SECRET_KEY_NAME", "openai_api_key")
OPENAI_PROJECT_KEY_NAME = os.environ.get("OPENAI_PROJECT_KEY_NAME", "openai_project_id")
OPENAI_API_KEY_FALLBACK = os.environ.get("OPENAI_API_KEY", "")
OPENAI_PROJECT_FALLBACK = os.environ.get("OPENAI_PROJECT_ID", "")

secrets = boto3.client("secretsmanager")
_secret_cache: dict | None = None


def _load_secret() -> dict:
    global _secret_cache
    if _secret_cache is not None:
        return _secret_cache
    value = secrets.get_secret_value(SecretId=OPENAI_SECRET_NAME)
    text = value.get("SecretString") or "{}"
    _secret_cache = json.loads(text)
    return _secret_cache


def _resolve_openai_credentials() -> tuple[str, str]:
    key = OPENAI_API_KEY_FALLBACK
    project = OPENAI_PROJECT_FALLBACK
    try:
        secret = _load_secret()
        key = (
            secret.get(OPENAI_SECRET_KEY_NAME)
            or secret.get("openai_api_key")
            or secret.get("openai_admin_api_key")
            or key
        )
        project = secret.get(OPENAI_PROJECT_KEY_NAME) or secret.get("openai_project_id") or project
    except Exception:
        # Fall back to env vars if secret read fails.
        pass
    return str(key or ""), str(project or "")


def _cors_headers(request_origin: str | None) -> dict:
    origin = request_origin if (request_origin and (not ALLOWED_ORIGINS or request_origin in ALLOWED_ORIGINS)) else "*"
    return {
        "Access-Control-Allow-Origin":  origin,
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Content-Type":                 "application/json",
    }


def _response(status: int, body: dict, origin: str | None = None) -> dict:
    return {
        "statusCode": status,
        "headers":    _cors_headers(origin),
        "body":       json.dumps(body),
    }


def lambda_handler(event: dict, _context: object) -> dict:
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    origin  = headers.get("origin")

    # User identity injected by API Gateway Cognito authorizer
    claims  = (event.get("requestContext") or {}).get("authorizer", {}).get("claims", {})
    user_id = claims.get("sub", "unknown")

    # Parse request body (same OpenAI shape: messages, model, etc.)
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body"}, origin)

    openai_payload = {
        "model":           body.get("model", "gpt-4o-mini"),
        "messages":        body.get("messages", []),
        "temperature":     body.get("temperature", 0),
        "response_format": body.get("response_format", {"type": "json_object"}),
    }

    if not openai_payload["messages"]:
        return _response(400, {"error": "messages array is required"}, origin)

    openai_api_key, openai_project = _resolve_openai_credentials()
    if not openai_api_key:
        return _response(500, {"error": "OpenAI key missing in Secrets Manager and env fallback"}, origin)

    print(f"analyze: user={user_id} model={openai_payload['model']} msgs={len(openai_payload['messages'])}")

    openai_headers = {
        "Content-Type":  "application/json",
        "Authorization": f"Bearer {openai_api_key}",
    }
    if openai_project:
        openai_headers["OpenAI-Project"] = openai_project

    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(openai_payload).encode(),
        headers=openai_headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=55) as resp:
            openai_body = json.loads(resp.read())
        return _response(200, openai_body, origin)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode()
        return _response(502, {"error": f"OpenAI {exc.code}: {error_body}"}, origin)
    except Exception as exc:
        return _response(502, {"error": str(exc)}, origin)
