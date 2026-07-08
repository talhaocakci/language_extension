import json
import os
import urllib.error
import urllib.request
from typing import Any

import boto3

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_SECRET_NAME = os.getenv("OPENAI_SECRET_NAME", "getfluentfast/secrets")
OPENAI_SECRET_KEY_NAME = os.getenv("OPENAI_SECRET_KEY_NAME", "openai_api_key")
OPENAI_PROJECT_KEY_NAME = os.getenv("OPENAI_PROJECT_KEY_NAME", "openai_project_id")
OPENAI_API_KEY_FALLBACK = os.getenv("OPENAI_API_KEY", "")
OPENAI_PROJECT_ID_FALLBACK = os.getenv("OPENAI_PROJECT_ID", "")
LLM_PROMPTS_TABLE = os.getenv("LLM_PROMPTS_TABLE", "")
DEFAULT_PROMPT_ID = os.getenv("EXPLAIN_PROMPT_ID", "language_backend:tier3:explain_sentence")
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]

dynamodb = boto3.resource("dynamodb")
secrets = boto3.client("secretsmanager")
_secret_cache: dict[str, Any] | None = None


def _cors_headers(origin: str | None) -> dict[str, str]:
    allow_origin = origin if (origin and (not ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS)) else "*"
    return {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Content-Type": "application/json",
    }


def _response(status_code: int, body: dict[str, Any], origin: str | None) -> dict:
    return {"statusCode": status_code, "headers": _cors_headers(origin), "body": json.dumps(body)}


def _parse_groups(groups_claim: Any) -> list[str]:
    if isinstance(groups_claim, list):
        return [g for g in groups_claim if isinstance(g, str) and g.strip()]

    if not isinstance(groups_claim, str):
        return []

    raw = groups_claim.strip()
    if not raw:
        return []

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [g for g in parsed if isinstance(g, str) and g.strip()]
    except Exception:
        pass

    trimmed = raw.strip("[]")
    return [
        part.strip().strip('"').strip("'")
        for part in trimmed.split(",")
        if part.strip()
    ]


def _is_admin_user(claims: dict[str, Any]) -> bool:
    groups = _parse_groups(claims.get("cognito:groups"))
    return any(g.upper() == "ADMIN" for g in groups)


def _get_prompt_item(prompt_id: str) -> dict[str, Any]:
    if not LLM_PROMPTS_TABLE:
        raise RuntimeError("LLM_PROMPTS_TABLE environment variable is missing")

    table = dynamodb.Table(LLM_PROMPTS_TABLE)
    resp = table.get_item(Key={"prompt_id": prompt_id})
    item = resp.get("Item")
    if not item:
        raise ValueError(f"Prompt not found: {prompt_id}")
    if item.get("is_active") is False:
        raise ValueError(f"Prompt is inactive: {prompt_id}")
    return item


def _render_template(template: str, sentence: str) -> str:
    # Support both handlebars and python-format style placeholders.
    out = template.replace("{{sentence}}", sentence)
    if "{sentence}" in out:
        out = out.replace("{sentence}", sentence)
    return out


def _build_openai_messages(prompt_item: dict[str, Any], sentence: str) -> tuple[list[dict[str, str]], str, float, str]:
    # Schema A (new): system_prompt + user_prompt_template
    system_prompt = str(prompt_item.get("system_prompt") or "").strip()
    user_template = str(prompt_item.get("user_prompt_template") or "").strip()

    # Schema B (current live table): body
    if not system_prompt and not user_template:
        body_prompt = str(prompt_item.get("body") or "").strip()
        if body_prompt:
            system_prompt = body_prompt
            user_template = "Sentence: {sentence}"

    if not system_prompt or not user_template:
        raise ValueError("Prompt item must include either body or system_prompt/user_prompt_template")

    model = str(prompt_item.get("model") or "gpt-4o-mini")
    temperature = float(prompt_item.get("temperature") or 0)
    response_format = str(prompt_item.get("response_format") or "json_object")
    user_prompt = _render_template(user_template, sentence)

    return (
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model,
        temperature,
        response_format,
    )


