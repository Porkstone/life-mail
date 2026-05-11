import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

const attachmentValidator = v.object({
  id: v.string(),
  filename: v.string(),
  content_type: v.string(),
  content_disposition: v.string(),
  content_id: v.union(v.string(), v.null()),
});

const replyAttachmentValidator = v.object({
  filename: v.string(),
  content: v.string(),
});

const outboundMessageValidator = {
  to: v.array(v.string()),
  cc: v.array(v.string()),
  subject: v.string(),
  text: v.string(),
  attachments: v.array(replyAttachmentValidator),
};

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
    const message = await ctx.db.get("receivedMessages", args.messageId);
    if (message === null) {
      return null;
    }

    const attachments = await ctx.db
      .query("receivedMessageAttachments")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .take(100);

    const replies = await ctx.db
      .query("sentMessages")
      .withIndex("by_original_message_id", (q) =>
        q.eq("originalMessageId", args.messageId),
      )
      .order("asc")
      .take(100);

    return { message, attachments, replies };
  },
});

export const blockSenderAndArchive = mutation({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get("receivedMessages", args.messageId);
    if (message === null) {
      return null;
    }

    const address = normalizeSenderAddress(message.from);
    if (address.length > 0) {
      const existingBlock = await ctx.db
        .query("blockedSenders")
        .withIndex("by_address", (q) => q.eq("address", address))
        .unique();

      if (existingBlock === null) {
        await ctx.db.insert("blockedSenders", {
          address,
          blockedAt: Date.now(),
        });
      }
    }

    await ctx.db.patch("receivedMessages", args.messageId, { archived: true });
    return { address };
  },
});

export const listBlockedSenders = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("blockedSenders")
      .withIndex("by_address")
      .order("asc")
      .take(200);
  },
});

export const removeBlockedSender = mutation({
  args: { blockedSenderId: v.id("blockedSenders") },
  handler: async (ctx, args) => {
    await ctx.db.delete("blockedSenders", args.blockedSenderId);
    return null;
  },
});

export const getReceivedBody = action({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args): Promise<ReceivedBody> => {
    const target: BodyFetchTarget | null = await ctx.runQuery(
      internal.emails.getReceivedBodyFetchTarget,
      args,
    );
    if (target === null) {
      throw new Error("Message not found.");
    }

    if (target.bodyFetchedAt !== undefined) {
      return {
        html: target.bodyHtml ?? null,
        text: target.bodyText ?? null,
      };
    }

    try {
      const body = await fetchReceivedBodyFromResend(target.resendEmailId);
      await ctx.runMutation(internal.emails.storeReceivedBody, {
        messageId: args.messageId,
        ...body,
      });
      return body;
    } catch (error: unknown) {
      await ctx.runMutation(internal.emails.storeReceivedBodyFetchError, {
        messageId: args.messageId,
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch the message body.",
      });
      throw error;
    }
  },
});

export const fetchPendingReceivedBodies = internalAction({
  args: {},
  handler: async (ctx): Promise<{ fetched: number; failed: number }> => {
    const targets: BodyFetchTarget[] = await ctx.runQuery(
      internal.emails.listPendingReceivedBodyFetches,
      {},
    );

    let fetched = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        const body = await fetchReceivedBodyFromResend(target.resendEmailId);
        await ctx.runMutation(internal.emails.storeReceivedBody, {
          messageId: target._id,
          ...body,
        });
        fetched += 1;
      } catch (error: unknown) {
        await ctx.runMutation(internal.emails.storeReceivedBodyFetchError, {
          messageId: target._id,
          error:
            error instanceof Error
              ? error.message
              : "Unable to fetch the message body.",
        });
        failed += 1;
      }
    }

    return { fetched, failed };
  },
});

export const getReceivedBodyFetchTarget = internalQuery({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get("receivedMessages", args.messageId);
    if (message === null) {
      return null;
    }

    return {
      _id: message._id,
      resendEmailId: message.resendEmailId,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      bodyFetchedAt: message.bodyFetchedAt,
    };
  },
});

export const listPendingReceivedBodyFetches = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("receivedMessages")
      .withIndex("by_body_fetch_status_and_received_at", (q) =>
        q.eq("bodyFetchStatus", "pending"),
      )
      .order("asc")
      .take(25);
  },
});

export const storeReceivedBody = internalMutation({
  args: {
    messageId: v.id("receivedMessages"),
    html: v.union(v.string(), v.null()),
    text: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("receivedMessages", args.messageId, {
      bodyHtml: args.html,
      bodyText: args.text,
      bodyFetchedAt: Date.now(),
      bodyFetchStatus: "ready",
      bodyFetchError: undefined,
    });
  },
});

