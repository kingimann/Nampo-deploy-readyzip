import { Platform } from "react-native";

// Apple takes a cut of in-app purchases (standard 30%; 15% under the App Store
// Small Business Program). On iOS we gross prices UP so that after Apple's cut
// the creator/seller still nets the amount they set.
//
//   charge = net / (1 - APPLE_FEE)      // what the buyer pays on iOS
//   net    = charge * (1 - APPLE_FEE)   // what the recipient keeps
//
// e.g. a $5.00 subscription is charged at $7.14 on iOS; Apple keeps $2.14 and
// the creator still receives $5.00.
export const APPLE_FEE = 0.30;

/** True on Apple platforms where the App Store fee applies. */
export const isApplePlatform = Platform.OS === "ios";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Price to charge a buyer so the recipient nets `net`. Grossed up only on iOS. */
export function withAppleFee(net: number): number {
  if (!isApplePlatform || !net) return round2(net || 0);
  return round2(net / (1 - APPLE_FEE));
}

/** Breakdown for a target net amount: what the buyer is charged and the fee. */
export function applePriceBreakdown(net: number): { charged: number; fee: number; net: number; applied: boolean } {
  const charged = withAppleFee(net);
  return { charged, fee: round2(charged - net), net: round2(net), applied: isApplePlatform && charged > net };
}

/** Short label for UI, e.g. "incl. App Store fee" — empty off iOS. */
export const appleFeeNote = isApplePlatform ? "incl. App Store fee" : "";
