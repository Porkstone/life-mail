import { useEffect, useMemo, useState } from "react";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const PAGE_SIZE = 50;

export default function App() {
  const { results: messages, status } = usePaginatedQuery(
    api.emails.listReceived,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const [selectedId, setSelectedId] =
    useState<Id<"receivedMessages"> | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const filteredMessages = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (normalizedSearch.length === 0) {
      return messages;
    }

    return messages.filter((message) =>
      [
        message.from,
        message.subject,
        message.to.join(" "),
        message.cc.join(" "),
        message.resendEmailId,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [messages, searchTerm]);

  const selectedMessageId = selectedId ?? filteredMessages[0]?._id ?? null;
  const selected = useQuery(
    api.emails.getReceived,
    selectedMessageId === null ? "skip" : { messageId: selectedMessageId },
  );
  const fetchReceivedBody = useAction(api.emails.getReceivedBody);
  const [selectedBody, setSelectedBody] = useState<MessageBodyState>({
    status: "idle",
  });

  useEffect(() => {
    if (selected === undefined || selected === null) {
      setSelectedBody({ status: "idle" });
      return;
    }

    let isCurrentSelection = true;
    setSelectedBody({ status: "loading" });

    fetchReceivedBody({ resendEmailId: selected.message.resendEmailId })
      .then((body) => {
        if (isCurrentSelection) {
          setSelectedBody({ status: "ready", body });
        }
      })
      .catch((error: unknown) => {
        if (isCurrentSelection) {
          setSelectedBody({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to fetch the message body.",
          });
        }
      });

    return () => {
      isCurrentSelection = false;
    };
  }, [fetchReceivedBody, selected]);

  return (
    <div className="mail-shell">
      <aside className="folder-rail" aria-label="Mail folders">
        <div className="brand-mark">L</div>
        <button className="rail-button active" title="Inbox" type="button">
          IN
        </button>
        <button className="rail-button" title="Archive" type="button">
          AR
        </button>
      </aside>

      <section className="message-list" aria-label="Received messages">
        <div className="list-header">
          <div>
            <p className="eyebrow">Resend</p>
            <h1>Inbox</h1>
          </div>
          <span className="message-count">{filteredMessages.length}</span>
        </div>

        <input
          className="search-box"
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search mail"
          type="search"
          value={searchTerm}
        />

        <div className="messages">
          {status === "LoadingFirstPage" ? (
            <EmptyState title="Loading inbox" detail="Waiting for Convex..." />
          ) : filteredMessages.length === 0 ? (
            <EmptyState
              title={messages.length === 0 ? "No received mail yet" : "No matches"}
              detail={
                messages.length === 0
                  ? "Point a Resend email.received webhook at /resend/webhook."
                  : "Try another sender, subject, or recipient."
              }
            />
          ) : (
            filteredMessages.map((message) => (
              <button
                className={
                  message._id === selectedMessageId
                    ? "message-row selected"
                    : "message-row"
                }
                key={message._id}
                onClick={() => setSelectedId(message._id)}
                type="button"
              >
                <span className="message-sender">
                  {displaySender(message.from)}
                </span>
                <span className="message-subject">{message.subject}</span>
                <span className="message-meta">
                  {formatDate(message.receivedAt)}
                  {message.attachmentCount > 0
                    ? ` · ${message.attachmentCount} attachment${
                        message.attachmentCount === 1 ? "" : "s"
                      }`
                    : ""}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <main className="preview-pane" aria-label="Message preview">
        {selectedMessageId === null ? (
          <EmptyPreview />
        ) : selected === undefined ? (
          <EmptyPreview title="Loading message" />
        ) : selected === null ? (
          <EmptyPreview title="Message not found" />
        ) : (
          <MessagePreview
            attachments={selected.attachments}
            bodyState={selectedBody}
            message={selected.message}
          />
        )}
      </main>
    </div>
  );
}

function MessagePreview({
  attachments,
  bodyState,
  message,
}: {
  attachments: Array<{
    _id: Id<"receivedMessageAttachments">;
    filename: string;
    contentType: string;
    contentDisposition: string;
    contentId: string | null;
  }>;
  bodyState: MessageBodyState;
  message: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    receivedAt: number;
    emailCreatedAt: string;
    resendEmailId: string;
    resendMessageId: string;
  };
}) {
  const recipients = useMemo(
    () => [message.to.join(", "), message.cc.join(", ")].filter(Boolean),
    [message.cc, message.to],
  );

  return (
    <article className="message-preview">
      <header className="preview-header">
        <div>
          <p className="eyebrow">{formatDate(message.receivedAt)}</p>
          <h2>{message.subject}</h2>
        </div>
      </header>

      <section className="sender-block">
        <div className="avatar">{initials(message.from)}</div>
        <div>
          <p className="from-line">{message.from}</p>
          <p className="to-line">
            To {recipients.length > 0 ? recipients.join(", ") : "unknown"}
          </p>
        </div>
      </section>

      <MessageBody bodyState={bodyState} />

      <dl className="metadata-grid">
        <div>
          <dt>Email ID</dt>
          <dd>{message.resendEmailId}</dd>
        </div>
        <div>
          <dt>Message ID</dt>
          <dd>{message.resendMessageId || "Unavailable"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{message.emailCreatedAt}</dd>
        </div>
      </dl>

      {attachments.length > 0 ? (
        <section className="attachment-section">
          <h3>Attachments</h3>
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment-item" key={attachment._id}>
                <span className="file-icon">FILE</span>
                <div>
                  <p>{attachment.filename}</p>
                  <span>
                    {attachment.contentType} · {attachment.contentDisposition}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

type MessageBodyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; body: { html: string | null; text: string | null } }
  | { status: "error"; message: string };

function MessageBody({ bodyState }: { bodyState: MessageBodyState }) {
  if (bodyState.status === "idle" || bodyState.status === "loading") {
    return (
      <section className="body-loading">
        {bodyState.status === "loading" ? "Loading message body..." : ""}
      </section>
    );
  }

  if (bodyState.status === "error") {
    return <section className="notice">{bodyState.message}</section>;
  }

  if (bodyState.body.html !== null && bodyState.body.html.trim().length > 0) {
    return (
      <iframe
        className="message-body-frame"
        sandbox=""
        srcDoc={bodyState.body.html}
        title="Message body"
      />
    );
  }

  if (bodyState.body.text !== null && bodyState.body.text.trim().length > 0) {
    return <pre className="message-body-text">{bodyState.body.text}</pre>;
  }

  return <section className="notice">This message does not include a body.</section>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-list">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function EmptyPreview({ title = "Select a message" }: { title?: string }) {
  return (
    <div className="empty-preview">
      <h2>{title}</h2>
    </div>
  );
}

function displaySender(from: string) {
  return from.replace(/\s*<.*?>\s*/g, "").trim() || from;
}

function initials(from: string) {
  const sender = displaySender(from);
  return sender
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
