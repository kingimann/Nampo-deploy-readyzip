import React from "react";

// Desktop is fully supported now — the web app runs as a website on PC. This
// gate used to block desktop browsers (when an admin enabled "mobile only") and
// tell people to open the site on their phone. It's now a passthrough so PC
// always works; kept as a component so it can be re-enabled later if needed.
export default function MobileOnlyGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
