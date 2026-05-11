import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
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
    rawEvent: v.string(),
  })
    .index("by_webhook_id", ["webhookId"])
    .index("by_resend_email_id", ["resendEmailId"])
    .index("by_received_at", ["receivedAt"]),

  receivedMessageAttachments: defineTable({
    messageId: v.id("receivedMessages"),
    resendAttachmentId: v.string(),
    filename: v.string(),
    contentType: v.string(),
    contentDisposition: v.string(),
    contentId: v.union(v.string(), v.null()),
  }).index("by_message_id", ["messageId"]),
});
