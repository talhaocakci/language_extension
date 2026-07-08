# Complete AWS Backend Setup Guide

This guide walks you through setting up the complete AWS infrastructure for the Subtitle Learning Chrome Extension with Lambda, API Gateway, Cognito, and DynamoDB.

## Architecture Overview

```
Chrome Extension (Client)
    ↓
Cognito (Authentication)
    ↓
API Gateway (REST API)
    ↓
Lambda Functions (Python)
    ↓
DynamoDB (Data Storage)
    ↓
OpenAI API (AI Processing)
```

## Prerequisites

- AWS Account with billing enabled
- AWS CLI v2 installed and configured
- Python 3.9+ (for Lambda functions)
- Node.js and npm (for extension build)
- OpenAI API key

## Step 1: Set Up AWS Environment

### 1.1 Configure AWS CLI

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter default region (e.g., us-east-1)
# Enter default output format (json)
```

### 1.2 Set Environment Variables

```bash
export AWS_REGION=us-east-1
export PROJECT_NAME=subtitle-learning
export OPENAI_API_KEY=sk-...your-key-here...
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

## Step 2: Create DynamoDB Table

### 2.1 Create the Table

```bash
aws dynamodb create-table \
  --table-name SubtitleLearningData \
  --attribute-definitions AttributeName=user_id,AttributeType=S \
  --key-schema AttributeName=user_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamViewType=NEW_AND_OLD_IMAGES \
  --tags Key=Application,Value=SubtitleLearningExtension Key=Environment,Value=prod
```

### 2.2 Verify Table Creation

```bash
aws dynamodb describe-table --table-name SubtitleLearningData
```

**Output:** Should show table status as `ACTIVE`

## Step 3: Set Up IAM Roles and Policies

### 3.1 Create Lambda Execution Role

```bash
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name subtitle-learning-lambda-role \
  --assume-role-policy-document file://trust-policy.json
```

### 3.2 Create and Attach Inline Policy

```bash
cat > lambda-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:ACCOUNT_ID:table/SubtitleLearningData"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name subtitle-learning-lambda-role \
  --policy-name SubtitleLearningLambdaPolicy \
  --policy-document file://lambda-policy.json
```

### 3.3 Attach CloudWatch Logs Policy

```bash
aws iam attach-role-policy \
  --role-name subtitle-learning-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

## Step 4: Create and Deploy Lambda Functions

### 4.1 Build Lambda Deployment Packages

```bash
cd backend/lambda

# Create layers for dependencies
mkdir -p python-layer/python
pip install -r requirements.txt -t python-layer/python/

# Publish layer
aws lambda publish-layer-version \
  --layer-name subtitle-learning-deps \
  --zip-file fileb://python-layer.zip \
  --compatible-runtimes python3.11
```

### 4.2 Deploy Each Lambda Function

```bash
# For each function (analyze_phrase, save_phrase, etc.)

FUNCTION_NAME="analyze_phrase"
ROLE_ARN=$(aws iam get-role --role-name subtitle-learning-lambda-role --query 'Role.Arn' --output text)

cd functions/$FUNCTION_NAME
zip -r function.zip . -x "*.pyc" "__pycache__/*"

aws lambda create-function \
  --function-name $FUNCTION_NAME \
  --runtime python3.11 \
  --role $ROLE_ARN \
  --handler index.lambda_handler \
  --zip-file fileb://function.zip \
  --timeout 60 \
  --memory-size 512 \
  --environment "Variables={OPENAI_API_KEY=$OPENAI_API_KEY}" \
  --layers arn:aws:lambda:us-east-1:ACCOUNT_ID:layer:subtitle-learning-deps:1
