# AWS Backend Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Chrome Extension (Client)                        │
│  ┌────────────────┐  ┌───────────────┐  ┌──────────────────────┐   │
│  │ Content Script │  │ Side Panel UI │  │ Authentication Flow  │   │
│  └────────┬───────┘  └───────┬───────┘  └──────────┬───────────┘   │
│           │                  │                      │                │
└───────────┼──────────────────┼──────────────────────┼────────────────┘
            │                  │                      │
            └──────────────────┼──────────────────────┘
                               │
                    ┌──────────▼─────────────┐
                    │   AWS Cognito OAuth    │
                    │   (Authentication)     │
                    └──────────┬─────────────┘
                               │
            ┌──────────────────▼──────────────────┐
            │   AWS API Gateway (REST API)        │
            │  - Request routing                  │
            │  - Cognito authorization            │
            │  - CORS headers                     │
            │  - Rate limiting                    │
            └─────────┬────┬─────────┬────┬───────┘
                      │    │         │    │
        ┌─────────────┘    │         │    └─────────────┐
        │                  │         │                  │
        ▼                  ▼         ▼                  ▼
    ┌────────┐        ┌────────┐ ┌────────┐       ┌──────────┐
    │ Lambda │        │ Lambda │ │ Lambda │       │  Lambda  │
    │analyze │        │ save   │ │ get    │       │generate  │
    │ phrase │        │ phrase │ │phrases │       │ quiz     │
    └───┬────┘        └───┬────┘ └───┬────┘       └──────────┘
        │                 │          │
        │                 ▼          │
        │         ┌───────────────────┘
        │         │
        ▼         ▼
    ┌──────────────────────┐
    │    DynamoDB Table    │
    │ SubtitleLearningData │
    │                      │
    │ {                    │
    │   "user_id": "...",  │
    │   "phrases": [...],  │
    │   "stats": {...},    │
    │   "updated_at": "..."│
    │ }                    │
    └──────────┬───────────┘
               │
               ▼
    ┌──────────────────────┐
    │   OpenAI GPT-4 API   │
    │   (AI Processing)    │
    └──────────────────────┘
```

## Component Details

### 1. DynamoDB Schema

**Table: `SubtitleLearningData`**

Single-object model per user:

```typescript
interface UserLearningData {
  // Primary Key
  user_id: string;                        // Partition key

  // User Info
  email: string;

  // Learning Data
  phrases: LearningPhrase[];              // All learned phrases
  
  // Statistics
  learning_stats: {
    total_phrases: number;
    beginner_count: number;
    intermediate_count: number;
    advanced_count: number;
    last_review_date: string;
    review_streak: number;
  };

  // Preferences
  preferences: {
    native_language: string;
    learning_language: string;
    notification_enabled: boolean;
    auto_save: boolean;
  };

  // Metadata
  created_at: ISO8601;
  updated_at: ISO8601;
  last_sync: ISO8601;
}

interface LearningPhrase {
  phrase_id: string;                      // UUID
  phrase_text: string;                    // The actual phrase/word
  meaningful_sentence: string;            // Context sentence
  
  grammar_analysis: {
    sentence: string;
    grammatical_structure: string;
    phrases: PhraseInfo[];
    difficulty: 'beginner' | 'intermediate' | 'advanced';
  };
  
  ai_explanation: string;                 // From OpenAI
  
  timestamps: {
    phrase_start: number;                 // ms
    phrase_end: number;                   // ms
    sentence_start: number;               // ms
    sentence_end: number;                 // ms
  };
  
  source_url: string;                     // YouTube/Netflix URL with timestamp
  platform: 'youtube' | 'netflix';
  video_title: string;
  thumbnail_url?: string;
  audio_clip_url?: string;                // Browser-stored blob URL
  
