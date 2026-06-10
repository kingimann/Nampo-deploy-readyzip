# okayspace_api (Dart)

A Dart client for the OkaySpace FastAPI backend, for use from a **Flutter** mobile app. It mirrors the React client (`frontend/src/api/client.ts`) exactly:

- every call hits **`<baseUrl>/api/<path>`**
- sends **`Authorization: Bearer <session_token>`** when a token is stored
- unwraps FastAPI's **`{ detail }`** error envelope into an `ApiException`
- optional **`Idempotency-Key`** on writes (the backend honors it — safe retries on flaky mobile networks)

So your React web app and your Flutter mobile app talk to the **same backend, the same way**.

---

## Install

This is a path package (not published). From your Flutter app's `pubspec.yaml`:

```yaml
dependencies:
  okayspace_api:
    path: ../mobile_flutter/packages/okayspace_api   # adjust to your layout
  flutter_secure_storage: ^9.0.0                      # for persistent tokens
```

Then `flutter pub get`.

---

## Quick start

```dart
import 'package:okayspace_api/okayspace_api.dart';

final api = OkaySpaceApi(
  baseUrl: 'https://okayspace.ca',          // same host EXPO_PUBLIC_BACKEND_URL uses
  tokenStore: SecureTokenStore(),           // see below; defaults to in-memory
);

// Auth (token is stored automatically on success)
final res = await api.login(identifier: 'me@example.com', password: '••••••');
if (res.needsTwofa) {
  // text code arrives; then:
  await api.verify2fa(identifier: res.twofa!.identifier, code: '123456');
}

// Use it
final me   = await api.me();
final feed = await api.homeFeed();
await api.toggleLike(feed.first.id);

// Messaging
final convs = await api.listConversations();
await api.sendText(convs.first.id, 'Hey 👋');
```

## Persisting the session token (Flutter)

The token must survive restarts. Back `TokenStore` with `flutter_secure_storage`:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:okayspace_api/okayspace_api.dart';

class SecureTokenStore implements TokenStore {
  static const _key = 'session_token';   // same key the web app uses
  final _s = const FlutterSecureStorage();

  @override
  Future<String?> read() => _s.read(key: _key);
  @override
  Future<void> write(String token) => _s.write(key: _key, value: token);
  @override
  Future<void> clear() => _s.delete(key: _key);
}
```

## Error handling

```dart
try {
  await api.login(identifier: 'x', password: 'wrong');
} on ApiException catch (e) {
  if (e.isUnauthorized) showSnack('Wrong email or password');
  else if (e.isNetworkError) showSnack('No connection');
  else showSnack(e.message);   // FastAPI detail.message
}
```

## Calling endpoints that aren't typed yet

The typed facade covers the main flows (auth, feed/posts, users, messaging, notifications, wallet). The backend has ~425 endpoints — reach **any** of them through `api.raw`:

```dart
final places   = await api.raw.getJson('/places');                 // GET
final guide    = await api.raw.postJson('/guides', body: {'name': 'Trip'});
await api.raw.patchJson('/auth/me', body: {'bio': 'hello'});
await api.raw.deleteJson('/posts/$id');
// safe retry:
await api.raw.postJson('/money/send', body: {...}, idempotencyKey: myUuid);
```

Promote a raw call to a typed method by adding it to `lib/src/api.dart` (copy the path + body straight from `frontend/src/api/client.ts`).

---

## What this does and doesn't include

**Included:** HTTP transport, auth/session, error envelope, idempotency, core models (`User`, `PublicUser`, `Post`, `Message`, `ConversationView`, …, all lenient with a `.raw` map), and typed methods for the main flows.

**Not included (by design):**
- **UI** — that's the Flutter app you build on top.
- **E2E encryption** — the web app encrypts message bodies/attachments client-side (`frontend/src/utils/e2e.ts`, NaCl box / X25519 + XSalsa20-Poly1305) *before* calling `sendMessage`. To interop with encrypted web chats, port that with a Dart NaCl lib (`pinenacl` or `cryptography`) and **match the exact wire format** (the `e2e:v1:` / media prefixes), then pass the ciphertext into `MessageCreate`. Until then, unencrypted sends work fine for non-E2E chats.
- **Native SDKs** — Stripe, Mapbox, LiveKit, push: add the Flutter SDKs in your app; this package only talks to your API.

## Alternative: generate from OpenAPI

FastAPI serves a full schema at **`<baseUrl>/api/openapi.json`** (or `/openapi.json`). If you'd rather auto-generate every model/endpoint, run:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i https://okayspace.ca/api/openapi.json -g dart-dio -o ./generated
```

This hand-written client is the lighter, more idiomatic option and matches the web client's exact conventions; the generated one is exhaustive but heavier. They can coexist.
