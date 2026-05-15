# ClassClimb — UI / UX redesign brief

This document describes **screens, structure, UI patterns, and design direction** in the current ClassClimb codebase. It is intended for designers or tools (e.g. Stitch, Figma handoff) to redesign without losing functional coverage.

---

## 1. Product summary

| Item | Detail |
|------|--------|
| **Name** | ClassClimb |
| **One-liner** | “Elevate your classroom engagement.” (guest landing) |
| **Core loop** | Teachers create classes, add students, award XP on a “teacher console.” Students (and teachers) view a **live leaderboard** for a class; scores update in real time via WebSocket. |
| **Auth** | Telegram — users open a bot link, then finish linking in the browser (`/auth/complete`). No email/password UI. |

**Primary audiences**

1. **Teachers** — manage classes, student roster, XP adjustments; share a public board link.
2. **Students / observers** — open the shared `/view/:classId` leaderboard; optional Telegram connection for notifications.

---

## 2. Technical context (affects implementation)

| Layer | Choice |
|-------|--------|
| Server | Node.js, Express |
| Templates | EJS (`views/`), server-rendered HTML |
| Styling | Tailwind CSS v4; built CSS at `public/css/output.css`; source/theme in `public/css/style.css` |
| JS | Vanilla JS in templates and `public/js/` (no React/Vue on pages) |
| Realtime | WebSocket (`/ws?classId=…`) for leaderboard sync |

Design deliverables can assume **mobile-first**, **dark UI**, and **progressive enhancement** (forms also post traditionally where applicable).

---

## 3. Information architecture — routes and templates

| URL | Template | Who | Purpose |
|-----|----------|-----|---------|
| `GET /` | `views/index.ejs` | Everyone | **Guest:** landing + Telegram sign-in. **Teacher (owns ≥1 class):** create class + paginated class list. **Signed-in user with no owned classes:** “student home” — list of subscribed boards. |
| `GET /dashboard` | *(redirect)* | — | Redirects `303` → `/` |
| `GET /view/:classId` | `views/leaderboard.ejs` | Signed-in only (`requireUser`) | Live leaderboard for numeric class ID; WebSocket updates. |
| `GET /class/manage/:viewId` | `views/class-manage.ejs` | Teacher (owner) | Teacher console: roster, XP buttons, drawers/modals. |
| `GET /class/start-teaching` | `views/start-teaching.ejs` | Signed-in, **no classes yet** | Standalone “create first class” flow; if user already has classes → redirect `/`. |
| `GET /auth/login` | *(redirect)* | — | Redirects to `/` with query preservation |
| Auth POSTs | *(no dedicated page)* | — | `POST /auth/logout`, `POST /auth/prepare-login`, `POST /auth/complete`, etc. |

**Unused / legacy**

- `views/dashboard.ejs` — placeholder (“Welcome to ClassClimb”); **not referenced by any route**. Safe to ignore for redesign scope unless product wants a dedicated dashboard URL later.

---

## 4. Global chrome

### 4.1 Document shell (`views/partials/header.ejs` + `footer.ejs`)

- **`<title>`** — static “ClassClimb”
- **Favicon / Apple touch icon** — `/asset/xp.png`
- **CSS** — `/css/output.css`
- **`<body>`** — `bg-pure-black text-white antialiased` (`#000` background)
- **Footer** — closes `</body></html>` only (no visible footer content)

### 4.2 Universal navigation (`views/partials/nav.ejs`)

**Sticky top bar** — `sticky top-0 z-30`, `border-b border-zinc-800`, `bg-pure-black/95 backdrop-blur-sm`, max width ~`max-w-5xl`, horizontal padding.

**Brand**

- Wordmark: **CLASSCLIMB** — `text-lg font-black italic tracking-tight`, links to `/`
- Context label (only on student “live board” paths under `/view/`): **“Live board”** — `text-xs uppercase tracking-widest text-zinc-500` (hidden on very small screens via `sm:inline`)

**Right side — state-dependent**

| State | UI |
|-------|-----|
| Not signed in, not on `/auth/*` | Pill: “Sign in” → `/` |
| Signed in, normal home | “Signed in” (sm+) + **hamburger** → opens **account drawer** |
| Signed in, path starts with `/view/` | **Hamburger only** → **leaderboard drawer** (defined in `leaderboard.ejs`, not nav) |
| Path starts with `/class/manage/` | **Hamburger** → **class tools drawer** (defined in `class-manage.ejs`) |

**Shared modal: log out** (in `nav.ejs`)

- Hidden control `cc-logout-open` opens **`#cc-logout-modal`**
- Copy: title “Log out?”, body “Are you sure you want to log out? You can sign in again anytime.”
- Actions: **Cancel** (outline), **Log out** (red primary) → submits `POST /auth/logout`

**Account drawer** (when hamburger on home)

- Full-screen overlay + **right slide-in panel** (`max-w-sm`), black background, sections with uppercase micro-labels (`text-[11px] text-zinc-500`)
- Current content: **Account → Log out** (triggers logout modal)
- Motion: backdrop fade, panel `translateX` with `cubic-bezier(0.22, 1, 0.36, 1)`; Escape closes unless logout modal open

