# Backend API Example Implementation

This document shows how to implement the backend API that the extension can send learning materials to.

## API Specification

### Authentication
All requests require a Bearer token in the Authorization header:
```
Authorization: Bearer {your-api-token}
```

### Base URL
```
https://your-api.com/api
```

## Endpoints

### 1. Save Learning Material

**Endpoint:** `POST /learning-materials`

**Request Body:**
```json
{
  "id": "uuid",
  "phrase": "get up",
  "meaningfulSentence": "I get up every morning at 6 AM",
  "grammarAnalysis": {
    "sentence": "I get up every morning at 6 AM",
    "grammaticalStructure": "Simple present tense with time expression",
    "phrases": [
      {
        "text": "get up",
        "type": "phrasal_verb",
        "partOfSpeech": "verb",
        "explanation": "A phrasal verb meaning to wake up from bed and stand"
      }
    ],
    "difficulty": "beginner"
  },
  "aiExplanation": "Detailed explanation from LLM...",
  "timestamps": {
    "phraseStart": 5000,
    "phraseEnd": 6000,
    "sentenceStart": 3000,
    "sentenceEnd": 10000
  },
  "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s",
  "platform": "youtube",
  "videoTitle": "Learn English Daily",
  "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "thumbnailUrl": "https://...",
  "audioClipUrl": "blob:...",
  "savedAt": "2024-03-19T10:30:00Z"
}
```

**Response (201 Created):**
```json
{
  "id": "uuid",
  "phrase": "get up",
  "... rest of material ..."
}
```

### 2. Get Learning Material

**Endpoint:** `GET /learning-materials/:id`

**Response (200 OK):**
```json
{
  "id": "uuid",
  "phrase": "get up",
  "... rest of material ..."
}
```

**Response (404 Not Found):**
```json
{
  "error": "Material not found"
}
```

### 3. Update Learning Material

**Endpoint:** `PATCH /learning-materials/:id`

**Request Body (any fields to update):**
```json
{
  "phrase": "updated phrase",
  "aiExplanation": "updated explanation"
}
```

**Response (200 OK):**
```json
{
  "id": "uuid",
  "phrase": "updated phrase",
  "... rest of material ..."
}
```

### 4. Delete Learning Material

**Endpoint:** `DELETE /learning-materials/:id`

**Response (200 OK):**
```json
{
  "success": true
}
```

**Response (404 Not Found):**
```json
{
  "error": "Material not found"
}
```

### 5. Search Learning Materials

**Endpoint:** `GET /learning-materials/search?query=get&limit=20`

