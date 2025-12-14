/**
 * Authentication Service
 *
 * Handles:
 * - Plex OAuth PIN-based authentication
 * - Session management (create, verify, delete)
 * - User creation and lookup
 */

import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { prisma } from "../db/client.js";
import { getConfig } from "../config/index.js";
import { getSchedulerService } from "./scheduler.js";
import type { User, PlexAccount, EmbyAccount, Session } from "@prisma/client";

// Plex API endpoints
const PLEX_AUTH_URL = "https://plex.tv/api/v2";
const PLEX_PIN_URL = `${PLEX_AUTH_URL}/pins`;
const PLEX_USER_URL = `${PLEX_AUTH_URL}/user`;

// Types for Plex API responses
interface PlexPin {
  id: number;
  code: string;
  clientIdentifier: string;
  authToken: string | null;
  expiresAt: string;
}

interface PlexUser {
  id: number;
  uuid: string;
  username: string;
  email: string;
  thumb: string;
  authToken: string;
}

// In-memory store for pending Plex auth PINs
// In production, this could be moved to Redis or database for multi-instance support
const pendingPins = new Map<
  string,
  {
    pinId: number;
    code: string;
    clientIdentifier: string;
    expiresAt: Date;
  }
>();

/**
 * Clean up expired PINs from the in-memory store
 */
function cleanupExpiredPins(): void {
  const now = new Date();
  for (const [key, pin] of pendingPins.entries()) {
    if (pin.expiresAt < now) {
      pendingPins.delete(key);
    }
  }
}

/**
 * Register auth cleanup tasks with the scheduler
 * Called once during server startup
 */
export function registerAuthTasks(): void {
  const scheduler = getSchedulerService();
  scheduler.register(
    "auth-pin-cleanup",
    "Auth PIN Cleanup",
    5 * 60 * 1000, // 5 minutes
    async () => {
      cleanupExpiredPins();
    }
  );
}

/**
 * Get Plex request headers with client identifier
 */
function getPlexHeaders(clientIdentifier: string): Record<string, string> {
  const config = getConfig();
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Plex-Client-Identifier": clientIdentifier,
    "X-Plex-Product": config.auth.plexProduct,
    "X-Plex-Device": config.auth.plexDevice,
    "X-Plex-Platform": "Web",
    "X-Plex-Platform-Version": "1.0",
    "X-Plex-Version": "1.0",
  };
}

/**
 * Generate or retrieve a stable client identifier
 * This should be consistent per installation
 */
function getClientIdentifier(): string {
  const config = getConfig();
  if (config.auth.plexClientId) {
    return config.auth.plexClientId;
  }
  // Generate a deterministic ID based on session secret
  return createHash("sha256")
    .update(`annex-${config.auth.sessionSecret}`)
    .digest("hex")
    .substring(0, 32);
}

/**
 * Create a new Plex PIN for OAuth
 * Returns a PIN code and auth URL that the user should visit
 */
export async function createPlexPin(): Promise<{
  pinId: string;
  code: string;
  authUrl: string;
}> {
  const clientIdentifier = getClientIdentifier();

  const response = await fetch(`${PLEX_PIN_URL}?strong=true`, {
    method: "POST",
    headers: getPlexHeaders(clientIdentifier),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Plex PIN: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as PlexPin;

  // Store the PIN for later verification
  const pinKey = randomUUID();
  pendingPins.set(pinKey, {
    pinId: data.id,
    code: data.code,
    clientIdentifier,
    expiresAt: new Date(data.expiresAt),
  });

  // Build the auth URL - user should be redirected here
  const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientIdentifier)}&code=${encodeURIComponent(data.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(getConfig().auth.plexProduct)}`;

  return {
    pinId: pinKey,
    code: data.code,
    authUrl,
  };
}

/**
 * Check if a Plex PIN has been authorized
 * Returns the auth token if successful, null if still pending
 */
export async function checkPlexPin(pinKey: string): Promise<string | null> {
  const pendingPin = pendingPins.get(pinKey);
  if (!pendingPin) {
    throw new Error("PIN not found or expired");
  }

  if (pendingPin.expiresAt < new Date()) {
    pendingPins.delete(pinKey);
    throw new Error("PIN expired");
  }

  const response = await fetch(`${PLEX_PIN_URL}/${pendingPin.pinId}`, {
    method: "GET",
    headers: getPlexHeaders(pendingPin.clientIdentifier),
  });

  if (!response.ok) {
    throw new Error(`Failed to check PIN: ${response.status}`);
  }

  const data = (await response.json()) as PlexPin;

  if (data.authToken) {
    // PIN has been authorized, clean up
    pendingPins.delete(pinKey);
    return data.authToken;
  }

  return null;
}

/**
 * Get Plex user info using an auth token
 */
export async function getPlexUser(authToken: string): Promise<PlexUser> {
  const clientIdentifier = getClientIdentifier();

  const response = await fetch(PLEX_USER_URL, {
    headers: {
      ...getPlexHeaders(clientIdentifier),
      "X-Plex-Token": authToken,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get Plex user: ${response.status}`);
  }

  return (await response.json()) as PlexUser;
}

