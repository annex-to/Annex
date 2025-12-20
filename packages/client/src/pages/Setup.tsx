/**
 * Setup Wizard Page
 *
 * First-run configuration wizard for new installations.
 * Guides users through setting up required API keys and services.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Input, Label } from "../components/ui";
import { trpc } from "../trpc";

type SetupStep = "welcome" | "trakt" | "downloads" | "complete";

export default function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<SetupStep>("welcome");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message?: string }>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const completeSetupMutation = trpc.secrets.completeSetup.useMutation();
  const testConnectionMutation = trpc.secrets.testConnection.useMutation();

  const updateSecret = (key: string, value: string) => {
    setSecrets((prev) => ({ ...prev, [key]: value }));
  };

  const testConnection = async (service: "qbittorrent" | "mdblist" | "trakt") => {
    try {
      const result = await testConnectionMutation.mutateAsync({ service });
      setTestResults((prev) => ({
        ...prev,
        [service]: { success: result.success, message: result.message || result.error },
      }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [service]: {
          success: false,
          message: error instanceof Error ? error.message : "Connection failed",
        },
      }));
    }
  };

  const handleComplete = async () => {
    setIsSubmitting(true);
    try {
      // Filter out empty values
      const filteredSecrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets)) {
        if (value.trim()) {
          filteredSecrets[key] = value.trim();
        }
      }

      const result = await completeSetupMutation.mutateAsync({ secrets: filteredSecrets });
      if (result.success) {
        setStep("complete");
      } else {
        alert(result.error || "Setup failed");
      }
    } catch (error) {
      alert(`Setup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const goToApp = () => {
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold flex items-center justify-center gap-3 mb-2">
            <span>🍿</span>
            <span className="bg-gradient-to-r from-annex-500 to-gold-500 bg-clip-text text-transparent">
              Annex
            </span>
          </h1>
          <p className="text-surface-400">Media Acquisition & Delivery Platform</p>
        </div>

        {/* Step indicator */}
        {step !== "welcome" && step !== "complete" && (
          <div className="flex justify-center gap-2 mb-8">
            {["trakt", "downloads"].map((s) => (
              <div
                key={s}
                className={`w-3 h-3 rounded-full transition-colors ${
                  s === step ? "bg-annex-500" : "bg-surface-700"
                }`}
              />
            ))}
          </div>
        )}

        {/* Steps */}
        {step === "welcome" && (
          <Card className="p-8 text-center space-y-6">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold">Welcome to Annex</h2>
              <p className="text-surface-400">
                Let's get your media server set up. This wizard will help you configure the
                essential services needed to discover, acquire, and deliver media.
              </p>
            </div>

            <div className="text-left bg-surface-900/50 rounded p-4 space-y-2">
              <p className="text-sm text-surface-300">You'll need:</p>
              <ul className="text-sm text-surface-400 space-y-1 list-disc list-inside">
                <li>A Trakt Client ID (free) for all metadata and discovery</li>
                <li>qBittorrent for downloading (optional now, required later)</li>
                <li>Indexer access for searching releases (configured in Settings)</li>
              </ul>
            </div>

            <Button onClick={() => setStep("trakt")} className="w-full">
              Get Started
            </Button>
          </Card>
        )}

        {step === "trakt" && (
          <Card className="p-8 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Trakt Client ID</h2>
              <p className="text-surface-400 text-sm">
                Trakt provides all movie and TV show metadata, images, discovery lists, and
                trailers. This is required for Annex to work.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <Label>Client ID</Label>
                <Input
                  type="password"
                  value={secrets["trakt.clientId"] || ""}
                  onChange={(e) => updateSecret("trakt.clientId", e.target.value)}
                  placeholder="Enter your Trakt client ID"
                />
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => testConnection("trakt")}
                  disabled={!secrets["trakt.clientId"] || testConnectionMutation.isLoading}
                >
                  {testConnectionMutation.isLoading ? "Testing..." : "Test Connection"}
                </Button>
                {testResults.trakt && (
                  <span
                    className={
                      testResults.trakt.success ? "text-green-400 text-sm" : "text-red-400 text-sm"
                    }
                  >
                    {testResults.trakt.message}
                  </span>
                )}
              </div>

              <p className="text-xs text-surface-500">
                Don't have a client ID?{" "}
                <a
                  href="https://trakt.tv/oauth/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-annex-400 hover:text-annex-300"
                >
                  Create a Trakt application (free)
                </a>
              </p>
            </div>

            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setStep("welcome")}>
                Back
              </Button>
              <Button
                onClick={() => setStep("downloads")}
                className="flex-1"
                disabled={!secrets["trakt.clientId"]}
              >
                Continue
              </Button>
            </div>
          </Card>
        )}

        {step === "downloads" && (
          <Card className="p-8 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Download Client</h2>
              <p className="text-surface-400 text-sm">
                Configure qBittorrent for downloading. You can skip this and configure it later.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <Label>qBittorrent URL</Label>
                <Input
                  type="text"
                  value={secrets["qbittorrent.url"] || ""}
                  onChange={(e) => updateSecret("qbittorrent.url", e.target.value)}
                  placeholder="http://localhost:8080"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Username (optional)</Label>
                  <Input
                    type="text"
                    value={secrets["qbittorrent.username"] || ""}
                    onChange={(e) => updateSecret("qbittorrent.username", e.target.value)}
                    placeholder="admin"
                  />
                </div>
                <div>
                  <Label>Password (optional)</Label>
                  <Input
                    type="password"
                    value={secrets["qbittorrent.password"] || ""}
                    onChange={(e) => updateSecret("qbittorrent.password", e.target.value)}
                    placeholder="password"
                  />
                </div>
              </div>

              {secrets["qbittorrent.url"] && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testConnection("qbittorrent")}
                    disabled={testConnectionMutation.isLoading}
                  >
                    {testConnectionMutation.isLoading ? "Testing..." : "Test Connection"}
                  </Button>
                  {testResults.qbittorrent && (
                    <span
                      className={
                        testResults.qbittorrent.success
                          ? "text-green-400 text-sm"
                          : "text-red-400 text-sm"
                      }
                    >
                      {testResults.qbittorrent.message}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setStep("trakt")}>
                Back
              </Button>
              <Button
                variant="secondary"
                onClick={handleComplete}
                className="flex-1"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Setting up..." : "Skip"}
              </Button>
              <Button onClick={handleComplete} className="flex-1" disabled={isSubmitting}>
                {isSubmitting ? "Setting up..." : "Complete Setup"}
              </Button>
            </div>
          </Card>
        )}

        {step === "complete" && (
          <Card className="p-8 text-center space-y-6">
            <div className="text-green-400 text-6xl">✓</div>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold">Setup Complete!</h2>
              <p className="text-surface-400">
                Annex is now configured and ready to use. You can modify these settings anytime from
                the Settings page.
              </p>
            </div>

            <div className="text-left bg-surface-900/50 rounded p-4 space-y-2">
              <p className="text-sm text-surface-300">Next steps:</p>
              <ul className="text-sm text-surface-400 space-y-1 list-disc list-inside">
                <li>Sign in with Plex or Emby to access Annex</li>
                <li>Add indexers in Settings to search for releases</li>
                <li>Configure storage servers for media delivery</li>
                <li>Set up encoding profiles for transcoding</li>
              </ul>
            </div>

            <Button onClick={goToApp} className="w-full">
              Go to Login
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
