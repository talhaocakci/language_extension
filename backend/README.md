# AWS Backend for Subtitle Learning Chrome Extension

Complete serverless backend built with AWS Lambda, API Gateway, Cognito, and DynamoDB.

## 📁 Directory Structure

```
backend/
├── lambda/
│   ├── shared/
│   │   ├── models.py              # Pydantic data models
│   │   ├── dynamodb_client.py      # DynamoDB operations
│   │   └── openai_client.py        # OpenAI GPT-4 integration
│   │
│   ├── functions/
│   │   ├── analyze_phrase/         # AI phrase analysis
│   │   ├── save_phrase/            # Save to learning list
│   │   ├── get_user_phrases/       # Retrieve phrases
│   │   ├── generate_quiz/          # Generate quizzes
│   │   └── generate_video_script/  # Generate video scripts
│   │
│   └── requirements.txt            # Python dependencies
│
├── aws/
│   ├── dynamodb_schema.json        # DynamoDB table definition
│   ├── deploy.sh                   # Automated deployment script
│   ├── cognito_setup.md            # Cognito setup guide
│   └── api_gateway_setup.md        # API Gateway configuration
│
├── AWS_SETUP_GUIDE.md              # Complete setup guide (65KB+)
├── ARCHITECTURE.md                 # System architecture details
└── README.md                       # This file
```

## 🚀 Quick Start

```bash
# 1. Configure AWS CLI
aws configure

# 2. Set environment variables
export AWS_REGION=us-east-1
export OPENAI_API_KEY=sk-...your-key...

# 3. Deploy (automated)
cd aws
chmod +x deploy.sh
./deploy.sh
```

**Estimated time: 15 minutes for Lambda deployment**

For full setup (including Cognito & API Gateway): **1-2 hours**

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md) | Complete step-by-step AWS setup |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design & data models |
| [QUICK_START.md](../QUICK_START.md) | Fast deployment guide |
| [BACKEND_OVERVIEW.md](../BACKEND_OVERVIEW.md) | Visual diagrams & flows |

## 🏗️ Architecture

### Tech Stack
- **Compute**: AWS Lambda (Python 3.11)
- **Database**: DynamoDB (on-demand billing)
- **API**: API Gateway (REST)
- **Auth**: Cognito User Pools + OAuth 2.0
- **AI**: OpenAI GPT-4
- **Infrastructure**: CloudWatch (monitoring)

### Components

1. **5 Lambda Functions**
   - Analyze phrases with OpenAI
   - Save/retrieve learning data
   - Generate quizzes & video scripts

2. **DynamoDB Table** (Single object per user)
   - All phrases in one document
   - Optimized for quiz generation
   - ~1KB per phrase, scales to millions

3. **API Gateway** (REST endpoints)
   - Cognito authorization
   - Rate limiting
   - CORS enabled

4. **Cognito** (Authentication)
   - User Pool for registration/login
   - OAuth 2.0 flow
   - Token management

## 📊 Data Model

Single user object containing all learning data:

```typescript
{
  "user_id": "cognito-123",
  "email": "user@example.com",
  "phrases": [
    {
      "phrase_id": "uuid",
      "phrase_text": "get up",
      "meaningful_sentence": "I get up at 6am",
      "grammar_analysis": {...},
      "ai_explanation": "...",
      "saved_at": "2024-01-15T10:30:00Z",
      "tags": ["phrasal-verbs"],
      ...
    }
  ],
  "learning_stats": {
    "total_phrases": 42,
    "beginner_count": 10,
    ...
  },
  "updated_at": "2024-01-20T14:22:00Z"
}
```

Benefits:
- ✅ Fast retrieval (single Get operation)
- ✅ Perfect for quizzes (all data available)
- ✅ Easy filtering & sorting client-side
- ✅ Simplified transactions
- ✅ Natural user model

## 🔌 API Endpoints

All endpoints require Cognito authentication (Bearer token).

### Phrases
```
POST   /phrases              # Save new phrase
GET    /phrases              # Get all phrases (with filters)
GET    /phrases/{phraseId}   # Get single phrase
DELETE /phrases/{phraseId}   # Delete phrase
PATCH  /phrases/{phraseId}   # Update metadata
```

### Analysis
```
POST   /phrases/analyze      # Analyze phrase with OpenAI
```

### Generation
```
POST   /quiz                 # Generate quiz (5-10 questions)
POST   /video-script         # Generate video script
```

### Stats
```
GET    /stats                # Get learning statistics
PATCH  /stats                # Update statistics
```

## 🔐 Security

