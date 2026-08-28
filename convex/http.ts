import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { allowedAppOrigins } from "./authShared";
import {
  generateRefreshToken,
  hashRefreshToken,
  mintSessionToken,
  publicJwks,
  verifyShooToken,
} from "./authTokens";

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

type ResendBouncedEmailEvent = {
  type: "email.bounced";
  created_at: string;
  data: {
    email_id: string;
    created_at?: string;
    from: string;
    to?: string[];
    subject?: string;
    bounce?: {
      diagnosticCode?: string[];
      message?: string;
      subType?: string;
      type?: string;
    };
  };
};

type ResendWebhookEvent =
  | ResendReceivedEmailEvent
  | ResendBouncedEmailEvent;

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

    let event: Partial<ResendWebhookEvent>;
    try {
      event = JSON.parse(payload) as Partial<ResendWebhookEvent>;
    } catch {
      return json({ error: "Invalid JSON payload" }, 400);
    }

    if (event.type === "email.bounced" && event.data !== undefined) {
      if (event.data.email_id === undefined || event.data.from === undefined) {
        return json({ error: "Invalid email.bounced payload" }, 400);
      }

      const occurredAt =
        Date.parse(event.created_at ?? event.data.created_at ?? "") || Date.now();
      await ctx.runMutation(internal.emailNotifications.storeResendBounce, {
        webhookId,
        resendEmailId: event.data.email_id,
        from: event.data.from,
        recipients: event.data.to ?? [],
        subject: event.data.subject ?? "(no subject)",
        reason:
          event.data.bounce?.message ??
          "The recipient's mail server rejected this email.",
        bounceType: event.data.bounce?.type ?? "Unknown",
        bounceSubtype: event.data.bounce?.subType ?? "Unknown",
        diagnosticCodes: event.data.bounce?.diagnosticCode ?? [],
        occurredAt,
      });

      return json({ ok: true });
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

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin === null || !allowedAppOrigins().includes(origin)) return {};

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function corsJson(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

const authPreflight = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
});

async function readJsonBody(req: Request) {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify(publicJwks()), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=600",
      },
    });
  }),
});

for (const path of ["/auth/session", "/auth/refresh", "/auth/signout"]) {
  http.route({ path, method: "OPTIONS", handler: authPreflight });
}

http.route({
  path: "/auth/session",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJsonBody(req);
    const idToken = body?.idToken;
    if (typeof idToken !== "string") {
      return corsJson(req, { error: "Missing idToken" }, 400);
    }

    let claims;
    try {
      claims = await verifyShooToken(idToken);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Token verification failed";
      return corsJson(req, { error: message }, 401);
    }

    const refreshToken = generateRefreshToken();
    await ctx.runMutation(internal.authSessions.create, {
      refreshTokenHash: await hashRefreshToken(refreshToken),
      subject: claims.subject,
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      ...(claims.emailVerified !== undefined
        ? { emailVerified: claims.emailVerified }
        : {}),
      ...(claims.name !== undefined ? { name: claims.name } : {}),
    });

    const minted = await mintSessionToken(claims);
    return corsJson(req, {
      accessToken: minted.token,
      expiresInSeconds: minted.expiresInSeconds,
      refreshToken,
    });
  }),
});

http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJsonBody(req);
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken !== "string") {
      return corsJson(req, { error: "Missing refreshToken" }, 400);
    }

    const claims = await ctx.runMutation(internal.authSessions.refresh, {
      refreshTokenHash: await hashRefreshToken(refreshToken),
    });
    if (claims === null) {
      return corsJson(req, { error: "Session expired" }, 401);
    }

    const minted = await mintSessionToken(claims);
    return corsJson(req, {
      accessToken: minted.token,
      expiresInSeconds: minted.expiresInSeconds,
    });
  }),
});

http.route({
  path: "/auth/signout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJsonBody(req);
    const refreshToken = body?.refreshToken;
    if (typeof refreshToken === "string") {
      await ctx.runMutation(internal.authSessions.remove, {
        refreshTokenHash: await hashRefreshToken(refreshToken),
      });
    }

    return corsJson(req, { ok: true });
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
