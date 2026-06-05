// Helpers to weave sponsored ads INTO a post list (rendered as normal posts),
// instead of pinning them to a header.

export type AdMarker = { __ad: number };

// How many posts between sponsored slots. Lower = more ads.
export const AD_EVERY = 5;

/** Insert an ad marker after every `every` posts. `__ad` is the slot ordinal
 *  (0,1,2…) so each slot can request distinct inventory and rotate. */
export function interleaveAds<T extends { id: string }>(items: T[], every = AD_EVERY): (T | AdMarker)[] {
  const out: (T | AdMarker)[] = [];
  let ad = 0;
  items.forEach((it, i) => {
    out.push(it);
    if ((i + 1) % every === 0) { out.push({ __ad: ad }); ad++; }
  });
  return out;
}

export const isAd = (x: any): x is AdMarker => !!x && typeof x.__ad === "number";
