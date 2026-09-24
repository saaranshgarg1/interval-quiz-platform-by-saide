import { createContext, useContext, useCallback, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string, role: 'student' | 'instructor') => Promise<User>;
  sso: (idToken: string) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTok] = useState<string | null>(getToken());

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

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    setToken(res.token);
    setTok(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string, role: 'student' | 'instructor') => {
      const res = await api.post<{ token: string; user: User }>('/auth/register', {
        name,
        email,
        password,
        role,
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
    setToken(null);
    setTok(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, login, register, sso, logout, refresh }}>
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