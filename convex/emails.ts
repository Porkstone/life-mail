import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";

const attachmentValidator = v.object({
  id: v.string(),
  filename: v.string(),
  content_type: v.string(),
  content_disposition: v.string(),
  content_id: v.union(v.string(), v.null()),
});

export const listReceived = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("receivedMessages")
      .withIndex("by_received_at")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getReceived = query({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (message === null) {
      return null;
    }

    const attachments = await ctx.db
      .query("receivedMessageAttachments")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .take(100);

    return { message, attachments };
  },
});

export const getReceivedBody = action({
  args: { resendEmailId: v.string() },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey === undefined) {
      throw new Error("RESEND_API_KEY is not configured.");
    }

    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(
        args.resendEmailId,
      )}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Resend returned ${response.status} while fetching the message body.${
          details.length > 0 ? ` ${details}` : ""
        }`,
      );
    }

    const email = (await response.json()) as {
      html?: string | null;
      text?: string | null;
    };

    return {
      html: email.html ?? null,
      text: email.text ?? null,
    };
  },
});

export const storeResendReceivedEmail = internalMutation({
  args: {
    webhookId: v.string(),
    webhookCreatedAt: v.string(),
    rawEvent: v.string(),
    data: v.object({
      email_id: v.string(),
      created_at: v.string(),
      from: v.string(),
      to: v.array(v.string()),
      cc: v.array(v.string()),
      bcc: v.array(v.string()),
      message_id: v.string(),
      subject: v.string(),
      attachments: v.array(attachmentValidator),
    }),
  },
  handler: async (ctx, args) => {
    const duplicateDelivery = await ctx.db
      .query("receivedMessages")
      .withIndex("by_webhook_id", (q) => q.eq("webhookId", args.webhookId))
      .unique();
    if (duplicateDelivery !== null) {
      return duplicateDelivery._id;
    }

    const existingMessage = await ctx.db
      .query("receivedMessages")
      .withIndex("by_resend_email_id", (q) =>
        q.eq("resendEmailId", args.data.email_id),
      )
      .unique();
    if (existingMessage !== null) {
      return existingMessage._id;
    }

    const messageId = await ctx.db.insert("receivedMessages", {
      resendEmailId: args.data.email_id,
      resendMessageId: args.data.message_id,
      webhookId: args.webhookId,
      webhookCreatedAt: args.webhookCreatedAt,
      emailCreatedAt: args.data.created_at,
      from: args.data.from,
      to: args.data.to,
      cc: args.data.cc,
      bcc: args.data.bcc,
      subject: args.data.subject,
      attachmentCount: args.data.attachments.length,
      receivedAt: Date.parse(args.data.created_at) || Date.now(),
      rawEvent: args.rawEvent,
    });

    for (const attachment of args.data.attachments) {
      await ctx.db.insert("receivedMessageAttachments", {
        messageId,
        resendAttachmentId: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        contentDisposition: attachment.content_disposition,
        contentId: attachment.content_id,
      });
    }

    return messageId;
  },
});
