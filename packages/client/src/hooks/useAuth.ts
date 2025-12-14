/**
 * Authentication Hook
 *
 * Provides authentication state and methods for the application.
 * Uses localStorage to persist the auth token.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Auth token storage key
const AUTH_TOKEN_KEY = "annex_auth_token";

// User type from the auth.me response
export interface AuthUser {
  id: string;
  email: string | null;
  username: string;
  avatar: string | null;
  isAdmin: boolean;
  plexAccount: {
    plexId: string;
    plexUsername: string;
  } | null;
  embyAccount: {
    embyId: string;
    embyUsername: string;
  } | null;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  isLoading: boolean;

  // Actions
  setToken: (token: string | null) => void;
  setUser: (user: AuthUser | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

/**
 * Auth store using Zustand with persistence
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isLoading: true,

      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      setLoading: (isLoading) => set({ isLoading }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: AUTH_TOKEN_KEY,
      partialize: (state) => ({ token: state.token }), // Only persist token
    }
  )
);

/**
 * Get the current auth token (for use in tRPC client)
 */
export function getAuthToken(): string | null {
  return useAuthStore.getState().token;
}
