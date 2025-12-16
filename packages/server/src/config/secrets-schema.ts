/**
 * Secrets Schema Definitions
 *
 * Defines all manageable secrets with metadata for validation and UI display.
 */

export interface SecretDefinition {
  key: string;
  label: string;
  description: string;
  group: "metadata" | "downloads" | "media-servers" | "system";
  required: boolean;
  sensitive: boolean;
  validate?: (value: string) => boolean;
  placeholder?: string;
  helpUrl?: string;
}

/**
 * All secret definitions
 */
export const SECRET_DEFINITIONS: SecretDefinition[] = [
  // Metadata APIs
  {
    key: "tmdb.apiKey",
    label: "TMDB API Key",
    description: "Required for movie and TV metadata",
    group: "metadata",
    required: false,
    sensitive: true,
    placeholder: "Enter your TMDB API key",
    helpUrl: "https://www.themoviedb.org/settings/api",
    validate: (v) => v.length >= 20,
  },
  {
    key: "mdblist.apiKey",
    label: "MDBList API Key",
    description: "Required for aggregated ratings (IMDb, Rotten Tomatoes, etc.)",
    group: "metadata",
    required: false,
    sensitive: true,
    placeholder: "Enter your MDBList API key",
    helpUrl: "https://mdblist.com/preferences/",
    validate: (v) => v.length >= 10,
  },
  {
    key: "trakt.clientId",
    label: "Trakt Client ID",
    description: "For Trakt integration (discovery lists)",
    group: "metadata",
    required: false,
    sensitive: true,
    placeholder: "Enter your Trakt client ID",
    helpUrl: "https://trakt.tv/oauth/applications",
  },
  {
    key: "trakt.clientSecret",
    label: "Trakt Client Secret",
    description: "For Trakt integration",
    group: "metadata",
    required: false,
    sensitive: true,
    placeholder: "Enter your Trakt client secret",
  },

  // Download client
  {
    key: "qbittorrent.url",
    label: "qBittorrent URL",
    description: "URL for qBittorrent WebUI",
    group: "downloads",
    required: false,
    sensitive: false,
    placeholder: "http://localhost:8080",
    validate: (v) => v.startsWith("http://") || v.startsWith("https://"),
  },
  {
    key: "qbittorrent.username",
    label: "qBittorrent Username",
    description: "Username for qBittorrent WebUI",
    group: "downloads",
    required: false,
    sensitive: false,
    placeholder: "admin",
  },
  {
    key: "qbittorrent.password",
    label: "qBittorrent Password",
    description: "Password for qBittorrent WebUI",
    group: "downloads",
    required: false,
    sensitive: true,
    placeholder: "Enter qBittorrent password",
  },

  // Media servers
  {
    key: "plex.serverUrl",
    label: "Plex Server URL",
    description: "URL for Plex server (for library sync)",
    group: "media-servers",
    required: false,
    sensitive: false,
    placeholder: "http://localhost:32400",
    validate: (v) => v.startsWith("http://") || v.startsWith("https://"),
  },
  {
    key: "plex.serverToken",
    label: "Plex Server Token",
    description: "Admin token for Plex server",
    group: "media-servers",
    required: false,
    sensitive: true,
    placeholder: "Enter Plex server token",
  },
  {
    key: "emby.serverUrl",
    label: "Emby Server URL",
    description: "URL for Emby server (for library sync)",
    group: "media-servers",
    required: false,
    sensitive: false,
    placeholder: "http://localhost:8096",
    validate: (v) => v.startsWith("http://") || v.startsWith("https://"),
  },
  {
    key: "emby.apiKey",
    label: "Emby API Key",
    description: "API key for Emby server",
    group: "media-servers",
    required: false,
    sensitive: true,
    placeholder: "Enter Emby API key",
  },

  // System
  {
    key: "auth.sessionSecret",
    label: "Session Secret",
    description: "Secret key for signing session tokens (auto-generated)",
    group: "system",
    required: true,
    sensitive: true,
    placeholder: "Auto-generated if not provided",
    validate: (v) => v.length >= 32,
  },
];

/**
 * Get secret definition by key
 */
export function getSecretDefinition(key: string): SecretDefinition | undefined {
  return SECRET_DEFINITIONS.find((d) => d.key === key);
}

/**
 * Get all secrets in a group
 */
export function getSecretsByGroup(group: SecretDefinition["group"]): SecretDefinition[] {
  return SECRET_DEFINITIONS.filter((d) => d.group === group);
}

/**
 * Validate a secret value
 */
export function validateSecret(key: string, value: string): boolean {
  const definition = getSecretDefinition(key);
  if (!definition) return true; // Unknown secrets are allowed

  if (definition.validate) {
    return definition.validate(value);
  }

  return true;
}

/**
 * Mask a secret value for display
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}