/**
 * Find or create a user from Plex account info
 */
export async function findOrCreateUserFromPlex(
  plexUser: PlexUser,
  plexToken: string
): Promise<User & { plexAccount: PlexAccount | null }> {
  // First, check if we already have this Plex account linked
  const existingPlexAccount = await prisma.plexAccount.findUnique({
    where: { plexId: plexUser.id.toString() },
    include: { user: true },
  });

  if (existingPlexAccount) {
    // Update the token and user info
    await prisma.plexAccount.update({
      where: { id: existingPlexAccount.id },
      data: {
        plexUsername: plexUser.username,
        plexEmail: plexUser.email,
        plexThumb: plexUser.thumb,
        plexToken: plexToken, // TODO: encrypt this
      },
    });

    return prisma.user.findUniqueOrThrow({
      where: { id: existingPlexAccount.userId },
      include: { plexAccount: true },
    });
  }

  // Check if there are any users - first user becomes admin
  const userCount = await prisma.user.count();
  const isFirstUser = userCount === 0;

  // Create new user with linked Plex account
  const user = await prisma.user.create({
    data: {
      email: plexUser.email,
      username: plexUser.username,
      avatar: plexUser.thumb,
      isAdmin: isFirstUser, // First user is admin
      enabled: true,
      plexAccount: {
        create: {
          plexId: plexUser.id.toString(),
          plexUsername: plexUser.username,
          plexEmail: plexUser.email,
          plexThumb: plexUser.thumb,
          plexToken: plexToken, // TODO: encrypt this
        },
      },
    },
    include: { plexAccount: true },
  });

  return user;
}

// =============================================================================
// Emby Authentication
// =============================================================================

interface EmbyAuthResult {
  AccessToken: string;
  User: {
    Id: string;
    Name: string;
    ServerId: string;
    PrimaryImageTag?: string;
  };
}

interface EmbyUser {
  id: string;
  username: string;
  serverId: string;
  imageTag?: string;
}

/**
 * Get the configured Emby server URL
 * Throws if not configured
 */
export function getEmbyServerUrl(): string {
  const config = getConfig();
  if (!config.emby.serverUrl) {
    throw new Error("Emby server URL is not configured. Set EMBY_SERVER_URL environment variable.");
  }
  return config.emby.serverUrl.replace(/\/$/, "");
}

/**
 * Check if Emby is configured
 */
export function isEmbyConfigured(): boolean {
  const config = getConfig();
  return !!config.emby.serverUrl;
}

/**
 * Authenticate with an Emby server using username/password
 * Uses the configured server URL from environment
 */
export async function authenticateWithEmby(
  username: string,
  password: string
): Promise<{ user: EmbyUser; token: string }> {
  const baseUrl = getEmbyServerUrl();

  // Emby auth headers
  const authHeader = `MediaBrowser Client="Annex", Device="Web Browser", DeviceId="annex-web", Version="1.0"`;

  const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": authHeader,
    },
    body: JSON.stringify({
      Username: username,
      Pw: password,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid username or password");
    }
    throw new Error(`Emby authentication failed: ${response.status}`);
  }

  const data = (await response.json()) as EmbyAuthResult;

  return {
    user: {
      id: data.User.Id,
      username: data.User.Name,
      serverId: data.User.ServerId,
      imageTag: data.User.PrimaryImageTag,
    },
    token: data.AccessToken,
  };
}

