import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireAdmin, requireUser } from "./auth";
import {
  action,
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
  type QueryCtx,
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
  content: v.optional(v.string()),
  storageId: v.optional(v.id("_storage")),
  contentType: v.optional(v.string()),
  contentId: v.optional(v.string()),
});

const outboundMessageValidator = {
  to: v.array(v.string()),
  cc: v.array(v.string()),
  subject: v.string(),
  text: v.string(),
  html: v.optional(v.string()),
  attachments: v.array(replyAttachmentValidator),
};

export const listReceived = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    if (addresses.length === 0) {
      return [];
    }

    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const messageIds = new Map<Id<"receivedMessages">, number>();
    for (const { address } of addresses) {
      const recipients = await ctx.db
        .query("receivedMessageRecipients")
        .withIndex("by_address_and_receivedAt", (q) => q.eq("address", address))
        .order("desc")
        .take(limit);
      for (const recipient of recipients) {
        messageIds.set(recipient.messageId, recipient.receivedAt);
      }
    }

    const messages = [];
    for (const messageId of messageIds.keys()) {
      const message = await ctx.db.get("receivedMessages", messageId);
      if (message !== null) {
        messages.push(message);
      }
    }

    return messages
      .sort((left, right) => right.receivedAt - left.receivedAt)
      .slice(0, limit);
  },
});

export const getReceived = query({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
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
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
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

export const archiveReceived = mutation({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
    await ctx.db.patch("receivedMessages", args.messageId, { archived: true });
    return null;
  },
});

export const listBlockedSenders = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
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
    await requireUser(ctx);
    await ctx.db.delete("blockedSenders", args.blockedSenderId);
    return null;
  },
});

export const generateAttachmentUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const backfillReceivedMessageRecipients = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const messages = await ctx.db
      .query("receivedMessages")
      .withIndex("by_received_at")
      .order("desc")
      .take(100);
    let indexed = 0;

    for (const message of messages) {
      const existing = await ctx.db
        .query("receivedMessageRecipients")
        .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
        .take(1);
      if (existing.length > 0) {
        continue;
      }

      const recipientAddresses = new Set(
        [...message.to, ...message.cc, ...message.bcc]
          .map(normalizeInboundAddress)
          .filter((address): address is string => address !== null),
      );
      for (const address of recipientAddresses) {
        await ctx.db.insert("receivedMessageRecipients", {
          messageId: message._id,
          address,
          receivedAt: message.receivedAt,
        });
        indexed += 1;
      }
    }

    return { indexed };
  },
});

export const getReceivedBody = action({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args): Promise<ReceivedBody> => {
    const identity = await requireActionIdentity(ctx);
    const target: BodyFetchTarget | null = await ctx.runQuery(
      internal.emails.getReceivedBodyFetchTargetForUser,
      { ...args, tokenIdentifier: identity.tokenIdentifier },
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

export const getReceivedBodyFetchTargetForUser = internalQuery({
  args: {
    messageId: v.id("receivedMessages"),
    tokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (user === null) {
      return null;
    }

    await requireMessageAccess(ctx, user._id, args.messageId);
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
    const identity = await requireActionIdentity(ctx);
    await ctx.runQuery(internal.emails.requireMessageAccessForUser, {
      messageId: args.originalMessageId,
      tokenIdentifier: identity.tokenIdentifier,
    });
    const sent = await sendOutboundMessage({
      ctx,
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
        html: args.html,
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
    await requireActionIdentity(ctx);
    const sent = await sendOutboundMessage({
      ctx,
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
        html: args.html,
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

    const recipientAddresses = new Set(
      [...args.data.to, ...args.data.cc, ...args.data.bcc]
        .map(normalizeInboundAddress)
        .filter((address): address is string => address !== null),
    );
    for (const address of recipientAddresses) {
      await ctx.db.insert("receivedMessageRecipients", {
        messageId,
        address,
        receivedAt: Date.parse(args.data.created_at) || Date.now(),
      });
    }

    return messageId;
  },
});

export const requireMessageAccessForUser = internalQuery({
  args: {
    messageId: v.id("receivedMessages"),
    tokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (user === null) {
      throw new Error("User not registered");
    }

    await requireMessageAccess(ctx, user._id, args.messageId);
    return null;
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
    html: v.optional(v.string()),
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
      html: args.html,
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
  ctx: ActionCtx;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
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

  const attachments = await Promise.all(
    args.attachments.map(async (attachment) => {
      const content =
        attachment.content ??
        (attachment.storageId === undefined
          ? null
          : await readStoredAttachmentContent(args.ctx, attachment.storageId));
      if (content === null) {
        throw new Error(`Unable to read ${attachment.filename}.`);
      }

      return {
        filename: attachment.filename,
        content,
        content_type: attachment.contentType,
        content_id: attachment.contentId,
      };
    }),
  );

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
      html: args.html !== undefined && args.html.trim().length > 0 ? args.html : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
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
  content?: string;
  storageId?: Id<"_storage">;
  contentType?: string;
  contentId?: string;
};

async function requireActionIdentity(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new Error("Not authenticated");
  }

  return identity;
}

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

function normalizeInboundAddress(value: string) {
  const bracketedAddress = value.match(/<([^<>]+)>/)?.[1];
  const address = (bracketedAddress ?? value).trim().toLowerCase();
  if (!/^[^@\s]+@avlec\.co$/.test(address)) {
    return null;
  }

  return address;
}

async function readStoredAttachmentContent(
  ctx: ActionCtx,
  storageId: Id<"_storage">,
) {
  const blob = await ctx.storage.get(storageId);
  if (blob === null) {
    return null;
  }

  return arrayBufferToBase64(await blob.arrayBuffer());
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

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
