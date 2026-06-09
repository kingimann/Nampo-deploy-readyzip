// One-shot, in-memory signal that the user asked to open the profile editor
// (e.g. Settings → "Edit profile"). Deterministic and URL-independent so the
// editor never re-opens on a page refresh or screen remount — unlike a ?edit=1
// query param, which persists in the URL on web.
let pending = false;

export function requestEditProfile(): void {
  pending = true;
}

// Returns true at most once per request, then resets.
export function consumeEditProfileIntent(): boolean {
  const v = pending;
  pending = false;
  return v;
}
