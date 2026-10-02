import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api';

export type Role = 'admin' | 'supervisor' | 'agent';
export interface User { id: number; name: string; email: string; role: Role }
export interface Company { id: number; name: string; slug: string; tz_offset_minutes?: number }

interface AuthState {
  user: User | null; company: Company | null; loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
}
const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  const logout = useCallback(() => { tokenStore.clear(); setUser(null); setCompany(null); }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) return;
    api<{ user: User; company: Company }>('/auth/me')
      .then((r) => { setUser(r.user); setCompany(r.company); })
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string; user: User; company: Company }>('/auth/login', { body: { email, password } });
    tokenStore.set(r.token); setUser(r.user); setCompany(r.company);
    return r.user;
  }, []);

  const value = useMemo(() => ({ user, company, loading, login, logout }), [user, company, loading, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
