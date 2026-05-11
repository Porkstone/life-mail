import { v } from "convex/values";
import {
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

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
    await ctx.db.patch("users", existing._id, {
      email: identity.email,
      name: identity.name,
      lastSeenAt: Date.now(),
    });
    await assignSignupEmailIfAvailable(ctx, existing._id, identity.email);
    return existing;
  }

  const existingUsers = await ctx.db.query("users").take(100);
  const userId = await ctx.db.insert("users", {
    tokenIdentifier: identity.tokenIdentifier,
    admin:
      existingUsers.length === 0 ||
      existingUsers.every((user) => user.tokenIdentifier === undefined),
    email: identity.email,
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
