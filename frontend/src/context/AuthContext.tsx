import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import { api, SESSION_TOKEN_KEY, User } from "@/src/api/client";
import { storage } from "@/src/utils/storage";

type AuthState = {
  loading: boolean;
  user: User | null;
  signOut: () => Promise<void>;
  processSessionId: (sessionId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  loginLocal: (identifier: string, password: string) => Promise<void>;
  registerLocal: (email: string, password: string, name: string, username: string) => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const token = await storage.secureGet<string>(SESSION_TOKEN_KEY, "");
      if (!token) {
        setUser(null);
        return;
      }
      const me = await api.me();
      setUser(me);
    } catch {
      await storage.secureRemove(SESSION_TOKEN_KEY);
      setUser(null);
    }
  }, []);

  const processSessionId = useCallback(
    async (sessionId: string): Promise<boolean> => {
      try {
        const { session_token, user: u } = await api.exchangeSession(sessionId);
        await storage.secureSet(SESSION_TOKEN_KEY, session_token);
        setUser(u);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    await storage.secureRemove(SESSION_TOKEN_KEY);
    setUser(null);
  }, []);

  const loginLocal = useCallback(async (identifier: string, password: string) => {
    const { session_token, user: u } = await api.loginLocal({ identifier, password });
    await storage.secureSet(SESSION_TOKEN_KEY, session_token);
    setUser(u);
  }, []);

  const registerLocal = useCallback(async (email: string, password: string, name: string, username: string) => {
    const { session_token, user: u } = await api.registerLocal({ email, password, name, username });
    await storage.secureSet(SESSION_TOKEN_KEY, session_token);
    setUser(u);
  }, []);

  // Parse session_id from URL (web) or initial deep link (mobile)
  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url) return false;
      let sid: string | null = null;
      try {
        // Support both ?session_id=... and #session_id=...
        const u = new URL(url);
        sid = u.searchParams.get("session_id");
        if (!sid && u.hash) {
          const params = new URLSearchParams(u.hash.replace(/^#/, ""));
          sid = params.get("session_id");
        }
      } catch {
        // Fallback regex parse
        const match = url.match(/[?#&]session_id=([^&]+)/);
        if (match) sid = decodeURIComponent(match[1]);
      }
      if (!sid) return false;

      const ok = await processSessionId(sid);
      if (ok && Platform.OS === "web" && typeof window !== "undefined") {
        window.history.replaceState(null, "", window.location.pathname);
      }
      return ok;
    },
    [processSessionId],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const handled = await handleUrl(window.location.href);
        if (!handled) await checkSession();
      } else {
        const initial = await Linking.getInitialURL();
        const handled = await handleUrl(initial);
        if (!handled) await checkSession();
      }
      if (mounted) setLoading(false);
    })();

    const sub = Linking.addEventListener("url", ({ url }) => {
      handleUrl(url);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [checkSession, handleUrl]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      signOut,
      processSessionId,
      refresh: checkSession,
      loginLocal,
      registerLocal,
    }),
    [loading, user, signOut, processSessionId, checkSession, loginLocal, registerLocal],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useAuth = (): AuthState => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
};
