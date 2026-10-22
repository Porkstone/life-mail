import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName } from "convex/server";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { optimisticallyArchiveMessage } from "./archiveMessage";

type Message = FunctionReturnType<typeof api.emails.listReceived>[number];

function message(id: string, kept = false): Message {
  return {
    _id: id as Id<"receivedMessages">,
    _creationTime: 1,
    from: "sender@example.com",
    to: ["inbox@avlec.co"],
    cc: [],
    subject: id,
    attachmentCount: 0,
    receivedAt: 1,
    resendEmailId: id,
    archived: false,
    kept,
    deletedOn: undefined,
    isWhitelisted: false,
  };
}

describe("optimistic archive", () => {
  test("immediately moves only the target across cached list variants without mutating results", () => {
    const target = message("target", true);
    const other = message("other");
    const inbox = Object.freeze([Object.freeze(target), Object.freeze(other)]);
    const archived = { ...message("archived"), archived: true };
    const getAllQueries = vi.fn<OptimisticLocalStore["getAllQueries"]>(
      (query) => {
        switch (getFunctionName(query)) {
          case "emails:listReceived":
            return [
              { args: { limit: 50 }, value: [...inbox, archived] },
              { args: { limit: 200 }, value: [...inbox] },
              { args: { limit: 500 }, value: undefined },
            ];
          case "emails:listKeptReceived":
            return [{ args: {}, value: [target] }];
          default:
            return [{ args: { limit: 50 }, value: [other] }];
        }
      },
    );
    const setQuery = vi.fn<OptimisticLocalStore["setQuery"]>();
    optimisticallyArchiveMessage(
      { getAllQueries, setQuery, getQuery: vi.fn() },
      {
        messageId: target._id,
      },
    );
    expect(setQuery).toHaveBeenCalledTimes(3);
    const updated = { ...target, archived: true, kept: false };
    expect(setQuery).toHaveBeenCalledWith(
      api.emails.listReceived,
      { limit: 50 },
      [updated, other, archived],
    );
    expect(setQuery).toHaveBeenCalledWith(
      api.emails.listReceived,
      { limit: 200 },
      [updated, other],
    );
    expect(setQuery).toHaveBeenCalledWith(api.emails.listKeptReceived, {}, []);
    expect(target.archived).toBe(false);
    expect(target.kept).toBe(true);
  });

  test("replaying a pending archive preserves other confirmed archives", () => {
    const target = message("target");
    const confirmed = { ...message("confirmed"), archived: true };
    const getAllQueries = vi.fn<OptimisticLocalStore["getAllQueries"]>(
      (query) =>
        getFunctionName(query) === "emails:listReceived"
          ? [{ args: { limit: 50 }, value: [target, confirmed] }]
          : [],
    );
    const setQuery = vi.fn<OptimisticLocalStore["setQuery"]>();
    optimisticallyArchiveMessage(
      { getAllQueries, setQuery, getQuery: vi.fn() },
      {
        messageId: target._id,
      },
    );
    expect(setQuery).toHaveBeenCalledWith(
      api.emails.listReceived,
      { limit: 50 },
      [{ ...target, archived: true, kept: false }, confirmed],
    );
  });
});
