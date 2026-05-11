import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.optional(v.string()),
    admin: v.boolean(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
  }).index("by_tokenIdentifier", ["tokenIdentifier"]),

  userEmailAddresses: defineTable({
    userId: v.id("users"),
    address: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_address", ["address"]),

  receivedMessageRecipients: defineTable({
    messageId: v.id("receivedMessages"),
    address: v.string(),
    receivedAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_address_and_receivedAt", ["address", "receivedAt"]),

  receivedMessages: defineTable({
    resendEmailId: v.string(),
    resendMessageId: v.string(),
    webhookId: v.string(),
    webhookCreatedAt: v.string(),
    emailCreatedAt: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    bcc: v.array(v.string()),
    subject: v.string(),
    attachmentCount: v.number(),
    receivedAt: v.number(),
    archived: v.optional(v.boolean()),
    bodyHtml: v.optional(v.union(v.string(), v.null())),
    bodyText: v.optional(v.union(v.string(), v.null())),
    bodyFetchedAt: v.optional(v.number()),
    bodyFetchStatus: v.optional(
      v.union(v.literal("pending"), v.literal("ready"), v.literal("error")),
    ),
    bodyFetchError: v.optional(v.string()),
    rawEvent: v.string(),
  })
    .index("by_webhook_id", ["webhookId"])
    .index("by_resend_email_id", ["resendEmailId"])
    .index("by_received_at", ["receivedAt"])
    .index("by_body_fetch_status_and_received_at", [
      "bodyFetchStatus",
      "receivedAt",
    ]),

  receivedMessageAttachments: defineTable({
    messageId: v.id("receivedMessages"),
    resendAttachmentId: v.string(),
    filename: v.string(),
    contentType: v.string(),
    contentDisposition: v.string(),
    contentId: v.union(v.string(), v.null()),
  }).index("by_message_id", ["messageId"]),

  sentMessages: defineTable({
    resendEmailId: v.string(),
    originalMessageId: v.optional(v.id("receivedMessages")),
    originalResendMessageId: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    sentAt: v.number(),
    resendResponse: v.string(),
  })
    .index("by_original_message_id", ["originalMessageId"])
    .index("by_resend_email_id", ["resendEmailId"])
    .index("by_sent_at", ["sentAt"]),

  blockedSenders: defineTable({
    address: v.string(),
    blockedAt: v.number(),
  }).index("by_address", ["address"]),
});
