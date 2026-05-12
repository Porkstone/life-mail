# Welcome to your Convex + React (Vite) app

This is a [Convex](https://convex.dev/) project created with [`npm create convex`](https://www.npmjs.com/package/create-convex).

After the initial setup (<2 minutes) you'll have a working full-stack app using:

- Convex as your backend (database, server logic)
- [React](https://react.dev/) as your frontend (web page interactivity)
- [Vite](https://vitest.dev/) for optimized web hosting
- [Tailwind](https://tailwindcss.com/) for building great looking accessible UI

## Get started

If you just cloned this codebase and didn't use `npm create convex`, run:

```
npm install
npm run dev
```

If you're reading this README on GitHub and want to use this template, run:

```
npm create convex@latest -- -t react-vite
```

## User accounts and duplicate prevention

Authentication uses [Shoo](https://shoo.dev/), which issues a **pairwise subject** per browser origin (see [Shoo’s introduction](https://docs.shoo.dev/)). The same Google account on **localhost** and on **production** therefore gets **different** JWT `sub` values and different Convex `tokenIdentifier`s. That is expected from Shoo; this app prevents duplicate **logical** users in three ways:

1. **JWT audiences in Convex** — [`convex/auth.config.ts`](convex/auth.config.ts) registers one Shoo `customJwt` provider per distinct JWT `aud` (each value is usually `origin:` plus your site URL). Localhost and Vercel production are included by default; add preview/custom deployment origins to `EXTRA_SHOO_JWT_AUDIENCES` so Convex accepts tokens from those hosts. If an origin is missing here, sign-in from that origin can fail before any user row is reconciled.

2. **Email-based account linking** — When `ensureCurrentUser` runs ([`convex/auth.ts`](convex/auth.ts)), it still matches primarily by `tokenIdentifier`. If there is no row for the current token, it looks up users by **normalized** `email` (using the `by_email` index on the `users` table). When the identity is safe to treat as email-backed (`emailVerified` is not explicitly `false`), it **reuses** the existing user row and updates `tokenIdentifier` (and profile fields) instead of inserting a second row. If multiple rows already share that email, they are merged first (inbound addresses move to one canonical user, `admin` is combined, duplicates are removed).

3. **Cleaning up existing duplicates** — If you already have more than one `users` document for the same email (for example from before linking was added), run the internal migration once against the target deployment:

   ```bash
   pnpm exec convex run auth:mergeAllDuplicateUsersByEmail '{}' --push
   ```

   That normalizes stored emails where needed, merges duplicate email groups, and reports how many groups and rows were affected.

**Note:** Replacing `tokenIdentifier` on a user row means sessions that still hold an **old** JWT for a merged-away Shoo subject may need a refresh or sign-in again until the client uses the identity tied to the canonical row.

## Learn more

To learn more about developing your project with Convex, check out:

- The [Tour of Convex](https://docs.convex.dev/get-started) for a thorough introduction to Convex principles.
- The rest of [Convex docs](https://docs.convex.dev/) to learn about all Convex features.
- [Stack](https://stack.convex.dev/) for in-depth articles on advanced topics.

## Join the community

Join thousands of developers building full-stack apps with Convex:

- Join the [Convex Discord community](https://convex.dev/community) to get help in real-time.
- Follow [Convex on GitHub](https://github.com/get-convex/), star and contribute to the open-source implementation of Convex.
