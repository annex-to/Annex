import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Config } from "./config/index.js";
import type { User, PlexAccount, EmbyAccount } from "@prisma/client";

// Re-export the type with linked accounts from auth service
export type AuthUser = User & {
  plexAccount: PlexAccount | null;
  embyAccount: EmbyAccount | null;
};

export interface Context {
  config: Config;
  // Session token from cookie/header (raw, unhashed)
  sessionToken: string | null;
  // Authenticated user (populated by middleware if session is valid)
  user: AuthUser | null;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

/**
 * Middleware that requires authentication
 * Throws UNAUTHORIZED if no valid session
 */
const isAuthenticated = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user, // Now guaranteed to be non-null
    },
  });
});

/**
 * Middleware that requires admin privileges
 * Throws FORBIDDEN if user is not an admin
 */
const isAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  if (!ctx.user.isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You must be an admin to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * Protected procedure - requires authenticated user
 */
export const protectedProcedure = t.procedure.use(isAuthenticated);

/**
 * Admin procedure - requires authenticated admin user
 */
export const adminProcedure = t.procedure.use(isAdmin);