---

## 5. Screen-by-screen inventory

### 5.1 Home — guest (`index.ejs`, `signedIn: false`)

**Layout**

- Full viewport minus nav; vertically centered column on large screens (`lg:w-[30%]`)
- Error banner (optional): red border/background if `error` query/message

**Hero**

- Logo image: `/asset/xp.png` — ~`h-20`–`h-28` responsive
- **CLASSCLIMB** — `text-5xl font-black tracking-tighter italic`
- Tagline: “Elevate your classroom engagement.” — `text-gray-500`

**Card: Telegram**

- Container: `bg-[#111] rounded-2xl border border-gray-900`
- Primary: **“Open Telegram”** — full width blue (`bg-blue-600 hover:bg-blue-500`)
- After open: **“Finish”** form appears (`POST /auth/complete`), same button style
- Optional: **“Open Telegram again”** — ghost link
- Script: `/js/telegram-login.js`

**Data attributes for login prep**

- `data-prepare-return`, `data-prepare-class-id` — deep-link return after auth

---

### 5.2 Home — teacher (`index.ejs`, `signedIn: true`, `isTeacher: true`)

**Section: For Teachers**

- Heading: “For Teachers” — `text-blue-500`
- Form **Create New Class** — `POST /class/create`
  - Fields: **Class Name** (required), **School Name** (required)
  - Inputs: `bg-[#050505] border-gray-800 rounded-lg`, focus ring blue
  - Submit: full-width blue button
  - Hidden `_formNonce` for CSRF-style protection
- Client-side: `fetch` submit with JSON response for inline new card; errors show in `#create-class-error`

**Section: Your Classes**

- Heading + optional total count
- **Class cards** (each):
  - Title (class name)
  - Trash icon → **delete class modal**
  - Line: “Share this:” + monospace URL (filled by JS: `{origin}/view/{numericId}`)
  - **Manage class** — `a.cc-btn` blue, links to `/class/manage/{view_id}`
  - **Copy student link** — ghost button, copies `/view/{id}` URL
- **Pagination** when multiple pages: Previous / “Page x of y” / Next

**Delete class modal**

- Title: “Delete class?”
- Dynamic body with class name
- Warning: removes students, XP, Telegram subscriptions; irreversible
- Cancel / **Delete class** (red)

---

### 5.3 Home — student-only user (`index.ejs`, signed in, not teacher dashboard)

**Section: Your boards**

- Heading + helper: open a class from teacher’s link
- List of cards linking to `/view/{class.id}` — class name, school subtitle, “Open live board”
- Empty state: prompt to get a ClassClimb link from teacher

---

### 5.4 Live leaderboard (`leaderboard.ejs`) — `GET /view/:classId`

**Purpose:** Read-only ranked list for one class; updates live over WebSocket.

**Header row (grid)**

- Back chevron → `/`
- Center: **“Live Leaderboard”** — `text-2xl font-bold uppercase tracking-widest`
- Subtitle: class label = `class_name · school_name` or “Class #{id}”
- Spacer for visual balance

**Telegram CTA block** (non-teacher, when `hasAlerts` is false)

- Tinted blue border/card
- Explains signing in with Telegram for XP updates
- **“Connect Telegram”** → `/?class_id={id}&return=/view/{id}`

**Leaderboard list**

- Container: bordered, divided rows, `bg-[#050505]` when populated
- Each row: rank `#n` (mono zinc), student **name** (truncate), **XP** pill on the right
- XP display:
  - Default: zinc ring, neutral text
  - On gain: green pulse background animation + optional count-up
  - On loss / rank drop: rose pulse
  - `prefers-reduced-motion` disables pulse animations

**Leaderboard drawer** (hamburger in nav on this route)

- **Board:** Refresh (reload page)
- **Account:** Log out → same logout modal flow as global

**Technical:** Inline JSON bootstrap + WebSocket client in page script.

---

### 5.5 Teacher console (`class-manage.ejs`) — `GET /class/manage/:viewId`

**Page header**

- Back → `/`
- Eyebrow: **“Teacher console”** — uppercase tracked wide zinc
- **Class title** (large), school line optional
- Hint: use **Class tools** in header for share link / add students

**Student list**

- Each **student card** (`rounded-2xl border border-zinc-800/90 bg-[#111]`):
  - Name + **XP badge** + **×** remove (opens modal)
  - **XP adjustment strip** inside nested darker panel (`bg-[#0a0a0a]`):
    - Left: **-10**, **-5** (rose-tinted buttons)
    - Divider
    - Right: **+5**, **+10** (emerald-tinted buttons)
  - After tap: **10-second pending state** with amber UI — “Pending ±N XP · applies in Ns” + **Cancel**; on commit, “Saved to leaderboard” then clears; server `POST /class/award-xp`

**Class tools drawer** (header hamburger)

