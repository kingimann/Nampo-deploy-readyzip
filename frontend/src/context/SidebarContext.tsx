import React, { createContext, useContext, useMemo, useState } from "react";

type Ctx = { open: boolean; setOpen: (v: boolean) => void };
const SidebarContext = createContext<Ctx>({ open: false, setOpen: () => {} });

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Memoize so consumers (DesktopShell, etc.) don't re-render on every provider
  // render from a fresh value object — only when `open` actually changes.
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <SidebarContext.Provider value={value}>
      {children}
    </SidebarContext.Provider>
  );
}

export const useSidebar = () => useContext(SidebarContext);
