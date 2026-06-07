// @ts-nocheck
import React, { useEffect, useRef } from "react";
import { theme } from "@/src/theme";

/**
 * Web build of the signature pad. react-native-webview doesn't run on
 * react-native-web, so on web we draw on a real DOM <canvas> directly and post
 * the PNG data URL back via onChange — the native pad (SignaturePad.tsx) keeps
 * using a WebView. Metro picks this file automatically on web.
 */
export default function SignaturePad({ onChange, height = 170 }: { onChange: (dataUrl: string) => void; height?: number }) {
  const ref = useRef(null);
  const dirty = useRef(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    const fit = () => {
      c.width = c.clientWidth || 300;
      c.height = c.clientHeight || height;
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = theme.textPrimary;
    };
    fit();
    window.addEventListener("resize", fit);
    let drawing = false;
    const pos = (e: any) => {
      const r = c.getBoundingClientRect();
      const t = (e.touches && e.touches[0]) || e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const down = (e: any) => { drawing = true; dirty.current = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e: any) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
    const up = () => { if (drawing) { drawing = false; onChange(dirty.current ? c.toDataURL("image/png") : ""); } };
    c.addEventListener("mousedown", down);
    c.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    c.addEventListener("touchstart", down, { passive: false });
    c.addEventListener("touchmove", move, { passive: false });
    c.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("mouseup", up);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => {
    const c = ref.current;
    if (!c) return;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange("");
  };

  return (
    <div>
      <canvas
        ref={ref}
        style={{
          width: "100%", height, display: "block", boxSizing: "border-box",
          border: `1px solid ${theme.border}`, borderRadius: 12,
          background: theme.surface, touchAction: "none", cursor: "crosshair",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button
          type="button"
          onClick={clear}
          style={{
            background: "transparent", color: theme.textMuted, fontSize: 12.5, fontWeight: 700,
            border: `1px solid ${theme.border}`, borderRadius: 8, padding: "5px 12px", cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