**Query Parameters:**
- `query` (required): Search term (searches phrase, sentence, explanation)
- `limit` (optional): Max results (default: 20)
- `offset` (optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
[
  {
    "id": "uuid1",
    "phrase": "get up",
    "... rest of material ..."
  },
  {
    "id": "uuid2",
    "phrase": "get off",
    "... rest of material ..."
  }
]
```

### 6. Bulk Save Materials

**Endpoint:** `POST /learning-materials/bulk`

**Request Body:**
```json
{
  "materials": [
    { "id": "uuid1", "phrase": "get up", ... },
    { "id": "uuid2", "phrase": "get off", ... }
  ]
}
```

**Response (201 Created):**
```json
[
  { "id": "uuid1", "phrase": "get up", ... },
  { "id": "uuid2", "phrase": "get off", ... }
]
```

## Example Implementation (Node.js/Express)

```typescript
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

// In-memory storage (replace with database in production)
const materials = new Map();

// Middleware for bearer token authentication
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  const token = auth?.split(' ')[1];
  
  if (token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

app.use(authenticate);

// POST /learning-materials
app.post('/learning-materials', (req, res) => {
  const material = req.body;
  
  if (!material.id) {
    material.id = uuidv4();
  }
  
  materials.set(material.id, material);
  
  res.status(201).json(material);
});

// GET /learning-materials/:id
app.get('/learning-materials/:id', (req, res) => {
  const material = materials.get(req.params.id);
  
  if (!material) {
    return res.status(404).json({ error: 'Material not found' });
  }
  
  res.json(material);
});

// PATCH /learning-materials/:id
app.patch('/learning-materials/:id', (req, res) => {
  const material = materials.get(req.params.id);
  
  if (!material) {
    return res.status(404).json({ error: 'Material not found' });
  }
  
  const updated = { ...material, ...req.body };
  materials.set(req.params.id, updated);
  
  res.json(updated);
});

// DELETE /learning-materials/:id
app.delete('/learning-materials/:id', (req, res) => {
  const exists = materials.has(req.params.id);
  
  if (!exists) {
    return res.status(404).json({ error: 'Material not found' });
  }
  
  materials.delete(req.params.id);
  
  res.json({ success: true });
});

// GET /learning-materials/search
app.get('/learning-materials/search', (req, res) => {
  const { query, limit = 20, offset = 0 } = req.query;
  
  if (!query) {
    return res.status(400).json({ error: 'Query required' });
  }
  
  const results = Array.from(materials.values())
    .filter(m => 
      m.phrase.toLowerCase().includes(query.toLowerCase()) ||
      m.meaningfulSentence.toLowerCase().includes(query.toLowerCase()) ||
      m.aiExplanation.toLowerCase().includes(query.toLowerCase())
    )
    .slice(Number(offset), Number(offset) + Number(limit));
  
  res.json(results);
});

// POST /learning-materials/bulk
app.post('/learning-materials/bulk', (req, res) => {
  const { materials: incomingMaterials } = req.body;
  
  const saved = incomingMaterials.map(material => {
    if (!material.id) {
      material.id = uuidv4();
    }
    materials.set(material.id, material);
    return material;
  });
  
  res.status(201).json(saved);
});

app.listen(3000, () => {
  console.log('API listening on port 3000');
});
```

## Database Schema (PostgreSQL Example)

```sql
CREATE TABLE learning_materials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  phrase TEXT NOT NULL,
  meaningful_sentence TEXT NOT NULL,
  grammar_analysis JSONB,
  ai_explanation TEXT,
  timestamps JSONB NOT NULL,
  source_url TEXT,
  platform VARCHAR(50),
  video_title TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  audio_clip_url TEXT,
  saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_id ON learning_materials(user_id);
CREATE INDEX idx_phrase ON learning_materials USING GIN (
  to_tsvector('english', phrase)
);
CREATE INDEX idx_sentence ON learning_materials USING GIN (
  to_tsvector('english', meaningful_sentence)
);
```

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message",
  "code": "error_code",
  "details": {}
}
```

### Common Status Codes:
- `200 OK` - Successful GET/PATCH/DELETE
- `201 Created` - Successful POST
- `400 Bad Request` - Invalid request data
- `401 Unauthorized` - Invalid or missing token
- `404 Not Found` - Resource not found
- `500 Internal Server Error` - Server error

## Rate Limiting (Recommended)

```typescript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests from this IP'
});

app.use(limiter);
```

## CORS Configuration (if needed)

```typescript
const cors = require('cors');

app.use(cors({
  origin: ['chrome-extension://*'],
  credentials: true
}));
```

## Security Considerations

1. **Validate all inputs** on the server
2. **Sanitize HTML** in explanations
3. **Store API tokens securely** (environment variables)
4. **Use HTTPS only** for all communications
5. **Implement rate limiting** to prevent abuse
6. **Validate file URLs** before storing
7. **Implement proper authentication** per user
8. **Log all API access** for audit trails

## Testing with cURL

```bash
# Save a material
curl -X POST https://your-api.com/api/learning-materials \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"phrase": "get up", "meaningfulSentence": "I get up early"}'

# Get a material
curl -X GET https://your-api.com/api/learning-materials/{id} \
  -H "Authorization: Bearer your-token"

# Search
curl -X GET "https://your-api.com/api/learning-materials/search?query=get" \
  -H "Authorization: Bearer your-token"

# Delete
curl -X DELETE https://your-api.com/api/learning-materials/{id} \
  -H "Authorization: Bearer your-token"
```

## Deployment

### Using Vercel (Recommended for serverless)

```bash
npm install -g vercel
vercel
```

### Using Heroku

```bash
heroku create your-app-name
heroku config:set API_TOKEN=your-token
git push heroku main
```

### Using Docker

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

This API can be enhanced with:
- User accounts and authentication
- Learning statistics and progress tracking
- Spaced repetition scheduling
- Quiz generation
- Social features (sharing, collaboration)
- Integration with other learning platforms