- **Transport**: HTTPS/TLS only
- **Authentication**: Cognito password hashing + MFA
- **Authorization**: Token validation on every request
- **Data**: DynamoDB encryption at rest
- **Isolation**: Users can only access their own data

## 💰 Cost Estimate

**Monthly cost for typical usage:**

| Service | Estimate |
|---------|----------|
| DynamoDB | $1-5 |
| Lambda | $0-2 |
| API Gateway | $0-3 |
| Cognito | Free (<50K users) |
| OpenAI | $5-20 |
| **Total** | **$6-30/month** |

## 📝 Python Lambda Code

Example Lambda function structure:

```python
import json
import os
from aws_lambda_powertools import Logger
from shared.openai_client import OpenAIClient
from shared.models import AnalysisRequest

logger = Logger()

def lambda_handler(event: dict, context) -> dict:
    try:
        # Parse request
        body = json.loads(event['body'])
        request = AnalysisRequest(**body)
        
        # Get user from token
        user_id = event['requestContext']['authorizer']['claims']['sub']
        
        # Call OpenAI
        ai = OpenAIClient()
        analysis = ai.analyze_phrase(
            request.phrase,
            request.meaningful_sentence,
            request.context
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps(analysis)
        }
    except Exception as e:
        logger.exception(f"Error: {str(e)}")
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
```

## 🛠️ Deployment

### Automated (Recommended)
```bash
cd aws
./deploy.sh
```

Creates:
- DynamoDB table
- IAM role for Lambda
- All 5 Lambda functions
- Generates aws_config.env

### Manual Setup
Follow [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md) for detailed CLI commands.

## ✅ Verification

```bash
# Check Lambda functions
aws lambda list-functions --query 'Functions[?contains(FunctionName, `subtitle`)].FunctionName'

# Check DynamoDB
aws dynamodb describe-table --table-name SubtitleLearningData

# Check API Gateway
aws apigateway get-rest-apis --query 'items[?name==`SubtitleLearningAPI`]'

# Check Cognito
aws cognito-idp describe-user-pool --user-pool-id us-east-1_XXXXXXXXX
```

## 🐛 Troubleshooting

**401 Unauthorized**
- Check token validity: `aws cognito-idp admin-get-user`
- Verify Cognito Authorizer in API Gateway
- Check Authorization header format: `Bearer <token>`

**Lambda timeout**
- Increase timeout: `aws lambda update-function-configuration --timeout 120`
- Check OpenAI API response times

**DynamoDB throttling**
- Verify on-demand billing (PAY_PER_REQUEST)
- Check CloudWatch metrics

See [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md#troubleshooting) for more.

## 📊 Monitoring

Monitor in CloudWatch:

```bash
# View Lambda logs
aws logs tail /aws/lambda/analyze_phrase --follow

# Check API metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name Latency \
  --dimensions Name=ApiName,Value=SubtitleLearningAPI \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Average
```

## 🔄 Continuous Deployment

To automate deployments:

```bash
# GitHub Actions example
name: Deploy Lambda
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Deploy Lambda
        run: cd backend/aws && ./deploy.sh
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## 📦 Dependencies

Python packages (requirements.txt):
- `boto3` - AWS SDK
- `openai` - OpenAI API client
- `pydantic` - Data validation
- `aws-lambda-powertools` - Logging & tracing
- `python-dotenv` - Environment management
- `requests` - HTTP client

## 🚀 Performance

Expected performance metrics:

| Operation | Latency | Cost |
|-----------|---------|------|
| Save phrase | 500ms-1s | $0.0001 |
| Get phrases | 200-500ms | $0.0001 |
| Analyze phrase | 2-5s | $0.0002 |
| Generate quiz | 3-8s | $0.0003 |
| Generate video | 5-15s | $0.0004 |

## 🔮 Future Enhancements

- [ ] Multi-language support
- [ ] Spaced repetition algorithm
- [ ] User progress analytics
- [ ] Phrase sharing/collaboration
- [ ] Custom LLM provider support
- [ ] Anki deck export
- [ ] Mobile app backend

## 📄 License

Included with main project

## 🆘 Support

- Check [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md) for setup issues
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for design questions
- Review [QUICK_START.md](../QUICK_START.md) for deployment steps

## 📞 Getting Help

1. Read the [AWS_SETUP_GUIDE.md](./AWS_SETUP_GUIDE.md) troubleshooting section
2. Check CloudWatch logs for specific errors
3. Verify AWS credentials: `aws sts get-caller-identity`
4. Test API manually with curl (see QUICK_START.md)

---

**Ready to deploy?** Start with [QUICK_START.md](../QUICK_START.md)
