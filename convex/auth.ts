import { v } from "convex/values";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

type UserDoc = Doc<"users">;

const AVLEC_DOMAIN = "avlec.co";

export const ensureCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    return await ensureUser(ctx);
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }

    const user = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
    if (user === null) {
      return {
        user: null,
        identity: {
          email: identity.email ?? null,
          name: identity.name ?? null,
          tokenIdentifier: identity.tokenIdentifier,
        },
        addresses: [],
        isAdmin: false,
      };
    }

    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);

    return {
      user,
      identity: {
        email: identity.email ?? null,
        name: identity.name ?? null,
        tokenIdentifier: identity.tokenIdentifier,
      },
      addresses,
      isAdmin: user.admin,
    };
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").take(200);
    const rows = [];

    for (const user of users) {
      const addresses = await ctx.db
        .query("userEmailAddresses")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .take(100);
      rows.push({ user, addresses });
    }

    return rows.sort((left, right) =>
      displayUser(left.user).localeCompare(displayUser(right.user)),
    );
  },
});

export const assignAddress = mutation({
  args: {
    userId: v.id("users"),
    address: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get("users", args.userId);
    if (user === null) {
      throw new Error("User not found");
    }

    const address = normalizeAvlecAddress(args.address);
    const existing = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_address", (q) => q.eq("address", address))
      .unique();

    if (existing !== null) {
      if (existing.userId === args.userId) {
        return existing._id;
      }
      throw new Error("That inbound address is already assigned");
    }

    return await ctx.db.insert("userEmailAddresses", {
      userId: args.userId,
      address,
      createdAt: Date.now(),
    });
  },
});

export const removeAddress = mutation({
  args: { addressId: v.id("userEmailAddresses") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete("userEmailAddresses", args.addressId);
    return null;
  },
});

export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Not authenticated");
  }

  const user = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
  if (user === null) {
    throw new Error("User not registered");
  }

  return { identity, user };
}

async function ensureUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Not authenticated");
  }

  const existing = await getUserByTokenIdentifier(ctx, identity.tokenIdentifier);
  if (existing !== null) {
    const normalizedEmail = tryNormalizeEmail(identity.email);
    await ctx.db.patch("users", existing._id, {
      ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
      ...(identity.name !== undefined ? { name: identity.name } : {}),
      lastSeenAt: Date.now(),
    });
    await assignSignupEmailIfAvailable(ctx, existing._id, identity.email);
    return await ctx.db.get("users", existing._id);
  }

  const normalizedEmail = tryNormalizeEmail(identity.email);
  if (
    normalizedEmail !== undefined &&
    isEmailSafeForAccountLinking(identity)
  ) {
    let sameEmail = await getUsersByNormalizedEmail(ctx, normalizedEmail);
    if (sameEmail.length > 1)
      await mergeDuplicateUsersInGroup(ctx, sameEmail);

    sameEmail = await getUsersByNormalizedEmail(ctx, normalizedEmail);
    if (sameEmail.length === 1) {
      const userRow = sameEmail[0];
      await ctx.db.patch("users", userRow._id, {
        tokenIdentifier: identity.tokenIdentifier,
        email: normalizedEmail,
        ...(identity.name !== undefined ? { name: identity.name } : {}),
        lastSeenAt: Date.now(),
      });
      await assignSignupEmailIfAvailable(ctx, userRow._id, identity.email);
      return await ctx.db.get("users", userRow._id);
    }
  }

  const existingUsers = await ctx.db.query("users").take(100);
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: identity.tokenIdentifier,
    admin:
      existingUsers.length === 0 ||
      existingUsers.every((user) => user.tokenIdentifier === undefined),
    email: normalizedEmail,
    name: identity.name,
    lastSeenAt: Date.now(),
  });

  await assignSignupEmailIfAvailable(ctx, userId, identity.email);

  return await ctx.db.get("users", userId);
}

export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const { user } = await requireUser(ctx);
  if (!user.admin) {
    throw new Error("Unauthorized");
  }

  return user;
}

async function getUserByTokenIdentifier(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", tokenIdentifier),
    )
    .unique();
}

async function getUsersByNormalizedEmail(
  ctx: QueryCtx | MutationCtx,
  normalizedEmail: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", normalizedEmail))
    .collect();
}

