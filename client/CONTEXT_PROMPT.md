# ChatApp — Frontend Redesign Contract

You are refining the frontend of **ChatApp**, a full-stack WhatsApp-style chat web app. The backend/API layer is **complete, tested, and must NOT change**. Your job is a **pure frontend/UI polish pass**: make the interface modern, sleek, and minimalist while keeping every core feature **byte-for-byte functionally identical**.

---

## 1. Project layout

- `C:\ChatApp\client` — React 19 + Vite 8 single-page app (dev port 5173, API proxy is `http://localhost:5000`)
- `C:\ChatApp\server` — Express + Socket.IO + MongoDB API (port 5000). **Do not touch.** All client→server calls go through `C:\ChatApp\client\src\api.js` (axios instance, baseURL `http://localhost:5000/api`, token in `localStorage`, 401 → logs out via `auth-error` event).

### Client source files (all live in `C:\ChatApp\client\src`)
| File | Purpose |
|---|---|
| `main.jsx` | React entry, imports `index.css` |
| `App.jsx` | Auth gate, theme toggle (`.dark` class on `<html>`), `lazy()` loading of ChatPage/AuthPage + Suspense, `<Toaster>`, `<TooltipProvider>` |
| `AuthPage.jsx` | Login / register form (shadcn Button/Input + motion entrance) |
| `ChatPage.jsx` | ~5,400 lines — the entire chat experience (everything below) |
| `Avatar.jsx` | Renders `img` for `user.avatar` or initials `div`; props `small`/`large` |
| `GroupModal.jsx` | Create group / add members modal + avatar row component |
| `components/ModalShell.jsx` | Motion `AnimatePresence` modal wrapper; children must be passed as a **function** `{() => (<>...</>)}` |
| `components/ui/*.tsx` | shadcn/ui components (button, input, skeleton, tooltip, dropdown-menu, dialog, avatar, badge, scroll-area, sonner) |
| `lib/utils.js` + `utils.ts` | `cn()` (clsx + tailwind-merge) |
| `emojis.js` | emoji list for the reaction picker |
| `index.css` | **All styles.** Tailwind v4 `@import "tailwindcss"`, `@theme` token mapping, shadcn `:root`/`.dark` tokens, and ~3,800 lines of custom component CSS |
| `vite.config.js` | React + `@tailwindcss/vite` plugins, `@` alias → `./src` |
| `tsconfig.json`, `components.json` | shadcn/Tailwind config (Base UI / "base-nova" style, lucide icons) |

---

## 2. Installed stack (what you MUST use — all already installed)

- **Tailwind CSS v4** (`@tailwindcss/vite`) — utility-first
- **shadcn/ui** — Base UI flavor (`@base-ui/react`), `tw-animate-css`, semantic CSS vars (`--primary`, `--popover`, `--surface`, `--bg`, …) define the palette; already recolored **blue/slate**
- **anime.js v4** — modular: **only `import { animate } from "animejs"`** (no default export)
- **motion** (framer-motion successor) — `import { motion, AnimatePresence } from "motion/react"`
- **lucide-react** — icons
- **sonner** — toasts (already adopted; `sonner.tsx` was rewritten to use a `MutationObserver` on `documentElement` class instead of `next-themes`)
- **@fontsource-variable/geist** is bundled but UNUSED — Inter remains the live font (do not enable Geist unless asked)

---

## 3. RULES — non-negotiable

1. **Zero backend changes.** No API shape changes. `api.js` stays as-is.
2. **No feature removal.** Every feature listed in §4 must remain present and working with identical user flows, state variables, handlers, and props. You may rebuild HOW they look and animate, never WHAT they do.
3. **Do not rename/remove React state or handler functions** in `ChatPage.jsx` — the logic depends on them. Restyle via JSX classes + `index.css`, or wrap with new shadcn components only where behavior is unchanged.
4. Children passed to `ModalShell` MUST stay function-form: `<ModalShell open={X} onClose={...}>{() => (<>...</>)}</ModalShell>`. Eager (non-function) children crash the app (they dereference possibly-null state).
5. Keep the palette consistent: blue/slate accents using the existing CSS variables (`--accent`, `--accent-glow`, `--primary`, `--bg`, `--surface`, `--panel`, `--border`, `--text`, `--text-muted`, `--danger`, `--online`). Both light (`:root`) and dark (`.dark`) variants exist.
6. Preserve responsive/overflow behavior: message scroller uses `.scroll-fade-b` mask; modals keep their backdrop blur; lightbox keeps zoom/pan.
7. Build must pass: `npm run build` (no errors), `npm run lint` (only 2 pre-existing warnings from `components/ui/button.tsx` + `badge.tsx` are allowed).
8. Keep lucide icon imports (Tree-shaken). Don't re-add emoji/unicode icons — they were already replaced.
9. Keep the `React.lazy` code-splitting of `ChatPage`/`AuthPage` in `App.jsx`; don't merge chunks back.

---

## 4. Core features to PRESERVE (all in `ChatPage.jsx` unless noted)

