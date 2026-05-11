import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, FormEvent } from "react";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Archive,
  Ban,
  File,
  Inbox,
  Paperclip,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const PAGE_SIZE = 50;
type Screen = "inbox" | "reply";
type Folder = "inbox" | "archive";

export default function App() {
  return (
    <Routes>
      <Route element={<MailScreen />} path="/" />
      <Route element={<SettingsScreen />} path="/settings" />
    </Routes>
  );
}

function MailScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { results: messages, status } = usePaginatedQuery(
    api.emails.listReceived,
    {},
    { initialNumItems: PAGE_SIZE },
  );
  const [selectedId, setSelectedId] =
    useState<Id<"receivedMessages"> | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [screen, setScreen] = useState<Screen>("inbox");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [blockState, setBlockState] = useState<
    | { status: "idle" }
    | { status: "blocking"; messageId: Id<"receivedMessages"> }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const filteredMessages = useMemo(() => {
    const visibleMessages = messages.filter((message) =>
      folder === "archive" ? message.archived === true : message.archived !== true,
    );
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (normalizedSearch.length === 0) {
      return visibleMessages;
    }

    return visibleMessages.filter((message) =>
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
  }, [folder, messages, searchTerm]);

  const selectedMessageId =
    filteredMessages.some((message) => message._id === selectedId)
      ? selectedId
      : filteredMessages[0]?._id ?? null;
  const selected = useQuery(
    api.emails.getReceived,
    selectedMessageId === null ? "skip" : { messageId: selectedMessageId },
  );
  const fetchReceivedBody = useAction(api.emails.getReceivedBody);
  const blockSenderAndArchive = useMutation(api.emails.blockSenderAndArchive);
  const [selectedBody, setSelectedBody] = useState<MessageBodyState>({
    status: "idle",
  });

  useEffect(() => {
    if (selected === undefined || selected === null) {
      queueMicrotask(() => setSelectedBody({ status: "idle" }));
      return;
    }

    let isCurrentSelection = true;
    queueMicrotask(() => {
      if (isCurrentSelection) {
        setSelectedBody({ status: "loading" });
      }
    });

    fetchReceivedBody({ messageId: selected.message._id })
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

  async function handleBlockSender(messageId: Id<"receivedMessages">) {
    setBlockState({ status: "blocking", messageId });
    try {
      await blockSenderAndArchive({ messageId });
      setSelectedId(null);
      setScreen("inbox");
      setBlockState({ status: "idle" });
    } catch (error: unknown) {
      setBlockState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to block this sender.",
      });
    }
  }

  return (
    <div className={isComposeOpen ? "mail-shell compose-open" : "mail-shell"}>
      <aside className="folder-rail" aria-label="Mail folders">
        <div className="brand-mark">L</div>
        <button
          className={folder === "inbox" ? "rail-button active" : "rail-button"}
          onClick={() => {
            setFolder("inbox");
            setSelectedId(null);
            setScreen("inbox");
          }}
          title="Inbox"
          type="button"
        >
          <Inbox aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
        <button
          className={folder === "archive" ? "rail-button active" : "rail-button"}
          onClick={() => {
            setFolder("archive");
            setSelectedId(null);
            setScreen("inbox");
          }}
          title="Archive"
          type="button"
        >
          <Archive aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
        <button
          aria-label="Open settings"
          className={
            location.pathname === "/settings"
              ? "rail-button settings-rail-button active"
              : "rail-button settings-rail-button"
          }
          onClick={() => {
            void navigate("/settings");
          }}
          title="Settings"
          type="button"
        >
          <Settings aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
      </aside>

      <section className="message-list" aria-label="Received messages">
        <div className="list-header">
          <div>
            <h1>{folder === "archive" ? "Archive" : "Inbox"}</h1>
          </div>
          <div className="list-header-actions">
            <span className="message-count">{filteredMessages.length}</span>
            <button
              aria-label="Compose new message"
              className={
                isComposeOpen
                  ? "icon-action compose-action active"
                  : "icon-action compose-action"
              }
              onClick={() => setIsComposeOpen(true)}
              title="Compose"
              type="button"
            >
              <SquarePen aria-hidden="true" size={18} strokeWidth={2.2} />
            </button>
          </div>
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
                  : folder === "archive"
                    ? "Archived messages and blocked senders will appear here."
                    : "Try another sender, subject, or recipient."
              }
            />
          ) : (
            filteredMessages.map((message) => (
              <div
                className={
                  message._id === selectedMessageId
                    ? "message-row selected"
                    : "message-row"
                }
                key={message._id}
                onClick={() => {
                  setSelectedId(message._id);
                  setScreen("inbox");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedId(message._id);
                    setScreen("inbox");
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className="message-row-top">
                  <span className="message-sender">
                    {displaySender(message.from)}
                  </span>
                  <button
                    aria-label="Block sender and archive message"
                    className="icon-action block-action message-block-action"
                    disabled={
                      blockState.status === "blocking" &&
                      blockState.messageId === message._id
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleBlockSender(message._id);
                    }}
                    title="Block sender and archive"
                    type="button"
                  >
                    <Ban aria-hidden="true" size={15} strokeWidth={2.3} />
                  </button>
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
              </div>
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
          <>
            {screen === "reply" ? (
              <ReplyScreen
                bodyState={selectedBody}
                message={selected.message}
                onBack={() => setScreen("inbox")}
              />
            ) : (
              <MessagePreview
                attachments={selected.attachments}
                blockError={
                  blockState.status === "error" ? blockState.message : null
                }
                bodyState={selectedBody}
                message={selected.message}
                onReply={() => setScreen("reply")}
                replies={selected.replies}
              />
            )}
          </>
        )}
      </main>

      {isComposeOpen ? (
        <ComposePane onClose={() => setIsComposeOpen(false)} />
      ) : null}
    </div>
  );
}