function isEmailSafeForAccountLinking(identity: {
  emailVerified?: boolean;
}) {
  if (identity.emailVerified === false) return false;

  return true;
}

async function pickCanonicalUserForMerge(ctx: MutationCtx, users: UserDoc[]) {
  if (users.length === 1) return users[0];

  let best = users[0];
  let bestAddrCount = -1;
  let bestCreationTime = Number.POSITIVE_INFINITY;
  for (const user of users) {
    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
    const addrCount = addresses.length;
    const created = user._creationTime;
    if (
      addrCount > bestAddrCount ||
      (addrCount === bestAddrCount && created < bestCreationTime)
    ) {
      best = user;
      bestAddrCount = addrCount;
      bestCreationTime = created;
    }
  }

  return best;
}

async function mergeDuplicateUsersInGroup(ctx: MutationCtx, users: UserDoc[]) {
  if (users.length <= 1) return users[0] ?? null;

  const canonical = await pickCanonicalUserForMerge(ctx, users);
  const duplicates = users.filter((user) => user._id !== canonical._id);
  let mergedAdmin = canonical.admin;
  for (const dup of duplicates) {
    mergedAdmin = mergedAdmin || dup.admin;
    const rows = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", dup._id))
      .collect();
    for (const row of rows)
      await ctx.db.patch("userEmailAddresses", row._id, {
        userId: canonical._id,
      });

    await ctx.db.delete("users", dup._id);
  }

  await ctx.db.patch("users", canonical._id, { admin: mergedAdmin });
  return await ctx.db.get("users", canonical._id);
}

export const mergeAllDuplicateUsersByEmail = internalMutation({
  args: {},
  handler: async (ctx) => {
    let normalizedEmailWrites = 0;
    const initialUsers = await ctx.db.query("users").take(10000);
    for (const user of initialUsers) {
      if (user.email === undefined) continue;
      const normalized = tryNormalizeEmail(user.email);
      if (normalized === undefined || normalized === user.email) continue;
      await ctx.db.patch("users", user._id, { email: normalized });
      normalizedEmailWrites++;
    }

    const grouped = new Map<string, UserDoc[]>();
    const refreshedUsers = await ctx.db.query("users").take(10000);
    for (const user of refreshedUsers) {
      if (user.email === undefined) continue;
      const list = grouped.get(user.email) ?? [];
      list.push(user);
      grouped.set(user.email, list);
    }

    let mergedGroups = 0;
    let removedUsers = 0;
    for (const group of grouped.values()) {
      if (group.length <= 1) continue;
      const before = group.length;
      await mergeDuplicateUsersInGroup(ctx, group);
      mergedGroups++;
      removedUsers += before - 1;
    }

    return { normalizedEmailWrites, mergedGroups, removedUsers };
  },
});

function normalizeAvlecAddress(value: string) {
  const normalized = normalizeEmailAddress(value);
  if (!normalized.endsWith(`@${AVLEC_DOMAIN}`)) {
    throw new Error(`Inbound addresses must use @${AVLEC_DOMAIN}`);
  }

  return normalized;
}

function normalizeEmailAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) {
    throw new Error("Enter a valid email address");
  }

  return normalized;
}

function tryNormalizeEmail(email: string | undefined) {
  if (email === undefined) return undefined;
  try {
    return normalizeEmailAddress(email);
  } catch {
    return undefined;
  }
}

async function assignSignupEmailIfAvailable(
  ctx: MutationCtx,
  userId: Id<"users">,
  email: string | undefined,
) {
  if (email === undefined) {
    return;
  }

  const existingUserAddress = await ctx.db
    .query("userEmailAddresses")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(1);
  if (existingUserAddress.length > 0) {
    return;
  }

  const address = normalizeEmailAddress(email);
  const existingAddress = await ctx.db
    .query("userEmailAddresses")
    .withIndex("by_address", (q) => q.eq("address", address))
    .unique();
  if (existingAddress !== null) {
    return;
  }

  await ctx.db.insert("userEmailAddresses", {
    userId,
    address,
    createdAt: Date.now(),
  });
}

function displayUser(user: {
  email?: string;
  name?: string;
  tokenIdentifier?: string;
}) {
  return user.name ?? user.email ?? user.tokenIdentifier ?? "";
}