**Account & UI shell**
- Auth gate in `App.jsx` (token from `localStorage`; logout clears it; 401 auto-logout)
- Light/dark theme toggle (settings + logout in a dropdown/header)
- App loading state, logo shimmer, skeleton loading for the conversation list

**Chats (left sidebar)**
- Conversation list with filters: **All / Favorites / Unread / Groups / Archived**
- Per-conversation ⋯ menu (shadcn `DropdownMenu`): pin, favorite, archive, view profile, delete chat
- Unread badges, last-message preview, typing preview (animated answering-dots)
- User search, "start conversation", friends list, friend requests (accept/decline), create-group button
- **Profile button** (top tool row) opens Profile modal: large avatar (click = lightbox), Add/Change/Remove photo, Edit profile form (username/handle/status) + Cancel/Save

**Chat window (right main area)**
- Per-bubble message rendering: text, images/videos (with media-send preview), documents, links, forwarded label, edited label
- Message actions per hover: reply, reactions (👍 ❤️ 😂 + picker with many emojis), react-chips with counts, ⋯ menu (reply/edit/star/forward/delete-for-me/delete-for-everyone), edit inline
- Read receipts (✓✓, pop animation when read), timestamps, date separators
- Reply preview inside bubbles, reply-to + jump-to-original
- Message star/unstar + **Starred messages** modal; **Shared media/files/links** modal; in-chat **message search** (results + jump)
- **Polls**: create poll modal, vote, live results
- **Voice messages**: hold-to-record (button mic), cancel-on-slide-up, pause/resume, waveform visualization, playback
- **View-once media**: open/view once then locks
- **Image lightbox**: full WhatsApp-style zoom (buttons + pinch + wheel + drag), pan, reset, save/download. Right-click / context menu disabled on media
- Typing indicator ("typing…" with bouncing dots): socket based
- Online status + last seen; profile modal (other user) with search-in-chat + shared media
- Chat header menu: group info, theme picker, background picker (image upload), mute duration, disappearing messages, star count, search, clear, block/unblock, delete chat, view profile

**Group features**
- Create group, add members, rename
- Group info modal: member list, promote/demote admin, transfer ownership, remove members, leave group
- Crown (owner) / Shield (admin) badges

**Other**
- Friend add/remove/block/unblock; blocked users list
- Desktop notifications permission toggle
- Chat lock (PIN) — lock overlay, set/change/remove PIN
- Profile picture: upload (multipart to `POST /api/users/avatar`), remove (`PATCH /api/users/me {avatar:""}`), view full-size in lightbox from sidebar, Profile modal, and other-user profile
- **Toasts** via sonner (`toast.success`/`toast.error`) — banners already removed
- Modal enter/exit via `<ModalShell>` (AnimatePresence spring)

**All toasts/banners/confirmation flows** (delete account, delete chat, delete-for-everyone, pin changes, etc.) must keep the same triggers.

---

## 5. What already uses the modern stack (do not undo)

- shadcn: `Button`, `Input`, `Skeleton`, `Tooltip<TooltipTrigger render>`/`TooltipContent`, `DropdownMenu` family, `Avatar`, `Badge`, `ScrollArea`, `Dialog`, sonner `Toaster`
- Tailwind theme mapping: `@theme` maps design tokens; shadcn vars (oklch blue/slate) in `:root` + `.dark`
- anime.js `animate()`: send-button pulse on message send
- motion: AuthPage entrance, message bubble entrance, modal AnimatePresence, `scroll-fade-b` masked scrollers

---

## 6. The redesign directive (the actual task)

Give the app a **modern, sleek, minimalist** aesthetic without changing behavior:

- Refine spacing, radius, shadows, and transitions for a tighter, more premium feel; keep the blue/slate palette but consider soft gradients and subtle glows (respect `--accent-glow`, dark-mode contrast)
- Elevate the type hierarchy (Inter): crisper headers, refined muted text, consistent `letter-spacing`
- Use anime.js tastefully: smooth spring/hover micro-interactions, send/reaction/typing/notification micro-animations, scroll-reveal for messages; keep them subtle and performant (no jank on group/large chats)
- Push more of the UI onto Tailwind utility classes + shadcn components **where it does not alter behavior**; keep any tightly-coupled custom CSS in `index.css`
- Modern composer/banner/empty-state/lightbox/voice-widget styling; consistent focus rings, hover states, active states
- Verify the result looks great in BOTH light and dark modes

## 7. Workflow / verification

1. Make changes in `C:\ChatApp\client` only.
2. After each batch: `npm run build` then `npm run lint` (workdir `C:\ChatApp\client`).
3. Smoke-test with `npm run dev`; leaving the existing instance untouched (it runs on 5173 — your test server picks the next free port; stop your own after).
4. Keep the server at `http://localhost:5000` running for manual testing (credentials are real accounts; create a throwaway account for testing and delete it via `DELETE /api/users/me` when done).
5. Do NOT reformat/refactor `ChatPage.jsx` logic wholesale — target the JSX class attributes and CSS, and introduce shadcn wrappers surgically.

Deliver: a visually modernized, consistent, minimalist UI that passes `npm run build` + `npm run lint` with all features intact.