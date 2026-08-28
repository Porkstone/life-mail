import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { REFRESH_TOKEN_TTL_MS } from "./authTokens";

export const create = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    subject: v.string(),
    email: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("authSessions", {
      ...args,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });

    return null;
  },
});

export const refresh = internalMutation({
  args: { refreshTokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_refreshTokenHash", (q) =>
        q.eq("refreshTokenHash", args.refreshTokenHash),
      )
      .unique();

    if (session === null) return null;

    const now = Date.now();
    if (session.expiresAt <= now) {
      await ctx.db.delete("authSessions", session._id);
      return null;
    }

    await ctx.db.patch("authSessions", session._id, {
      lastUsedAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
    });

    return {
      subject: session.subject,
      email: session.email,
      emailVerified: session.emailVerified,
      name: session.name,
    };
  },
});

export const remove = internalMutation({
  args: { refreshTokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_refreshTokenHash", (q) =>
        q.eq("refreshTokenHash", args.refreshTokenHash),
      )
      .unique();

    if (session !== null) await ctx.db.delete("authSessions", session._id);

    return null;
  },
});
