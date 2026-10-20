/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const user = t.withIdentity({
    subject: "mail-user",
    email: "user@example.com",
  });
  const currentUser = await user.mutation(api.auth.ensureCurrentUser, {});
  if (currentUser === null) throw new Error("Test user was not created");
  await t.run(async (ctx) => {
    await ctx.db.insert("userEmailAddresses", {
      userId: currentUser._id,
      address: "inbox@avlec.co",
      createdAt: Date.now(),
    });
  });
  return { t, user };
}

async function receive(
  t: Awaited<ReturnType<typeof setup>>["t"],
  from = "Sender <SENDER@example.com>",
) {
  const id = crypto.randomUUID();
  return await t.mutation(internal.emails.storeResendReceivedEmail, {
    webhookId: id,
    webhookCreatedAt: new Date().toISOString(),
    rawEvent: "{}",
    data: {
      email_id: id,
      created_at: new Date().toISOString(),
      from,
      to: ["inbox@avlec.co"],
      cc: [],
      bcc: [],
      message_id: id,
      subject: "Test message",
      attachments: [],
    },
  });
}

describe("sender whitelist", () => {
  test("normalizes addresses, removes an existing block and prevents duplicates", async () => {
    const { t, user } = await setup();
    const messageId = await receive(t);
    await user.mutation(api.emails.blockSenderAndDelete, { messageId });
    const id = await user.mutation(api.emails.addWhitelistedSender, {
      address: " Sender <SENDER@Example.com> ",
    });
    expect(
      await user.mutation(api.emails.addWhitelistedSender, {
        address: "sender@example.com",
      }),
    ).toBe(id);
    expect(await user.query(api.emails.listBlockedSenders, {})).toEqual([]);
    const result = await user.query(api.emails.listWhitelistedSenders, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(result.page).toMatchObject([{ address: "sender@example.com" }]);
    expect(result.isDone).toBe(true);
  });

  test("rejects blocking through either API without deleting or changing the message", async () => {
    const { t, user } = await setup();
    const messageId = await receive(t);
    await user.mutation(api.emails.keepReceived, { messageId });
    await user.mutation(api.emails.addWhitelistedSender, {
      address: "sender@example.com",
    });
    for (const mutation of [
      api.emails.blockSenderAndDelete,
      api.emails.blockSenderAndArchive,
    ]) {
      await expect(user.mutation(mutation, { messageId })).rejects.toThrow(
        "Whitelisted senders cannot be blocked",
      );
    }
    const message = await t.run((ctx) =>
      ctx.db.get("receivedMessages", messageId),
    );
    expect(message?.deletedOn).toBeUndefined();
    expect(message?.kept).toBe(true);
    expect(await user.query(api.emails.listBlockedSenders, {})).toEqual([]);
    const recipients = await t.run((ctx) =>
      ctx.db.query("receivedMessageRecipients").collect(),
    );
    expect(recipients[0].deletedOn).toBeUndefined();
  });

  test("whitelist wins over a stale block during incoming delivery", async () => {
    const { t, user } = await setup();
    await user.mutation(api.emails.addWhitelistedSender, {
      address: "sender@example.com",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("blockedSenders", {
        address: "sender@example.com",
        blockedAt: Date.now(),
      });
      await ctx.db.insert("blockedSenders", {
        address: "blocked@example.com",
        blockedAt: Date.now(),
      });
    });
    const protectedId = await receive(t);
    const blockedId = await receive(t, "Blocked <BLOCKED@example.com>");
    const [protectedMessage, blockedMessage] = await t.run(async (ctx) => [
      await ctx.db.get("receivedMessages", protectedId),
      await ctx.db.get("receivedMessages", blockedId),
    ]);
    expect(protectedMessage?.deletedOn).toBeUndefined();
    expect(blockedMessage?.deletedOn).toEqual(expect.any(Number));
    const inbox = await user.query(api.emails.listReceived, {});
    expect(inbox).toMatchObject([{ _id: protectedId, isWhitelisted: true }]);
  });

  test("reports whitelist status in inbox, keep and deleted folders", async () => {
    const { t, user } = await setup();
    const messageId = await receive(t);
    await user.mutation(api.emails.addWhitelistedSender, {
      address: "sender@example.com",
    });
    expect(await user.query(api.emails.listReceived, {})).toMatchObject([
      { isWhitelisted: true },
    ]);
    await user.mutation(api.emails.keepReceived, { messageId });
    expect(await user.query(api.emails.listKeptReceived, {})).toMatchObject([
      { isWhitelisted: true },
    ]);
    // Whitelisting protects against blocking; manually deleting mail is still allowed.
    await user.mutation(api.emails.deleteReceived, { messageId });
    expect(await user.query(api.emails.listDeletedReceived, {})).toMatchObject([
      { isWhitelisted: true },
    ]);
  });

  test("removing protection allows blocking again", async () => {
    const { t, user } = await setup();
    const messageId = await receive(t);
    const whitelistedSenderId = await user.mutation(
      api.emails.addWhitelistedSender,
      { address: "sender@example.com" },
    );
    await user.mutation(api.emails.removeWhitelistedSender, {
      whitelistedSenderId,
    });
    expect(await user.query(api.emails.listReceived, {})).toMatchObject([
      { isWhitelisted: false },
    ]);
    await user.mutation(api.emails.blockSenderAndDelete, { messageId });
    expect(await user.query(api.emails.listBlockedSenders, {})).toMatchObject([
      { address: "sender@example.com" },
    ]);
  });

  test("requires authentication and rejects invalid addresses", async () => {
    const { t, user } = await setup();
    await expect(
      t.mutation(api.emails.addWhitelistedSender, {
        address: "sender@example.com",
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      t.query(api.emails.listWhitelistedSenders, {
        paginationOpts: { numItems: 50, cursor: null },
      }),
    ).rejects.toThrow("Not authenticated");
    const whitelistedSenderId = await user.mutation(
      api.emails.addWhitelistedSender,
      { address: "sender@example.com" },
    );
    await expect(
      t.mutation(api.emails.removeWhitelistedSender, { whitelistedSenderId }),
    ).rejects.toThrow("Not authenticated");
    for (const address of ["", "invalid", "a@", "a@b.com,other@example.com"]) {
      await expect(
        user.mutation(api.emails.addWhitelistedSender, { address }),
      ).rejects.toThrow("valid email address");
    }
  });

  test("enforces message ownership even when the sender is whitelisted", async () => {
    const { t, user } = await setup();
    const messageId = await receive(t, "stranger@example.com");
    await user.mutation(api.emails.addWhitelistedSender, {
      address: "stranger@example.com",
    });
    const otherUser = t.withIdentity({
      subject: "other-user",
      email: "other@example.com",
    });
    await otherUser.mutation(api.auth.ensureCurrentUser, {});
    await expect(
      otherUser.mutation(api.emails.blockSenderAndDelete, { messageId }),
    ).rejects.toThrow();
    expect(
      (await t.run((ctx) => ctx.db.get("receivedMessages", messageId)))
        ?.deletedOn,
    ).toBeUndefined();
  });
});