/**
 * Get Emby user avatar URL
 */
export function getEmbyAvatarUrl(
  userId: string,
  imageTag?: string
): string | null {
  if (!imageTag) return null;
  const baseUrl = getEmbyServerUrl();
  return `${baseUrl}/Users/${userId}/Images/Primary?tag=${imageTag}`;
}

/**
 * Find or create a user from Emby account info
 */
export async function findOrCreateUserFromEmby(
  embyUser: EmbyUser,
  embyToken: string
): Promise<User & { embyAccount: EmbyAccount | null }> {
  // First, check if we already have this Emby account linked
  const existingEmbyAccount = await prisma.embyAccount.findUnique({
    where: { embyId: embyUser.id },
    include: { user: true },
  });

  const avatarUrl = getEmbyAvatarUrl(embyUser.id, embyUser.imageTag);

  if (existingEmbyAccount) {
    // Update the token and user info
    await prisma.embyAccount.update({
      where: { id: existingEmbyAccount.id },
      data: {
        embyUsername: embyUser.username,
        embyServerId: embyUser.serverId,
        embyToken: embyToken, // TODO: encrypt this
      },
    });

    // Also update user avatar if available
    if (avatarUrl) {
      await prisma.user.update({
        where: { id: existingEmbyAccount.userId },
        data: { avatar: avatarUrl },
      });
    }

    return prisma.user.findUniqueOrThrow({
      where: { id: existingEmbyAccount.userId },
      include: { embyAccount: true },
    });
  }

  // Check if there are any users - first user becomes admin
  const userCount = await prisma.user.count();
  const isFirstUser = userCount === 0;

  // Create new user with linked Emby account
  const user = await prisma.user.create({
    data: {
      username: embyUser.username,
      avatar: avatarUrl,
      isAdmin: isFirstUser, // First user is admin
      enabled: true,
      embyAccount: {
        create: {
          embyId: embyUser.id,
          embyUsername: embyUser.username,
          embyServerId: embyUser.serverId,
          embyToken: embyToken, // TODO: encrypt this
        },
      },
    },
    include: { embyAccount: true },
  });

  return user;
}

/**
 * Hash a session token for storage
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Create a new session for a user
 */
export async function createSession(
  userId: string,
  userAgent?: string,
  ipAddress?: string
): Promise<{ session: Session; token: string }> {
  const config = getConfig();
  const token = randomUUID();
  const hashedToken = hashToken(token);

  const expiresAt = new Date(Date.now() + config.auth.sessionMaxAge * 1000);

  const session = await prisma.session.create({
    data: {
      token: hashedToken,
      userId,
      expiresAt,
      userAgent,
      ipAddress,
    },
  });

  return { session, token };
}

/**
 * Verify a session token and return the associated user
 */
export async function verifySession(
  token: string
): Promise<(User & { plexAccount: PlexAccount | null; embyAccount: EmbyAccount | null }) | null> {
  const hashedToken = hashToken(token);

  const session = await prisma.session.findUnique({
    where: { token: hashedToken },
    include: {
      user: {
        include: {
          plexAccount: true,
          embyAccount: true,
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // Check expiration
  if (session.expiresAt < new Date()) {
    // Clean up expired session
    await prisma.session.delete({ where: { id: session.id } });
    return null;
  }

  // Check if user is still enabled
  if (!session.user.enabled) {
    return null;
  }

  // Update last active time
  await prisma.session.update({
    where: { id: session.id },
    data: { lastActiveAt: new Date() },
  });

  return session.user;
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(token: string): Promise<void> {
  const hashedToken = hashToken(token);

  await prisma.session
    .delete({
      where: { token: hashedToken },
    })
    .catch(() => {
      // Session may already be deleted, ignore
    });
}

/**
 * Delete all sessions for a user
 */
export async function deleteAllUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({
    where: { userId },
  });
}

/**
 * Clean up expired sessions
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}

/**
 * Get all users (admin only)
 */
export async function getAllUsers(): Promise<
  Array<User & { plexAccount: PlexAccount | null }>
> {
  return prisma.user.findMany({
    include: { plexAccount: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Update user admin status
 */
export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data: { isAdmin },
  });
}

/**
 * Enable or disable a user
 */
export async function setUserEnabled(userId: string, enabled: boolean): Promise<User> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { enabled },
  });

  // If disabling, also delete all their sessions
  if (!enabled) {
    await deleteAllUserSessions(userId);
  }

  return user;
}

/**
 * Get user by ID
 */
export async function getUserById(
  userId: string
): Promise<(User & { plexAccount: PlexAccount | null }) | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { plexAccount: true },
  });
}

