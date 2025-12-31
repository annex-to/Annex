/**
 * Login Page
 *
 * Handles Plex OAuth and Emby authentication flows
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Input, Label } from "../components/ui";
import { useAuthStore } from "../hooks/useAuth";
import { trpc } from "../trpc";

// Plex logo SVG
function PlexLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M11.643 0H4.68l7.679 12L4.68 24h6.963l7.677-12L11.643 0z" />
    </svg>
  );
}

// Emby logo SVG
function EmbyLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M11.041 2.177C6.398 2.64 2.639 6.398 2.177 11.041c-.173 1.729-.173 3.189 0 4.918.462 4.643 4.221 8.401 8.864 8.864 1.729.173 3.189.173 4.918 0 4.643-.463 8.402-4.221 8.864-8.864.173-1.729.173-3.189 0-4.918-.462-4.643-4.221-8.401-8.864-8.864-1.729-.173-3.189-.173-4.918 0zm4.186 4.92l3.036 4.903-3.036 4.903H8.773L5.737 12 8.773 7.097h6.454z" />
    </svg>
  );
}

type AuthMethod = "select" | "plex" | "emby";

type LoginState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "awaiting"; pinId: string; authUrl: string }
  | { status: "error"; message: string };

export default function LoginPage() {
  const navigate = useNavigate();
  const { token, user, setToken } = useAuthStore();
  const [authMethod, setAuthMethod] = useState<AuthMethod>("select");
  const [state, setState] = useState<LoginState>({ status: "idle" });
  const pollIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Check if Plex/Emby servers exist
  const { data: plexServers } = trpc.servers.hasPlexServers.useQuery();
  const { data: embyServerList } = trpc.auth.getEmbyServers.useQuery();
  const { data: embyConfig } = trpc.auth.embyConfigured.useQuery();

  const isPlexAvailable = plexServers?.exists ?? false;
  const isEmbyAvailable = embyConfig?.configured ?? false;
  const availableEmbyServers = embyServerList?.servers ?? [];

  // Emby form state
  const [selectedEmbyServerId, setSelectedEmbyServerId] = useState<string>("");
  const [embyUsername, setEmbyUsername] = useState("");
  const [embyPassword, setEmbyPassword] = useState("");

  // Mutations
  const plexLogin = trpc.auth.plexLogin.useMutation();
  const plexCallback = trpc.auth.plexCallback.useMutation();
  const embyLogin = trpc.auth.embyLogin.useMutation();

  // If already authenticated, redirect to home
  useEffect(() => {
    if (token && user) {
      navigate("/", { replace: true });
    }
  }, [token, user, navigate]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const startPlexLogin = async () => {
    setState({ status: "loading" });

    try {
      const result = await plexLogin.mutateAsync();
      setState({
        status: "awaiting",
        pinId: result.pinId,
        authUrl: result.authUrl,
      });

      // Open Plex auth in new window
      const authWindow = window.open(result.authUrl, "_blank", "width=800,height=600");

      // Start polling for completion
      pollIntervalRef.current = setInterval(async () => {
        try {
          const callbackResult = await plexCallback.mutateAsync({ pinId: result.pinId });

          if (callbackResult.success && callbackResult.token) {
            // Login successful - set token and let AuthProvider fetch user
            clearInterval(pollIntervalRef.current);
            setToken(callbackResult.token);
            authWindow?.close();
            // AuthProvider will fetch user and redirect
          }
          // If pending, continue polling
        } catch (error) {
          // PIN expired or error
          clearInterval(pollIntervalRef.current);
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Authentication failed",
          });
          authWindow?.close();
        }
      }, 2000); // Poll every 2 seconds
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to start login",
      });
    }
  };

  const handleEmbyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ status: "loading" });

    try {
      const result = await embyLogin.mutateAsync({
        username: embyUsername,
        password: embyPassword,
        serverId: selectedEmbyServerId || undefined,
      });

      if (result.success && result.token) {
        setToken(result.token);
        // AuthProvider will fetch user and redirect
      }
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Emby authentication failed",
      });
    }
  };

  const cancelLogin = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    setState({ status: "idle" });
  };

  const goBack = () => {
    cancelLogin();
    setAuthMethod("select");
    // Reset Emby form
    setSelectedEmbyServerId("");
    setEmbyUsername("");
    setEmbyPassword("");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      {/* Background gradient */}
      <div className="fixed inset-0 bg-black">
        <div className="absolute inset-0 bg-gradient-to-br from-annex-500/20 via-transparent to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-transparent to-annex-500/10" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold flex items-center justify-center gap-3">
            <span>🍿</span>
            <span className="bg-gradient-to-r from-annex-500 to-gold-500 bg-clip-text text-transparent">
              Annex
            </span>
          </h1>
        </div>

        <Card className="p-8">
          <div className="text-center space-y-6">
            <h2 className="text-xl font-semibold text-white">Sign In</h2>

            {/* Auth Method Selection */}
            {authMethod === "select" && state.status === "idle" && (
              <>
                <p className="text-white/60 text-sm">Choose your media server to sign in</p>
                {!isPlexAvailable && !isEmbyAvailable && (
                  <p className="text-annex-400 text-sm">
                    No media servers configured. Please run setup.
                  </p>
                )}
                <div className="space-y-3">
                  {isPlexAvailable && (
                    <Button
                      onClick={() => {
                        setAuthMethod("plex");
                        startPlexLogin();
                      }}
                      className="w-full flex items-center justify-center gap-3"
                      size="lg"
                    >
                      <PlexLogo className="w-5 h-5" />
                      Sign in with Plex
                    </Button>
                  )}
                  {isEmbyAvailable &&
                    availableEmbyServers.map((server) => (
                      <Button
                        key={server.id}
                        onClick={() => {
                          setSelectedEmbyServerId(server.id);
                          setAuthMethod("emby");
                        }}
                        variant="secondary"
                        className="w-full flex items-center justify-center gap-3"
                        size="lg"
                      >
                        <EmbyLogo className="w-5 h-5" />
                        <span className="flex flex-col items-start gap-0.5">
                          <span>{server.name}</span>
                          <span className="text-xs text-white/40">Emby</span>
                        </span>
                      </Button>
                    ))}
                </div>
              </>
            )}

            {/* Emby Login Form */}
            {authMethod === "emby" && state.status === "idle" && (
              <form onSubmit={handleEmbyLogin} className="space-y-4 text-left">
                <div>
                  <Label>Username</Label>
                  <Input
                    type="text"
                    placeholder="Username"
                    value={embyUsername}
                    onChange={(e) => setEmbyUsername(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input
                    type="password"
                    placeholder="Password"
                    value={embyPassword}
                    onChange={(e) => setEmbyPassword(e.target.value)}
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <Button type="button" variant="secondary" onClick={goBack} className="flex-1">
                    Back
                  </Button>
                  <Button type="submit" className="flex-1">
                    Sign In
                  </Button>
                </div>
              </form>
            )}

            {/* Loading State */}
            {state.status === "loading" && (
              <div className="py-4">
                <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-white/60 text-sm mt-4">
                  {authMethod === "emby" ? "Authenticating with Emby..." : "Starting login..."}
                </p>
              </div>
            )}

            {/* Plex Awaiting State */}
            {state.status === "awaiting" && (
              <>
                <div className="py-4">
                  <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin mx-auto" />
                  <p className="text-white/60 text-sm mt-4">Waiting for Plex authorization...</p>
                  <p className="text-white/40 text-xs mt-2">
                    A new window should have opened. Complete the login there.
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button variant="secondary" onClick={goBack} className="flex-1">
                    Cancel
                  </Button>
                  <Button onClick={() => window.open(state.authUrl, "_blank")} className="flex-1">
                    Reopen Plex
                  </Button>
                </div>
              </>
            )}

            {/* Error State */}
            {state.status === "error" && (
              <>
                <div className="py-4">
                  <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto">
                    <svg
                      className="w-6 h-6 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </div>
                  <p className="text-white/60 text-sm mt-4">{state.message}</p>
                </div>
                <div className="flex gap-3">
                  <Button variant="secondary" onClick={goBack} className="flex-1">
                    Back
                  </Button>
                  <Button onClick={() => setState({ status: "idle" })} className="flex-1">
                    Try Again
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
