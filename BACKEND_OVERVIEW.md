# Backend Overview - Architecture & Components

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                        CHROME EXTENSION (Client Layer)                      │
│                                                                             │
│    ┌──────────────────────────────────────────────────────────────────┐   │
│    │                                                                  │   │
│    │  Content Script          Side Panel              Auth Manager   │   │
│    │  ├─ Detect subtitles     ├─ Subtitle stream     ├─ Login flow  │   │
│    │  ├─ Extract text         ├─ Phrase display      ├─ Token mgmt  │   │
│    │  └─ Send to panel        ├─ Save button         └─ Auto-refresh│   │
│    │                          └─ Analytics                           │   │
│    │                                                                  │   │
│    └──────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                            API Client Module                               │
│                         ├─ auth-manager.ts                                 │
│                         └─ api-client.ts                                   │
│                                    │                                        │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │ HTTPS/TLS
                    ┌────────────────▼────────────────┐
                    │   AWS Cognito (Authentication)  │
                    │  ├─ User Pool Management        │
                    │  ├─ OAuth 2.0 Flows             │
                    │  ├─ Token Generation            │
                    │  └─ User Attributes             │
                    └────────────────┬────────────────┘
                                     │
┌────────────────────────────────────┼────────────────────────────────────────┐
│                                    │                                        │
│    AWS API GATEWAY (REST Endpoints)                                       │
│    ├─ Request Routing                                                     │
│    ├─ Cognito Authorization                                              │
│    ├─ Rate Limiting (1000 req/hr per user)                              │
│    ├─ CORS Handling                                                      │
│    └─ Request/Response Transformation                                    │
│                                                                           │
│    Endpoints:                                                             │
│    ├─ POST   /phrases           (save-phrase)                            │
│    ├─ GET    /phrases           (get-user-phrases)                       │
│    ├─ DELETE /phrases/{id}      (delete-phrase)                          │
│    ├─ PATCH  /phrases/{id}      (update-phrase)                          │
│    ├─ POST   /phrases/analyze   (analyze-phrase)                         │
│    ├─ POST   /quiz              (generate-quiz)                          │
│    ├─ POST   /video-script      (generate-video-script)                  │
│    ├─ GET    /stats             (get-stats)                              │
│    └─ PATCH  /stats             (update-stats)                           │
│                                                                           │
└─────────────┬──────────────────┬──────────────────┬──────────────────────┘
              │                  │                  │
        ┌─────▼────┐      ┌──────▼───────┐  ┌─────▼──────┐
        │ Lambda 1  │      │  Lambda 2    │  │  Lambda 3  │
        │           │      │              │  │            │
        │ Analyze   │      │  Save        │  │  Get       │
        │ Phrase    │      │  Phrase      │  │  Phrases   │
        └─────┬────┘      └──────┬───────┘  └─────┬──────┘
              │                  │                │
              └──────────┬───────┴────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │   AWS DYNAMODB                  │
        │                                 │
        │  Table: SubtitleLearningData    │
        │  ├─ user_id (Partition Key)    │
        │  ├─ phrases[] (all user data)   │
        │  ├─ learning_stats              │
        │  ├─ preferences                 │
        │  └─ timestamps                  │
        │                                 │
        │  Data stored as single object   │
        │  for efficient quiz generation  │
        │                                 │
        └────────────────┬────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │  OpenAI API (GPT-4)              │
        │                                 │
        │  Used for:                      │
        │  ├─ Grammar analysis            │
        │  ├─ Vocabulary explanations     │
        │  ├─ Exercise generation         │
        │  ├─ Quiz creation               │
        │  └─ Video script generation     │
        │                                 │
        └─────────────────────────────────┘
```

## Data Flow: Saving a Phrase

```
User selects phrase "get up" in YouTube subtitle
    │
    ▼
Extension calls API: POST /phrases/analyze
{
  "phrase": "get up",
  "meaningful_sentence": "I get up at 6am",
  "context": "From English learning video"
}
    │
    ▼
API Gateway validates request + Cognito token
    │
    ▼
Lambda: analyze_phrase triggered
    ├─ Extract phrase + context
    ├─ Call OpenAI GPT-4 with analysis prompt
    ├─ Receive JSON response:
    │  {
    │    "analysis": {
    │      "grammatical_structure": "phrasal verb + adverbial phrase",
    │      "parts_of_speech": {"get": "verb", "up": "adverb"},
    │      "is_phrasal_verb": true
    │    },
    │    "vocabulary": {
    │      "word_explanations": {...},
    │      "synonyms": ["wake up", "rise"]
    │    },
    │    "usage": {
    │      "example_sentences": [...]
    │    }
    │  }
    ├─ Generate exercises (fill-blank, multiple choice)
    └─ Return to extension
    │
    ▼