/**
 * Get user by ID with all linked accounts
 */
export async function getUserWithAccounts(
  userId: string
): Promise<(User & { plexAccount: PlexAccount | null; embyAccount: EmbyAccount | null }) | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    include: { plexAccount: true, embyAccount: true },
  });
}

// =============================================================================
// Account Linking
// =============================================================================

/**
 * Link a Plex account to an existing user
 * Throws if the Plex account is already linked to another user
 */
export async function linkPlexAccount(
  userId: string,
  plexUser: PlexUser,
  plexToken: string
): Promise<PlexAccount> {
  // Check if this Plex account is already linked to another user
  const existingLink = await prisma.plexAccount.findUnique({
    where: { plexId: plexUser.id.toString() },
  });

  if (existingLink && existingLink.userId !== userId) {
    throw new Error("This Plex account is already linked to another user");
  }

  // Check if user already has a Plex account linked
  const userPlexAccount = await prisma.plexAccount.findUnique({
    where: { userId },
  });

  if (userPlexAccount) {
    // Update existing link
    return prisma.plexAccount.update({
      where: { id: userPlexAccount.id },
      data: {
        plexId: plexUser.id.toString(),
        plexUsername: plexUser.username,
        plexEmail: plexUser.email,
        plexThumb: plexUser.thumb,
        plexToken: plexToken,
      },
    });
  }

  // Create new link
  return prisma.plexAccount.create({
    data: {
      userId,
      plexId: plexUser.id.toString(),
      plexUsername: plexUser.username,
      plexEmail: plexUser.email,
      plexThumb: plexUser.thumb,
      plexToken: plexToken,
    },
  });
}

/**
 * Unlink a Plex account from a user
 */
export async function unlinkPlexAccount(userId: string): Promise<void> {
  await prisma.plexAccount.deleteMany({
    where: { userId },
  });
}

/**
 * Link an Emby account to an existing user
 * Throws if the Emby account is already linked to another user
 */
export async function linkEmbyAccount(
  userId: string,
  embyUser: { id: string; username: string; serverId: string; imageTag?: string },
  embyToken: string
): Promise<EmbyAccount> {
  // Check if this Emby account is already linked to another user
  const existingLink = await prisma.embyAccount.findUnique({
    where: { embyId: embyUser.id },
  });

  if (existingLink && existingLink.userId !== userId) {
    throw new Error("This Emby account is already linked to another user");
  }

  // Check if user already has an Emby account linked
  const userEmbyAccount = await prisma.embyAccount.findUnique({
    where: { userId },
  });

  if (userEmbyAccount) {
    // Update existing link
    return prisma.embyAccount.update({
      where: { id: userEmbyAccount.id },
      data: {
        embyId: embyUser.id,
        embyUsername: embyUser.username,
        embyServerId: embyUser.serverId,
        embyToken: embyToken,
      },
    });
  }

  // Create new link
  return prisma.embyAccount.create({
    data: {
      userId,
      embyId: embyUser.id,
      embyUsername: embyUser.username,
      embyServerId: embyUser.serverId,
      embyToken: embyToken,
    },
  });
}

/**
 * Unlink an Emby account from a user
 */
export async function unlinkEmbyAccount(userId: string): Promise<void> {
  await prisma.embyAccount.deleteMany({
    where: { userId },
  });
}

/**
 * Update user profile
 */
export async function updateUserProfile(
  userId: string,
  data: { username?: string; email?: string; avatar?: string }
): Promise<User> {
  return prisma.user.update({
    where: { id: userId },
    data,
  });
}
