import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "fetch received message bodies",
  { hours: 1 },
  internal.emails.fetchPendingReceivedBodies,
  {},
);

export default crons;