export const storeReceivedBodyFetchError = internalMutation({
  args: {
    messageId: v.id("receivedMessages"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("receivedMessages", args.messageId, {
      bodyFetchStatus: "error",
      bodyFetchError: args.error,
    });
  },
});

export const sendReply = action({
  args: {
    originalMessageId: v.id("receivedMessages"),
    originalResendMessageId: v.string(),
    ...outboundMessageValidator,
  },
  handler: async (ctx, args) => {
    const sent = await sendOutboundMessage({
      ...args,
      failureLabel: "reply",
      originalResendMessageId: args.originalResendMessageId,
    });

    const sentMessageId: Id<"sentMessages"> = await ctx.runMutation(
      internal.emails.storeSentMessage,
      {
        resendEmailId: sent.resendEmailId,
        originalMessageId: args.originalMessageId,
        originalResendMessageId: args.originalResendMessageId,
        from: sent.from,
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        text: args.text,
        sentAt: Date.now(),
        resendResponse: sent.responseBody,
      },
    );

    return sentMessageId;
  },
});

export const sendMessage = action({
  args: outboundMessageValidator,
  handler: async (ctx, args) => {
    const sent = await sendOutboundMessage({
      ...args,
      failureLabel: "message",
    });

    const sentMessageId: Id<"sentMessages"> = await ctx.runMutation(
      internal.emails.storeSentMessage,
      {
        resendEmailId: sent.resendEmailId,
        originalMessageId: undefined,
        originalResendMessageId: "",
        from: sent.from,
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        text: args.text,
        sentAt: Date.now(),
        resendResponse: sent.responseBody,
      },
    );

    return sentMessageId;
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

    const senderAddress = normalizeSenderAddress(args.data.from);
    const blockedSender =
      senderAddress.length === 0
        ? null
        : await ctx.db
            .query("blockedSenders")
            .withIndex("by_address", (q) => q.eq("address", senderAddress))
            .unique();

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
      archived: blockedSender !== null,
      bodyFetchStatus: "pending",
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

export const storeSentMessage = internalMutation({
  args: {
    resendEmailId: v.string(),
    originalMessageId: v.optional(v.id("receivedMessages")),
    originalResendMessageId: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
    sentAt: v.number(),
    resendResponse: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sentMessages", {
      resendEmailId: args.resendEmailId,
      originalMessageId: args.originalMessageId,
      originalResendMessageId: args.originalResendMessageId,
      from: args.from,
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      text: args.text,
      sentAt: args.sentAt,
      resendResponse: args.resendResponse,
    });
  },
});

function normalizeSenderAddress(from: string) {
  const bracketedAddress = from.match(/<([^<>]+)>/)?.[1];
  return (bracketedAddress ?? from).trim().toLowerCase();
}

async function sendOutboundMessage(args: {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: ReplyAttachmentInput[];
  failureLabel: string;
  originalResendMessageId?: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const from = process.env.RESEND_FROM_EMAIL;
  if (from === undefined) {
    throw new Error("RESEND_FROM_EMAIL is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: args.to,
      cc: args.cc.length > 0 ? args.cc : undefined,
      subject: args.subject,
      text: args.text,
      attachments: args.attachments.length > 0 ? args.attachments : undefined,
      headers:
        args.originalResendMessageId !== undefined &&
        args.originalResendMessageId.trim().length > 0
          ? {
              "In-Reply-To": args.originalResendMessageId,
              References: args.originalResendMessageId,
            }
          : undefined,
    }),
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Resend returned ${response.status} while sending the ${
        args.failureLabel
      }.${responseBody.length > 0 ? ` ${responseBody}` : ""}`,
    );
  }

  let resendEmailId = "";
  try {
    const sent = JSON.parse(responseBody) as { id?: string };
    resendEmailId = sent.id ?? "";
  } catch {
    resendEmailId = "";
  }

  return { from, resendEmailId, responseBody };
}

type BodyFetchTarget = {
  _id: Id<"receivedMessages">;
  resendEmailId: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyFetchedAt?: number;
};

type ReceivedBody = {
  html: string | null;
  text: string | null;
};

type ReplyAttachmentInput = {
  filename: string;
  content: string;
};

async function fetchReceivedBodyFromResend(
  resendEmailId: string,
): Promise<ReceivedBody> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(
      resendEmailId,
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
}
