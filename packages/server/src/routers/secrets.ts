/**
 * Secrets Router
 *
 * tRPC endpoints for managing encrypted secrets.
 *
 * Public endpoints:
 * - setupStatus: Check if app is configured
 * - completeSetup: Initial setup (only works if not configured)
 *
 * Admin endpoints:
 * - list: List all secrets with status
 * - get: Get a secret value
 * - set: Set a secret value
 * - delete: Delete a secret
 */

import { z } from "zod";
import { randomBytes } from "crypto";
import { router, publicProcedure, adminProcedure } from "../trpc.js";
import { getSecretsService } from "../services/secrets.js";
import {
  SECRET_DEFINITIONS,
  getSecretDefinition,
  validateSecret,
  maskSecret,
} from "../config/secrets-schema.js";

export const secretsRouter = router({
  /**
   * Check if the app is configured (has required secrets)
   * Public endpoint - used by setup wizard guard
   */
  setupStatus: publicProcedure.query(async () => {
    const secrets = getSecretsService();

    // Check if session secret exists (indicates setup is complete)
    const hasSessionSecret = await secrets.hasSecret("auth.sessionSecret");

    // Check each service's secrets
    const services: Record<string, boolean> = {};
    const serviceSecrets = ["tmdb.apiKey", "mdblist.apiKey", "qbittorrent.url", "plex.serverUrl", "emby.serverUrl"];

    for (const key of serviceSecrets) {
      const serviceName = key.split(".")[0];
      services[serviceName] = await secrets.hasSecret(key);
    }

    return {
      isConfigured: hasSessionSecret,
      services,
    };
  }),

  /**
   * Complete initial setup
   * Public endpoint - only works if app is not yet configured
   */
  completeSetup: publicProcedure
    .input(
      z.object({
        secrets: z.record(z.string()),
      })
    )
    .mutation(async ({ input }) => {
      const secretsService = getSecretsService();

      // Check if already configured
      const isConfigured = await secretsService.hasSecret("auth.sessionSecret");
      if (isConfigured) {
        return {
          success: false,
          error: "System is already configured",
        };
      }

      // Generate session secret if not provided
      if (!input.secrets["auth.sessionSecret"]) {
        input.secrets["auth.sessionSecret"] = randomBytes(32).toString("hex");
      }

      // Validate all secrets
      const errors: string[] = [];
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value && !validateSecret(key, value)) {
          const def = getSecretDefinition(key);
          errors.push(`Invalid value for ${def?.label || key}`);
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          error: errors.join(", "),
        };
      }

      // Save all provided secrets
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value) {
          await secretsService.setSecret(key, value);
        }
      }

      console.log("[Secrets] Initial setup completed");

      return {
        success: true,
      };
    }),

  /**
   * List all secret definitions with their status
   * Admin only
   */
  list: adminProcedure.query(async () => {
    const secrets = getSecretsService();

    const results = await Promise.all(
      SECRET_DEFINITIONS.map(async (def) => ({
        key: def.key,
        label: def.label,
        description: def.description,
        group: def.group,
        required: def.required,
        sensitive: def.sensitive,
        placeholder: def.placeholder,
        helpUrl: def.helpUrl,
        hasValue: await secrets.hasSecret(def.key),
      }))
    );

    return results;
  }),

  /**
   * Get a secret value
   * Admin only
   * Returns masked value by default
   */
  get: adminProcedure
    .input(
      z.object({
        key: z.string(),
        masked: z.boolean().default(true),
      })
    )
    .query(async ({ input }) => {
      const secrets = getSecretsService();
      const value = await secrets.getSecret(input.key);

      if (!value) {
        return null;
      }

      const def = getSecretDefinition(input.key);

      return {
        key: input.key,
        value: input.masked && def?.sensitive ? maskSecret(value) : value,
        hasValue: true,
        label: def?.label,
      };
    }),

  /**
   * Set a secret value
   * Admin only
   */
  set: adminProcedure
    .input(
      z.object({
        key: z.string(),
        value: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // Validate the secret
      if (!validateSecret(input.key, input.value)) {
        const def = getSecretDefinition(input.key);
        return {
          success: false,
          error: `Invalid value for ${def?.label || input.key}`,
        };
      }

      const secrets = getSecretsService();
      await secrets.setSecret(input.key, input.value);

      console.log(`[Secrets] Updated secret: ${input.key}`);

      return {
        success: true,
      };
    }),

  /**
   * Delete a secret
   * Admin only
   */
  delete: adminProcedure
    .input(
      z.object({
        key: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // Prevent deleting session secret
      if (input.key === "auth.sessionSecret") {
        return {
          success: false,
          error: "Cannot delete session secret",
        };
      }

      const secrets = getSecretsService();
      await secrets.deleteSecret(input.key);

      console.log(`[Secrets] Deleted secret: ${input.key}`);

      return {
        success: true,
      };
    }),

  /**
   * Test a service connection using its secrets
   * Admin only
   */
  testConnection: adminProcedure
    .input(
      z.object({
        service: z.enum(["qbittorrent", "plex", "emby", "tmdb", "mdblist"]),
      })
    )
    .mutation(async ({ input }) => {
      const secrets = getSecretsService();

      switch (input.service) {
        case "qbittorrent": {
          const url = await secrets.getSecret("qbittorrent.url");
          const username = await secrets.getSecret("qbittorrent.username");
          const password = await secrets.getSecret("qbittorrent.password");

          if (!url) {
            return { success: false, error: "qBittorrent URL not configured" };
          }

          try {
            const response = await fetch(`${url}/api/v2/app/version`, {
              headers: username && password
                ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
                : undefined,
            });

            if (response.ok) {
              const version = await response.text();
              return { success: true, message: `Connected! Version: ${version}` };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        case "tmdb": {
          const apiKey = await secrets.getSecret("tmdb.apiKey");
          if (!apiKey) {
            return { success: false, error: "TMDB API key not configured" };
          }

          try {
            const response = await fetch(
              `https://api.themoviedb.org/3/configuration?api_key=${apiKey}`
            );

            if (response.ok) {
              return { success: true, message: "Connected to TMDB!" };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        case "mdblist": {
          const apiKey = await secrets.getSecret("mdblist.apiKey");
          if (!apiKey) {
            return { success: false, error: "MDBList API key not configured" };
          }

          try {
            const response = await fetch(
              `https://mdblist.com/api/?apikey=${apiKey}&i=tt0111161`
            );

            if (response.ok) {
              return { success: true, message: "Connected to MDBList!" };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        case "plex": {
          const serverUrl = await secrets.getSecret("plex.serverUrl");
          const token = await secrets.getSecret("plex.serverToken");

          if (!serverUrl) {
            return { success: false, error: "Plex server URL not configured" };
          }
          if (!token) {
            return { success: false, error: "Plex server token not configured" };
          }

          try {
            const response = await fetch(`${serverUrl}/identity`, {
              headers: { "X-Plex-Token": token },
            });

            if (response.ok) {
              return { success: true, message: "Connected to Plex!" };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        case "emby": {
          const serverUrl = await secrets.getSecret("emby.serverUrl");
          const apiKey = await secrets.getSecret("emby.apiKey");

          if (!serverUrl) {
            return { success: false, error: "Emby server URL not configured" };
          }
          if (!apiKey) {
            return { success: false, error: "Emby API key not configured" };
          }

          try {
            const response = await fetch(
              `${serverUrl}/System/Info?api_key=${apiKey}`
            );

            if (response.ok) {
              return { success: true, message: "Connected to Emby!" };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        default:
          return { success: false, error: "Unknown service" };
      }
    }),
});
