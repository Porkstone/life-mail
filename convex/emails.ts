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
  from: v.optional(v.string()),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  subject: v.string(),
  text: v.string(),
  html: v.optional(v.string()),
  attachments: v.array(replyAttachmentValidator),
};

const SETTINGS_KEY = "global";
const OPENROUTER_MODEL = "openrouter/auto";
const OLD_ARCHIVED_MESSAGE_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const OLD_ARCHIVED_MESSAGE_DELETE_BATCH_SIZE = 50;
const RECEIVED_MESSAGE_SENDER_INDEX_BACKFILL_BATCH_SIZE = 10;
const MAX_INLINE_BODY_BYTES = 500_000;

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
      if (message !== null && message.deletedOn === undefined) {
        messages.push(message);
      }
    }

    return messages
      .sort((left, right) => right.receivedAt - left.receivedAt)
      .slice(0, limit);
  },
});

export const listKeptReceived = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireUser(ctx);
    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    if (addresses.length === 0) {
      return [];
    }

    const addressSet = new Set(addresses.map((address) => address.address));
    const keptMessages = await ctx.db
      .query("receivedMessages")
      .withIndex("by_kept_and_deletedOn_and_receivedAt", (q) =>
        q.eq("kept", true).eq("deletedOn", undefined),
      )
      .order("desc")
      .collect();

    const messages = [];
    for (const message of keptMessages) {
      if (await userCanAccessMessage(ctx, addressSet, message._id)) {
        messages.push(message);
      }
    }

    return messages;
  },
});

export const listDeletedReceived = query({
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
        .withIndex("by_address_and_deletedOn", (q) =>
          q.eq("address", address).gt("deletedOn", 0),
        )
        .order("desc")
        .take(limit);
      for (const recipient of recipients) {
        messageIds.set(recipient.messageId, recipient.deletedOn ?? 0);
      }
    }

    const addressSet = new Set(addresses.map((address) => address.address));
    const deletedMessages = await ctx.db
      .query("receivedMessages")
      .withIndex("by_deletedOn_and_receivedAt", (q) => q.gt("deletedOn", 0))
      .order("desc")
      .take(limit);
    for (const message of deletedMessages) {
      if (
        !messageIds.has(message._id) &&
        (await userCanAccessMessage(ctx, addressSet, message._id))
      ) {
        messageIds.set(message._id, message.deletedOn ?? 0);
      }
    }

    const messages = [];
    for (const messageId of messageIds.keys()) {
      const message = await ctx.db.get("receivedMessages", messageId);
      if (message !== null && message.deletedOn !== undefined) {
        messages.push(message);
      }
    }

    return messages
      .sort((left, right) => (right.deletedOn ?? 0) - (left.deletedOn ?? 0))
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

export const getLastPreviousReceivedFromSender = query({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);

    const messageSenderIndex = await ctx.db
      .query("receivedMessageSenderIndex")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (messageSenderIndex === null) {
      return null;
    }

    const senderAddress = messageSenderIndex.fromAddress;
    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    const addressSet = new Set(addresses.map((address) => address.address));

    const senderMatches = await ctx.db
      .query("receivedMessageSenderIndex")
      .withIndex("by_fromAddress_and_receivedAt", (q) =>
        q
          .eq("fromAddress", senderAddress)
          .lt("receivedAt", messageSenderIndex.receivedAt),
      )
      .order("desc")
      .take(10);

    for (const previousMessage of senderMatches) {
      if (await userCanAccessMessage(ctx, addressSet, previousMessage.messageId)) {
        return previousMessage.receivedAt;
      }
    }

    return null;
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

    await ctx.db.patch("receivedMessages", args.messageId, {
      archived: true,
      kept: false,
    });
    return { address };
  },
});

export const archiveReceived = mutation({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
    await ctx.db.patch("receivedMessages", args.messageId, {
      archived: true,
      kept: false,
    });
    return null;
  },
});