  // Learning metadata
  saved_at: ISO8601;
  review_count: number;                   // How many times reviewed
  difficulty_rating?: number;              // 1-5 user rating
  user_notes?: string;                    // User's personal notes
  tags: string[];                         // For categorization
  last_reviewed?: ISO8601;
}
```

**Why Single Object?**
- Faster for typical user workflows (get all phrases at once)
- Easier to maintain consistency
- Better for generating quizzes/videos (all data available)
- Can be split later using Global Secondary Indexes if needed

**Scaling Strategy:**
- Start with on-demand billing (PAY_PER_REQUEST)
- Monitor usage with CloudWatch
- If costs exceed $10/month, consider reserved capacity
- For millions of users, consider:
  - Partition by user segments (user_id ranges)
  - Archive old phrases to S3
  - Create separate table for quiz/video history

### 2. Lambda Functions

#### 2.1 analyze_phrase
**Triggers:** API Gateway POST `/phrases/analyze`

**Purpose:** AI-powered phrase analysis using OpenAI GPT-4

**Process:**
1. Receive phrase + context
2. Call OpenAI with analysis prompt
3. Parse JSON response
4. Generate practice exercises
5. Return analysis + exercises

**Timeout:** 60s
**Memory:** 512MB
**Cost:** ~$0.0002 per invocation

#### 2.2 save_phrase
**Triggers:** API Gateway POST `/phrases`

**Purpose:** Save analyzed phrase to user's learning list

**Process:**
1. Authenticate user from Cognito token
2. Validate request data
3. Generate phrase ID (UUID)
4. Fetch current user data from DynamoDB
5. Add phrase to phrases array
6. Update timestamps and stats
7. Write back to DynamoDB
8. Return phrase ID

**Timeout:** 30s
**Memory:** 256MB
**Cost:** ~$0.0001 per invocation

#### 2.3 get_user_phrases
**Triggers:** API Gateway GET `/phrases`

**Purpose:** Retrieve user's learning phrases with filtering

**Features:**
- Filter by difficulty
- Filter by tags
- Pagination (limit/offset)
- Include stats

**Timeout:** 30s
**Memory:** 256MB
**Cost:** ~$0.0001 per invocation

#### 2.4 generate_quiz
**Triggers:** API Gateway POST `/quiz`

**Purpose:** Generate AI-powered quiz from learned phrases

**Process:**
1. Get user's phrases (filtered by difficulty/tags)
2. Select up to 10 phrases
3. Call OpenAI to generate quiz questions
4. Format response with answers and explanations
5. Return quiz structure

**Timeout:** 60s
**Memory:** 512MB
**Cost:** ~$0.0003 per invocation

#### 2.5 generate_video_script
**Triggers:** API Gateway POST `/video-script`

**Purpose:** Generate educational video script outline

**Process:**
1. Get user's phrases (filtered)
2. Call OpenAI to generate script
3. Include sections with timestamps
4. Add visual suggestions
5. Return structured script

**Timeout:** 120s
**Memory:** 512MB
**Cost:** ~$0.0004 per invocation

### 3. API Gateway

**Type:** REST API (Regional)

**Endpoints:**
```
POST   /phrases                    - Save phrase
GET    /phrases                    - Get phrases (filtered)
DELETE /phrases/{phraseId}         - Delete phrase
PATCH  /phrases/{phraseId}         - Update phrase metadata
POST   /phrases/analyze            - Analyze phrase
POST   /quiz                       - Generate quiz
POST   /video-script               - Generate video script
GET    /stats                      - Get learning stats
PATCH  /stats                      - Update stats
```

**Authentication:** Cognito User Pools
**Authorization:** Bearer token in Authorization header

**Request/Response:**
- Content-Type: application/json
- CORS enabled for extension origin
- Error handling with proper HTTP status codes

**Rate Limiting:**
- 1000 requests per user per hour (standard plan)
- 10 requests per second concurrent

### 4. Cognito User Pool

**Authentication Flow:**
```
1. User clicks "Login" in extension
2. Extension opens Cognito auth page
3. User enters email/password
4. Cognito returns authorization code
5. Extension exchanges code for tokens
6. Tokens stored in Chrome sync storage
7. API calls include Bearer token
8. Auto-refresh before expiration
```

**Token Structure:**
- Access Token: Valid for 1 hour
- Refresh Token: Valid for 30 days
- ID Token: Contains user claims

**User Attributes:**
- email (required, unique)
- name (required)
- custom:learning_language (optional)

### 5. OpenAI Integration

**Model:** GPT-4
**Timeout:** 30 seconds

**Prompts Used:**

1. **Phrase Analysis:**
   - Grammar breakdown
   - Parts of speech
   - Phrasal verb detection
   - Vocabulary explanations
   - Usage examples
   - Synonyms/antonyms
   - Difficulty level

2. **Exercise Generation:**
   - Fill-in-blank questions
   - Multiple choice
   - Translation exercises
   - With answer key

3. **Quiz Generation:**
   - Progressive difficulty
   - 5-10 questions
   - Explanations for correct answers
   - Mixed question types

4. **Video Script:**
   - Timestamped sections
   - Visual suggestions
   - Key takeaways
   - Engagement elements

## Data Flow

### Save Phrase Flow

```
Extension
  ↓