function ComposePane({ onClose }: { onClose: () => void }) {
  const sendMessage = useAction(api.emails.sendMessage);
  const generateAttachmentUploadUrl = useMutation(
    api.emails.generateAttachmentUploadUrl,
  );
  const attachmentInputId = useId();
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [html, setHtml] = useState("");
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sendState, setSendState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "sent" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const recipients = parseRecipients(to);
  const canSend =
    recipients.length > 0 &&
    subject.trim().length > 0 &&
    text.trim().length > 0 &&
    sendState.status !== "sending";

  function resetSendState() {
    if (sendState.status === "sent" || sendState.status === "error") {
      setSendState({ status: "idle" });
    }
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    resetSendState();
    try {
      const encodedAttachments = await Promise.all(
        files.map((file) =>
          uploadReplyAttachment(file, generateAttachmentUploadUrl),
        ),
      );
      setAttachments((current) => [...current, ...encodedAttachments]);
    } catch (error: unknown) {
      setSendState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to add attachment.",
      });
    }
  }

  function removeAttachment(indexToRemove: number) {
    resetSendState();
    setAttachments((current) =>
      current.filter((_, index) => index !== indexToRemove),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    setSendState({ status: "sending" });
    try {
      await sendMessage({
        to: recipients,
        cc: parseRecipients(cc),
        subject: subject.trim(),
        text: text.trim(),
        html: serializeEditorHtml(html),
        attachments: [
          ...attachments.map((attachment) => ({
            filename: attachment.filename,
            storageId: attachment.storageId,
            contentType: attachment.contentType,
          })),
          ...inlineImages.map((image) => ({
            filename: image.filename,
            content: image.content,
            contentType: image.contentType,
            contentId: image.contentId,
          })),
        ] satisfies OutboundAttachment[],
      });
      setSendState({ status: "sent" });
      setTo("");
      setCc("");
      setSubject("");
      setText("");
      setHtml("");
      setInlineImages([]);
      setAttachments([]);
    } catch (error: unknown) {
      setSendState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to send message.",
      });
    }
  }

  return (
    <aside className="compose-pane" aria-label="Compose new message">
      <form
        className="reply-editor compose-editor"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <header className="compose-header">
          <div>
            <p className="eyebrow">Compose</p>
            <h2>New message</h2>
          </div>
          <button
            aria-label="Close compose"
            className="icon-action close-compose-action"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X aria-hidden="true" size={18} strokeWidth={2.2} />
          </button>
        </header>

        <label className="editor-field">
          <span>To</span>
          <input
            autoFocus
            onChange={(event) => {
              setTo(event.target.value);
              resetSendState();
            }}
            placeholder="name@example.com"
            type="text"
            value={to}
          />
        </label>

        <label className="editor-field">
          <span>Cc</span>
          <input
            onChange={(event) => {
              setCc(event.target.value);
              resetSendState();
            }}
            placeholder="Add recipients"
            type="text"
            value={cc}
          />
        </label>

        <label className="editor-field">
          <span>Subject</span>
          <input
            onChange={(event) => {
              setSubject(event.target.value);
              resetSendState();
            }}
            placeholder="Subject"
            type="text"
            value={subject}
          />
        </label>

        <label className="editor-field">
          <span>Message</span>
          <InlineBodyEditor
            html={html}
            onChange={({ html: nextHtml, text: nextText, inlineImages: nextInlineImages }) => {
              setHtml(nextHtml);
              setText(nextText);
              setInlineImages(nextInlineImages);
              resetSendState();
            }}
            placeholder="Write your message"
          />
        </label>

        <section className="reply-attachments" aria-label="Message attachments">
          <div className="attachment-toolbar">
            <label className="ghost-action attachment-picker" htmlFor={attachmentInputId}>
              <Paperclip aria-hidden="true" size={16} strokeWidth={2.2} />
              Attach files
            </label>
            <input
              className="visually-hidden"
              id={attachmentInputId}
              multiple
              onChange={(event) => {
                void handleAttachmentChange(event);
              }}
              type="file"
            />
            {attachments.length > 0 ? (
              <span className="attachment-summary">
                {attachments.length} file{attachments.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>

          {attachments.length > 0 ? (
            <div className="reply-attachment-list">
              {attachments.map((attachment, index) => (
                <div className="reply-attachment-item" key={`${attachment.filename}-${index}`}>
                  <span className="file-icon">
                    <File aria-hidden="true" size={22} strokeWidth={2} />
                  </span>
                  <div>
                    <p>{attachment.filename}</p>
                    <span>{formatFileSize(attachment.size)}</span>
                  </div>
                  <button
                    aria-label={`Remove ${attachment.filename}`}
                    className="remove-attachment"
                    onClick={() => removeAttachment(index)}
                    title="Remove attachment"
                    type="button"
                  >
                    <X aria-hidden="true" size={16} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <div className="editor-actions">
          <button className="primary-action" disabled={!canSend} type="submit">
            {sendState.status === "sending" ? "Sending..." : "Send"}
          </button>
          <button className="ghost-action" onClick={onClose} type="button">
            Cancel
          </button>
        </div>

        {sendState.status === "sent" ? (
          <p className="send-status success">Message sent.</p>
        ) : sendState.status === "error" ? (
          <p className="send-status error">{sendState.message}</p>
        ) : null}
      </form>
    </aside>
  );
}

function SettingsScreen() {
  const navigate = useNavigate();
  const [blockedSenderSearch, setBlockedSenderSearch] = useState("");
  const [removingBlockedSenderId, setRemovingBlockedSenderId] =
    useState<Id<"blockedSenders"> | null>(null);
  const blockedSenders = useQuery(api.emails.listBlockedSenders, {});
  const removeBlockedSender = useMutation(api.emails.removeBlockedSender);
  const visibleBlockedSenders = useMemo(() => {
    if (blockedSenders === undefined) {
      return undefined;
    }

    const normalizedSearch = blockedSenderSearch.trim().toLowerCase();
    if (normalizedSearch.length === 0) {
      return blockedSenders;
    }

    return blockedSenders.filter((sender) =>
      sender.address.includes(normalizedSearch),
    );
  }, [blockedSenderSearch, blockedSenders]);

  async function handleRemoveBlockedSender(
    blockedSenderId: Id<"blockedSenders">,
  ) {
    setRemovingBlockedSenderId(blockedSenderId);
    try {
      await removeBlockedSender({ blockedSenderId });
    } finally {
      setRemovingBlockedSenderId(null);
    }
  }

  return (
    <main className="settings-screen">
      <header className="settings-header">
        <button
          className="ghost-action"
          onClick={() => {
            void navigate("/");
          }}
          type="button"
        >
          Back
        </button>
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Settings</h1>
        </div>
      </header>

      <section className="settings-panel" aria-label="Settings">
        <h2>Settings</h2>
        <p>Settings controls can live here.</p>
      </section>

      <section className="settings-panel" aria-label="Blocked senders">
        <div className="settings-panel-header">
          <div>
            <p className="eyebrow">Mail rules</p>
            <h2>Blocked senders</h2>
          </div>
          <span className="message-count">{blockedSenders?.length ?? 0}</span>
        </div>

        <input
          className="search-box settings-search"
          onChange={(event) => setBlockedSenderSearch(event.target.value)}
          placeholder="Search blocked senders"
          type="search"
          value={blockedSenderSearch}
        />

        <div className="blocked-sender-list">
          {visibleBlockedSenders === undefined ? (
            <EmptyState
              title="Loading blocked senders"
              detail="Waiting for Convex..."
            />
          ) : visibleBlockedSenders.length === 0 ? (
            <EmptyState
              title={
                blockedSenderSearch.trim().length === 0
                  ? "No blocked senders"
                  : "No matching senders"
              }
              detail={
                blockedSenderSearch.trim().length === 0
                  ? "Blocked sender addresses will appear here."
                  : "Try another email address."
              }
            />
          ) : (
            visibleBlockedSenders.map((sender) => (
              <div className="blocked-sender-row" key={sender._id}>
                <span>{sender.address}</span>
                <div className="blocked-sender-actions">
                  <time dateTime={new Date(sender.blockedAt).toISOString()}>
                    {formatDate(sender.blockedAt)}
                  </time>
                  <button
                    aria-label={`Remove ${sender.address} from blocked senders`}
                    className="icon-action remove-blocked-sender-action"
                    disabled={removingBlockedSenderId === sender._id}
                    onClick={() => {
                      void handleRemoveBlockedSender(sender._id);
                    }}
                    title="Remove blocked sender"
                    type="button"
                  >
                    <X aria-hidden="true" size={16} strokeWidth={2.2} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

function MessagePreview({
  attachments,
  blockError,
  bodyState,
  message,
  onReply,
  replies,
}: {
  attachments: Array<{
    _id: Id<"receivedMessageAttachments">;
    filename: string;
    contentType: string;
    contentDisposition: string;
    contentId: string | null;
  }>;
  bodyState: MessageBodyState;
  blockError: string | null;
  message: {
    _id: Id<"receivedMessages">;
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
  onReply: () => void;
  replies: Array<{
    _id: Id<"sentMessages">;
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    sentAt: number;
    resendEmailId: string;
  }>;
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
        <button className="primary-action" onClick={onReply} type="button">
          Reply
        </button>
      </header>

      {blockError !== null ? (
        <section className="notice error">{blockError}</section>
      ) : null}

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

      <RepliesSection replies={replies} />

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
                <span className="file-icon">
                  <File aria-hidden="true" size={22} strokeWidth={2} />
                </span>
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

function RepliesSection({
  replies,
}: {
  replies: Array<{
    _id: Id<"sentMessages">;
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    sentAt: number;
    resendEmailId: string;
  }>;
}) {
  if (replies.length === 0) {
    return null;
  }

  return (
    <section className="replies-section" aria-label="Replies">
      <h3>Replies</h3>
      <div className="reply-list">
        {replies.map((reply) => (
          <article className="reply-card" key={reply._id}>
            <header className="reply-card-header">
              <div className="avatar">{initials(reply.from)}</div>
              <div>
                <p className="from-line">{reply.from}</p>
                <p className="to-line">
                  To {reply.to.length > 0 ? reply.to.join(", ") : "unknown"}
                  {reply.cc.length > 0 ? `, Cc ${reply.cc.join(", ")}` : ""}
                </p>
              </div>
              <time dateTime={new Date(reply.sentAt).toISOString()}>
                {formatDate(reply.sentAt)}
              </time>
            </header>
            <h4>{reply.subject}</h4>
            <pre className="reply-body-text">{reply.text}</pre>
            {reply.resendEmailId.trim().length > 0 ? (
              <p className="reply-id">Email ID {reply.resendEmailId}</p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function ReplyScreen({
  bodyState,
  message,
  onBack,
}: {
  bodyState: MessageBodyState;
  message: {
    _id: Id<"receivedMessages">;
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    receivedAt: number;
    resendMessageId: string;
  };
  onBack: () => void;
}) {
  const sendReply = useAction(api.emails.sendReply);
  const generateAttachmentUploadUrl = useMutation(
    api.emails.generateAttachmentUploadUrl,
  );
  const attachmentInputId = useId();
  const [cc, setCc] = useState("");
  const [text, setText] = useState("");
  const [html, setHtml] = useState("");
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sendState, setSendState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "sent" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const subject = replySubject(message.subject);
  const canSend = text.trim().length > 0 && sendState.status !== "sending";

  function resetSendState() {
    if (sendState.status === "sent" || sendState.status === "error") {
      setSendState({ status: "idle" });
    }
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) {
      return;
    }

    resetSendState();
    try {
      const encodedAttachments = await Promise.all(
        files.map((file) =>
          uploadReplyAttachment(file, generateAttachmentUploadUrl),
        ),
      );
      setAttachments((current) => [...current, ...encodedAttachments]);
    } catch (error: unknown) {
      setSendState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to add attachment.",
      });
    }
  }

  function removeAttachment(indexToRemove: number) {
    resetSendState();
    setAttachments((current) =>
      current.filter((_, index) => index !== indexToRemove),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    setSendState({ status: "sending" });
    try {
      await sendReply({
        originalMessageId: message._id,
        originalResendMessageId: message.resendMessageId,
        to: [message.from],
        cc: parseRecipients(cc),
        subject,
        text: text.trim(),
        html: serializeEditorHtml(html),
        attachments: [
          ...attachments.map((attachment) => ({
            filename: attachment.filename,
            storageId: attachment.storageId,
            contentType: attachment.contentType,
          })),
          ...inlineImages.map((image) => ({
            filename: image.filename,
            content: image.content,
            contentType: image.contentType,
            contentId: image.contentId,
          })),
        ] satisfies OutboundAttachment[],
      });
      setSendState({ status: "sent" });
      setText("");
      setHtml("");
      setInlineImages([]);
      setCc("");
      setAttachments([]);
    } catch (error: unknown) {
      setSendState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to send reply.",
      });
    }
  }

  return (
    <div className="reply-screen">
      <section className="reply-original" aria-label="Original message">
        <header className="reply-original-header">
          <button
            className="ghost-action"
            onClick={() => {
              void onBack();
            }}
            type="button"
          >
            Back
          </button>
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
              To {message.to.length > 0 ? message.to.join(", ") : "unknown"}
            </p>
          </div>
        </section>

        <MessageBody bodyState={bodyState} />
      </section>

      <section className="reply-editor-panel" aria-label="Reply editor">
        <form
          className="reply-editor"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div>
            <p className="eyebrow">Reply</p>
            <h2>{subject}</h2>
          </div>

          <label className="editor-field">
            <span>To</span>
            <input readOnly type="text" value={message.from} />
          </label>

          <label className="editor-field">
            <span>Cc</span>
            <input
              onChange={(event) => {
                setCc(event.target.value);
                resetSendState();
              }}
              placeholder="Add recipients"
              type="text"
              value={cc}
            />
          </label>

          <label className="editor-field">
            <span>Message</span>
            <InlineBodyEditor
              autoFocus
              html={html}
              onChange={({ html: nextHtml, text: nextText, inlineImages: nextInlineImages }) => {
                setHtml(nextHtml);
                setText(nextText);
                setInlineImages(nextInlineImages);
                resetSendState();
              }}
              placeholder="Write your reply"
            />
          </label>

          <section className="reply-attachments" aria-label="Reply attachments">
            <div className="attachment-toolbar">
              <label className="ghost-action attachment-picker" htmlFor={attachmentInputId}>
                <Paperclip aria-hidden="true" size={16} strokeWidth={2.2} />
                Attach files
              </label>
              <input
                className="visually-hidden"
                id={attachmentInputId}
                multiple
                onChange={(event) => {
                  void handleAttachmentChange(event);
                }}
                type="file"
              />
              {attachments.length > 0 ? (
                <span className="attachment-summary">
                  {attachments.length} file{attachments.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>

            {attachments.length > 0 ? (
              <div className="reply-attachment-list">
                {attachments.map((attachment, index) => (
                  <div className="reply-attachment-item" key={`${attachment.filename}-${index}`}>
                    <span className="file-icon">
                      <File aria-hidden="true" size={22} strokeWidth={2} />
                    </span>
                    <div>
                      <p>{attachment.filename}</p>
                      <span>{formatFileSize(attachment.size)}</span>
                    </div>
                    <button
                      aria-label={`Remove ${attachment.filename}`}
                      className="remove-attachment"
                      onClick={() => removeAttachment(index)}
                      title="Remove attachment"
                      type="button"
                    >
                      <X aria-hidden="true" size={16} strokeWidth={2.2} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <div className="editor-actions">
            <button className="primary-action" disabled={!canSend} type="submit">
              {sendState.status === "sending" ? "Sending..." : "Send"}
            </button>
            <button className="ghost-action" onClick={onBack} type="button">
              Cancel
            </button>
          </div>

          {sendState.status === "sent" ? (
            <p className="send-status success">Reply sent.</p>
          ) : sendState.status === "error" ? (
            <p className="send-status error">{sendState.message}</p>
          ) : null}
        </form>
      </section>
    </div>
  );
}

type MessageBodyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; body: { html: string | null; text: string | null } }
  | { status: "error"; message: string };

type ReplyAttachment = {
  filename: string;
  storageId: Id<"_storage">;
  contentType?: string;
  size: number;
};

type InlineImage = {
  filename: string;
  content: string;
  size: number;
  contentId: string;
  contentType: string;
  previewUrl: string;
};

type OutboundAttachment = {
  filename: string;
  content?: string;
  storageId?: Id<"_storage">;
  contentType?: string;
  contentId?: string;
};

type InlineBodyEditorChange = {
  html: string;
  text: string;
  inlineImages: InlineImage[];
};

function InlineBodyEditor({
  autoFocus = false,
  html,
  onChange,
  placeholder,
}: {
  autoFocus?: boolean;
  html: string;
  onChange: (change: InlineBodyEditorChange) => void;
  placeholder: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const inlineImagesRef = useRef<InlineImage[]>([]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || editor.innerHTML === html) {
      return;
    }

    editor.innerHTML = html;
    if (html.trim().length === 0) {
      inlineImagesRef.current = [];
    }
  }, [html]);

  function syncChange() {
    const editor = editorRef.current;
    if (editor === null) {
      return;
    }

    const usedContentIds = new Set(
      Array.from(editor.querySelectorAll("img[data-content-id]"))
        .map((image) => image.getAttribute("data-content-id"))
        .filter((contentId): contentId is string => contentId !== null),
    );
    inlineImagesRef.current = inlineImagesRef.current.filter((image) =>
      usedContentIds.has(image.contentId),
    );

    onChange({
      html: editor.innerHTML,
      text: editor.innerText,
      inlineImages: inlineImagesRef.current,
    });
  }

  async function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();

    const pastedImages = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    const text = event.clipboardData.getData("text/plain");
    if (text.length > 0) {
      insertHtmlAtSelection(escapeHtml(text).replace(/\r?\n/g, "<br>"));
    }

    for (const file of pastedImages) {
      const image = await readInlineImage(file);
      inlineImagesRef.current = [...inlineImagesRef.current, image];
      insertHtmlAtSelection(
        `<img alt="${escapeHtml(file.name)}" data-content-id="${image.contentId}" src="${image.previewUrl}">`,
      );
    }

    syncChange();
  }

  return (
    <div
      aria-label={placeholder}
      className="inline-body-editor"
      contentEditable
      data-placeholder={placeholder}
      onBlur={syncChange}
      onInput={syncChange}
      onPaste={(event) => {
        void handlePaste(event);
      }}
      ref={editorRef}
      role="textbox"
      spellCheck
      suppressContentEditableWarning
      tabIndex={0}
      {...(autoFocus ? { autoFocus: true } : {})}
    />
  );
}

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

function replySubject(subject: string) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function parseRecipients(value: string) {
  return value
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

async function uploadReplyAttachment(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<ReplyAttachment> {
  const uploadUrl = await generateUploadUrl();
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Unable to upload ${file.name}.`);
  }

  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  return {
    filename: file.name,
    storageId,
    contentType: file.type || undefined,
    size: file.size,
  };
}

async function readReplyAttachmentContent(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error(`Unable to read ${file.name}.`));
      }
    });
    reader.addEventListener("error", () => {
      reject(new Error(`Unable to read ${file.name}.`));
    });
    reader.readAsDataURL(file);
  });

  return dataUrl.split(",")[1] ?? "";
}

async function readInlineImage(file: File): Promise<InlineImage> {
  const content = await readReplyAttachmentContent(file);
  const extension = file.name.split(".").pop()?.toLowerCase() || "png";

  return {
    filename: file.name,
    content,
    size: file.size,
    contentId: `inline-${crypto.randomUUID().replace(/-/g, "")}`,
    contentType: file.type || `image/${extension}`,
    previewUrl: `data:${file.type || "image/png"};base64,${content}`,
  };
}

function insertHtmlAtSelection(html: string) {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = range.createContextualFragment(html);
  const lastChild = fragment.lastChild;
  range.insertNode(fragment);
  if (lastChild !== null) {
    range.setStartAfter(lastChild);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function serializeEditorHtml(html: string) {
  if (html.trim().length === 0) {
    return "";
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(`<div>${html}</div>`, "text/html");
  for (const image of Array.from(document.querySelectorAll("img[data-content-id]"))) {
    const contentId = image.getAttribute("data-content-id");
    if (contentId === null || contentId.trim().length === 0) {
      image.remove();
      continue;
    }

    image.setAttribute("src", `cid:${contentId}`);
    image.removeAttribute("data-content-id");
  }

  return document.body.firstElementChild?.innerHTML ?? "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  const kilobytes = size / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}