Extension displays analysis to user
    │
    ▼
User clicks "Save to Learning List"
    │
    ▼
Extension calls API: POST /phrases
{
  "phrase_text": "get up",
  "meaningful_sentence": "I get up at 6am",
  "grammar_analysis": {...},
  "ai_explanation": "A phrasal verb meaning to wake up...",
  "timestamps": {...},
  "source_url": "https://youtube.com/watch?v=...",
  "platform": "youtube",
  "video_title": "English for Beginners",
  "tags": ["phrasal-verbs", "morning-routine"]
}
    │
    ▼
API Gateway routes to Lambda: save_phrase
    │
    ├─ Extract user_id from Cognito token
    ├─ Fetch current user data from DynamoDB
    ├─ Add new phrase to phrases[] array
    ├─ Update total_phrases count
    ├─ Update last_sync timestamp
    │
    ▼
DynamoDB updates (atomic write):
{
  "user_id": "cognito-user-123",
  "phrases": [
    {
      "phrase_id": "uuid-1234",
      "phrase_text": "get up",
      ...
      "saved_at": "2024-01-20T10:30:00Z"
    },
    ... other phrases ...
  ],
  "learning_stats": {
    "total_phrases": 42,
    ...
  },
  "updated_at": "2024-01-20T10:30:00Z"
}
    │
    ▼
Lambda returns: {
  "phrase_id": "uuid-1234",
  "message": "Phrase saved successfully",
  "saved_at": "2024-01-20T10:30:00Z"
}
    │
    ▼
Extension receives success + phrase_id
    │
    ▼
User sees "Saved!" notification
Local storage updated with sync timestamp
```

## Data Flow: Generating a Quiz

```
User has saved 10+ phrases
    │
    ▼
User clicks "Generate Quiz"
    │
    ▼
Extension shows options:
  ├─ Number of questions (5-10)
  ├─ Filter by difficulty (all/beginner/intermediate/advanced)
  ├─ Filter by tags
  └─ Quiz type (mixed/multiple-choice/fill-blank)
    │
    ▼
Extension calls API: POST /quiz
{
  "num_phrases": 8,
  "difficulty": "intermediate",
  "quiz_type": "mixed",
  "tags": "phrasal-verbs"
}
    │
    ▼
Lambda: generate_quiz triggered
    │
    ├─ Extract user_id from token
    ├─ Fetch user's complete learning data from DynamoDB
    │  (all phrases in single object)
    │
    ├─ Filter phrases:
    │  ├─ By difficulty: "intermediate"
    │  └─ By tags: "phrasal-verbs"
    │
    ├─ Select up to 8 phrases
    │  [
    │    {"phrase_text": "get up", "explanation": "..."},
    │    {"phrase_text": "get down", "explanation": "..."},
    │    ... 6 more ...
    │  ]
    │
    ├─ Call OpenAI GPT-4 with quiz generation prompt:
    │  "Generate 8 mixed-type quiz questions from these phrases.
    │   Include fill-blank, multiple-choice, and translation.
    │   Progressive difficulty. Include answer explanations."
    │
    ├─ Receive JSON response:
    │  {
    │    "questions": [
    │      {
    │        "id": "q1",
    │        "type": "multiple_choice",
    │        "question": "What does 'get up' mean?",
    │        "answer": "wake up",
    │        "alternatives": ["sit down", "stand still", "lie down"],
    │        "explanation": "Get up is a phrasal verb meaning..."
    │      },
    │      ... 7 more questions ...
    │    ]
    │  }
    │
    └─ Format and return
    │
    ▼
Extension receives quiz structure
    │
    ▼
Display interactive quiz UI:
  ├─ Question counter (1/8)
  ├─ Question text + options
  ├─ Submit button
  └─ Progress bar
    │
    ▼
User answers questions
    │
    ▼
Display results:
  ├─ Score (8/8)
  ├─ Breakdown by difficulty
  ├─ Explanation for wrong answers
  └─ "Try Again" or "Save Quiz Results"
    │
    ▼
Optional: Save results to DynamoDB
  └─ Updates user learning_stats
```

## DynamoDB Data Structure

### Single User Object (Optimized for Quizzes)

```
Partition Key: user_id (String)

