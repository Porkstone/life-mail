import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

type ResendReceivedEmailEvent = {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    message_id?: string;
    subject?: string;
    attachments?: Array<{
      id?: string;
      filename?: string;
      content_type?: string;
      content_disposition?: string;
      content_id?: string | null;
    }>;
  };
};

const http = httpRouter();

http.route({
  path: "/resend/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const payload = await req.text();
    const webhookId = req.headers.get("svix-id");
    const timestamp = req.headers.get("svix-timestamp");
    const signature = req.headers.get("svix-signature");

    if (webhookId === null || timestamp === null || signature === null) {
      return json({ error: "Missing Resend webhook signature headers" }, 400);
    }

    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (webhookSecret === undefined) {
      return json({ error: "RESEND_WEBHOOK_SECRET is not configured" }, 500);
    }

    const verified = await verifySvixSignature({
      payload,
      webhookId,
      timestamp,
      signature,
      webhookSecret,
    });
    if (!verified) {
      return json({ error: "Invalid webhook signature" }, 400);
    }

    let event: Partial<ResendReceivedEmailEvent>;
    try {
      event = JSON.parse(payload) as Partial<ResendReceivedEmailEvent>;
    } catch {
      return json({ error: "Invalid JSON payload" }, 400);
    }

    if (event.type !== "email.received" || event.data === undefined) {
      return json({ ok: true, ignored: true });
    }
    if (event.data.email_id === undefined || event.data.from === undefined) {
      return json({ error: "Invalid email.received payload" }, 400);
    }

    await ctx.runMutation(internal.emails.storeResendReceivedEmail, {
      webhookId,
      webhookCreatedAt: event.created_at ?? new Date().toISOString(),
      rawEvent: payload,
      data: {
        email_id: event.data.email_id,
        created_at: event.data.created_at ?? new Date().toISOString(),
        from: event.data.from,
        to: event.data.to ?? [],
        cc: event.data.cc ?? [],
        bcc: event.data.bcc ?? [],
        message_id: event.data.message_id ?? "",
        subject: event.data.subject ?? "(no subject)",
        attachments: (event.data.attachments ?? []).map((attachment) => ({
          id: attachment.id ?? "",
          filename: attachment.filename ?? "attachment",
          content_type: attachment.content_type ?? "application/octet-stream",
          content_disposition: attachment.content_disposition ?? "attachment",
          content_id: attachment.content_id ?? null,
        })),
      },
    });

    return json({ ok: true });
  }),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function verifySvixSignature({
  payload,
  webhookId,
  timestamp,
  signature,
  webhookSecret,
}: {
  payload: string;
  webhookId: string;
  timestamp: string;
  signature: string;
  webhookSecret: string;
}) {
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > 5 * 60
  ) {
    return false;
  }

  const secret = webhookSecret.startsWith("whsec_")
    ? webhookSecret.slice("whsec_".length)
    : webhookSecret;
  const keyBytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
  const signedContent = `${webhookId}.${timestamp}.${payload}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(signedContent),
  );
  const expected = base64Encode(new Uint8Array(expectedSignature));

  return signature
    .split(" ")
    .some((entry) => timingSafeEqual(entry.replace(/^v\d+,/, ""), expected));
}

function base64Encode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export default http;