export const deleteReceived = mutation({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
    const deletedOn = Date.now();
    await ctx.db.patch("receivedMessages", args.messageId, {
      archived: false,
      kept: false,
      deletedOn,
    });
    await markReceivedMessageRecipientsDeleted(ctx, args.messageId, deletedOn);
    return null;
  },
});

export const keepReceived = mutation({
  args: { messageId: v.id("receivedMessages") },
  handler: async (ctx, args) => {
    const { user } = await requireUser(ctx);
    await requireMessageAccess(ctx, user._id, args.messageId);
    await ctx.db.patch("receivedMessages", args.messageId, {
      archived: false,
      kept: true,
    });
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

export const backfillReceivedMessageSenderIndex = mutation({
  args: { beforeReceivedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const query =
      args.beforeReceivedAt === undefined
        ? ctx.db.query("receivedMessages").withIndex("by_received_at")
        : ctx.db
            .query("receivedMessages")
            .withIndex("by_received_at", (q) =>
              q.lt("receivedAt", args.beforeReceivedAt!),
            );
    const messages = await query
      .order("desc")
      .take(RECEIVED_MESSAGE_SENDER_INDEX_BACKFILL_BATCH_SIZE);
    let indexed = 0;
    let skipped = 0;
    let nextBeforeReceivedAt: number | null = null;

    for (const message of messages) {
      nextBeforeReceivedAt = message.receivedAt;
      const existing = await ctx.db
        .query("receivedMessageSenderIndex")
        .withIndex("by_messageId", (q) => q.eq("messageId", message._id))
        .take(1);
      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      const fromAddress = message.fromAddress ?? normalizeSenderAddress(message.from);
      if (fromAddress.length === 0) {
        skipped += 1;
        continue;
      }

      await ctx.db.insert("receivedMessageSenderIndex", {
        messageId: message._id,
        fromAddress,
        receivedAt: message.receivedAt,
      });
      indexed += 1;
    }

    return {
      indexed,
      skipped,
      nextBeforeReceivedAt,
      hasMore: messages.length === RECEIVED_MESSAGE_SENDER_INDEX_BACKFILL_BATCH_SIZE,
    };
  },
});

export const getOpenRouterSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const settings = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();

    return {
      hasApiKey:
        settings?.openRouterApiKey !== undefined &&
        settings.openRouterApiKey.trim().length > 0,
      systemPrompt: settings?.openRouterSystemPrompt ?? "",
    };
  },
});

