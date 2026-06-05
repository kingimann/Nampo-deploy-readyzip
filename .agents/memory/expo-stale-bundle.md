---
name: Expo Metro stale-bundle false crashes
description: How to tell a real source bug from a stale web bundle in the Expo frontend
---

# Stale Metro bundle masquerades as a source crash

A `ReferenceError` / "Invalid hook call" in a screen (e.g. MapScreen `index.tsx`) shown in
the browser console can be a **stale Metro web bundle**, not a real source bug.

**Why:** Removing a symbol (state var, hook, import) from a `(tabs)` screen while the dev
server is serving an old compiled bundle leaves the browser running code that still
references the deleted symbol. `tsc --noEmit` is clean and grep finds no reference, yet the
console keeps throwing — and React's error boundary recreating the tree emits cascading
"Invalid hook call" noise that looks like a second, unrelated bug.

**How to apply:** Before chasing a console crash, confirm the source is actually clean
(grep for the symbol, run tsc). If clean, restart the `Start frontend` workflow to force a
fresh bundle, then re-check. Distinguish stale errors by timestamp: console logs accumulate,
so errors logged *before* the latest "Running application main" / "Web Bundled" line are
pre-restart and can be ignored.