{
  "user_id": "cognito-user-12345",
  "email": "user@example.com",
  
  "phrases": [
    {
      "phrase_id": "uuid-001",
      "phrase_text": "get up",
      "meaningful_sentence": "I get up early every morning",
      
      "grammar_analysis": {
        "sentence": "I get up early every morning",
        "grammatical_structure": "Subject + Phrasal Verb + Adverbial Phrase",
        "phrases": [
          {
            "text": "get up",
            "type": "phrasal_verb",
            "explanation": "To wake from sleep",
            "part_of_speech": "Verb"
          },
          {
            "text": "every morning",
            "type": "prepositional",
            "explanation": "Time expression",
            "part_of_speech": "Adverbial Phrase"
          }
        ],
        "difficulty": "intermediate"
      },
      
      "ai_explanation": "A phrasal verb composed of 'get' (base verb) + 'up' (particle). Means to wake up or rise from bed. Common in morning routines and daily conversation.",
      
      "timestamps": {
        "phrase_start": 15000,
        "phrase_end": 16500,
        "sentence_start": 14000,
        "sentence_end": 18000
      },
      
      "source_url": "https://www.youtube.com/watch?v=abc123&t=15s",
      "platform": "youtube",
      "video_title": "English for Beginners - Morning Routine",
      "thumbnail_url": "https://i.ytimg.com/vi/abc123/default.jpg",
      "audio_clip_url": "blob:chrome-extension://...",
      
      "tags": ["phrasal-verbs", "morning", "daily-routine"],
      "saved_at": "2024-01-15T10:30:00Z",
      "review_count": 3,
      "difficulty_rating": 4,
      "user_notes": "Use this every morning",
      "last_reviewed": "2024-01-20T14:22:00Z"
    },
    // ... more phrases ...
  ],
  
  "learning_stats": {
    "total_phrases": 42,
    "beginner_count": 10,
    "intermediate_count": 20,
    "advanced_count": 12,
    "total_reviews": 127,
    "review_streak": 5,
    "last_review_date": "2024-01-20T14:22:00Z",
    "average_difficulty_rating": 3.8
  },
  
  "preferences": {
    "native_language": "Spanish",
    "learning_language": "English",
    "notification_enabled": true,
    "auto_save": true,
    "email_digest": "weekly"
  },
  
  "created_at": "2024-01-01T08:00:00Z",
  "updated_at": "2024-01-20T14:22:00Z",
  "last_sync": "2024-01-20T14:22:00Z"
}
```

## Lambda Functions Summary

| Function | Trigger | Purpose | Duration | Memory |
|----------|---------|---------|----------|--------|
| analyze_phrase | POST /phrases/analyze | AI analysis of phrase | 60s | 512MB |
| save_phrase | POST /phrases | Save to DynamoDB | 30s | 256MB |
| get_user_phrases | GET /phrases | Retrieve with filters | 30s | 256MB |
| generate_quiz | POST /quiz | Create quiz questions | 60s | 512MB |
| generate_video_script | POST /video-script | Create video outline | 120s | 512MB |

## Authentication Flow

```
Extension UI
    │
    ├─ User clicks "Login"
    │
    ▼
Chrome opens popup window
    │
    ├─ Window navigates to Cognito OAuth endpoint:
    │  https://subtitle-learning-XXX.auth.us-east-1.amazoncognito.com
    │       /oauth2/authorize
    │       ?client_id=...
    │       &response_type=code
    │       &scope=openid%20email%20profile
    │       &redirect_uri=chrome-extension://...
    │
    ▼
User enters email + password
    │
    ▼
Cognito validates credentials
    │
    ├─ Password check against secure hash
    ├─ MFA check (if enabled)
    └─ Generate authorization code
    │
    ▼
Browser redirects to:
  chrome-extension://YOUR_ID/callback.html?code=AUTH_CODE&state=...
    │
    ▼
