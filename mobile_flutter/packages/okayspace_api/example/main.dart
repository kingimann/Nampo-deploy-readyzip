// Pure-Dart smoke test (no Flutter needed):
//   dart run example/main.dart <baseUrl> <identifier> <password>
// e.g. dart run example/main.dart https://okayspace.ca me@example.com 'secret'
import 'package:okayspace_api/okayspace_api.dart';

Future<void> main(List<String> args) async {
  if (args.length < 3) {
    print('usage: dart run example/main.dart <baseUrl> <identifier> <password>');
    return;
  }
  final api = OkaySpaceApi(baseUrl: args[0]); // in-memory token store

  try {
    final res = await api.login(identifier: args[1], password: args[2]);
    if (res.needsTwofa) {
      print('2FA required (code texted to ${res.twofa!.maskedPhone}). '
          'Call api.verify2fa(...) with the code.');
      return;
    }
    print('Logged in as ${res.user!.name} (@${res.user!.username})');

    final feed = await api.homeFeed();
    print('Home feed: ${feed.length} posts');
    if (feed.isNotEmpty) {
      final p = feed.first;
      print('  top: ${p.author.name}: "${p.text}" — ❤ ${p.likesCount}');
    }

    final unread = await api.unreadNotificationsCount();
    print('Unread notifications: $unread');

    final convs = await api.listConversations();
    print('Conversations: ${convs.length}');

    final bal = await api.getWalletBalance();
    print('Wallet: ${bal.balance} ${bal.currency ?? ''}');
  } on ApiException catch (e) {
    print('API error ${e.statusCode}: ${e.message}');
  } finally {
    api.close();
  }
}
