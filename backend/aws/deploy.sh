#!/bin/bash

# AWS Deployment Script for Subtitle Learning Extension Backend
# This script deploys all Lambda functions, creates DynamoDB table, and sets up API Gateway

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
ENVIRONMENT=${ENVIRONMENT:-prod}
PROJECT_NAME="subtitle-learning"

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Subtitle Learning Extension - AWS Deploy${NC}"
echo -e "${YELLOW}========================================${NC}"

# Function to print status
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${YELLOW}→${NC} $1"
}

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    print_error "AWS CLI not found. Please install it first."
    exit 1
fi

print_status "AWS CLI found"

# Get account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
print_status "AWS Account ID: $ACCOUNT_ID"

# 1. Create DynamoDB Table
print_info "Creating DynamoDB table..."
aws dynamodb create-table \
  --table-name SubtitleLearningData \
  --attribute-definitions AttributeName=user_id,AttributeType=S \
  --key-schema AttributeName=user_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region $AWS_REGION \
  2>/dev/null || echo "Table already exists"

print_status "DynamoDB table ready"

# 2. Create Lambda execution role
print_info "Setting up IAM role for Lambda..."

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

ROLE_NAME="${PROJECT_NAME}-lambda-role"

# Create role if it doesn't exist
aws iam create-role \
  --role-name $ROLE_NAME \
  --assume-role-policy-document "$TRUST_POLICY" \
  --region $AWS_REGION \
  2>/dev/null || echo "Role already exists"

# Attach policies
aws iam attach-role-policy \
  --role-name $ROLE_NAME \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam attach-role-policy \
  --role-name $ROLE_NAME \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess

print_status "IAM role created/updated"

# Get role ARN
ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query 'Role.Arn' --output text)
print_info "Role ARN: $ROLE_ARN"

# 3. Deploy Lambda functions
print_info "Deploying Lambda functions..."

LAMBDA_FUNCTIONS=(
    "analyze_phrase"
    "save_phrase"
    "get_user_phrases"
    "generate_quiz"
    "generate_video_script"
)

for func in "${LAMBDA_FUNCTIONS[@]}"; do
    print_info "Deploying $func..."
    
    # Create deployment package
    cd backend/lambda/functions/$func
    
    # Copy shared modules
    mkdir -p package/shared
    cp ../../shared/*.py package/shared/ 2>/dev/null || true
    cp -r ../../shared/ package/ 2>/dev/null || true
    
    # Copy function code
    cp index.py package/
    
    # Create requirements.txt if needed
    cd package
    zip -r ../${func}.zip . -q 2>/dev/null || true
    cd ..
    
    # Update or create function
    if aws lambda get-function --function-name ${func} --region $AWS_REGION &>/dev/null; then
        aws lambda update-function-code \
          --function-name ${func} \
          --zip-file fileb://${func}.zip \
          --region $AWS_REGION
    else
        aws lambda create-function \
          --function-name ${func} \
          --runtime python3.11 \
          --role $ROLE_ARN \
          --handler index.lambda_handler \
          --zip-file fileb://${func}.zip \
          --timeout 60 \
          --memory-size 512 \
          --region $AWS_REGION \
          --environment Variables="{OPENAI_API_KEY=$OPENAI_API_KEY}"
    fi
    
    # Clean up
    rm -rf package ${func}.zip
    cd ../../..
    
    print_status "$func deployed"
done

# 4. Lambda permissions for API Gateway
print_info "Granting API Gateway permissions..."

API_GATEWAY_PRINCIPAL="apigateway.amazonaws.com"

for func in "${LAMBDA_FUNCTIONS[@]}"; do
    aws lambda add-permission \
      --function-name ${func} \
      --statement-id AllowAPIGateway \
      --action lambda:InvokeFunction \
      --principal $API_GATEWAY_PRINCIPAL \
      --region $AWS_REGION \
      2>/dev/null || echo "$func permission already exists"
done

print_status "API Gateway permissions configured"

# 5. Output configuration
print_info "Generating configuration file..."

cat > aws_config.env << EOF
# AWS Configuration for Subtitle Learning Extension
AWS_REGION=$AWS_REGION
ACCOUNT_ID=$ACCOUNT_ID
ENVIRONMENT=$ENVIRONMENT

# Lambda Functions
LAMBDA_ANALYZE_PHRASE=analyze_phrase
LAMBDA_SAVE_PHRASE=save_phrase
LAMBDA_GET_PHRASES=get_user_phrases
LAMBDA_GENERATE_QUIZ=generate_quiz
LAMBDA_GENERATE_VIDEO=generate_video_script

# DynamoDB
DYNAMODB_TABLE=SubtitleLearningData
DYNAMODB_REGION=$AWS_REGION

# IAM
LAMBDA_ROLE_ARN=$ROLE_ARN

# Next: Set up API Gateway manually or use Terraform
# API_ENDPOINT will be populated after API Gateway deployment
EOF

print_status "Configuration file created: aws_config.env"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Successful!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Set OPENAI_API_KEY environment variable"
echo "2. Create Cognito User Pool (see cognito_setup.md)"
echo "3. Create API Gateway (see api_gateway_setup.md)"
echo "4. Update extension configuration with API endpoint and Cognito details"
echo ""
echo "Configuration saved to: aws_config.env"