- Title: “Class tools”
- **Board link:** Copy link, Open leaderboard (new tab), Add students (bulk), Add one student
- **Account:** Log out

**Modals**

| ID | Title | Actions |
|----|-------|---------|
| `quick-add-student-modal` | Add one student | Name field; Cancel; **Add student** (white/black primary) |
| `add-students-modal` | Add students | Textarea (lines/comma); Cancel; **Save students** (blue) — posts `POST /class/bulk-add/:viewId` |
| `remove-student-modal` | Remove student? | Confirms removal; red **Remove** — `fetch` delete |

**Realtime:** Same WebSocket pattern — roster + XP can rebuild from server pushes when multiple clients open manage page.

---

### 5.6 First-time teaching (`start-teaching.ejs`) — `GET /class/start-teaching`

- Centered layout with back button and title **“Create your class”** (italic black)
- Subtitle about share link
- Same create-class form as home (nonce-backed `POST /class/create`)
- Users with existing classes never see this page (redirect home)

---

## 6. Reusable UI patterns / “components”

Conceptual building blocks (implemented as HTML + classes, not React components):

| Pattern | Classes / notes |
|---------|------------------|
| **Primary CTA** | Blue fill `bg-blue-600 hover:bg-blue-500`, bold, rounded-lg |
| **Destructive** | `bg-red-600 hover:bg-red-500` |
| **Ghost / text link** | `cc-btn-ghost` — underline, no chrome; used for secondary actions |
| **Link-as-button** | `a.cc-btn` — matches button padding/border from `style.css` |
| **Cards** | `bg-[#111]` or `bg-[#050505]`, `border-zinc-800` or `gray-900`, `rounded-xl`–`rounded-2xl` |
| **Inputs** | Dark fill `#050505`, `border-zinc-800` or `gray-800`, blue focus on some forms |
| **Drawers** | Full viewport overlay `z-[110]`, backdrop `bg-black/90`, panel from right `max-w-sm` |
| **Modals** | `z-[120]`, `bg-black/70` backdrop, card `bg-[#111]` or `#141414`, `rounded-xl`–`rounded-2xl` |
| **Icons** | Inline SVGs (Heroicons-style strokes), white or zinc |

---

## 7. Design tokens (from `public/css/style.css`)

| Token / concept | Value / usage |
|-----------------|----------------|
| **pure-black** | `#000000` — page bg |
| **card-dark** (named in theme) | `#111111` — cards |
| **Body** | White text on black; antialiased |
| **Primary accent** | Tailwind **blue-600** / **blue-500** hover for CTAs |
| **Success / XP gain** | Emerald greens (leaderboard pulse, animations) |
| **Loss / negative** | Rose / red tones |
| **Warning / pending XP** | Amber UI for 10s countdown strip |
| **Borders** | `zinc-800`, `zinc-700`; subtle white border on generic buttons via `--cc-btn-border` |
| **Focus ring** | Blue glow `--cc-btn-focus-ring` on native buttons and `.cc-btn` |
| **Scrollbar** (WebKit) | Thin, `#222` thumb on `#000` track |

Typography: heavy use of **uppercase + tracking** for section labels; **italic black** for brand headlines; **tabular-nums** on XP.

---

## 8. Motion and accessibility

- **Leaderboard:** XP number animations (`cc-lb-xp-anim-up/down`), row background pulse; optional `prefers-reduced-motion` stripping pulse
- **Drawers/modals:** Escape to close; focus management implied via button targets
- **No native `alert` / `confirm` / `prompt`** in flows documented — confirmations use custom modals

---

## 9. Assets and branding

| Asset | Path | Usage |
|-------|------|-------|
| Logo / XP mark | `/asset/xp.png` | Favicon, apple-touch-icon, guest landing hero |
| Built CSS | `/css/output.css` | All pages |

---

## 10. Design directions implied by current UI

Use these as **starting hypotheses** for redesign (validate with stakeholders):

1. **Dark, minimal, “console” aesthetic** — black base, zinc borders, single accent (blue).
2. **Brand voice** — bold italic wordmark; classroom/professional, not playful-game UI except XP motion.
3. **Density** — narrow content column (`~30%` width on large screens) for focus; may feel constrained on desktop — worth exploring wider layouts for teacher lists.
4. **Hierarchy** — Strong separation between marketing hero (guest) and utilitarian dashboard sections.
5. **Realtime feedback** — Leaderboard and teacher console emphasize **live** updates; redesign should preserve clarity when rows reorder or XP flashes.

---

## 11. Suggested deliverables for a redesign pass

- Component library covering: nav variants, cards, drawers, modals, ghost links, XP badges, pending/undo strip, leaderboard row states (idle, gain, loss).
- Responsive breakpoints for **teacher class list** and **manage** XP grid (many buttons on narrow screens).
- Optional light theme only if product requires it — current implementation is dark-only.
- Empty states: guest, no classes, no students, leaderboard empty, Telegram connect.

---

*Generated from the ClassClimb repository (Express + EJS + Tailwind v4). Routes and templates reflect the codebase at documentation time; adjust if server routes change.*