```

### 4.3 Repeat for All Functions

- `analyze_phrase` - AI analysis of phrases
- `save_phrase` - Save to DynamoDB
- `get_user_phrases` - Retrieve phrases
- `generate_quiz` - Generate quizzes
- `generate_video_script` - Generate video scripts

Or use the automated deployment script:

```bash
cd backend/aws
chmod +x deploy.sh
./deploy.sh
```

## Step 5: Set Up Cognito User Pool

### 5.1 Create User Pool

```bash
aws cognito-idp create-user-pool \
  --pool-name SubtitleLearningExtension \
  --policies PasswordPolicy='{MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
  --auto-verified-attributes email \
  --schema '[
    {
      "Name": "email",
      "AttributeDataType": "String",
      "Required": true,
      "Mutable": true
    },
    {
      "Name": "name",
      "AttributeDataType": "String",
      "Required": true,
      "Mutable": true
    }
  ]'
```

**Save the `UserPoolId`** (format: `us-east-1_XXXXXXXXX`)

### 5.2 Create User Pool Domain

```bash
USER_POOL_ID="us-east-1_XXXXXXXXX"

aws cognito-idp create-user-pool-domain \
  --domain subtitle-learning-$(date +%s) \
  --user-pool-id $USER_POOL_ID
```

### 5.3 Create User Pool Client (App Client)

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id $USER_POOL_ID \
  --client-name SubtitleExtensionClient \
  --generate-secret \
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_PASSWORD_AUTH \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --callback-urls 'chrome-extension://YOUR_EXTENSION_ID/callback.html' \
  --logout-urls 'chrome-extension://YOUR_EXTENSION_ID/logout.html'
```

**Save the `ClientId` and `ClientSecret`**

### 5.4 Create Identity Pool

```bash
CLIENT_ID="your_client_id"

aws cognito-identity create-identity-pool \
  --identity-pool-name SubtitleLearningExtension \
  --allow-unauthenticated-identities false \
  --cognito-identity-providers \
    ProviderName=cognito-idp.us-east-1.amazonaws.com/$USER_POOL_ID,ClientId=$CLIENT_ID,ServerSideTokenValidation=true
```

**Save the `IdentityPoolId`**

## Step 6: Set Up API Gateway

### 6.1 Create REST API

```bash
API_ID=$(aws apigateway create-rest-api \
  --name SubtitleLearningAPI \
  --description "API for Subtitle Learning Extension" \
  --endpoint-configuration types=REGIONAL \
  --query 'id' \
  --output text)

echo "API_ID: $API_ID"
```

### 6.2 Create Cognito Authorizer

```bash
AUTHORIZER_ID=$(aws apigateway create-authorizer \
  --rest-api-id $API_ID \
  --name CognitoAuthorizer \
  --type COGNITO_USER_POOLS \
  --provider-arn arn:aws:cognito-idp:us-east-1:ACCOUNT_ID:userpool/$USER_POOL_ID \
  --identity-source method.request.header.Authorization \
  --query 'id' \
  --output text)

echo "AUTHORIZER_ID: $AUTHORIZER_ID"
```

### 6.3 Create Resources and Methods

```bash
ROOT_ID=$(aws apigateway get-resources \
  --rest-api-id $API_ID \
  --query 'items[0].id' \
  --output text)

# Create /phrases resource
PHRASES_RESOURCE=$(aws apigateway create-resource \
  --rest-api-id $API_ID \
  --parent-id $ROOT_ID \
  --path-part phrases \
  --query 'id' \
  --output text)

# Create POST method on /phrases
aws apigateway put-method \
  --rest-api-id $API_ID \
  --resource-id $PHRASES_RESOURCE \
  --http-method POST \
  --type COGNITO_USER_POOLS \
  --authorizer-id $AUTHORIZER_ID \
  --request-parameters method.request.header.Authorization=true

# Create Lambda integration
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name subtitle-learning-lambda-role --query 'Role.Arn' --output text)

aws apigateway put-integration \
  --rest-api-id $API_ID \
  --resource-id $PHRASES_RESOURCE \
  --http-method POST \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:ACCOUNT_ID:function:save_phrase/invocations
```

### 6.4 Deploy API

