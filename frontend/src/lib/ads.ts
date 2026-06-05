// Helpers to weave sponsored ads INTO a post list (rendered as normal posts),
// instead of pinning them to a header.

export type AdMarker = { __ad: number };

/** Insert an ad marker after every `every` posts. */
export function interleaveAds<T extends { id: string }>(items: T[], every = 6): (T | AdMarker)[] {
  const out: (T | AdMarker)[] = [];
  items.forEach((it, i) => {
    out.push(it);
    if ((i + 1) % every === 0) out.push({ __ad: i });
  });
  return out;
}

export const isAd = (x: any): x is AdMarker => !!x && typeof x.__ad === "number";
