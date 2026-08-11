import { v } from "convex/values";
import { requireUser } from "./auth";
import {
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const bounceNotificationValidator = v.object({
  _id: v.id("emailBounceNotifications"),
  _creationTime: v.number(),
  resendEmailId: v.string(),
  sentMessageId: v.union(v.id("sentMessages"), v.null()),
  recipients: v.array(v.string()),
  subject: v.string(),
  reason: v.string(),
  bounceType: v.string(),
  bounceSubtype: v.string(),
  diagnosticCodes: v.array(v.string()),
  occurredAt: v.number(),
});

export const listActiveBounces = query({
  args: {},
  returns: v.array(bounceNotificationValidator),
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    const notifications = new Map<
      Id<"emailBounceNotifications">,
      {
        _id: Id<"emailBounceNotifications">;
        _creationTime: number;
        resendEmailId: string;
        sentMessageId: Id<"sentMessages"> | null;
        recipients: string[];
        subject: string;
        reason: string;
        bounceType: string;
        bounceSubtype: string;
        diagnosticCodes: string[];
        occurredAt: number;
      }
    >();

    for (const { address } of addresses) {
      const addressNotifications = await ctx.db
        .query("emailBounceNotifications")
        .withIndex(
          "by_fromAddress_and_dismissedAt_and_occurredAt",
          (q) => q.eq("fromAddress", address).eq("dismissedAt", undefined),
        )
        .order("desc")
        .take(50);
      for (const notification of addressNotifications) {
        notifications.set(notification._id, {
          _id: notification._id,
          _creationTime: notification._creationTime,
          resendEmailId: notification.resendEmailId,
          sentMessageId: notification.sentMessageId ?? null,
          recipients: notification.recipients,
          subject: notification.subject,
          reason: notification.reason,
          bounceType: notification.bounceType,
          bounceSubtype: notification.bounceSubtype,
          diagnosticCodes: notification.diagnosticCodes,
          occurredAt: notification.occurredAt,
        });
      }
    }

    return [...notifications.values()]
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, 50);
  },
});

export const dismissBounce = mutation({
  args: { notificationId: v.id("emailBounceNotifications") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const notification = await ctx.db.get(
      "emailBounceNotifications",
      args.notificationId,
    );
    if (notification === null) {
      throw new Error("Bounce notification not found");
    }

    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    if (!addresses.some(({ address }) => address === notification.fromAddress)) {
      throw new Error("Unauthorized");
    }

    if (notification.dismissedAt === undefined) {
      await ctx.db.patch("emailBounceNotifications", notification._id, {
        dismissedAt: Date.now(),
      });
    }
    return null;
  },
});

export const storeResendBounce = internalMutation({
  args: {
    webhookId: v.string(),
    resendEmailId: v.string(),
    from: v.string(),
    recipients: v.array(v.string()),
    subject: v.string(),
    reason: v.string(),
    bounceType: v.string(),
    bounceSubtype: v.string(),
    diagnosticCodes: v.array(v.string()),
    occurredAt: v.number(),
  },
  returns: v.id("emailBounceNotifications"),
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("emailBounceNotifications")
      .withIndex("by_webhookId", (q) => q.eq("webhookId", args.webhookId))
      .unique();
    if (duplicate !== null) {
      return duplicate._id;
    }

    const sentMessage = await ctx.db
      .query("sentMessages")
      .withIndex("by_resend_email_id", (q) =>
        q.eq("resendEmailId", args.resendEmailId),
      )
      .unique();
    const fromAddress =
      sentMessage?.fromAddress ?? normalizeSenderAddress(args.from);

    return await ctx.db.insert("emailBounceNotifications", {
      webhookId: args.webhookId,
      resendEmailId: args.resendEmailId,
      ...(sentMessage === null ? {} : { sentMessageId: sentMessage._id }),
      fromAddress,
      recipients: args.recipients,
      subject: args.subject,
      reason: args.reason,
      bounceType: args.bounceType,
      bounceSubtype: args.bounceSubtype,
      diagnosticCodes: args.diagnosticCodes,
      occurredAt: args.occurredAt,
    });
  },
});

function normalizeSenderAddress(from: string) {
  const bracketedAddress = from.match(/<([^<>]+)>/)?.[1];
  return (bracketedAddress ?? from).trim().toLowerCase();
}
