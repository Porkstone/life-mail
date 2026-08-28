/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as authSessions from "../authSessions.js";
import type * as authShared from "../authShared.js";
import type * as authTokens from "../authTokens.js";
import type * as crons from "../crons.js";
import type * as emailNotifications from "../emailNotifications.js";
import type * as emails from "../emails.js";
import type * as expenses from "../expenses.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  authSessions: typeof authSessions;
  authShared: typeof authShared;
  authTokens: typeof authTokens;
  crons: typeof crons;
  emailNotifications: typeof emailNotifications;
  emails: typeof emails;
  expenses: typeof expenses;
  http: typeof http;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
