# GetFluentFast Browser Extension

The browser extension adds opt-in language-learning controls to supported video pages. It is a frontend client of `language_backend`; this repository contains no AWS infrastructure, Lambda source, database schema, hosted vocabulary application, or user-profile backend.

## Supported sites

- YouTube
- Netflix
- Max / HBO Max

Learning mode is disabled for each video until the viewer enables it from the player control. When disabled, the extension leaves the platform's normal subtitles and playback experience alone.

When enabled, the extension suppresses the platform subtitle renderer and places its stable learning overlay in the same player region. Subtitle metadata is the only source of the target language. If the language cannot be detected, vocabulary saving stops with an explicit error instead of using a profile or language default.

## Backend contracts

- Authentication: `https://auth.getfluentfast.app`, using the dedicated browser-extension Cognito client.
- LLM analysis: `POST /prod/analyze` and `POST /prod/explain` on the retained extension API Gateway.
- Vocabulary: `https://api.getfluentfast.app/learn-items` with an explicit `target_language`.
- Quiz evaluation: `https://api.getfluentfast.app/quiz/evaluate`.

The extension never stores an OpenAI key and has no phrase-table API. Subscription, entitlement, vocabulary, and user identity remain backend responsibilities.

## Development

```bash
npm install
npm run type-check
npm run test:language-preferences
npm run test:subtitle-processor
npm run test:subtitle-timing
npm run build
```

Load the generated `dist/` directory as an unpacked extension in Chrome.

## Permissions

Host access is limited to the supported streaming sites, GetFluentFast authentication and API hosts, and the retained API Gateway. The manifest does not request broad `https://*/*` access.
