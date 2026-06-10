import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { theme } from "@/src/theme";

/**
 * Catches render-time errors in the route tree so a single screen blowing up
 * (e.g. an infinite-update loop, a thrown invariant) shows a recoverable
 * fallback instead of crashing/reloading the whole web app in a loop.
 *
 * It deliberately does NOT auto-reload — that's what turns a one-off error into
 * an endless refresh. The error text is shown on screen so it can actually be
 * read/reported, with a "Try again" that just re-renders the subtree.
 */
type Props = { children: React.ReactNode };
type State = { error: Error | null; stack?: string | null };

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Surface it in the console too (one entry, not a loop).
    // eslint-disable-next-line no-console
    console.error("[AppErrorBoundary]", error?.message, info?.componentStack);
    this.setState({ stack: info?.componentStack || null });
  }

  reset = () => this.setState({ error: null, stack: null });

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const firstStackLine = (stack || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join("\n");

    return (
      <ScrollView contentContainerStyle={styles.wrap} testID="app-error-boundary">
        <Text style={styles.emoji}>😵</Text>
        <Text style={styles.title}>Something broke on this screen</Text>
        <Text style={styles.sub}>
          It’s been contained so the app won’t keep reloading. Details below.
        </Text>
        <View style={styles.box}>
          <Text style={styles.errText} selectable>
            {error.name}: {error.message}
          </Text>
          {!!firstStackLine && (
            <Text style={styles.stackText} selectable>
              {firstStackLine}
            </Text>
          )}
        </View>
        <TouchableOpacity style={styles.btn} onPress={this.reset} testID="error-try-again">
          <Text style={styles.btnText}>Try again</Text>
        </TouchableOpacity>
        {Platform.OS === "web" && (
          <TouchableOpacity
            style={[styles.btn, styles.btnGhost]}
            onPress={() => { try { window.location.assign("/feed"); } catch {} }}
            testID="error-go-home"
          >
            <Text style={[styles.btnText, { color: theme.textPrimary }]}>Go to Home</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 12, backgroundColor: theme.bg },
  emoji: { fontSize: 40 },
  title: { color: theme.textPrimary, fontSize: 20, fontWeight: "800", textAlign: "center" },
  sub: { color: theme.textSecondary, fontSize: 14, textAlign: "center", maxWidth: 420, lineHeight: 20 },
  box: {
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    padding: 14, gap: 8, maxWidth: 560, width: "100%",
  },
  errText: { color: theme.error, fontSize: 13.5, fontWeight: "700" },
  stackText: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
  btn: { backgroundColor: theme.primary, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 12, marginTop: 4 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.border },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
