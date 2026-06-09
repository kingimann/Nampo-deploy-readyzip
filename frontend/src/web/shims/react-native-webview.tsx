/**
 * Web stub for `react-native-webview`.
 *
 * The real package has no react-native-web build — importing it executes
 * native-module lookups that throw on web ("Cannot read properties of undefined
 * (reading 'NativeModule…')"), which blanks the whole app at load.
 *
 * Every component here renders a real <iframe> on web and only uses <WebView> on
 * native, so this stub is never actually rendered — it exists solely to satisfy
 * the import without touching native modules.
 */
import React from "react";

export const WebView: any = React.forwardRef((_props: any, _ref: any) => null);
WebView.displayName = "WebViewWebStub";

export default { WebView };
