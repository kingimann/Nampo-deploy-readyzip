/// Where the session token lives between launches.
///
/// The JS client stores it in secure storage under the key `session_token`.
/// In Flutter, back this with `flutter_secure_storage` (see the package README)
/// so the token survives restarts and stays in the platform keychain/keystore.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// Default, non-persistent store — fine for tests/POCs. Replace with a secure,
/// persistent implementation in a real app.
class InMemoryTokenStore implements TokenStore {
  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async => _token = token;

  @override
  Future<void> clear() async => _token = null;
}
