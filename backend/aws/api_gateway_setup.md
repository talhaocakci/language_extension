# AWS API Gateway Setup Guide

## 1. Create REST API

```bash
aws apigateway create-rest-api \
  --name SubtitleLearningExtensionAPI \
  --description "API for Subtitle Learning Chrome Extension" \
  --endpoint-configuration types=REGIONAL
```

**Output:** Save the `id` as `API_ID`

## 2. Create Cognito Authorizer

```bash
aws apigateway create-authorizer \
  --rest-api-id API_ID \
  --name CognitoAuthorizer \
  --type COGNITO_USER_POOLS \
  --provider-arn arn:aws:cognito-idp:us-east-1:ACCOUNT_ID:userpool/us-east-1_XXXXXXXXX \
  --identity-source method.request.header.Authorization
```

**Output:** Save the `id` as `AUTHORIZER_ID`

## 3. API Resources & Methods

### Resource: `/phrases`

#### POST /phrases (Save new phrase)
- **Authorization:** Cognito
- **Lambda:** save_phrase
- **Request Model:**
```json
{
  "phrase_text": "string",
  "meaningful_sentence": "string",
  "grammar_analysis": {
    "sentence": "string",
    "grammatical_structure": "string",
    "phrases": [],
    "difficulty": "string"
  },
  "ai_explanation": "string",
  "timestamps": {},
  "source_url": "string",
  "platform": "youtube|netflix",
  "video_title": "string"
}
```

#### GET /phrases (Get all phrases)
- **Authorization:** Cognito
- **Lambda:** get_user_phrases
- **Query Parameters:**
  - `difficulty` (optional): beginner|intermediate|advanced
  - `tags` (optional): comma-separated
  - `limit` (optional): default 999999
  - `offset` (optional): default 0

#### DELETE /phrases/{phraseId}
- **Authorization:** Cognito
- **Lambda:** delete_phrase
- **Path Parameter:** phraseId

### Resource: `/phrases/{phraseId}/analyze`

#### POST /phrases/{phraseId}/analyze (Analyze a phrase)
- **Authorization:** Cognito
- **Lambda:** analyze_phrase
- **Request Model:**
```json
{
  "phrase": "string",
  "meaningful_sentence": "string",
  "context": "optional string"
}
```

### Resource: `/quiz`

#### POST /quiz (Generate quiz)
- **Authorization:** Cognito
- **Lambda:** generate_quiz
- **Request Model:**
```json
{
  "num_phrases": 10,
  "difficulty": "all|beginner|intermediate|advanced",
  "quiz_type": "multiple_choice|fill_blank|mixed",
  "tags": "optional,comma,separated"
}
```

### Resource: `/video-script`

#### POST /video-script (Generate video script)
- **Authorization:** Cognito
- **Lambda:** generate_video_script
- **Request Model:**
```json
{
  "num_phrases": 5,
  "video_duration": 5,
  "difficulty": "all|beginner|intermediate|advanced",
  "tags": "optional,comma,separated"
}
```

## 4. Create Resource & Method Using AWS CLI

```bash
# Get root resource ID
ROOT_ID=$(aws apigateway get-resources \
  --rest-api-id API_ID \
  --query 'items[0].id' \
  --output text)

# Create /phrases resource
PHRASES_RESOURCE=$(aws apigateway create-resource \
  --rest-api-id API_ID \
  --parent-id $ROOT_ID \
  --path-part phrases \
  --query 'id' \
  --output text)

# Create POST method
aws apigateway put-method \
  --rest-api-id API_ID \
  --resource-id $PHRASES_RESOURCE \
  --http-method POST \
  --authorization-type COGNITO_USER_POOLS \
  --authorizer-id AUTHORIZER_ID \
  --request-parameters method.request.header.Authorization=true

# Create Lambda integration
aws apigateway put-integration \
  --rest-api-id API_ID \
  --resource-id $PHRASES_RESOURCE \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:ACCOUNT_ID:function:save_phrase/invocations
```

## 5. Deploy API

```bash
aws apigateway create-deployment \
  --rest-api-id API_ID \
  --stage-name prod \
  --stage-description "Production deployment"

# Get the API endpoint
API_ENDPOINT=$(aws apigateway get-stage \
  --rest-api-id API_ID \
  --stage-name prod \
  --query 'invokeUrl' \
  --output text)

echo "API Endpoint: $API_ENDPOINT"
```

## 6. Enable CORS

```bash
# For each resource and method, add CORS headers in integration response
aws apigateway put-method-response \
  --rest-api-id API_ID \
  --resource-id RESOURCE_ID \
  --http-method POST \
  --status-code 200 \
  --response-parameters method.response.header.Access-Control-Allow-Headers=true,method.response.header.Access-Control-Allow-Methods=true,method.response.header.Access-Control-Allow-Origin=true

aws apigateway put-integration-response \
  --rest-api-id API_ID \
  --resource-id RESOURCE_ID \
  --http-method POST \
  --status-code 200 \
  --response-parameters method.response.header.Access-Control-Allow-Headers='\'Content-Type\'',method.response.header.Access-Control-Allow-Methods='\'POST,GET,DELETE,OPTIONS\'',method.response.header.Access-Control-Allow-Origin='\'*\''
```

## Configuration Reference

Save for extension configuration:

```
API_ENDPOINT=https://XXXXXXXX.execute-api.us-east-1.amazonaws.com/prod
COGNITO_DOMAIN=https://YOUR_USER_POOL_ID.auth.us-east-1.amazoncognito.com
CLIENT_ID=your_client_id
REDIRECT_URI=chrome-extension://YOUR_EXTENSION_ID/callback.html
```
