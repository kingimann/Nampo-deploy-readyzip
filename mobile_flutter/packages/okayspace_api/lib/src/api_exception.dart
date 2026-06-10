/// Thrown for any non-2xx response (or a network failure with [statusCode] 0).
///
/// Mirrors the JS client's `throw new Error("<status>: <detail.message>")`: the
/// backend's `{ detail }` envelope is unwrapped into [message], and the raw
/// parsed detail (string or object) is kept on [detail] for richer handling
/// (e.g. field-level validation errors).
class ApiException implements Exception {
  ApiException(this.statusCode, this.message, {this.detail});

  /// HTTP status, or 0 when the request never reached the server.
  final int statusCode;

  /// Human-readable message (FastAPI `detail.message` when present).
  final String message;

  /// Raw parsed `detail` (String, Map, or List) when the body was JSON.
  final Object? detail;

  bool get isNetworkError => statusCode == 0;
  bool get isUnauthorized => statusCode == 401;
  bool get isForbidden => statusCode == 403;
  bool get isNotFound => statusCode == 404;

  @override
  String toString() => '$statusCode: $message';
}
