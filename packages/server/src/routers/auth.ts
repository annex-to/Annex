/**
 * Authentication Router
 *
 * Handles Plex OAuth flow, Emby auth, and session management
 */

import { z } from "zod";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "../trpc.js";
import {
  createPlexPin,
  checkPlexPin,
  getPlexUser,
  findOrCreateUserFromPlex,
  authenticateWithEmby,
  findOrCreateUserFromEmby,
  isEmbyConfigured,
  createSession,
  deleteSession,
  getAllUsers,
  setUserAdmin,
  setUserEnabled,
  getUserById,
  getUserWithAccounts,
  linkPlexAccount,
  unlinkPlexAccount,
  linkEmbyAccount,
  unlinkEmbyAccount,
  updateUserProfile,
} from "../services/auth.js";
import { TRPCError } from "@trpc/server";

export const authRouter = router({
  /**
   * Get current authenticated user
   */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      return null;
    }

    return {
      id: ctx.user.id,
      email: ctx.user.email,
      username: ctx.user.username,
      avatar: ctx.user.avatar,
      isAdmin: ctx.user.isAdmin,
      plexAccount: ctx.user.plexAccount
        ? {
            plexId: ctx.user.plexAccount.plexId,
            plexUsername: ctx.user.plexAccount.plexUsername,
          }
        : null,
      embyAccount: ctx.user.embyAccount
        ? {
            embyId: ctx.user.embyAccount.embyId,
            embyUsername: ctx.user.embyAccount.embyUsername,
          }
        : null,
    };
  }),

  /**
   * Start Plex OAuth flow
   * Returns a PIN ID and auth URL that the frontend should redirect to
   */
  plexLogin: publicProcedure.mutation(async () => {
    const { pinId, code, authUrl } = await createPlexPin();

    return {
      pinId,
      code,
      authUrl,
    };
  }),

  /**
   * Check if Plex PIN has been authorized and complete login
   * This should be polled by the frontend after redirecting back from Plex
   */
  plexCallback: publicProcedure
    .input(
      z.object({
        pinId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check if PIN has been authorized
      const authToken = await checkPlexPin(input.pinId);

      if (!authToken) {
        // Still waiting for user to authorize
        return { success: false, pending: true };
      }

      // Get Plex user info
      const plexUser = await getPlexUser(authToken);

      // Find or create our user
      const user = await findOrCreateUserFromPlex(plexUser, authToken);

      // Check if user is enabled
      if (!user.enabled) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Your account has been disabled",
        });
      }

      // Create session
      // Note: userAgent and ipAddress would need to be passed from the HTTP layer
      const { token } = await createSession(user.id);

      return {
        success: true,
        pending: false,
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          avatar: user.avatar,
          isAdmin: user.isAdmin,
        },
      };
    }),

  /**
   * Check if Emby authentication is available (server configured)
   */
  embyConfigured: publicProcedure.query(() => {
    return { configured: isEmbyConfigured() };
  }),

  /**
   * Login with Emby credentials
   * Uses the server-configured Emby URL
   */
  embyLogin: publicProcedure
    .input(
      z.object({
        username: z.string().min(1),
        password: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      if (!isEmbyConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Emby authentication is not configured. Contact your administrator.",
        });
      }

      try {
        // Authenticate with Emby server
        const { user: embyUser, token: embyToken } = await authenticateWithEmby(
          input.username,
          input.password
        );

        // Find or create our user
        const user = await findOrCreateUserFromEmby(embyUser, embyToken);

        // Check if user is enabled
        if (!user.enabled) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your account has been disabled",
          });
        }

        // Create session
        const { token } = await createSession(user.id);

        return {
          success: true,
          token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            avatar: user.avatar,
            isAdmin: user.isAdmin,
          },
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: error instanceof Error ? error.message : "Emby authentication failed",
        });
      }
    }),

  /**
   * Logout - destroy current session
   */
  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      await deleteSession(ctx.sessionToken);
    }
    return { success: true };
  }),

  // ============================================
  // User preferences & account linking
  // ============================================

  /**
   * Get current user's full profile with linked accounts
   */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await getUserWithAccounts(ctx.user.id);

    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
      plexAccount: user.plexAccount
        ? {
            plexId: user.plexAccount.plexId,
            plexUsername: user.plexAccount.plexUsername,
            plexEmail: user.plexAccount.plexEmail,
          }
        : null,
      embyAccount: user.embyAccount
        ? {
            embyId: user.embyAccount.embyId,
            embyUsername: user.embyAccount.embyUsername,
            embyServerId: user.embyAccount.embyServerId,
          }
        : null,
    };
  }),

  /**
   * Update user profile
   */
  updateProfile: protectedProcedure
    .input(
      z.object({
        username: z.string().min(1).max(100).optional(),
        email: z.string().email().optional().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const user = await updateUserProfile(ctx.user.id, {
        username: input.username,
        email: input.email ?? undefined,
      });

      return {
        id: user.id,
        username: user.username,
        email: user.email,
      };
    }),

  /**
   * Start linking a Plex account (returns PIN for OAuth flow)
   */
  linkPlexStart: protectedProcedure.mutation(async ({ ctx }) => {
    // Check if user already has Plex linked
    const user = await getUserWithAccounts(ctx.user.id);
    if (user?.plexAccount) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You already have a Plex account linked. Unlink it first to link a different account.",
      });
    }

    const { pinId, code, authUrl } = await createPlexPin();

    return {
      pinId,
      code,
      authUrl,
    };
  }),

  /**
   * Complete Plex account linking
   */
  linkPlexComplete: protectedProcedure
    .input(
      z.object({
        pinId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check if PIN has been authorized
      const authToken = await checkPlexPin(input.pinId);

      if (!authToken) {
        return { success: false, pending: true };
      }

      // Get Plex user info
      const plexUser = await getPlexUser(authToken);

      // Link the account
      try {
        const plexAccount = await linkPlexAccount(ctx.user.id, plexUser, authToken);

        return {
          success: true,
          pending: false,
          plexAccount: {
            plexId: plexAccount.plexId,
            plexUsername: plexAccount.plexUsername,
          },
        };
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Failed to link Plex account",
        });
      }
    }),

  /**
   * Unlink Plex account
   */
  unlinkPlex: protectedProcedure.mutation(async ({ ctx }) => {
    // Check if user has other login methods
    const user = await getUserWithAccounts(ctx.user.id);
    if (!user?.embyAccount) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot unlink Plex account - you need at least one login method",
      });
    }

    await unlinkPlexAccount(ctx.user.id);
    return { success: true };
  }),

  /**
   * Link an Emby account
   */
  linkEmby: protectedProcedure
    .input(
      z.object({
        username: z.string().min(1),
        password: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isEmbyConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Emby is not configured. Contact your administrator.",
        });
      }

      // Check if user already has Emby linked
      const user = await getUserWithAccounts(ctx.user.id);
      if (user?.embyAccount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You already have an Emby account linked. Unlink it first to link a different account.",
        });
      }

      try {
        // Authenticate with Emby
        const { user: embyUser, token: embyToken } = await authenticateWithEmby(
          input.username,
          input.password
        );

        // Link the account
        const embyAccount = await linkEmbyAccount(
          ctx.user.id,
          embyUser,
          embyToken
        );

        return {
          success: true,
          embyAccount: {
            embyId: embyAccount.embyId,
            embyUsername: embyAccount.embyUsername,
          },
        };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Failed to link Emby account",
        });
      }
    }),

  /**
   * Unlink Emby account
   */
  unlinkEmby: protectedProcedure.mutation(async ({ ctx }) => {
    // Check if user has other login methods
    const user = await getUserWithAccounts(ctx.user.id);
    if (!user?.plexAccount) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot unlink Emby account - you need at least one login method",
      });
    }

    await unlinkEmbyAccount(ctx.user.id);
    return { success: true };
  }),

  // ============================================
  // Admin endpoints
  // ============================================

  /**
   * List all users (admin only)
   */
  listUsers: adminProcedure.query(async () => {
    const users = await getAllUsers();

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar,
      isAdmin: user.isAdmin,
      enabled: user.enabled,
      createdAt: user.createdAt,
      plexAccount: user.plexAccount
        ? {
            plexId: user.plexAccount.plexId,
            plexUsername: user.plexAccount.plexUsername,
          }
        : null,
    }));
  }),

  /**
   * Set user admin status (admin only)
   */
  setAdmin: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        isAdmin: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Prevent self-demotion
      if (input.userId === ctx.user.id && !input.isAdmin) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot remove your own admin status",
        });
      }

      const user = await setUserAdmin(input.userId, input.isAdmin);

      return {
        id: user.id,
        isAdmin: user.isAdmin,
      };
    }),

  /**
   * Enable or disable a user (admin only)
   */
  setEnabled: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Prevent self-disable
      if (input.userId === ctx.user.id && !input.enabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot disable your own account",
        });
      }

      const user = await setUserEnabled(input.userId, input.enabled);

      return {
        id: user.id,
        enabled: user.enabled,
      };
    }),

  /**
   * Get a specific user by ID (admin only)
   */
  getUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const user = await getUserById(input.userId);

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      return {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        isAdmin: user.isAdmin,
        enabled: user.enabled,
        createdAt: user.createdAt,
        plexAccount: user.plexAccount
          ? {
              plexId: user.plexAccount.plexId,
              plexUsername: user.plexAccount.plexUsername,
            }
          : null,
      };
    }),
});
