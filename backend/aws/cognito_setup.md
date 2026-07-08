# AWS Cognito Setup Guide

## 1. Create User Pool

```bash
aws cognito-idp create-user-pool \
  --pool-name SubtitleLearningExtension \
  --policies PasswordPolicy='{MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
  --auto-verified-attributes email \
  --mfa-configuration OPTIONAL \
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
    },
    {
      "Name": "learning_language",
      "AttributeDataType": "String",
      "Mutable": true
    }
  ]'
```

**Output:** Save the `UserPoolId` (e.g., `us-east-1_XXXXXXXXX`)

## 2. Create User Pool Client

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id us-east-1_XXXXXXXXX \
  --client-name SubtitleExtensionClient \
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH \
  --generate-secret \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --callback-urls 'http://localhost:3000/callback,https://yourdomain.com/callback' \
  --logout-urls 'http://localhost:3000/logout,https://yourdomain.com/logout'
```

**Output:** Save the `ClientId` and `ClientSecret`

## 3. Create Identity Pool (for extension access)

```bash
aws cognito-identity create-identity-pool \
  --identity-pool-name SubtitleLearningExtension \
  --allow-unauthenticated-identities false \
  --cognito-identity-providers \
    ProviderName=cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX,ClientId=YOUR_CLIENT_ID,ServerSideTokenValidation=true
```

**Output:** Save the `IdentityPoolId`

## 4. Create IAM Role for Authenticated Users

```bash
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "cognito-identity.amazonaws.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "cognito-identity.amazonaws.com:aud": "YOUR_IDENTITY_POOL_ID"
        },
        "ForAllValues:StringLike": {
          "cognito-identity.amazonaws.com:sub": "*"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name SubtitleLearningExtensionAuthenticatedRole \
  --assume-role-policy-document file://trust-policy.json
```

## 5. Attach Policy to Role

```bash
cat > lambda-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:ACCOUNT_ID:table/SubtitleLearningData"
    },
    {
      "Effect": "Allow",
      "Action": [
        "execute-api:Invoke"
      ],
      "Resource": "arn:aws:execute-api:us-east-1:ACCOUNT_ID:API_ID/*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name SubtitleLearningExtensionAuthenticatedRole \
  --policy-name SubtitleLearningPolicy \
  --policy-document file://lambda-policy.json
```

## Configuration Reference

Save these values for API Gateway and extension configuration:

```
USER_POOL_ID=us-east-1_XXXXXXXXX
USER_POOL_REGION=us-east-1
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
IDENTITY_POOL_ID=us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AUTHENTICATED_ROLE_ARN=arn:aws:iam::ACCOUNT_ID:role/SubtitleLearningExtensionAuthenticatedRole
```
