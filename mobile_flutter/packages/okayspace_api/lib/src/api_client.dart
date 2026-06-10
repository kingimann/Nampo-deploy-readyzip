import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_exception.dart';
import 'token_store.dart';

/// Low-level HTTP transport — the Dart equivalent of `request<T>()` in
/// `frontend/src/api/client.ts`.
///
/// * Every call hits `<baseUrl>/api/<path>`.
/// * Adds `Authorization: Bearer <token>` when [tokenStore] has one.
/// * Sends/decodes JSON; unwraps FastAPI's `{ detail }` error envelope into an
///   [ApiException].
/// * Optional `Idempotency-Key` on writes (the backend honors it to make retries
///   safe — handy on flaky mobile networks).
///
/// Most apps use the higher-level [OkaySpaceApi] facade, but the typed
/// getJson/postJson/... helpers here let you call *any* of the backend's ~425
/// endpoints, even ones without a typed wrapper yet.
class ApiClient {
  ApiClient({
    required String baseUrl,
    TokenStore? tokenStore,
    http.Client? httpClient,
  })  : baseUrl = _trim(baseUrl),
        tokenStore = tokenStore ?? InMemoryTokenStore(),
        _http = httpClient ?? http.Client();

  /// Backend origin, no trailing slash, e.g. `https://okayspace.ca`.
  /// Same role as `EXPO_PUBLIC_BACKEND_URL` in the web build.
  final String baseUrl;
  final TokenStore tokenStore;
  final http.Client _http;

  static String _trim(String s) => s.endsWith('/') ? s.substring(0, s.length - 1) : s;

  Uri _uri(String path) => Uri.parse('$baseUrl/api$path');

  Future<Map<String, String>> _headers(Map<String, String>? extra) async {
    final token = await tokenStore.read();
    return {
      'Content-Type': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
      ...?extra,
    };
  }

  /// Perform a request and return the decoded JSON body (`Map`, `List`, or
  /// `null` for empty 200s). Throws [ApiException] on non-2xx or network error.
  Future<dynamic> send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? headers,
    String? idempotencyKey,
  }) async {
    final hdrs = await _headers({
      ...?headers,
      if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
    });

    http.Response res;
    try {
      final req = http.Request(method, _uri(path))..headers.addAll(hdrs);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _http.send(req));
    } catch (e) {
      // DNS/connection/TLS failure before any response.
      throw ApiException(0, "Can't reach the server ($baseUrl). $e");
    }

    final text = res.body;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      Object? detail = text;
      var msg = text;
      try {
        final parsed = jsonDecode(text);
        final d = parsed is Map ? parsed['detail'] : null;
        detail = d ?? parsed;
        if (d is Map && d['message'] != null) {
          msg = d['message'].toString();
        } else if (d != null) {
          msg = d is String ? d : jsonEncode(d);
        }
      } catch (_) {
        // Non-JSON error body — keep the raw text.
      }
      throw ApiException(res.statusCode, msg, detail: detail);
    }

    if (text.isEmpty) return null; // some endpoints reply 200 with no body
    try {
      return jsonDecode(text);
    } catch (_) {
      throw ApiException(res.statusCode, 'Unexpected non-JSON response from ${_uri(path)}');
    }
  }

  Future<dynamic> getJson(String path, {Map<String, String>? headers}) =>
      send('GET', path, headers: headers);

  Future<dynamic> postJson(String path, {Object? body, String? idempotencyKey}) =>
      send('POST', path, body: body, idempotencyKey: idempotencyKey);

  Future<dynamic> patchJson(String path, {Object? body}) =>
      send('PATCH', path, body: body);

  Future<dynamic> putJson(String path, {Object? body}) =>
      send('PUT', path, body: body);

  Future<dynamic> deleteJson(String path, {Object? body}) =>
      send('DELETE', path, body: body);

  void close() => _http.close();
}
