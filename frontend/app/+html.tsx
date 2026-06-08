// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%", overflow: "hidden" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover, shrink-to-fit=no, interactive-widget=resizes-content"
        />
        {/* Make the web build installable + open standalone, like a native app. */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0B141A" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Nami" />
        <link rel="apple-touch-icon" href="/icon.png" />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              /* Lock the document to the viewport so the page can't scroll/
                 rubber-band into empty white space on mobile Safari. App screens
                 scroll internally via ScrollView/FlatList. */
              html { height: 100%; overflow: hidden !important; overscroll-behavior: none !important; touch-action: manipulation; }
              body {
                position: fixed !important;
                top: 0; left: 0; right: 0; bottom: 0;
                width: 100%; height: 100%;
                margin: 0; overflow: hidden !important;
                overscroll-behavior: none !important;
                touch-action: manipulation;   /* block double-tap zoom; map keeps its own pinch */
              }
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }

              /* ---- Native-app feel in the browser ---- */
              html { background: #000; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
              body { background: #0B141A; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
              /* No text selection or long-press callout (feels like an app, not a page).
                 Inputs and anything React Native marks selectable stay selectable. */
              * { -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none;
                  -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; }
              input, textarea, [contenteditable="true"], [data-selectable="true"] {
                  -webkit-user-select: text; -moz-user-select: text; -ms-user-select: text; user-select: text; -webkit-touch-callout: default; }
              /* Hide scrollbars everywhere — app screens scroll internally. */
              * { scrollbar-width: none; -ms-overflow-style: none; -webkit-overflow-scrolling: touch; }
              *::-webkit-scrollbar { display: none; width: 0; height: 0; }
              /* No image drag ghost / blue focus ring on tappables. */
              img, a { -webkit-user-drag: none; user-drag: none; }
              :focus { outline: none; }

              /* Branded launch screen shown while the app boots (and on PWA cold start). */
              #nami-splash {
                position: fixed; inset: 0; z-index: 99999;
                display: flex; align-items: center; justify-content: center;
                background: #0B141A; transition: opacity .35s ease;
              }
              #nami-splash img { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 10px 34px rgba(0,0,0,.55); }
              #nami-splash.hide { opacity: 0; pointer-events: none; }
            `,
          }}
        />
        {/* Block page pinch-zoom (iOS Safari ignores user-scalable=no). These iOS
            'gesture*' events only fire for multi-finger pinch, so normal taps and
            the app's own double-tap gestures are unaffected. (Double-tap-to-zoom
            is already disabled by touch-action above.) The map keeps its own zoom. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
              document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
              document.addEventListener('gestureend', function (e) { e.preventDefault(); }, { passive: false });
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          overscrollBehavior: "none",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
        {/* Keep the app sized to the VISUAL viewport so the on-screen keyboard
            never covers bottom inputs (chat composer, compose box, etc.). The
            layout is position:fixed/full-height, so on mobile the keyboard would
            otherwise sit on top of it. interactive-widget handles Android;
            this VisualViewport handler covers iOS Safari, which ignores it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                var vv = window.visualViewport;
                if(!vv) return;
                function rootEl(){ return document.querySelector('body > div'); }
                function apply(){
                  var r = rootEl();
                  if(!r) return;
                  r.style.position = 'fixed';
                  r.style.top = vv.offsetTop + 'px';
                  r.style.left = '0';
                  r.style.right = '0';
                  r.style.bottom = 'auto';
                  r.style.height = vv.height + 'px';
                }
                vv.addEventListener('resize', apply);
                vv.addEventListener('scroll', apply);
                if(rootEl()){ apply(); }
                else {
                  var o = new MutationObserver(function(){ if(rootEl()){ o.disconnect(); apply(); } });
                  o.observe(document.body, { childList: true });
                }
              })();
            `,
          }}
        />
        {/* Branded launch screen — removed as soon as the app mounts. */}
        <div id="nami-splash">
          <img src="/icon.png" alt="Nami" />
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function(){
                function hide(){ var s=document.getElementById('nami-splash'); if(!s) return; s.className='hide'; setTimeout(function(){ if(s&&s.parentNode) s.parentNode.removeChild(s); }, 420); }
                var done=false; function finish(){ if(done) return; done=true; hide(); }
                var root=document.querySelector('body > div'); // the React Native app root (first div)
                if(root){
                  if(root.childNodes.length>0){ finish(); }
                  else { var o=new MutationObserver(function(){ if(root.childNodes.length>0){ o.disconnect(); finish(); } }); o.observe(root,{childList:true}); }
                }
                window.addEventListener('load', function(){ setTimeout(finish, 2000); });
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}
