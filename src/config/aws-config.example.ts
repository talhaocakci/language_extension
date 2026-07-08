/**
 * AWS Configuration for Subtitle Learning Extension
 * 
 * Copy this file to aws-config.ts and fill in your AWS details
 */

export const AWS_CONFIG = {
  // AWS Region
  region: 'us-east-1',

  // Cognito Configuration
  cognito: {
    userPoolId: 'us-east-1_XXXXXXXXX', // From Cognito User Pool
    clientId: 'your_client_id_here', // From Cognito App Client
    domain: 'https://YOUR_DOMAIN.auth.us-east-1.amazoncognito.com', // Cognito domain
    redirectUri: 'chrome-extension://YOUR_EXTENSION_ID/callback.html',
    scopes: ['openid', 'email', 'profile'],
    responseType: 'code',
  },

  // API Gateway Configuration
  api: {
    endpoint: 'https://XXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',
    timeout: 30000,
  },

  // DynamoDB Configuration (for reference)
  dynamodb: {
    tableName: 'SubtitleLearningData',
    region: 'us-east-1',
  },

  // Lambda Functions
  lambdaFunctions: {
    analyzePhrase: 'analyze_phrase',
    savePhrase: 'save_phrase',
    getUserPhrases: 'get_user_phrases',
    generateQuiz: 'generate_quiz',
    generateVideoScript: 'generate_video_script',
  },
};

export const AUTH_CONFIG = {
  // Token storage
  tokenStorageKey: 'subtitle_learning_auth_token',
  refreshTokenStorageKey: 'subtitle_learning_refresh_token',
  userDataStorageKey: 'subtitle_learning_user_data',

  // Token settings
  tokenExpirationBuffer: 60000, // 1 minute before actual expiration
  autoRefreshToken: true,
};

export const API_ENDPOINTS = {
  // Phrase management
  SAVE_PHRASE: '/phrases',
  GET_PHRASES: '/phrases',
  GET_PHRASE: (phraseId: string) => `/phrases/${phraseId}`,
  DELETE_PHRASE: (phraseId: string) => `/phrases/${phraseId}`,
  UPDATE_PHRASE: (phraseId: string) => `/phrases/${phraseId}`,
  UPDATE_PHRASE_METADATA: (phraseId: string) => `/phrases/${phraseId}/metadata`,

  // Analysis
  ANALYZE_PHRASE: '/phrases/analyze',

  // Quiz & Video
  GENERATE_QUIZ: '/quiz',
  GENERATE_VIDEO_SCRIPT: '/video-script',

  // User stats
  GET_STATS: '/stats',
  UPDATE_STATS: '/stats',
};