Extension callback handler:
    │
    ├─ Extract authorization code
    │
    ├─ POST to Cognito token endpoint:
    │  https://subtitle-learning-XXX.auth.us-east-1.amazoncognito.com
    │       /oauth2/token
    │  {
    │    "grant_type": "authorization_code",
    │    "code": "AUTH_CODE",
    │    "client_id": "...",
    │    "redirect_uri": "chrome-extension://..."
    │  }
    │
    ├─ Receive tokens:
    │  {
    │    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    │    "refresh_token": "eyJjdHkiOiJKV1QiLCJlbmMi...",
    │    "id_token": "eyJraWQiOiJaWVZNQXBMaDEyMVQ0dkZI...",
    │    "expires_in": 3600
    │  }
    │
    ├─ Extract user info from ID token:
    │  {
    │    "sub": "cognito-user-12345",
    │    "email": "user@example.com",
    │    "email_verified": true,
    │    "aud": "client-id",
    │    "iat": 1705754400,
    │    "exp": 1705758000
    │  }
    │
    └─ Store in Chrome sync storage:
       └─ "access_token" → eyJ...
       └─ "refresh_token" → eyJ...
       └─ "token_expiration" → 1705758000
       └─ "user_data" → {...}
    │
    ▼
Extension UI updates:
    │
    ├─ Show user email
    ├─ Enable "Save Phrase" button
    └─ Hide login button
    │
    ▼
API calls now include:
    │
    └─ Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
    │
    ▼
When token expires:
    │
    ├─ Extension detects expiration (1 min before)
    ├─ Auto-refreshes using refresh token
    └─ Stores new tokens
    │
    ▼
User can logout:
    │
    └─ Clear all tokens from storage
       └─ Clear user data
       └─ Show login UI
```

## Security Model

```
┌─────────────────────────────────────────────────────┐
│              Security Layers                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: Transport                                 │
│  ├─ HTTPS/TLS for all connections                  │
│  ├─ Certificate validation                         │
│  └─ No mixed HTTP/HTTPS                            │
│                                                     │
│  Layer 2: Authentication                           │
│  ├─ Cognito password hashing (bcrypt)              │
│  ├─ MFA support (optional)                         │
│  ├─ Session tokens with expiration                 │
│  └─ Refresh token rotation                         │
│                                                     │
│  Layer 3: Authorization                            │
│  ├─ API Gateway Cognito Authorizer                 │
│  ├─ Token signature validation                     │
│  ├─ User ID isolation (user can only access own)  │
│  └─ Lambda runtime user ID verification           │
│                                                     │
│  Layer 4: Data Protection                          │
│  ├─ DynamoDB encryption at rest                    │
│  ├─ User data isolated by user_id partition key   │
│  ├─ No sensitive data in logs                      │
│  └─ CORS restricted to extension origin           │
│                                                     │
│  Layer 5: API Security                             │
│  ├─ Rate limiting (1000 req/hr per user)          │
│  ├─ Input validation (Pydantic)                    │
│  ├─ SQL injection prevention (no SQL)             │
│  └─ CORS headers validation                        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Cost Breakdown (Monthly)

```
┌──────────────────────────────────────────────────────┐
│  Service                   Usage        Cost         │
├──────────────────────────────────────────────────────┤
│  DynamoDB                  on-demand    $1-5         │
│  (1M writes/month)         pay/request                │
│                                                     │
│  Lambda                    1M invokes   $0-2         │
│  (5 functions)            512MB, 60s                │
│                                                     │
│  API Gateway              1M requests  $0-3         │
│  (REST API)               regional                  │
│                                                     │
│  Cognito                  <50K users   FREE         │
│  (User Pool)                                        │
│                                                     │
│  CloudWatch              logs + metrics $0-1        │
│  (Monitoring)                                       │
│                                                     │
│  OpenAI API              variable     $5-20        │
│  (GPT-4 calls)                                      │
│                                                     │
├──────────────────────────────────────────────────────┤
│  TOTAL MONTHLY                        $6-31        │
└──────────────────────────────────────────────────────┘

Note: Costs scale as user base grows.
First 1000 users: ~$10-15/month
10,000 users: ~$50-100/month
100,000+ users: Consider reserved capacity
```

## Deployment Checklist

- [ ] AWS Account with billing enabled
- [ ] AWS CLI configured (aws configure)
- [ ] Python 3.11+ installed
- [ ] OpenAI API key
- [ ] Deploy Lambda functions (./deploy.sh)
- [ ] Create Cognito User Pool
- [ ] Create Cognito App Client
- [ ] Set up API Gateway REST API
- [ ] Create Cognito Authorizer
- [ ] Create resources (/phrases, /quiz, etc.)
- [ ] Deploy API to prod stage
- [ ] Configure extension aws-config.ts
- [ ] Build Chrome extension
- [ ] Test with sample user
- [ ] Set up CloudWatch monitoring
- [ ] Configure cost alerts

---

**Next:** See QUICK_START.md for step-by-step deployment instructions.
