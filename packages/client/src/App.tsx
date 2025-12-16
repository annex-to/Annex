import { useState, useRef, useEffect } from "react";
import { Routes, Route, useLocation, Navigate, Link } from "react-router-dom";
import DiscoverPage from "./pages/Discover";
import MediaDetailPage from "./pages/MediaDetail";
import RequestsPage from "./pages/Requests";
import LibraryPage from "./pages/Library";
import SettingsPage from "./pages/Settings";
import PreferencesPage from "./pages/Preferences";
import LoginPage from "./pages/Login";
import SetupPage from "./pages/Setup";
import { NavButton } from "./components/ui/NavButton";
import { AuthProvider } from "./components/AuthProvider";
import { useAuthStore } from "./hooks/useAuth";
import { trpc } from "./trpc";
import type { ReactNode } from "react";

// Setup guard - redirects to /setup if app is not configured
function SetupGuard({ children }: { children: ReactNode }) {
  const { data: status, isLoading } = trpc.secrets.setupStatus.useQuery();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!status?.isConfigured) {
    return <Navigate to="/setup" replace />;
  }

  return <>{children}</>;
}

// Protected route wrapper
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token, user, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// User menu component with dropdown
function UserMenu() {
  const { user, logout } = useAuthStore();
  const logoutMutation = trpc.auth.logout.useMutation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleLogout = async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch {
      // Ignore errors, clear local state anyway
    }
    logout();
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!user) return null;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 hover:bg-white/5 rounded px-2 py-1 transition-colors"
      >
        {user.avatar ? (
          <img
            src={user.avatar}
            alt={user.username}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-annex-500/20 flex items-center justify-center text-annex-400 text-sm font-medium">
            {user.username.charAt(0).toUpperCase()}
          </div>
        )}
        <span className="text-sm text-white/70">{user.username}</span>
        {user.isAdmin && (
          <span className="text-xs bg-annex-500/20 text-annex-400 px-1.5 py-0.5 rounded">
            Admin
          </span>
        )}
        <svg
          className={`w-4 h-4 text-white/50 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-black/95 border border-white/10 rounded shadow-xl z-50">
          <div className="py-1">
            <Link
              to="/preferences"
              onClick={() => setIsOpen(false)}
              className="block px-4 py-2 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
            >
              Preferences
            </Link>
            <hr className="my-1 border-white/10" />
            <button
              onClick={() => {
                setIsOpen(false);
                handleLogout();
              }}
              className="w-full text-left px-4 py-2 text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function AppLayout() {
  const location = useLocation();
  const isMediaDetailPage = location.pathname.startsWith("/movie/") || location.pathname.startsWith("/tv/");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-black/90 border-b border-surface-900 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <span>🍿</span>
              <span className="bg-gradient-to-r from-annex-500 to-gold-500 bg-clip-text text-transparent">Annex</span>
            </h1>
            <nav className="flex gap-2">
              <NavButton to="/" end>Discover</NavButton>
              <NavButton to="/requests">Requests</NavButton>
              <NavButton to="/library">Library</NavButton>
              <NavButton to="/settings">Settings</NavButton>
            </nav>
          </div>
          <UserMenu />
        </div>
      </header>

      {/* Main content with ambient glow */}
      <main className="flex-1 ambient-glow">
        <div className={isMediaDetailPage ? "" : "max-w-7xl mx-auto px-4 py-8"}>
          <Routes>
            <Route path="/" element={<DiscoverPage />} />
            <Route path="/movie/:id" element={<MediaDetailPage />} />
            <Route path="/tv/:id" element={<MediaDetailPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/preferences" element={<PreferencesPage />} />
          </Routes>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-black border-t border-surface-900 py-4">
        <div className="max-w-7xl mx-auto px-4 text-center text-surface-500 text-sm">
          <span className="text-annex-500">Annex</span> v0.1.0 — Media Acquisition & Delivery Platform
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Setup wizard - no guards needed */}
        <Route path="/setup" element={<SetupPage />} />
        {/* Login - only accessible if app is configured */}
        <Route
          path="/login"
          element={
            <SetupGuard>
              <LoginPage />
            </SetupGuard>
          }
        />
        {/* Main app - requires setup and auth */}
        <Route
          path="/*"
          element={
            <SetupGuard>
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            </SetupGuard>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
