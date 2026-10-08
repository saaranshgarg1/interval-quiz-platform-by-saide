import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';
import { clearAllAttemptStorage } from './lib/attempt-storage';
import { queryClient } from './lib/query';
import type { User } from './types';

interface AuthState {
  user: User | null;
  token: string | null;
  /**
   * False until the initial session bootstrap resolves. Guards against
   * redirecting a token-holding user to /login on a hard navigation or
   * refresh before `refresh()` has had a chance to restore `user`.
   */
  ready: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string, entryNumber?: string) => Promise<User>;
  sso: (idToken: string) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTok] = useState<string | null>(getToken());
  // If there's no stored token there's nothing to restore, so we're ready immediately.
  const [ready, setReady] = useState<boolean>(() => !getToken());

  const refresh = useCallback(async () => {
    const t = getToken();
    if (!t) return;
    try {
      const res = await api.get<{ user: User }>('/auth/me');
      setUser(res.user);
    } catch {
      setToken(null);
      setTok(null);
      setUser(null);
    }
  }, []);

  // One-shot session bootstrap: restore the user from a stored token on mount,
  // then flip `ready` so route guards can safely act on the resolved state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string, entryNumber?: string) => {
      const res = await api.post<{ token: string; user: User }>('/auth/register', {
        name,
        email,
        password,
        entry_number: entryNumber,
      });
      setToken(res.token);
      setTok(res.token);
      setUser(res.user);
      return res.user;
    },
    [],
  );

  const sso = useCallback(async (idToken: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/sso', { id_token: idToken });
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(() => {
    // Shared lab machines: leave no attempt session, buffered answers or cached data behind.
    clearAllAttemptStorage();
    queryClient.clear();
    setToken(null);
    setTok(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, ready, login, register, sso, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export { setToken as clearToken };