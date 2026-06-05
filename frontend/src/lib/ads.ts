// Helpers to weave sponsored ads INTO a post list (rendered as normal posts),
// instead of pinning them to a header.

export type AdMarker = { __ad: number };

// First ad after this many posts, then one every `AD_EVERY` after. Kept sparse
// so the newsfeed isn't flooded with sponsored posts. Short lists (e.g. a
// profile with a few posts) still get exactly one ad via the guarantee below.
export const AD_FIRST = 5;
export const AD_EVERY = 10;

/** Weave ad markers into a post list. `__ad` is the slot ordinal (0,1,2…) so each
 *  slot can request distinct inventory and rotate. Guarantees at least one ad on
 *  any non-empty list so short feeds (profiles) still show sponsored content. */
export function interleaveAds<T extends { id: string }>(items: T[], every = AD_EVERY, first = AD_FIRST): (T | AdMarker)[] {
  const out: (T | AdMarker)[] = [];
  let ad = 0;
  items.forEach((it, i) => {
    out.push(it);
    const pos = i + 1;
    if (pos === first || (pos > first && (pos - first) % every === 0)) {
      out.push({ __ad: ad }); ad++;
    }
  });
  if (items.length > 0 && ad === 0) out.push({ __ad: 0 }); // short list → still one ad
  return out;
}

export const isAd = (x: any): x is AdMarker => !!x && typeof x.__ad === "number";
