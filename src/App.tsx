import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, FormEvent, ReactNode } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  Archive,
  Ban,
  Download,
  Eye,
  File,
  Inbox,
  LogIn,
  LogOut,
  Paperclip,
  Save,
  Settings,
  Shield,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { needsManualSignIn, signIn, signOut } from "./shoo";

const PAGE_SIZE = 50;
const COMPOSE_DRAFT_KEY = "life-mail:compose-draft";
type Screen = "inbox" | "reply";
type Folder = "inbox" | "archive" | "keep" | "deleted";
type SenderAddress = {
  _id: Id<"userEmailAddresses">;
  address: string;
  createdAt: number;
};

export default function App() {
  const convexAuth = useConvexAuth();
  const ensureCurrentUser = useMutation(api.auth.ensureCurrentUser);
  const viewer = useQuery(
    api.auth.viewer,
    convexAuth.isAuthenticated ? {} : "skip",
  );

  useEffect(() => {
    if (!convexAuth.isAuthenticated) {
      return;
    }

    void ensureCurrentUser({});
  }, [convexAuth.isAuthenticated, ensureCurrentUser]);

  if (convexAuth.isLoading) {
    return <AuthShell title="Loading" detail="Checking your session..." />;
  }

  if (!convexAuth.isAuthenticated) {
    if (!needsManualSignIn()) {
      return (
        <AuthShell
          title="Life Mail"
          detail="Refreshing your session..."
        />
      );
    }

    return (
      <AuthShell
        title="Life Mail"
        detail="Sign in with Google to open your mailbox."
        action={
          <button
            className="primary-action auth-action"
            onClick={() => {
              void signIn();
            }}
            type="button"
          >
            <LogIn aria-hidden="true" size={18} strokeWidth={2.2} />
            Sign in
          </button>
        }
      />
    );
  }

  if (viewer === undefined || viewer?.user === null) {
    return <AuthShell title="Loading" detail="Preparing your mailbox..." />;
  }

  return (
    <Routes>
      <Route element={<MailScreen />} path="/" />
      <Route element={<SettingsScreen />} path="/settings" />
      <Route element={<AdminScreen />} path="/admin" />
    </Routes>
  );
}

function MailScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [folder, setFolder] = useState<Folder>("inbox");
  const messages = useQuery(api.emails.listReceived, { limit: PAGE_SIZE });
  const deletedMessages = useQuery(
    api.emails.listDeletedReceived,
    folder === "deleted" ? { limit: PAGE_SIZE } : "skip",
  );
  const viewer = useQuery(api.auth.viewer, {});
  const [selectedId, setSelectedId] = useState<Id<"receivedMessages"> | null>(
    null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [screen, setScreen] = useState<Screen>("inbox");
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [blockState, setBlockState] = useState<
    | { status: "idle" }
    | { status: "blocking"; messageId: Id<"receivedMessages"> }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [archiveState, setArchiveState] = useState<
    | { status: "idle" }
    | { status: "archiving"; messageId: Id<"receivedMessages"> }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [keepState, setKeepState] = useState<
    | { status: "idle" }
    | { status: "keeping"; messageId: Id<"receivedMessages"> }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const filteredMessages = useMemo(() => {
    const activeMessages = folder === "deleted" ? deletedMessages : messages;
    if (activeMessages === undefined) {
      return [];
    }

    const visibleMessages = activeMessages.filter((message) => {
      if (folder === "deleted") {
        return true;
      }
      if (folder === "archive") {
        return message.archived === true;
      }
      if (folder === "keep") {
        return message.kept === true;
      }
      return message.archived !== true && message.kept !== true;
    });
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
  }, [deletedMessages, folder, messages, searchTerm]);

  const selectedMessageId = filteredMessages.some(
    (message) => message._id === selectedId,
  )
    ? selectedId
    : (filteredMessages[0]?._id ?? null);
  const selected = useQuery(
    api.emails.getReceived,
    selectedMessageId === null ? "skip" : { messageId: selectedMessageId },
  );
  const fetchReceivedBody = useAction(api.emails.getReceivedBody);
  const blockSenderAndArchive = useMutation(api.emails.blockSenderAndArchive);
  const archiveReceived = useMutation(api.emails.archiveReceived);
  const keepReceived = useMutation(api.emails.keepReceived);
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

  async function handleArchiveMessage(messageId: Id<"receivedMessages">) {
    setArchiveState({ status: "archiving", messageId });
    try {
      await archiveReceived({ messageId });
      setSelectedId(null);
      setScreen("inbox");
      setArchiveState({ status: "idle" });
    } catch (error: unknown) {
      setArchiveState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to archive this message.",
      });
    }
  }

  async function handleKeepMessage(messageId: Id<"receivedMessages">) {
    setKeepState({ status: "keeping", messageId });
    try {
      await keepReceived({ messageId });
      setSelectedId(null);
      setScreen("inbox");
      setKeepState({ status: "idle" });
    } catch (error: unknown) {
      setKeepState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to keep this message.",
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
          className={
            folder === "archive" ? "rail-button active" : "rail-button"
          }
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
          className={folder === "keep" ? "rail-button active" : "rail-button"}
          onClick={() => {
            setFolder("keep");
            setSelectedId(null);
            setScreen("inbox");
          }}
          title="Keep"
          type="button"
        >
          <Save aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
        <button
          className={
            folder === "deleted" ? "rail-button active" : "rail-button"
          }
          onClick={() => {
            setFolder("deleted");
            setSelectedId(null);
            setScreen("inbox");
          }}
          title="Deleted"
          type="button"
        >
          <Trash2 aria-hidden="true" size={20} strokeWidth={2.2} />
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
        {viewer?.isAdmin === true ? (
          <button
            aria-label="Open admin"
            className={
              location.pathname === "/admin"
                ? "rail-button active"
                : "rail-button"
            }
            onClick={() => {
              void navigate("/admin");
            }}
            title="Admin"
            type="button"
          >
            <Shield aria-hidden="true" size={20} strokeWidth={2.2} />
          </button>
        ) : null}
        <button
          aria-label="Sign out"
          className="rail-button"
          onClick={signOut}
          title="Sign out"
          type="button"
        >
          <LogOut aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
      </aside>

      <section className="message-list" aria-label="Received messages">
        <div className="list-header">
          <div>
            <h1>
              {folder === "archive"
                ? "Archive"
                : folder === "keep"
                  ? "Keep"
                  : folder === "deleted"
                    ? "Deleted"
                  : "Inbox"}
            </h1>
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
          {(folder === "deleted" ? deletedMessages : messages) ===
          undefined ? (
            <EmptyState title="Loading inbox" detail="Waiting for Convex..." />
          ) : filteredMessages.length === 0 ? (
            <EmptyState
              title={
                (folder === "deleted" ? deletedMessages : messages)?.length ===
                0
                  ? folder === "deleted"
                    ? "No deleted mail"
                    : "No received mail yet"
                  : "No matches"
              }
              detail={
                (folder === "deleted" ? deletedMessages : messages)?.length ===
                0
                  ? folder === "deleted"
                    ? "Messages deleted by retention cleanup will appear here."
                    : "Ask an administrator to link your avlec.co inbound address."
                    : folder === "archive"
                      ? "Archived messages and blocked senders will appear here."
                      : folder === "keep"
                        ? "Saved messages will appear here."
                        : folder === "deleted"
                          ? "Messages deleted by retention cleanup will appear here."
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
                  <span className="message-row-actions">
                    <button
                      aria-label="Archive message"
                      className="icon-action message-row-action message-archive-action"
                      disabled={
                        folder === "deleted" ||
                        message.archived === true ||
                        (archiveState.status === "archiving" &&
                          archiveState.messageId === message._id)
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleArchiveMessage(message._id);
                      }}
                      title="Archive message"
                      type="button"
                    >
                      <Archive aria-hidden="true" size={15} strokeWidth={2.3} />
                    </button>
                    <button
                      aria-label="Block sender and archive message"
                      className="icon-action block-action message-row-action message-block-action"
                      disabled={
                        folder === "deleted" ||
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
                    <button
                      aria-label="Move message to Keep"
                      className="icon-action message-row-action message-keep-action"
                      disabled={
                        folder === "deleted" ||
                        message.kept === true ||
                        (keepState.status === "keeping" &&
                          keepState.messageId === message._id)
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleKeepMessage(message._id);
                      }}
                      title="Keep message"
                      type="button"
                    >
                      <Save aria-hidden="true" size={15} strokeWidth={2.3} />
                    </button>
                  </span>
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
                key={selected.message._id}
                message={selected.message}
                onBack={() => setScreen("inbox")}
                senderAddresses={getSortedSenderAddresses(viewer?.addresses)}
              />
            ) : (
              <MessagePreview
                attachments={selected.attachments}
                blockError={
                  archiveState.status === "error"
                    ? archiveState.message
                    : keepState.status === "error"
                      ? keepState.message
                      : blockState.status === "error"
                        ? blockState.message
                        : null
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
        <ComposePane
          onClose={() => setIsComposeOpen(false)}
          senderAddresses={getSortedSenderAddresses(viewer?.addresses)}
        />
      ) : null}
    </div>
  );
}

function AuthShell({
  action,
  detail,
  title,
}: {
  action?: ReactNode;
  detail: string;
  title: string;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-label="Authentication">
        <div className="brand-mark auth-brand">L</div>
        <h1>{title}</h1>
        <p>{detail}</p>
        {action}
      </section>
    </main>
  );
}

function AdminScreen() {
  const navigate = useNavigate();
  const viewer = useQuery(api.auth.viewer, {});
  const users = useQuery(
    api.auth.listUsers,
    viewer?.isAdmin === true ? {} : "skip",
  );
  const openRouterSettings = useQuery(
    api.emails.getOpenRouterSettings,
    viewer?.isAdmin === true ? {} : "skip",
  );
  const assignAddress = useMutation(api.auth.assignAddress);
  const removeAddress = useMutation(api.auth.removeAddress);
  const updateOpenRouterSettings = useMutation(
    api.emails.updateOpenRouterSettings,
  );
  const backfillRecipients = useMutation(
    api.emails.backfillReceivedMessageRecipients,
  );
  const backfillSenderIndex = useMutation(
    api.emails.backfillReceivedMessageSenderIndex,
  );
  const [selectedUserId, setSelectedUserId] = useState<Id<"users"> | "">("");
  const [addressLocalPart, setAddressLocalPart] = useState("");
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [openRouterSystemPrompt, setOpenRouterSystemPrompt] = useState("");
  const [openRouterSystemPromptDirty, setOpenRouterSystemPromptDirty] =
    useState(false);
  const [adminState, setAdminState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "indexing" }
    | { status: "indexed"; count: number }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [openRouterState, setOpenRouterState] = useState<
    | { status: "idle" }
    | { status: "saving" }
    | { status: "saved" }
    | { status: "error"; message: string }
  >({ status: "idle" });

  if (viewer === undefined) {
    return (
      <AuthShell title="Loading" detail="Checking administrator access..." />
    );
  }

  if (viewer === null || viewer.isAdmin !== true) {
    return (
      <AuthShell
        title="Unauthorized"
        detail="Administrator access is required."
      />
    );
  }

  async function handleAssignAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedUserId === "" || addressLocalPart.trim().length === 0) {
      return;
    }

    setAdminState({ status: "saving" });
    try {
      await assignAddress({
        userId: selectedUserId,
        address: `${addressLocalPart.trim()}@avlec.co`,
      });
      setAddressLocalPart("");
      setAdminState({ status: "idle" });
    } catch (error: unknown) {
      setAdminState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to assign that inbound address.",
      });
    }
  }

  async function handleBackfillRecipients() {
    setAdminState({ status: "indexing" });
    try {
      const recipientResult = await backfillRecipients({});
      let senderIndexed = 0;
      let beforeReceivedAt: number | undefined;
      for (;;) {
        const senderResult = await backfillSenderIndex({ beforeReceivedAt });
        senderIndexed += senderResult.indexed;
        if (!senderResult.hasMore || senderResult.nextBeforeReceivedAt === null) {
          break;
        }
        beforeReceivedAt = senderResult.nextBeforeReceivedAt;
      }
      setAdminState({
        status: "indexed",
        count: recipientResult.indexed + senderIndexed,
      });
    } catch (error: unknown) {
      setAdminState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to index existing received mail.",
      });
    }
  }

  async function handleOpenRouterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOpenRouterState({ status: "saving" });
    try {
      await updateOpenRouterSettings({
        apiKey:
          openRouterApiKey.trim().length > 0
            ? openRouterApiKey.trim()
            : undefined,
        systemPrompt: openRouterSystemPrompt,
      });
      setOpenRouterApiKey("");
      setOpenRouterSystemPromptDirty(false);
      setOpenRouterState({ status: "saved" });
    } catch (error: unknown) {
      setOpenRouterState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to save OpenRouter settings.",
      });
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
          <p className="eyebrow">Admin</p>
          <h1>Inbound addresses</h1>
        </div>
      </header>

      <section className="settings-panel" aria-label="Assign inbound address">
        <div className="settings-panel-header">
          <div>
            <p className="eyebrow">avlec.co</p>
            <h2>Link address</h2>
          </div>
        </div>

        <form
          className="admin-address-form"
          onSubmit={(event) => void handleAssignAddress(event)}
        >
          <label className="editor-field">
            <span>User</span>
            <select
              onChange={(event) =>
                setSelectedUserId(event.target.value as Id<"users"> | "")
              }
              value={selectedUserId}
            >
              <option value="">Select a user</option>
              {(users ?? []).map(({ user }) => (
                <option key={user._id} value={user._id}>
                  {user.name ?? user.email ?? user.tokenIdentifier ?? user._id}
                </option>
              ))}
            </select>
          </label>

          <label className="editor-field">
            <span>Inbound address</span>
            <div className="domain-input">
              <input
                onChange={(event) => setAddressLocalPart(event.target.value)}
                placeholder="name"
                type="text"
                value={addressLocalPart}
              />
              <span>@avlec.co</span>
            </div>
          </label>

          <button
            className="primary-action"
            disabled={
              selectedUserId === "" ||
              addressLocalPart.trim().length === 0 ||
              adminState.status === "saving"
            }
            type="submit"
          >
            {adminState.status === "saving" ? "Linking..." : "Link address"}
          </button>
        </form>

        {adminState.status === "error" ? (
          <p className="send-status error">{adminState.message}</p>
        ) : adminState.status === "indexed" ? (
          <p className="send-status success">
            Indexed {adminState.count} recipient links.
          </p>
        ) : null}
      </section>

      <section className="settings-panel" aria-label="OpenRouter settings">
        <div className="settings-panel-header">
          <div>
            <p className="eyebrow">OpenRouter</p>
            <h2>Reply generation</h2>
          </div>
          {openRouterSettings?.hasApiKey === true ? (
            <span className="admin-badge">API key set</span>
          ) : null}
        </div>

        <form
          className="admin-address-form openrouter-form"
          onSubmit={(event) => void handleOpenRouterSubmit(event)}
        >
          <label className="editor-field">
            <span>API key</span>
            <input
              autoComplete="off"
              onChange={(event) => {
                setOpenRouterApiKey(event.target.value);
                setOpenRouterState({ status: "idle" });
              }}
              placeholder={
                openRouterSettings?.hasApiKey === true
                  ? "Leave blank to keep existing key"
                  : "sk-or-..."
              }
              type="password"
              value={openRouterApiKey}
            />
          </label>

          <label className="editor-field">
            <span>System prompt</span>
            <textarea
              onChange={(event) => {
                setOpenRouterSystemPromptDirty(true);
                setOpenRouterSystemPrompt(event.target.value);
                setOpenRouterState({ status: "idle" });
              }}
              placeholder="Instructions to prefix to every reply prompt"
              value={
                openRouterSystemPromptDirty
                  ? openRouterSystemPrompt
                  : openRouterSettings?.systemPrompt ?? openRouterSystemPrompt
              }
            />
          </label>

          <button
            className="primary-action"
            disabled={
              openRouterSettings === undefined ||
              openRouterState.status === "saving"
            }
            type="submit"
          >
            {openRouterState.status === "saving"
              ? "Saving..."
              : "Save OpenRouter"}
          </button>
        </form>

        {openRouterState.status === "saved" ? (
          <p className="send-status success">OpenRouter settings saved.</p>
        ) : openRouterState.status === "error" ? (
          <p className="send-status error">{openRouterState.message}</p>
        ) : null}
      </section>

      <section className="settings-panel" aria-label="Users">
        <div className="settings-panel-header">
          <div>
            <p className="eyebrow">Access</p>
            <h2>Users</h2>
          </div>
          <span className="message-count">{users?.length ?? 0}</span>
        </div>
        <button
          className="ghost-action index-mail-action"
          disabled={adminState.status === "indexing"}
          onClick={() => {
            void handleBackfillRecipients();
          }}
          type="button"
        >
          {adminState.status === "indexing"
            ? "Indexing..."
            : "Index existing mail"}
        </button>

        <div className="admin-user-list">
          {users === undefined ? (
            <EmptyState title="Loading users" detail="Waiting for Convex..." />
          ) : users.length === 0 ? (
            <EmptyState
              title="No users yet"
              detail="Users appear after sign-in."
            />
          ) : (
            users.map(({ addresses, user }) => (
              <article className="admin-user-row" key={user._id}>
                <div>
                  <h3>{user.name ?? user.email ?? "Unnamed user"}</h3>
                  <p>{user.email ?? user.tokenIdentifier ?? user._id}</p>
                  {user.admin ? (
                    <span className="admin-badge">Admin</span>
                  ) : null}
                </div>
                <div className="address-chip-list">
                  {addresses.length === 0 ? (
                    <span className="muted-chip">No inbound addresses</span>
                  ) : (
                    addresses.map((address) => (
                      <span className="address-chip" key={address._id}>
                        {address.address}
                        <button
                          aria-label={`Remove ${address.address}`}
                          onClick={() => {
                            void removeAddress({ addressId: address._id });
                          }}
                          title="Remove address"
                          type="button"
                        >
                          <X aria-hidden="true" size={14} strokeWidth={2.2} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

function ComposePane({
  onClose,
  senderAddresses,
}: {
  onClose: () => void;
  senderAddresses: SenderAddress[];
}) {
  const sendMessage = useAction(api.emails.sendMessage);
  const generateAttachmentUploadUrl = useMutation(
    api.emails.generateAttachmentUploadUrl,
  );
  const attachmentInputId = useId();
  const [to, setTo] = useState(() => readDraft(COMPOSE_DRAFT_KEY).to);
  const [cc, setCc] = useState(() => readDraft(COMPOSE_DRAFT_KEY).cc);
  const [from, setFrom] = useState(() => getDefaultSenderAddress(senderAddresses));
  const [subject, setSubject] = useState(
    () => readDraft(COMPOSE_DRAFT_KEY).subject,
  );
  const [text, setText] = useState(() => readDraft(COMPOSE_DRAFT_KEY).text);
  const [html, setHtml] = useState(() => readDraft(COMPOSE_DRAFT_KEY).html);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sendState, setSendState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "sent" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const recipients = parseRecipients(to);
  const resolvedFrom = senderAddresses.some((address) => address.address === from)
    ? from
    : getDefaultSenderAddress(senderAddresses);
  const canSend =
    resolvedFrom.trim().length > 0 &&
    recipients.length > 0 &&
    subject.trim().length > 0 &&
    text.trim().length > 0 &&
    sendState.status !== "sending";

  useEffect(() => {
    writeDraft(COMPOSE_DRAFT_KEY, { to, cc, subject, text, html });
  }, [cc, html, subject, text, to]);

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
        from: resolvedFrom,
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
      clearDraft(COMPOSE_DRAFT_KEY);
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
          <span>From</span>
          {senderAddresses.length > 1 ? (
            <select
              onChange={(event) => {
                setFrom(event.target.value);
                resetSendState();
              }}
              value={resolvedFrom}
            >
              {senderAddresses.map((address) => (
                <option key={address._id} value={address.address}>
                  {address.address}
                </option>
              ))}
            </select>
          ) : (
            <input readOnly type="text" value={resolvedFrom} />
          )}
        </label>

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
            onChange={({
              html: nextHtml,
              text: nextText,
              inlineImages: nextInlineImages,
            }) => {
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
            <label
              className="ghost-action attachment-picker"
              htmlFor={attachmentInputId}
            >
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
                <div
                  className="reply-attachment-item"
                  key={`${attachment.filename}-${index}`}
                >
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
  const getAttachmentDownload = useAction(
    api.emails.getReceivedAttachmentDownload,
  );
  const [attachmentState, setAttachmentState] = useState<
    | { status: "idle" }
    | {
        status: "loading";
        attachmentId: Id<"receivedMessageAttachments">;
        intent: "download" | "preview";
      }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const recipients = useMemo(
    () => [message.to.join(", "), message.cc.join(", ")].filter(Boolean),
    [message.cc, message.to],
  );
  const canDownloadBodyHtml =
    bodyState.status === "ready" &&
    bodyState.body.html !== null &&
    bodyState.body.html.trim().length > 0;

  async function openAttachment(
    attachment: {
      _id: Id<"receivedMessageAttachments">;
      filename: string;
    },
    intent: "download" | "preview",
  ) {
    setAttachmentState({
      status: "loading",
      attachmentId: attachment._id,
      intent,
    });

    try {
      const download = await getAttachmentDownload({
        attachmentId: attachment._id,
      });
      if (intent === "preview") {
        window.open(download.downloadUrl, "_blank", "noopener,noreferrer");
      } else {
        const link = document.createElement("a");
        link.href = download.downloadUrl;
        link.download = download.filename || attachment.filename;
        link.rel = "noopener noreferrer";
        document.body.append(link);
        link.click();
        link.remove();
      }

      setAttachmentState({ status: "idle" });
    } catch (error: unknown) {
      setAttachmentState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to open this attachment.",
      });
    }
  }

  function downloadBodyHtml() {
    if (
      bodyState.status !== "ready" ||
      bodyState.body.html === null ||
      bodyState.body.html.trim().length === 0
    ) {
      return;
    }

    const blob = new Blob([bodyState.body.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${toDownloadFilename(message.subject, "message")}.html`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <article className="message-preview">
      <header className="preview-header">
        <div>
          <p className="eyebrow">{formatDate(message.receivedAt)}</p>
          <h2>{message.subject}</h2>
        </div>
        <div className="preview-actions">
          <button
            aria-label="Download message HTML"
            className="icon-action body-download-action"
            disabled={!canDownloadBodyHtml}
            onClick={downloadBodyHtml}
            title="Download message HTML"
            type="button"
          >
            <Download aria-hidden="true" size={17} strokeWidth={2.2} />
          </button>
          <button className="primary-action" onClick={onReply} type="button">
            Reply
          </button>
        </div>
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
          {attachmentState.status === "error" ? (
            <p className="send-status error">{attachmentState.message}</p>
          ) : null}
          <div className="attachment-list">
            {attachments.map((attachment) => {
              const isPdf = isPdfAttachment(attachment);
              const isLoading =
                attachmentState.status === "loading" &&
                attachmentState.attachmentId === attachment._id;

              return (
                <div className="attachment-item" key={attachment._id}>
                  <span className="file-icon">
                    <File aria-hidden="true" size={22} strokeWidth={2} />
                  </span>
                  <div className="attachment-details">
                    <p>{attachment.filename}</p>
                    <span>
                      {attachment.contentType} · {attachment.contentDisposition}
                    </span>
                  </div>
                  {isPdf ? (
                    <div className="attachment-actions">
                      <button
                        aria-label={`Preview ${attachment.filename}`}
                        className="attachment-action"
                        disabled={isLoading}
                        onClick={() => {
                          void openAttachment(attachment, "preview");
                        }}
                        title="Preview PDF"
                        type="button"
                      >
                        <Eye aria-hidden="true" size={16} strokeWidth={2.2} />
                      </button>
                      <button
                        aria-label={`Download ${attachment.filename}`}
                        className="attachment-action"
                        disabled={isLoading}
                        onClick={() => {
                          void openAttachment(attachment, "download");
                        }}
                        title="Download attachment"
                        type="button"
                      >
                        <Download
                          aria-hidden="true"
                          size={16}
                          strokeWidth={2.2}
                        />
                      </button>
                    </div>
                  ) : (
                    <div className="attachment-actions">
                      <button
                        aria-label={`Download ${attachment.filename}`}
                        className="attachment-action"
                        disabled={isLoading}
                        onClick={() => {
                          void openAttachment(attachment, "download");
                        }}
                        title="Download attachment"
                        type="button"
                      >
                        <Download
                          aria-hidden="true"
                          size={16}
                          strokeWidth={2.2}
                        />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
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
  senderAddresses,
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
  senderAddresses: SenderAddress[];
}) {
  const sendReply = useAction(api.emails.sendReply);
  const generateReplyFromPrompt = useAction(api.emails.generateReplyFromPrompt);
  const previewOpenRouterPrompt = useAction(api.emails.previewOpenRouterPrompt);
  const lastPreviousReceivedAt = useQuery(
    api.emails.getLastPreviousReceivedFromSender,
    { messageId: message._id },
  );
  const generateAttachmentUploadUrl = useMutation(
    api.emails.generateAttachmentUploadUrl,
  );
  const attachmentInputId = useId();
  const draftKey = `life-mail:reply-draft:${message._id}`;
  const [cc, setCc] = useState(() => readDraft(draftKey).cc);
  const [from, setFrom] = useState(() => getDefaultSenderAddress(senderAddresses));
  const [prompt, setPrompt] = useState(() => readDraft(draftKey).prompt);
  const [text, setText] = useState(() => readDraft(draftKey).text);
  const [html, setHtml] = useState(() => readDraft(draftKey).html);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sendState, setSendState] = useState<
    | { status: "idle" }
    | { status: "sending" }
    | { status: "sent" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [promptState, setPromptState] = useState<
    | { status: "idle" }
    | { status: "generating" }
    | { status: "previewing" }
    | {
        status: "preview";
        systemPrompt: string;
        prompt: string;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const subject = replySubject(message.subject);
  const resolvedFrom = senderAddresses.some((address) => address.address === from)
    ? from
    : getDefaultSenderAddress(senderAddresses);
  const canSend = text.trim().length > 0 && sendState.status !== "sending";
  const canGenerate =
    prompt.trim().length > 0 &&
    promptState.status !== "generating" &&
    promptState.status !== "previewing";

  useEffect(() => {
    writeDraft(draftKey, { cc, prompt, text, html });
  }, [cc, draftKey, html, prompt, text]);

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

  async function handlePromptSubmit() {
    if (!canGenerate) {
      return;
    }

    setPromptState({ status: "generating" });
    try {
      const reply = await generateReplyFromPrompt({
        originalMessageId: message._id,
        prompt: prompt.trim(),
      });
      setText(reply.text);
      setHtml(escapeHtml(reply.text).replace(/\r?\n/g, "<br>"));
      setInlineImages([]);
      resetSendState();
      setPromptState({ status: "idle" });
    } catch (error: unknown) {
      setPromptState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Unable to draft a reply.",
      });
    }
  }

  async function handlePromptPreview() {
    if (!canGenerate) {
      return;
    }

    setPromptState({ status: "previewing" });
    try {
      const preview = await previewOpenRouterPrompt({
        originalMessageId: message._id,
        prompt: prompt.trim(),
      });
      setPromptState({ status: "preview", ...preview });
    } catch (error: unknown) {
      setPromptState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to preview the AI prompt.",
      });
    }
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
        from: resolvedFrom,
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
      clearDraft(draftKey);
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
            <p className="eyebrow">Reply to {displaySenderAddress(message.from)}</p>
            <h2>{subject}</h2>
            {typeof lastPreviousReceivedAt === "number" ? (
              <p className="sender-history-label">
                Last received from this sender{" "}
                <time dateTime={new Date(lastPreviousReceivedAt).toISOString()}>
                  {formatElapsedSince(lastPreviousReceivedAt)} ago
                </time>
              </p>
            ) : null}
          </div>

          <div
            className="prompt-field"
            role="group"
            aria-label="Generate reply from prompt"
          >
            <label className="editor-field">
              <span>AI Prompt</span>
              <textarea
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setPromptState({ status: "idle" });
                }}
                placeholder="Ask OpenRouter to draft the reply"
                value={prompt}
              />
            </label>
            <div className="prompt-actions">
              <button
                aria-label="Preview full AI prompt"
                className="icon-action prompt-preview-action"
                disabled={!canGenerate}
                onClick={() => {
                  void handlePromptPreview();
                }}
                title="Preview full AI prompt"
                type="button"
              >
                <Eye aria-hidden="true" size={16} strokeWidth={2.2} />
              </button>
              <button
                className="ghost-action prompt-send-action"
                disabled={!canGenerate}
                onClick={() => {
                  void handlePromptSubmit();
                }}
                type="button"
              >
                <Sparkles aria-hidden="true" size={16} strokeWidth={2.2} />
                {promptState.status === "generating" ? "Drafting..." : "Send"}
              </button>
            </div>
            {promptState.status === "preview" ? (
              <section className="prompt-preview" aria-label="AI prompt preview">
                <div>
                  <span>System</span>
                  <pre>
                    {promptState.systemPrompt.length > 0
                      ? promptState.systemPrompt
                      : "No system prompt set."}
                  </pre>
                </div>
                <div>
                  <span>User</span>
                  <pre>{promptState.prompt}</pre>
                </div>
              </section>
            ) : null}
            {promptState.status === "error" ? (
              <p className="send-status error">{promptState.message}</p>
            ) : null}
          </div>

          <label className="editor-field">
            <span>From</span>
            {senderAddresses.length > 1 ? (
              <select
                onChange={(event) => {
                  setFrom(event.target.value);
                  resetSendState();
                }}
                value={resolvedFrom}
              >
                {senderAddresses.map((address) => (
                  <option key={address._id} value={address.address}>
                    {address.address}
                  </option>
                ))}
              </select>
            ) : (
              <input readOnly type="text" value={resolvedFrom} />
            )}
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
              onChange={({
                html: nextHtml,
                text: nextText,
                inlineImages: nextInlineImages,
              }) => {
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
              <label
                className="ghost-action attachment-picker"
                htmlFor={attachmentInputId}
              >
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
                  <div
                    className="reply-attachment-item"
                    key={`${attachment.filename}-${index}`}
                  >
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
            <button
              className="primary-action"
              disabled={!canSend}
              type="submit"
            >
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

type MailDraft = {
  cc: string;
  html: string;
  prompt: string;
  subject: string;
  text: string;
  to: string;
};

function emptyDraft(): MailDraft {
  return { cc: "", html: "", prompt: "", subject: "", text: "", to: "" };
}

function readDraft(key: string): MailDraft {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return emptyDraft();
    }

    return { ...emptyDraft(), ...JSON.parse(raw) };
  } catch {
    return emptyDraft();
  }
}

function writeDraft(key: string, draft: Partial<MailDraft>) {
  const hasContent = Object.values(draft).some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (!hasContent) {
    clearDraft(key);
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(draft));
}

function clearDraft(key: string) {
  window.localStorage.removeItem(key);
}

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

  return (
    <section className="notice">This message does not include a body.</section>
  );
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

function displaySenderAddress(from: string) {
  return from.match(/<([^<>]+)>/)?.[1].trim() || from.trim() || from;
}

function toDownloadFilename(value: string, fallback: string) {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .replace(/[. ]+$/g, "");

  return sanitized.length > 0 ? sanitized : fallback;
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

function formatElapsedSince(value: number) {
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.now() - value) / (24 * 60 * 60 * 1000)),
  );

  if (elapsedDays < 14) {
    return formatRelativeUnit(Math.max(elapsedDays, 1), "day");
  }

  if (elapsedDays < 61) {
    return formatRelativeUnit(Math.floor(elapsedDays / 7), "week");
  }

  return formatRelativeUnit(Math.floor(elapsedDays / 30), "month");
}

function formatRelativeUnit(value: number, unit: "day" | "week" | "month") {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
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

  const { storageId } = (await response.json()) as {
    storageId: Id<"_storage">;
  };
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

function getSortedSenderAddresses(addresses?: SenderAddress[]) {
  return [...(addresses ?? [])].sort(
    (left, right) => left.createdAt - right.createdAt,
  );
}

function getDefaultSenderAddress(addresses: SenderAddress[]) {
  return addresses[0]?.address ?? "";
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
  for (const image of Array.from(
    document.querySelectorAll("img[data-content-id]"),
  )) {
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

function isPdfAttachment(attachment: {
  contentType: string;
  filename: string;
}) {
  return (
    attachment.contentType.toLowerCase().includes("pdf") ||
    attachment.filename.toLowerCase().endsWith(".pdf")
  );
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
