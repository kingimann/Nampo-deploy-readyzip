/**
 * Web entry point (replaces `expo-router/entry`).
 *
 * Uses react-native-web's AppRegistry so the root node gets RNW's flex/height
 * styles (a plain createRoot mount leaves #root non-flex and the app collapses
 * to 0 height → blank screen). An error boundary renders any mount-time crash
 * to the DOM so failures are visible instead of a white page.
 */
import "react-native-url-polyfill/auto";
import React from "react";
import { AppRegistry } from "react-native";
import { RouterProvider } from "react-router-dom";
import { router } from "./routes";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("App crash:", err, info);
  }
  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            padding: 20, color: "#E9EDEF", background: "#0a0a0a",
            fontFamily: "monospace", whiteSpace: "pre-wrap",
            height: "100%", overflow: "auto", boxSizing: "border-box",
          }}
        >
          <h2 style={{ color: "#F15C6D" }}>App error</h2>
          {String(this.state.err?.message || this.state.err)}
          {"\n\n"}
          {String(this.state.err?.stack || "")}
        </div>
      );
    }
    return this.props.children as React.ReactElement;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}

AppRegistry.registerComponent("OkaySpace", () => App);
AppRegistry.runApplication("OkaySpace", {
  rootTag: document.getElementById("root"),
});
