import { v } from "convex/values";
import {
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUser } from "./auth";

export const create = mutation({
  args: {
    sourceMessageId: v.id("receivedMessages"),
    expenseType: v.string(),
    stayDates: v.string(),
    venue: v.string(),
    cost: v.string(),
    invoiceAttachmentId: v.optional(v.id("receivedMessageAttachments")),
    details: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.sourceMessageId);

    if (args.invoiceAttachmentId !== undefined) {
      const attachment = await ctx.db.get(args.invoiceAttachmentId);
      if (
        attachment === null ||
        attachment.messageId !== args.sourceMessageId
      ) {
        throw new Error("Selected invoice does not belong to this message.");
      }
    }

    const now = Date.now();
    return await ctx.db.insert("expenses", {
      userId: user._id,
      sourceMessageId: args.sourceMessageId,
      expenseType: args.expenseType.trim(),
      stayDates: args.stayDates.trim(),
      venue: args.venue.trim(),
      cost: args.cost.trim(),
      invoiceAttachmentId: args.invoiceAttachmentId,
      details: args.details.trim(),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return await Promise.all(
      expenses.map(async (expense) => {
        const message = await ctx.db.get(expense.sourceMessageId);
        const invoice =
          expense.invoiceAttachmentId === undefined
            ? null
            : await ctx.db.get(expense.invoiceAttachmentId);
        return { expense, message, invoice };
      }),
    );
  },
});

export const listForMessage = query({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
    return await ctx.db
      .query("expenses")
      .withIndex("by_sourceMessageId", (q) =>
        q.eq("sourceMessageId", args.messageId),
      )
      .order("desc")
      .take(20);
  },
});

async function requireMessageAccess(
  ctx: MutationCtx | QueryCtx,
  userId: Id<"users">,
  messageId: Id<"receivedMessages">,
) {
  const addresses = await ctx.db
    .query("userEmailAddresses")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(100);
  const addressSet = new Set(addresses.map((address) => address.address));

  const recipients = await ctx.db
    .query("receivedMessageRecipients")
    .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
    .take(100);
  if (recipients.some((recipient) => addressSet.has(recipient.address))) {
    return null;
  }

  throw new Error("Unauthorized");
}