def _load_secret() -> dict[str, Any]:
    global _secret_cache
    if _secret_cache is not None:
        return _secret_cache
    value = secrets.get_secret_value(SecretId=OPENAI_SECRET_NAME)
    text = value.get("SecretString") or "{}"
    _secret_cache = json.loads(text)
    return _secret_cache


def _resolve_openai_credentials() -> tuple[str, str]:
    key = OPENAI_API_KEY_FALLBACK
    project = OPENAI_PROJECT_ID_FALLBACK
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
        pass
    return str(key or ""), str(project or "")


def _fallback_analysis(sentence: str) -> dict[str, Any]:
    lower = sentence.lower()
    fixed: list[dict[str, str]] = []

    if "geht um" in lower or "es geht um" in lower:
        fixed.append(
            {
                "foundInText": "geht um",
                "kind": "expression",
                "canonicalForm": "es geht um",
                "meaning": "to be about / to concern",
                "example": "In diesem Kapitel geht es um deutsche Geschichte.",
            }
        )

    if " halten" in lower and " für " in lower:
        fixed.append(
            {
                "foundInText": "für ... halten",
                "kind": "construction",
                "canonicalForm": "jemanden/etwas für ... halten",
                "meaning": "to consider someone/something as ...",
                "example": "Viele halten ihn für sehr talentiert.",
            }
        )

    return {
        "phrasalVerbs": [],
        "fixedPhrases": fixed,
        "note": "Fallback analysis used because the upstream LLM key is not configured correctly.",
    }


def lambda_handler(event: dict, _context: object) -> dict:
    request_headers = event.get("headers") or {}
    origin = request_headers.get("origin") or request_headers.get("Origin")
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": _cors_headers(origin), "body": ""}

    try:
        claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
        user_id = claims.get("sub", "unknown")
        if not _is_admin_user(claims):
            return _response(403, {"error": "ADMIN group membership required"}, origin)

        body = json.loads(event.get("body") or "{}")
        sentence = str(body.get("sentence") or "").strip()
        prompt_id = str(body.get("prompt_id") or DEFAULT_PROMPT_ID)
        if not sentence:
            return _response(400, {"error": "sentence is required"}, origin)

        openai_api_key, openai_project_id = _resolve_openai_credentials()
        if not openai_api_key:
            return _response(500, {"error": "OpenAI key missing in Secrets Manager and env fallback"}, origin)

        prompt_item = _get_prompt_item(prompt_id)
        messages, model, temperature, response_format = _build_openai_messages(prompt_item, sentence)
        openai_payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "response_format": {"type": response_format},
        }

        openai_headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {openai_api_key}",
        }
        if openai_project_id:
            openai_headers["OpenAI-Project"] = openai_project_id

        req = urllib.request.Request(
            OPENAI_URL,
            data=json.dumps(openai_payload).encode(),
            headers=openai_headers,
            method="POST",
        )

        print(f"explain: user={user_id} prompt_id={prompt_id} model={model}")
        with urllib.request.urlopen(req, timeout=55) as resp:
            openai_body = json.loads(resp.read())

        content = (openai_body.get("choices") or [{}])[0].get("message", {}).get("content") or "{}"
        try:
            analysis = json.loads(content)
        except Exception:
            analysis = {"phrasalVerbs": [], "fixedPhrases": [], "note": content}

        return _response(
            200,
            {
                "analysis": analysis,
                "prompt_id": prompt_id,
            },
            origin,
        )
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode()
        if exc.code == 401:
            return _response(
                200,
                {
                    "analysis": _fallback_analysis(sentence),
                    "prompt_id": prompt_id,
                    "warning": "LLM provider credentials are invalid on the backend; returned fallback analysis.",
                },
                origin,
            )
        return _response(502, {"error": f"OpenAI {exc.code}: {error_body}"}, origin)
    except Exception as exc:
        return _response(500, {"error": str(exc)}, origin)
