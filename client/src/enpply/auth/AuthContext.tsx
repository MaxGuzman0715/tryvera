import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, setUnauthorizedHandler } from "../api";
import type { AuthUser } from "../types";

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  needsSetup: boolean;
};

type AuthContextValue = AuthState & {
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Replace the cached user (used after PUT /api/auth/me/preferences). */
  setUser: (user: AuthUser) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, needsSetup: false });
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const status = await api.getSetupStatus();
      if (status.needsSetup) {
        if (mountedRef.current) {
          setState({ user: null, loading: false, needsSetup: true });
        }
        return;
      }
      try {
        const { user } = await api.me();
        if (mountedRef.current) setState({ user, loading: false, needsSetup: false });
      } catch {
        if (mountedRef.current) setState({ user: null, loading: false, needsSetup: false });
      }
    } catch {
      if (mountedRef.current) setState({ user: null, loading: false, needsSetup: false });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    setUnauthorizedHandler(() => {
      if (mountedRef.current) setState((s) => ({ ...s, user: null }));
    });
    return () => {
      mountedRef.current = false;
      setUnauthorizedHandler(null);
    };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.login({ email, password });
    setState({ user, loading: false, needsSetup: false });
  }, []);

  const setup = useCallback(async (email: string, password: string) => {
    const { user } = await api.setup({ email, password });
    setState({ user, loading: false, needsSetup: false });
  }, []);

  const setUser = useCallback((user: AuthUser) => {
    setState((prev) => ({ ...prev, user, loading: false, needsSetup: false }));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best-effort */
    }
    setState({ user: null, loading: false, needsSetup: false });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAdmin: state.user?.role === "admin",
      login,
      setup,
      logout,
      refresh,
      setUser,
    }),
    [state, login, setup, logout, refresh, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
