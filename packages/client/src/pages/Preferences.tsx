/**
 * User Preferences Page
 *
 * Allows users to view/edit profile and link/unlink accounts
 */

import { useState, useEffect, useRef } from "react";
import { trpc } from "../trpc";
import { Button, Card, Input, Label, Badge } from "../components/ui";

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

type LinkingState =
  | { status: "idle" }
  | { status: "linking"; provider: "plex" | "emby" }
  | { status: "awaiting-plex"; pinId: string; authUrl: string }
  | { status: "error"; message: string };

export default function PreferencesPage() {
  const utils = trpc.useUtils();

  // Fetch profile
  const { data: profile, isLoading } = trpc.auth.getProfile.useQuery();

  // Check if Emby is configured
  const { data: embyConfig } = trpc.auth.embyConfigured.useQuery();
  const isEmbyAvailable = embyConfig?.configured ?? false;

  // Form state
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Emby linking form
  const [embyUsername, setEmbyUsername] = useState("");
  const [embyPassword, setEmbyPassword] = useState("");

  // Linking state
  const [linkingState, setLinkingState] = useState<LinkingState>({ status: "idle" });
  const pollIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Mutations
  const updateProfile = trpc.auth.updateProfile.useMutation();
  const linkPlexStart = trpc.auth.linkPlexStart.useMutation();
  const linkPlexComplete = trpc.auth.linkPlexComplete.useMutation();
  const unlinkPlex = trpc.auth.unlinkPlex.useMutation();
  const linkEmby = trpc.auth.linkEmby.useMutation();
  const unlinkEmby = trpc.auth.unlinkEmby.useMutation();

  // Initialize form with profile data
  useEffect(() => {
    if (profile) {
      setUsername(profile.username);
      setEmail(profile.email || "");
    }
  }, [profile]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      await updateProfile.mutateAsync({
        username,
        email: email || null,
      });
      utils.auth.getProfile.invalidate();
      utils.auth.me.invalidate();
    } catch (error) {
      console.error("Failed to save profile:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const startPlexLinking = async () => {
    setLinkingState({ status: "linking", provider: "plex" });

    try {
      const result = await linkPlexStart.mutateAsync();
      setLinkingState({
        status: "awaiting-plex",
        pinId: result.pinId,
        authUrl: result.authUrl,
      });

      // Open Plex auth in new window
      const authWindow = window.open(result.authUrl, "_blank", "width=800,height=600");

      // Start polling for completion
      pollIntervalRef.current = setInterval(async () => {
        try {
          const callbackResult = await linkPlexComplete.mutateAsync({ pinId: result.pinId });

          if (callbackResult.success) {
            clearInterval(pollIntervalRef.current);
            setLinkingState({ status: "idle" });
            utils.auth.getProfile.invalidate();
            utils.auth.me.invalidate();
            authWindow?.close();
          }
        } catch (error) {
          clearInterval(pollIntervalRef.current);
          setLinkingState({
            status: "error",
            message: error instanceof Error ? error.message : "Failed to link Plex account",
          });
          authWindow?.close();
        }
      }, 2000);
    } catch (error) {
      setLinkingState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to start Plex linking",
      });
    }
  };

  const handleUnlinkPlex = async () => {
    if (!confirm("Are you sure you want to unlink your Plex account?")) {
      return;
    }

    try {
      await unlinkPlex.mutateAsync();
      utils.auth.getProfile.invalidate();
      utils.auth.me.invalidate();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to unlink Plex account");
    }
  };

  const handleLinkEmby = async (e: React.FormEvent) => {
    e.preventDefault();
    setLinkingState({ status: "linking", provider: "emby" });

    try {
      await linkEmby.mutateAsync({
        username: embyUsername,
        password: embyPassword,
      });
      setLinkingState({ status: "idle" });
      setEmbyUsername("");
      setEmbyPassword("");
      utils.auth.getProfile.invalidate();
      utils.auth.me.invalidate();
    } catch (error) {
      setLinkingState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to link Emby account",
      });
    }
  };

  const handleUnlinkEmby = async () => {
    if (!confirm("Are you sure you want to unlink your Emby account?")) {
      return;
    }

    try {
      await unlinkEmby.mutateAsync();
      utils.auth.getProfile.invalidate();
      utils.auth.me.invalidate();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to unlink Emby account");
    }
  };

  const cancelLinking = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    setLinkingState({ status: "idle" });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="text-center py-12 text-white/60">
        Failed to load profile
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Preferences</h1>
        <p className="text-white/60 mt-1">Manage your account settings and linked accounts</p>
      </div>

      {/* Profile Section */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Profile</h2>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="flex items-center gap-4 mb-6">
            {profile.avatar ? (
              <img
                src={profile.avatar}
                alt={profile.username}
                className="w-16 h-16 rounded-full"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-annex-500/20 flex items-center justify-center text-annex-400 text-2xl font-medium">
                {profile.username.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <p className="text-white font-medium">{profile.username}</p>
              <p className="text-white/50 text-sm">
                Member since {new Date(profile.createdAt).toLocaleDateString()}
              </p>
              {profile.isAdmin && (
                <Badge variant="info" className="mt-1">Administrator</Badge>
              )}
            </div>
          </div>

          <div>
            <Label>Username</Label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div>
            <Label hint="Optional - used for notifications">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
          </div>

          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </form>
      </Card>

      {/* Linked Accounts Section */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Linked Accounts</h2>
        <p className="text-white/60 text-sm mb-6">
          Link multiple accounts to sign in with either Plex or Emby
        </p>

        {/* Error display */}
        {linkingState.status === "error" && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
            {linkingState.message}
            <button
              onClick={() => setLinkingState({ status: "idle" })}
              className="ml-2 underline hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="space-y-4">
          {/* Plex Account */}
          <div className="flex items-center justify-between p-4 bg-white/5 rounded border border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#E5A00D]/20 rounded flex items-center justify-center">
                <PlexLogo className="w-5 h-5 text-[#E5A00D]" />
              </div>
              <div>
                <p className="text-white font-medium">Plex</p>
                {profile.plexAccount ? (
                  <p className="text-white/50 text-sm">
                    {profile.plexAccount.plexUsername}
                    {profile.plexAccount.plexEmail && ` (${profile.plexAccount.plexEmail})`}
                  </p>
                ) : (
                  <p className="text-white/40 text-sm">Not linked</p>
                )}
              </div>
            </div>

            {profile.plexAccount ? (
              <Button
                variant="danger"
                size="sm"
                onClick={handleUnlinkPlex}
                disabled={!profile.embyAccount}
              >
                Unlink
              </Button>
            ) : linkingState.status === "awaiting-plex" ? (
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-annex-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-white/60 text-sm">Waiting...</span>
                <Button variant="secondary" size="sm" onClick={cancelLinking}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={startPlexLinking}
                disabled={linkingState.status === "linking"}
              >
                {linkingState.status === "linking" && linkingState.provider === "plex"
                  ? "Linking..."
                  : "Link Plex"}
              </Button>
            )}
          </div>

          {/* Emby Account - only show if Emby is configured */}
          {isEmbyAvailable && (
            <div className="p-4 bg-white/5 rounded border border-white/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-[#52B54B]/20 rounded flex items-center justify-center">
                    <EmbyLogo className="w-5 h-5 text-[#52B54B]" />
                  </div>
                  <div>
                    <p className="text-white font-medium">Emby</p>
                    {profile.embyAccount ? (
                      <p className="text-white/50 text-sm">
                        {profile.embyAccount.embyUsername}
                      </p>
                    ) : (
                      <p className="text-white/40 text-sm">Not linked</p>
                    )}
                  </div>
                </div>

                {profile.embyAccount && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleUnlinkEmby}
                    disabled={!profile.plexAccount}
                  >
                    Unlink
                  </Button>
                )}
              </div>

              {/* Emby linking form */}
              {!profile.embyAccount && (
                <form onSubmit={handleLinkEmby} className="mt-4 pt-4 border-t border-white/10 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
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
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={linkingState.status === "linking" && linkingState.provider === "emby"}
                  >
                    {linkingState.status === "linking" && linkingState.provider === "emby"
                      ? "Linking..."
                      : "Link Emby Account"}
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>

        {/* Help text */}
        <p className="text-white/40 text-xs mt-4">
          You must have at least one linked account to sign in. Unlink is only available when you have multiple accounts linked.
        </p>
      </Card>
    </div>
  );
}