export const updateOpenRouterSettings = mutation({
  args: {
    apiKey: v.optional(v.string()),
    systemPrompt: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    const trimmedApiKey = args.apiKey?.trim();
    const update = {
      openRouterSystemPrompt: args.systemPrompt,
      updatedAt: Date.now(),
      ...(trimmedApiKey !== undefined && trimmedApiKey.length > 0
        ? { openRouterApiKey: trimmedApiKey }
        : {}),
    };

    if (existing === null) {
      await ctx.db.insert("appSettings", {
        key: SETTINGS_KEY,
        ...update,
      });
    } else {
      await ctx.db.patch("appSettings", existing._id, update);
    }

    return null;
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

    if (target.deletedOn !== undefined || target.bodyFetchedAt !== undefined) {
      return await buildReceivedBodyResponse(ctx, target);
    }

    try {
      const body = await fetchReceivedBodyFromResend(target.resendEmailId);
      const storedBody = await prepareReceivedBodyForStorage(ctx, body);
      await ctx.runMutation(internal.emails.storeReceivedBody, {
        messageId: args.messageId,
        ...storedBody,
      });
      return await buildStoredReceivedBodyResponse(ctx, storedBody);
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

export const generateReplyFromPrompt = action({
  args: {
    originalMessageId: v.id("receivedMessages"),
    prompt: v.string(),
  },
  handler: async (ctx, args): Promise<{ text: string }> => {
    const identity = await requireActionIdentity(ctx);
    const settings: OpenRouterSettings | null = await ctx.runQuery(
      internal.emails.getOpenRouterSettingsForAction,
      {},
    );
    const apiKey = settings?.openRouterApiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("OpenRouter API key is not configured.");
    }
    if (settings === null) {
      throw new Error("OpenRouter settings are not configured.");
    }

    const prompt = args.prompt.trim();
    if (prompt.length === 0) {
      throw new Error("Enter a prompt first.");
    }

    const originalBody = await getReceivedBodyTextForPrompt(
      ctx,
      args.originalMessageId,
      identity.tokenIdentifier,
    );

    return {
      text: await generateOpenRouterReply(
        apiKey,
        settings,
        buildOpenRouterUserPrompt(prompt, originalBody),
      ),
    };
  },
});

export const previewOpenRouterPrompt = action({
  args: {
    originalMessageId: v.id("receivedMessages"),
    prompt: v.string(),
  },
  handler: async (ctx, args): Promise<{ systemPrompt: string; prompt: string }> => {
    const identity = await requireActionIdentity(ctx);
    const settings: OpenRouterSettings | null = await ctx.runQuery(
      internal.emails.getOpenRouterSettingsForAction,
      {},
    );
    const originalBody = await getReceivedBodyTextForPrompt(
      ctx,
      args.originalMessageId,
      identity.tokenIdentifier,
    );

    return {
      systemPrompt: settings?.openRouterSystemPrompt?.trim() ?? "",
      prompt: buildOpenRouterUserPrompt(args.prompt.trim(), originalBody),
    };
  },
});

export const getReceivedAttachmentDownload = action({
  args: {
    attachmentId: v.id("receivedMessageAttachments"),
  },
  handler: async (ctx, args): Promise<ReceivedAttachmentDownload> => {
    const identity = await requireActionIdentity(ctx);
    const target: AttachmentFetchTarget | null = await ctx.runQuery(
      internal.emails.getReceivedAttachmentFetchTargetForUser,
      { ...args, tokenIdentifier: identity.tokenIdentifier },
    );
    if (target === null) {
      throw new Error("Attachment not found.");
    }

    return await fetchReceivedAttachmentDownloadFromResend(target);
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
        const storedBody = await prepareReceivedBodyForStorage(ctx, body);
        await ctx.runMutation(internal.emails.storeReceivedBody, {
          messageId: target._id,
          ...storedBody,
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

export const getReceivedAttachmentFetchTargetForUser = internalQuery({
  args: {
    attachmentId: v.id("receivedMessageAttachments"),
    tokenIdentifier: v.string(),
  },
  handler: async (ctx, args): Promise<AttachmentFetchTarget | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (user === null) {
      return null;
    }

    const attachment = await ctx.db.get(
      "receivedMessageAttachments",
      args.attachmentId,
    );
    if (attachment === null) {
      return null;
    }

    await requireMessageAccess(ctx, user._id, attachment.messageId);
    const message = await ctx.db.get("receivedMessages", attachment.messageId);
    if (message === null) {
      return null;
    }

    return {
      attachmentId: attachment.resendAttachmentId,
      contentType: attachment.contentType,
      emailId: message.resendEmailId,
      filename: attachment.filename,
    };
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
      bodyHtmlStorageId: message.bodyHtmlStorageId,
      bodyTextStorageId: message.bodyTextStorageId,
      bodyFetchedAt: message.bodyFetchedAt,
      deletedOn: message.deletedOn,
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
      bodyHtmlStorageId: message.bodyHtmlStorageId,
      bodyTextStorageId: message.bodyTextStorageId,
      bodyFetchedAt: message.bodyFetchedAt,
      deletedOn: message.deletedOn,
    };
  },
});

export const listPendingReceivedBodyFetches = internalQuery({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db
      .query("receivedMessages")
      .withIndex("by_body_fetch_status_and_received_at", (q) =>
        q.eq("bodyFetchStatus", "pending"),
      )
      .order("asc")
      .take(25);

    return messages.filter((message) => message.deletedOn === undefined);
  },
});

export const deleteOldArchivedReceivedMessages = internalMutation({
  args: { cutoffReceivedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoffReceivedAt =
      args.cutoffReceivedAt ?? Date.now() - OLD_ARCHIVED_MESSAGE_AGE_MS;
    const deletedOn = Date.now();
    const messages = await ctx.db
      .query("receivedMessages")
      .withIndex("by_archived_and_deletedOn_and_receivedAt", (q) =>
        q
          .eq("archived", true)
          .eq("deletedOn", undefined)
          .lte("receivedAt", cutoffReceivedAt),
      )
      .take(OLD_ARCHIVED_MESSAGE_DELETE_BATCH_SIZE);

    for (const message of messages) {
      const attachments = await ctx.db
        .query("receivedMessageAttachments")
        .withIndex("by_message_id", (q) => q.eq("messageId", message._id))
        .take(100);
      for (const attachment of attachments) {
        await ctx.db.delete("receivedMessageAttachments", attachment._id);
      }

      await ctx.db.patch("receivedMessages", message._id, {
        deletedOn,
        bodyText: null,
        bodyHtml: null,
        bodyTextStorageId: null,
        bodyHtmlStorageId: null,
        bodyFetchStatus: undefined,
        bodyFetchError: undefined,
        bodyFetchedAt: undefined,
        attachmentCount: 0,
      });
      await markReceivedMessageRecipientsDeleted(ctx, message._id, deletedOn);
    }

    if (messages.length === OLD_ARCHIVED_MESSAGE_DELETE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.emails.deleteOldArchivedReceivedMessages,
        { cutoffReceivedAt },
      );
    }

    return { deleted: messages.length };
  },
});

export const storeReceivedBody = internalMutation({
  args: {
    messageId: v.id("receivedMessages"),
    html: v.union(v.string(), v.null()),
    text: v.union(v.string(), v.null()),
    htmlStorageId: v.union(v.id("_storage"), v.null()),
    textStorageId: v.union(v.id("_storage"), v.null()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("receivedMessages", args.messageId, {
      bodyHtml: args.html,
      bodyText: args.text,
      bodyHtmlStorageId: args.htmlStorageId,
      bodyTextStorageId: args.textStorageId,
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

export const getOpenRouterSettingsForAction = internalQuery({
  args: {},
  handler: async (ctx): Promise<OpenRouterSettings | null> => {
    return await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
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
      fromAddress: senderAddress,
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

    if (senderAddress.length > 0) {
      await ctx.db.insert("receivedMessageSenderIndex", {
        messageId,
        fromAddress: senderAddress,
        receivedAt: Date.parse(args.data.created_at) || Date.now(),
      });
    }

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
  from?: string;
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

  const identity = await requireActionIdentity(args.ctx);
  const from = await resolveOutboundSenderAddress(
    args.ctx,
    identity.tokenIdentifier,
    args.from,
  );

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
      html: buildOutboundHtml(args.text, args.html),
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

async function resolveOutboundSenderAddress(
  ctx: ActionCtx,
  tokenIdentifier: string,
  requestedFrom?: string,
) {
  const user = await ctx.runQuery(internal.emails.getOutboundSenderForUser, {
    tokenIdentifier,
    requestedFrom,
  });

  if (user === null) {
    throw new Error("User not registered");
  }

  return user;
}

export const getOutboundSenderForUser = internalQuery({
  args: {
    tokenIdentifier: v.string(),
    requestedFrom: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier),
      )
      .unique();
    if (user === null) {
      return null;
    }

    const addresses = await ctx.db
      .query("userEmailAddresses")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .take(100);
    if (addresses.length === 0) {
      throw new Error("No sender address is associated with this user.");
    }

    const sortedAddresses = addresses.sort(
      (left, right) => left.createdAt - right.createdAt,
    );
    const normalizedRequestedFrom = args.requestedFrom?.trim().toLowerCase();
    if (normalizedRequestedFrom !== undefined && normalizedRequestedFrom !== "") {
      const matchingAddress = sortedAddresses.find(
        (address) => address.address === normalizedRequestedFrom,
      );
      if (matchingAddress === undefined) {
        throw new Error("The selected sender address is not available.");
      }
      return matchingAddress.address;
    }

    return sortedAddresses[0]?.address ?? null;
  },
});

function buildOutboundHtml(text: string, html?: string) {
  if (html !== undefined && html.trim().length > 0) {
    return html;
  }

  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalizedText.trim().length === 0) {
    return undefined;
  }

  return escapeHtml(normalizedText).replace(/\n/g, "<br>");
}

type BodyFetchTarget = {
  _id: Id<"receivedMessages">;
  resendEmailId: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyHtmlStorageId?: Id<"_storage"> | null;
  bodyTextStorageId?: Id<"_storage"> | null;
  bodyFetchedAt?: number;
  deletedOn?: number;
};

type ReceivedBody = {
  html: string | null;
  text: string | null;
  htmlUrl?: string | null;
  textUrl?: string | null;
};

type StoredReceivedBody = {
  html: string | null;
  text: string | null;
  htmlStorageId: Id<"_storage"> | null;
  textStorageId: Id<"_storage"> | null;
};

type AttachmentFetchTarget = {
  attachmentId: string;
  contentType: string;
  emailId: string;
  filename: string;
};

type ReceivedAttachmentDownload = {
  downloadUrl: string;
  expiresAt: string | null;
  filename: string;
  contentType: string;
};

type OpenRouterSettings = {
  openRouterApiKey?: string;
  openRouterSystemPrompt?: string;
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

async function generateOpenRouterReply(
  apiKey: string,
  settings: OpenRouterSettings,
  prompt: string,
) {
  const messages = [
    ...(settings.openRouterSystemPrompt?.trim()
      ? [{ role: "system", content: settings.openRouterSystemPrompt.trim() }]
      : []),
    { role: "user", content: prompt },
  ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://life-mail.local",
      "X-Title": "Life Mail",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
    }),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter returned ${response.status} while generating the reply.${
        responseBody.length > 0 ? ` ${responseBody}` : ""
      }`,
    );
  }

  const parsed = JSON.parse(responseBody) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = parsed.choices?.[0]?.message?.content?.trim();
  if (content === undefined || content.length === 0) {
    throw new Error("OpenRouter did not return a reply.");
  }

  return content;
}

async function getReceivedBodyTextForPrompt(
  ctx: ActionCtx,
  messageId: Id<"receivedMessages">,
  tokenIdentifier: string,
) {
  const target: BodyFetchTarget | null = await ctx.runQuery(
    internal.emails.getReceivedBodyFetchTargetForUser,
    { messageId, tokenIdentifier },
  );
  if (target === null) {
    throw new Error("Message not found.");
  }

  if (target.bodyFetchedAt !== undefined) {
    return await getStoredReceivedBodyText(ctx, target);
  }

  const body = await fetchReceivedBodyFromResend(target.resendEmailId);
  const storedBody = await prepareReceivedBodyForStorage(ctx, body);
  await ctx.runMutation(internal.emails.storeReceivedBody, {
    messageId,
    ...storedBody,
  });

  return body.text ?? htmlToText(body.html ?? "");
}

async function prepareReceivedBodyForStorage(
  ctx: ActionCtx,
  body: Pick<ReceivedBody, "html" | "text">,
): Promise<StoredReceivedBody> {
  const totalBodySize = encodedSize(body.html ?? "") + encodedSize(body.text ?? "");
  const shouldStoreBody = totalBodySize > MAX_INLINE_BODY_BYTES;
  const htmlStorageId =
    body.html !== null && shouldStoreBody
      ? await ctx.storage.store(new Blob([body.html], { type: "text/html" }))
      : null;
  const textStorageId =
    body.text !== null && shouldStoreBody
      ? await ctx.storage.store(new Blob([body.text], { type: "text/plain" }))
      : null;

  return {
    html: htmlStorageId === null ? body.html : null,
    text: textStorageId === null ? body.text : null,
    htmlStorageId,
    textStorageId,
  };
}

async function buildStoredReceivedBodyResponse(
  ctx: ActionCtx,
  body: StoredReceivedBody,
): Promise<ReceivedBody> {
  return {
    html: body.html,
    text: body.text,
    htmlUrl:
      body.htmlStorageId === null
        ? null
        : await ctx.storage.getUrl(body.htmlStorageId),
    textUrl:
      body.textStorageId === null
        ? null
        : await ctx.storage.getUrl(body.textStorageId),
  };
}

async function buildReceivedBodyResponse(
  ctx: ActionCtx,
  body: Pick<
    BodyFetchTarget,
    "bodyHtml" | "bodyText" | "bodyHtmlStorageId" | "bodyTextStorageId"
  >,
): Promise<ReceivedBody> {
  return {
    html: body.bodyHtml ?? null,
    text: body.bodyText ?? null,
    htmlUrl:
      body.bodyHtmlStorageId === undefined || body.bodyHtmlStorageId === null
        ? null
        : await ctx.storage.getUrl(body.bodyHtmlStorageId),
    textUrl:
      body.bodyTextStorageId === undefined || body.bodyTextStorageId === null
        ? null
        : await ctx.storage.getUrl(body.bodyTextStorageId),
  };
}

async function getStoredReceivedBodyText(
  ctx: ActionCtx,
  target: BodyFetchTarget,
) {
  if (target.bodyText !== undefined && target.bodyText !== null) {
    return target.bodyText;
  }
  if (target.bodyTextStorageId !== undefined && target.bodyTextStorageId !== null) {
    const textBlob = await ctx.storage.get(target.bodyTextStorageId);
    return textBlob === null ? "" : await textBlob.text();
  }
  if (target.bodyHtml !== undefined && target.bodyHtml !== null) {
    return htmlToText(target.bodyHtml);
  }
  if (target.bodyHtmlStorageId !== undefined && target.bodyHtmlStorageId !== null) {
    const htmlBlob = await ctx.storage.get(target.bodyHtmlStorageId);
    return htmlBlob === null ? "" : htmlToText(await htmlBlob.text());
  }

  return "";
}

function encodedSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function buildOpenRouterUserPrompt(prompt: string, originalBody: string) {
  const trimmedBody = originalBody.trim();
  if (trimmedBody.length === 0) {
    return prompt;
  }

  return `${prompt}\n\nOriginal message body:\n${trimmedBody}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
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

async function markReceivedMessageRecipientsDeleted(
  ctx: MutationCtx,
  messageId: Id<"receivedMessages">,
  deletedOn: number,
) {
  const recipients = await ctx.db
    .query("receivedMessageRecipients")
    .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
    .take(100);

  for (const recipient of recipients) {
    await ctx.db.patch("receivedMessageRecipients", recipient._id, {
      deletedOn,
    });
  }
}

async function userCanAccessMessage(
  ctx: QueryCtx,
  addressSet: Set<string>,
  messageId: Id<"receivedMessages">,
) {
  const recipients = await ctx.db
    .query("receivedMessageRecipients")
    .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
    .take(100);

  return recipients.some((recipient) => addressSet.has(recipient.address));
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

async function fetchReceivedAttachmentDownloadFromResend(
  target: AttachmentFetchTarget,
): Promise<ReceivedAttachmentDownload> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey === undefined) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(
      target.emailId,
    )}/attachments`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Resend returned ${response.status} while fetching the attachment.${
        responseBody.length > 0 ? ` ${responseBody}` : ""
      }`,
    );
  }

  const parsed = JSON.parse(responseBody) as
    | Array<{
        id?: string;
        download_url?: string;
        expires_at?: string | null;
        filename?: string;
        content_type?: string;
      }>
    | {
        data?: Array<{
          id?: string;
          download_url?: string;
          expires_at?: string | null;
          filename?: string;
          content_type?: string;
        }>;
      };
  const attachments = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  const attachment = attachments.find(
    (candidate) => candidate.id === target.attachmentId,
  );
  if (attachment === undefined) {
    throw new Error("Resend did not return this attachment.");
  }
  if (attachment.download_url === undefined) {
    throw new Error(
      "Resend did not return a download URL for this attachment.",
    );
  }

  return {
    downloadUrl: attachment.download_url,
    expiresAt: attachment.expires_at ?? null,
    filename: attachment.filename ?? target.filename,
    contentType: attachment.content_type ?? target.contentType,
  };
}
