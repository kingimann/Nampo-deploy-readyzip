/// OkaySpace Dart API client.
///
/// Mirrors the React Native client (`frontend/src/api/client.ts`): every request
/// hits `<baseUrl>/api/<path>`, sends `Authorization: Bearer <session_token>`
/// when a token is stored, and surfaces FastAPI's `{ detail }` error envelope as
/// an [ApiException]. Point [OkaySpaceApi.baseUrl] at the same host the web app
/// uses (e.g. `https://okayspace.ca`).
library okayspace_api;

export 'src/api.dart';
export 'src/api_client.dart';
export 'src/api_exception.dart';
export 'src/token_store.dart';
export 'src/models.dart';
