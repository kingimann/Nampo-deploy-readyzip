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
import { api, SESSION_TOKEN_KEY, User, LoginResponse } from "@/src/api/client";
import { storage } from "@/src/utils/storage";
import { ensureKeyPair } from "@/src/utils/e2e";

type AuthState = {
  loading: boolean;
  user: User | null;
  signOut: () => Promise<void>;
  applySessionToken: (token: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  loginLocal: (identifier: string, password: string) => Promise<LoginResponse>;
  registerLocal: (email: string, password: string, name: string, username: string) => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  // Once signed in, make sure our E2E keypair exists and our public key is
  // published — so peers can end-to-end encrypt to us from the first message.
  useEffect(() => {
    if (user?.user_id) { ensureKeyPair().catch(() => {}); }
  }, [user?.user_id]);

  // Presence heartbeat: mark ourselves active now, then every 50s while signed in.
  useEffect(() => {
    if (!user?.user_id) return;
    let alive = true;
    const ping = () => { if (alive) api.presencePing().catch(() => {}); };
    ping();
    const id = setInterval(ping, 50000);
    return () => { alive = false; clearInterval(id); };
  }, [user?.user_id]);

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

  const applySessionToken = useCallback(
    async (token: string): Promise<boolean> => {
      try {
        await storage.secureSet(SESSION_TOKEN_KEY, token);
        const me = await api.me();
        setUser(me);
        return true;
      } catch {
        await storage.secureRemove(SESSION_TOKEN_KEY);
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
    const res = await api.loginLocal({ identifier, password });
    // Two-factor accounts get a challenge instead of a session — let the caller
    // collect the SMS code and finish via api.login2fa + applySessionToken.
    if ("twofa_required" in res) return res;
    await storage.secureSet(SESSION_TOKEN_KEY, res.session_token);
    setUser(res.user);
    return res;
  }, []);

  const registerLocal = useCallback(async (email: string, password: string, name: string, username: string) => {
    const { session_token, user: u } = await api.registerLocal({ email, password, name, username });
    await storage.secureSet(SESSION_TOKEN_KEY, session_token);
    setUser(u);
  }, []);

  // Parse session_token from URL (web) or deep link (mobile) after Google OAuth
  const handleUrl = useCallback(
    async (url: string | null) => {
      if (!url) return false;
      let tok: string | null = null;
      try {
        // Support both ?session_token=... and #session_token=...
        const u = new URL(url);
        tok = u.searchParams.get("session_token");
        if (!tok && u.hash) {
          const params = new URLSearchParams(u.hash.replace(/^#/, ""));
          tok = params.get("session_token");
        }
      } catch {
        // Fallback regex parse
        const match = url.match(/[?#&]session_token=([^&]+)/);
        if (match) tok = decodeURIComponent(match[1]);
      }
      if (!tok) return false;

      const ok = await applySessionToken(tok);
      if (ok && Platform.OS === "web" && typeof window !== "undefined") {
        window.history.replaceState(null, "", window.location.pathname);
      }
      return ok;
    },
    [applySessionToken],
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
      applySessionToken,
      refresh: checkSession,
      loginLocal,
      registerLocal,
    }),
    [loading, user, signOut, applySessionToken, checkSession, loginLocal, registerLocal],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useAuth = (): AuthState => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
};
