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

import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  getSecretDefinition,
  maskSecret,
  SECRET_DEFINITIONS,
  validateSecret,
} from "../config/secrets-schema.js";
import { getSecretsService } from "../services/secrets.js";
import { adminProcedure, publicProcedure, router, setupProcedure } from "../trpc.js";

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
    const serviceSecrets = [
      "mdblist.apiKey",
      "plex.serverUrl",
      "emby.serverUrl",
    ];

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
   * Get a secret's status
   * Admin only
   * Never returns the actual secret value - only masked version for sensitive secrets
   */
  get: adminProcedure
    .input(
      z.object({
        key: z.string(),
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
        // Always mask sensitive secrets - never expose plain text
        value: def?.sensitive ? maskSecret(value) : value,
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
   * Accessible during setup or requires admin after setup
   * During setup, accepts secret values directly; otherwise reads from secrets service
   */
  testConnection: setupProcedure
    .input(
      z.object({
        service: z.enum(["mdblist", "trakt"]),
        // Optional: provide secrets directly (used during setup before saving)
        secrets: z.record(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const secretsService = getSecretsService();

      // Helper to get secret value (from input or service)
      const getSecretValue = async (key: string): Promise<string | null> => {
        if (input.secrets?.[key]) {
          return input.secrets[key];
        }
        return await secretsService.getSecret(key);
      };

      switch (input.service) {
        case "mdblist": {
          const apiKey = await getSecretValue("mdblist.apiKey");
          if (!apiKey) {
            return { success: false, error: "MDBList API key not configured" };
          }

          try {
            const response = await fetch(`https://mdblist.com/api/?apikey=${apiKey}&i=tt0111161`);

            if (response.ok) {
              return { success: true, message: "Connected to MDBList!" };
            } else {
              return { success: false, error: `HTTP ${response.status}` };
            }
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }

        case "trakt": {
          const clientId = await getSecretValue("trakt.clientId");
          if (!clientId) {
            return { success: false, error: "Trakt Client ID not configured" };
          }

          try {
            const response = await fetch("https://api.trakt.tv/movies/trending?limit=1", {
              headers: {
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": clientId,
                "User-Agent": "Annex/1.0",
              },
            });

            if (response.ok) {
              return { success: true, message: "Connected to Trakt!" };
            } else if (response.status === 403) {
              return {
                success: false,
                error: "Invalid Client ID. Create an application at trakt.tv/oauth/applications",
              };
            } else {
              // Get error details from response
              let errorMsg = `HTTP ${response.status}`;
              try {
                const errorBody = await response.text();
                if (errorBody) {
                  errorMsg += `: ${errorBody}`;
                }
              } catch (_e) {
                // Ignore errors reading response body
              }
              return { success: false, error: errorMsg };
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