User selects phrase → analyzePhrase() → gets grammar_analysis
  ↓
User clicks "Save" → savePhrase()
  ↓
API Gateway receives POST /phrases
  ↓
Cognito Authorizer validates token
  ↓
Lambda:save_phrase executes
  ├─ Get user from token
  ├─ Fetch current UserLearningData from DynamoDB
  ├─ Add phrase to phrases array
  ├─ Update stats
  └─ Write back to DynamoDB
  ↓
Extension receives phrase_id
  ↓
Local storage updated with success
```

### Generate Quiz Flow

```
Extension
  ↓
User selects "Generate Quiz"
  ↓
POST /quiz with filters
  ↓
API Gateway receives request
  ↓
Lambda:generate_quiz executes
  ├─ Get user from token
  ├─ Fetch UserLearningData from DynamoDB
  ├─ Filter phrases (difficulty, tags)
  ├─ Call OpenAI.generate_quiz()
  └─ Format response
  ↓
Extension receives quiz structure
  ↓
Display quiz UI
```

## Error Handling

**API Errors:**
- 400: Bad Request (invalid data)
- 401: Unauthorized (invalid/expired token)
- 403: Forbidden (user not allowed)
- 404: Not Found (resource doesn't exist)
- 500: Internal Server Error (Lambda failure)
- 503: Service Unavailable (AWS service issue)

**Lambda Error Handling:**
- Try-catch blocks with logging
- Proper error messages to client
- Automatic retries for transient errors
- CloudWatch alarms for critical errors

## Security

**Authentication:**
- Cognito handles password hashing
- Token validation on each request
- Auto-refresh tokens before expiration
- Secure storage in Chrome sync

**Authorization:**
- User can only access their own data
- Cognito authorizer validates token
- Lambda checks user_id from token vs request

**Data Protection:**
- DynamoDB encryption at rest
- API Gateway HTTPS only
- No sensitive data in logs
- OpenAI API key in Lambda environment

**CORS:**
- Only extension origin allowed
- Restricted to API Gateway domain
- No credentials needed (Bearer token)

## Monitoring & Observability

**CloudWatch Logs:**
- `/aws/lambda/analyze_phrase`
- `/aws/lambda/save_phrase`
- etc.

**CloudWatch Metrics:**
- Lambda duration, errors, throttles
- API Gateway latency, 4xx/5xx errors
- DynamoDB read/write units
- OpenAI API cost tracking

**Alarms:**
- Lambda error rate > 1%
- API Gateway 5xx errors > 10/min
- DynamoDB consumed capacity spike
- High API latency (> 5s)

## Cost Optimization

**Current Approach:**
- On-demand DynamoDB (best for variable workload)
- Lambda pay-as-you-go
- API Gateway pay-per-request

**Optimization Opportunities:**
1. Cache quiz/video scripts in S3 (CloudFront)
2. Batch OpenAI calls for multiple users
3. Archive old phrases to Glacier
4. Reserved capacity if usage grows

## Deployment Pipeline

```
Local development
    ↓
Push to GitHub
    ↓
GitHub Actions trigger
    ├─ Run tests
    ├─ Build Lambda packages
    ├─ Run linters
    └─ Deploy to AWS
    ↓
Blue-green deployment
    ├─ Deploy to staging
    ├─ Run integration tests
    └─ Switch traffic
    ↓
Production
```

## Future Enhancements

1. **Multi-language Support:**
   - Detect source language
   - Provide translations
   - Context-aware explanations

2. **Advanced Analytics:**
   - Learning progress tracking
   - Spaced repetition scheduling
   - Weakness identification

3. **Social Features:**
   - Phrase sharing
   - Leaderboards
   - Peer review

4. **Integration:**
   - Anki deck export
   - Quizlet sync
   - Custom LLM providers

5. **Performance:**
   - Cache common phrases
   - Batch OpenAI calls
   - Precompute quizzes