```bash
DEPLOYMENT=$(aws apigateway create-deployment \
  --rest-api-id $API_ID \
  --stage-name prod \
  --stage-description "Production" \
  --query 'id' \
  --output text)

API_ENDPOINT=$(aws apigateway get-stage \
  --rest-api-id $API_ID \
  --stage-name prod \
  --query 'invokeUrl' \
  --output text)

echo "API Endpoint: $API_ENDPOINT"
```

## Step 7: Configure Chrome Extension

### 7.1 Update AWS Configuration

```bash
cp src/config/aws-config.example.ts src/config/aws-config.ts
```

Edit `src/config/aws-config.ts` with your values:

```typescript
export const AWS_CONFIG = {
  region: 'us-east-1',
  cognito: {
    userPoolId: 'us-east-1_XXXXXXXXX',
    clientId: 'your_client_id_here',
    domain: 'https://subtitle-learning-XXXXX.auth.us-east-1.amazoncognito.com',
    redirectUri: 'chrome-extension://YOUR_EXTENSION_ID/callback.html',
  },
  api: {
    endpoint: 'https://XXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',
  },
};
```

### 7.2 Get Your Extension ID

After building the extension, you'll see the ID in Chrome Extensions page (`chrome://extensions/`)

## Step 8: Test the Setup

### 8.1 Create Test User

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username testuser@example.com \
  --message-action SUPPRESS \
  --temporary-password TempPassword123! \
  --user-attributes Name=email,Value=testuser@example.com Name=name,Value="Test User"

# Set permanent password
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username testuser@example.com \
  --password TestPassword123! \
  --permanent
```

### 8.2 Test API Endpoint

```bash
# Get access token
TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id $USER_POOL_ID \
  --client-id $CLIENT_ID \
  --auth-flow ADMIN_NO_SRP_AUTH \
  --auth-parameters USERNAME=testuser@example.com,PASSWORD=TestPassword123! \
  --query 'AuthenticationResult.AccessToken' \
  --output text)

# Test API
curl -X POST $API_ENDPOINT/phrases \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "phrase_text": "get up",
    "meaningful_sentence": "I get up early every morning",
    "platform": "youtube",
    "video_title": "Morning Routine"
  }'
```

## Step 9: Monitor and Maintain

### View Lambda Logs

```bash
aws logs tail /aws/lambda/analyze_phrase --follow
```

### Monitor DynamoDB Usage

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=SubtitleLearningData \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Sum
```

## Troubleshooting

### Common Issues

**401 Unauthorized on API calls**
- Check token expiration: `aws cognito-idp admin-get-user ...`
- Verify Cognito Authorizer configuration
- Check Authorization header format: `Bearer <token>`

**Lambda timeout**
- Increase timeout: `aws lambda update-function-configuration --function-name analyze_phrase --timeout 120`
- Check OpenAI API response times

**DynamoDB throttling**
- Verify billing mode is PAY_PER_REQUEST
- Check CloudWatch metrics for hot partitions

## Cleanup

To remove all resources:

```bash
# Delete API Gateway
aws apigateway delete-rest-api --rest-api-id $API_ID

# Delete Lambda functions
aws lambda delete-function --function-name analyze_phrase
aws lambda delete-function --function-name save_phrase
# ... etc

# Delete DynamoDB table
aws dynamodb delete-table --table-name SubtitleLearningData

# Delete Cognito
aws cognito-idp delete-user-pool --user-pool-id $USER_POOL_ID
aws cognito-identity delete-identity-pool --identity-pool-id $IDENTITY_POOL_ID

# Delete IAM role
aws iam delete-role --role-name subtitle-learning-lambda-role
```

## Cost Estimation

**Monthly costs (estimated for typical usage):**

- DynamoDB: $1.25 (on-demand, 1M requests)
- Lambda: $0.50 (1M invocations × 512MB × 60s)
- API Gateway: $3.50 (1M requests)
- Cognito: Free (for < 50K users)

**Total: ~$5.25/month**

For high-traffic applications, consider:
- Reserved capacity on DynamoDB
- Lambda reserved concurrency
- API Gateway caching
