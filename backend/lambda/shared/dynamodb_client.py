import base64
import json
import os
import uuid
import boto3
from boto3.dynamodb.conditions import Key
from datetime import datetime
from typing import Optional, List, Tuple

from .models import UserMetaItem, PhraseItem, SavePhraseRequest

dynamodb = boto3.resource('dynamodb')
TABLE_NAME = os.environ.get('TABLE_NAME', 'langext-phrases-prod')


def _user_pk(user_id: str) -> str:
    """Normalise PK so it always starts with 'u#'."""
    return user_id if user_id.startswith('u#') else f'u#{user_id}'


def _phrase_sk(phrase_id: str) -> str:
    return f'phrase#{phrase_id}'


def _encode_cursor(last_evaluated_key: dict) -> str:
    return base64.b64encode(json.dumps(last_evaluated_key).encode()).decode()


def _decode_cursor(cursor: str) -> dict:
    return json.loads(base64.b64decode(cursor.encode()).decode())


class DynamoDBClient:
    def __init__(self):
        self.table = dynamodb.Table(TABLE_NAME)

    # ── User meta ──────────────────────────────────────────────────────────────

    def get_user_meta(self, raw_user_id: str) -> Optional[UserMetaItem]:
        uid = _user_pk(raw_user_id)
        resp = self.table.get_item(Key={'user_id': uid, 'sort_key': 'META'})
        if 'Item' not in resp:
            return None
        return UserMetaItem(**resp['Item'])

    def ensure_user_meta(self, raw_user_id: str, email: str) -> UserMetaItem:
        """Return existing meta or create it."""
        meta = self.get_user_meta(raw_user_id)
        if meta:
            return meta
        now = datetime.utcnow().isoformat()
        meta = UserMetaItem(
            user_id=_user_pk(raw_user_id),
            email=email,
            created_at=now,
            updated_at=now
        )
        self.table.put_item(Item=meta.model_dump())
        return meta

    def increment_phrase_count(self, raw_user_id: str, delta: int = 1) -> None:
        uid = _user_pk(raw_user_id)
        self.table.update_item(
            Key={'user_id': uid, 'sort_key': 'META'},
            UpdateExpression='SET total_phrases = total_phrases + :d, updated_at = :t',
            ExpressionAttributeValues={':d': delta, ':t': datetime.utcnow().isoformat()}
        )

    # ── Phrases ────────────────────────────────────────────────────────────────

    def save_phrase(
        self,
        raw_user_id: str,
        req: SavePhraseRequest
    ) -> Tuple[PhraseItem, bool]:
        """
        Persist a phrase item.  Returns (item, already_exists).
        Duplicates are detected by querying GSI1 (canonical_form_index).
        """
        uid = _user_pk(raw_user_id)

        # Deduplication check via GSI1
        existing = self.get_phrase_by_canonical_form(raw_user_id, req.canonical_form)
        if existing:
            return existing, True

        phrase_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        item = PhraseItem(
            user_id=uid,
            sort_key=_phrase_sk(phrase_id),
            phrase_id=phrase_id,
            canonical_form=req.canonical_form,
            found_in_text=req.found_in_text,
            kind=req.kind,
            meaning=req.meaning,
            example=req.example,
            language=req.language,
            audio=req.audio,
            source_sentence=req.source_sentence,
            source_url=req.source_url,
            video_title=req.video_title,
            saved_at=now,
            tags=req.tags
        )
        self.table.put_item(Item=item.model_dump())
        self.increment_phrase_count(raw_user_id, 1)
        return item, False

    def get_phrase_by_canonical_form(
        self, raw_user_id: str, canonical_form: str
    ) -> Optional[PhraseItem]:
        uid = _user_pk(raw_user_id)
        resp = self.table.query(
            IndexName='canonical_form_index',
            KeyConditionExpression=Key('canonical_form').eq(canonical_form) & Key('user_id').eq(uid),
            Limit=1
        )
        items = resp.get('Items', [])
        return PhraseItem(**items[0]) if items else None

    def get_user_phrases(
        self,
        raw_user_id: str,
        kind: Optional[str] = None,
        limit: int = 50,
        cursor: Optional[str] = None
    ) -> Tuple[List[PhraseItem], Optional[str]]:
        """
        Return (phrases, next_cursor).
        If kind is given, query GSI2 (kind_index); otherwise query main table
        with begins_with SK 'phrase#'.
        """
        uid = _user_pk(raw_user_id)
        kwargs: dict = {'Limit': limit}
        if cursor:
            kwargs['ExclusiveStartKey'] = _decode_cursor(cursor)

        if kind:
            kwargs['IndexName'] = 'kind_index'
            kwargs['KeyConditionExpression'] = (
                Key('user_id').eq(uid) & Key('kind').eq(kind)
            )
        else:
            kwargs['KeyConditionExpression'] = (
                Key('user_id').eq(uid) & Key('sort_key').begins_with('phrase#')
            )

        resp = self.table.query(**kwargs)
        phrases = [PhraseItem(**i) for i in resp.get('Items', [])]
        lek = resp.get('LastEvaluatedKey')
        next_cursor = _encode_cursor(lek) if lek else None
        return phrases, next_cursor

    def delete_phrase(self, raw_user_id: str, phrase_id: str) -> bool:
        uid = _user_pk(raw_user_id)
        sk = _phrase_sk(phrase_id)
        try:
            self.table.delete_item(
                Key={'user_id': uid, 'sort_key': sk},
                ConditionExpression='attribute_exists(phrase_id)'
            )
            self.increment_phrase_count(raw_user_id, -1)
            return True
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            return False

    def get_phrase_by_id(self, raw_user_id: str, phrase_id: str) -> Optional[PhraseItem]:
        uid = _user_pk(raw_user_id)
        resp = self.table.get_item(Key={'user_id': uid, 'sort_key': _phrase_sk(phrase_id)})
        if 'Item' not in resp:
            return None
        return PhraseItem(**resp['Item'])

    def update_phrase_fields(
        self,
        raw_user_id: str,
        phrase_id: str,
        updates: dict,
        updated_at: str,
    ) -> bool:
        """Update arbitrary editable fields on a PhraseItem via UpdateExpression."""
        uid = _user_pk(raw_user_id)
        sk = _phrase_sk(phrase_id)

        set_parts = ['updated_at = :updated_at']
        expr_values: dict = {':updated_at': updated_at}
        expr_names: dict = {}

        for i, (field, value) in enumerate(updates.items()):
            placeholder = f':v{i}'
            name_alias = f'#f{i}'
            set_parts.append(f'{name_alias} = {placeholder}')
            expr_values[placeholder] = value
            expr_names[name_alias] = field

        kwargs: dict = {
            'Key': {'user_id': uid, 'sort_key': sk},
            'UpdateExpression': 'SET ' + ', '.join(set_parts),
            'ExpressionAttributeValues': expr_values,
            'ConditionExpression': 'attribute_exists(phrase_id)',
        }
        if expr_names:
            kwargs['ExpressionAttributeNames'] = expr_names
        self.table.update_item(**kwargs)
        return True

    def get_phrase_count_by_kind(self, raw_user_id: str) -> dict:
        """
        Return a {kind: count} dict by querying the kind_index GSI for each
        known phrase kind.  Uses a scan with filter to avoid multiple index
        queries when the kind list is small.
        """
        uid = _user_pk(raw_user_id)
        resp = self.table.query(
            KeyConditionExpression=Key('user_id').eq(uid) & Key('sort_key').begins_with('phrase#'),
        )
        counts: dict = {}
        for item in resp.get('Items', []):
            kind = item.get('kind', 'unknown')
            counts[kind] = counts.get(kind, 0) + 1
        # paginate if needed
        while resp.get('LastEvaluatedKey'):
            resp = self.table.query(
                KeyConditionExpression=Key('user_id').eq(uid) & Key('sort_key').begins_with('phrase#'),
                ExclusiveStartKey=resp['LastEvaluatedKey'],
            )
            for item in resp.get('Items', []):
                kind = item.get('kind', 'unknown')
                counts[kind] = counts.get(kind, 0) + 1
        return counts
