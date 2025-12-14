/**
 * Auth Provider Component
 *
 * Handles initial auth state loading and provides auth context to the app.
 * Must be wrapped inside the tRPC provider.
 */

import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "../hooks/useAuth";
import { trpc } from "../trpc";

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { token, setUser, setLoading, logout } = useAuthStore();

  // Fetch current user on mount and when token changes
  const { data, isLoading, error } = trpc.auth.me.useQuery(undefined, {
    enabled: !!token, // Only fetch if we have a token
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!token) {
      // No token, not authenticated
      setUser(null);
      setLoading(false);
      return;
    }

    if (isLoading) {
      setLoading(true);
      return;
    }

    if (error) {
      // Token is invalid, clear it
      logout();
      setLoading(false);
      return;
    }

    if (data) {
      setUser(data);
    } else {
      setUser(null);
    }
    setLoading(false);
  }, [token, data, isLoading, error, setUser, setLoading, logout]);

  return <>{children}</>;
}
