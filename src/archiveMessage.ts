import type { OptimisticUpdate } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Convex replays pending updates over fresh results and rolls back failures.
export const optimisticallyArchiveMessage: OptimisticUpdate<{
  messageId: Id<"receivedMessages">;
}> = (localStore, { messageId }) => {
  for (const query of [
    api.emails.listReceived,
    api.emails.listDeletedReceived,
  ]) {
    for (const { args, value } of localStore.getAllQueries(query)) {
      if (value?.some((message) => message._id === messageId)) {
        localStore.setQuery(
          query,
          args,
          value.map((message) =>
            message._id === messageId
              ? { ...message, archived: true, kept: false }
              : message,
          ),
        );
      }
    }
  }
  for (const { args, value } of localStore.getAllQueries(
    api.emails.listKeptReceived,
  )) {
    if (value?.some((message) => message._id === messageId)) {
      localStore.setQuery(
        api.emails.listKeptReceived,
        args,
        value.filter((message) => message._id !== messageId),
      );
    }
  }
};
