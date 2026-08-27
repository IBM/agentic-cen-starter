---
name: add-wxo-chat
description: Add a watsonx Orchestrate embedded web chat to this app — asks which layout flavour the user wants (float, custom, fullscreen, or docview), then scaffolds the components, env vars, and route. Use when the user asks to embed watsonx Orchestrate, add a WXO chat interface, or integrate a watsonx Orchestrate agent into the frontend.
---

# Add watsonx Orchestrate Embedded Chat

Scaffold a WXO embedded web chat into the agentic-cen-starter. The WXO widget is loaded
via a `<script>` tag at runtime — there are no npm packages to install. Everything goes
into `frontend/src/components/watsonx/`.

## Step 0 — Run setup first (unfinalized projects only)

Before touching any source files, check whether the project has been finalized:

1. Read `package.json` and inspect `cen.finalized`.
2. If `cen.finalized` is `true` — the project is already set up. Skip to Step 1.
3. If `cen.finalized` is `false` (or the field is absent) — the project is an
   unfinalized CEN Starter clone. This skill depends on the **Carbon** flavor
   (`@carbon/react`, Carbon tokens, `useTheme`, etc.). You must run setup before
   scaffolding the embed.

**Do not ask the user to do setup manually.** Drive it yourself:

- Activate the `setup` skill.
- Follow its interview flow with one pre-answered decision — do **not** ask the
  user about it:
  - **Browser app or service?** → always **browser app**. A WXO embedded chat is
    a UI by definition; never offer the backend-service path.
- All other setup questions (account management, which look) are asked normally —
  follow the setup skill's decision tree for those choices.
- Complete setup through finalization (step 6 of the setup skill) with the user's
  explicit confirmation.
- Only once `cen.finalized` is `true` and the app is running, return here and
  continue with Step 1.

## Step 1 — Ask for the layout

Use `ask_followup_question` with all four choices:

- **float** — Floating, minimizable, draggable chat bubble. Good when chat is supplementary
  to existing page content.
- **custom** — Two-column layout: a branding/guide panel alongside the chat. Most
  customizable.
- **fullscreen** — Chat fills the entire viewport. Immersive; supports chat history.
- **docview** — Side-by-side: chat on the left, a document viewer panel on the right.
  Links in chat open automatically in the viewer.

Then ask: **Should the user be able to toggle between this layout and fullscreen?**
(Layout switcher — only meaningful for `float` and `custom`. Skip for `fullscreen` and
`docview`.)

## Step 2 — Scaffold the file tree

Create the following structure under `frontend/src/components/watsonx/`:

```
watsonx/
├── lib/
│   ├── types.ts          # WXO TypeScript types + window augmentation
│   ├── utils.ts          # env helpers, layout state, chat lifecycle
│   └── useAppTheme.ts    # (placeholder — theme sync not scaffolded; see Step 7)
├── handlers/
│   └── orchestrateHandlers.ts  # WXO event handlers (send/receive/feedback)
├── header/
│   ├── languageSelector.ts     # custom header dropdown for locale switching
│   ├── layoutSwitcher.ts       # custom header button: toggle default ↔ fullscreen
│   ├── dragHandle.ts           # drag-to-move for float layout
│   └── documentViewer.ts       # docview: link detection + viewer panel logic
└── core/
    ├── OrchestrateChat.tsx     # initializes and owns a single WXO instance
    ├── OrchestrateLayout.tsx   # layout router: picks Custom/Chat/DocView wrapper
    ├── CustomComponent.tsx     # the custom two-column layout wrapper
    └── DocumentViewPanel.tsx   # the slide-in document viewer panel (docview only)
```

## Step 3 — Implement each file

### `lib/types.ts`

Define TypeScript types for the WXO configuration and instance. The key pieces:

- `LayoutType = "fullscreen" | "custom" | "docview" | "float"`
- `WxoConfiguration` — mirrors `window.wxOConfiguration` (see Step 4 for the full shape)
- `WxoInstance` — the object passed to `chatOptions.onLoad`, with methods:
  `on`, `off`, `destroy`, `updateLocale`, `updateCustomHeaderItems`,
  `getWriteableElement`, `loadThreadById`, `restartConversation`, `send`
- `WxoChatPosition` — positions for `getWriteableElement`:
  `"belowHeader" | "aboveInputBar" | "aboveWelcomeTitle" | "belowWelcomeStarters" | "chatWelcomeComponent"`
- WXO event types: `send`, `receive`, `pre:send`, `pre:receive`, `feedback`,
  `restartConversation`, `pre:threadLoaded`, `pre:stream:delta`, `chat:ready`, etc.
- Augment `Window` with `wxOConfiguration`, `wxoLoader` (`{ init, chatInstance }`).

### `lib/utils.ts`

**Environment / container helpers:**
```ts
// Read VITE_WXO_AGENT_ID_2 with fallback to VITE_WXO_AGENT_ID
export const getEnvWithSuffix = (baseKey: string, suffix?: string): string | null => {
  if (suffix) {
    const v = import.meta.env[`${baseKey}_${suffix}`];
    if (v) return v;
  }
  return import.meta.env[baseKey] || null;
};

export const getWxoContainerId = (suffix?: string) =>
  suffix ? `wxo-container-${suffix}` : "wxo-container";
```

**Layout state** — module-level (not React state) so header items can read it without
a re-render:
```ts
let currentLayout: LayoutType = "fullscreen";
let layoutChangeCallback: LayoutChangeCallback | null = null;

export const setLayoutState = (l: LayoutType, cb?: LayoutChangeCallback) => {
  currentLayout = l; layoutChangeCallback = cb ?? null;
};
export const getCurrentLayout = () => currentLayout;
```

**Layout persistence** — store user preference and the default in `localStorage`:
`getInitialLayout(suffix)`, `saveLayoutPreference(layout, suffix)`,
`saveDefaultLayout(suffix)`, `getSavedDefaultLayout(suffix)`.

**Chat lifecycle:**
```ts
export const loadWxoScript = (hostURL: string): Promise<void> => {
  // Set script.async = true and append to document.body (not document.head).
  // Append <script src="${hostURL}/wxochat/wxoLoader.js?embed=true"> once.
  // Resolve immediately if already loaded.
  // IMPORTANT: window.wxOConfiguration must be assigned BEFORE this function
  // is called. The WXO loader reads the config synchronously at parse time —
  // setting it inside or after an onload callback is too late.
};

export const destroyChat = (containerId: string) => {
  window.wxoLoader?.chatInstance?.destroy();
  // Hide + reset the container div.
};

export const enableBodyScroll = (): void => {
  // WXO (float mode in particular) sets overflow:hidden on both body AND
  // document.documentElement (<html>). Both must be cleared or the rest of
  // the app stays hidden behind the widget.
  document.body.style.overflow = "auto";
  document.body.style.position = "";
  const htmlElement = document.documentElement;
  if (htmlElement.style.overflow === "hidden") {
    htmlElement.style.overflow = "auto";
  }
};
```

**Layout switcher guard:**
```ts
// Only show the switcher when the default layout is custom or float.
export const shouldShowLayoutSwitcher = (suffix?: string): boolean => {
  const def = getSavedDefaultLayout(suffix);
  return layoutChangeCallback !== null && (def === "custom" || def === "float");
};
```

### `lib/useAppTheme.ts`

**Do not scaffold this file.** Theme sync between the app and the WXO widget is not
reliably achievable without a verified set of SCSS overrides for every WXO sub-component.
WXO's own bundled stylesheet contains highly specific hardcoded rules that override Carbon
zone class inheritance unpredictably. Attempting a partial implementation leaves surfaces
with wrong colours and is harder to debug than no implementation at all.

Create an empty export as a placeholder:

```ts
// Theme sync not implemented.
// WXO renders with its own default theme.
// To add theme sync, obtain the full SCSS override set from your WXO embed reference
// project and apply it together with zone class stamping on <html>.
export function useWatsonxTheme(_containerId: string) {}
```

### `handlers/orchestrateHandlers.ts`

Factory that returns all WXO event handlers. Accept `{ queryClient }` for future
feedback API calls:

- **`send`** — store the user's message text per `thread_id` (for feedback linking);
  call `storeCurrentThreadId`.
- **`receive`** — link `parentMessageId` → user message; call `storeCurrentThreadId`.
- **`pre:receive`** — enable the per-message feedback UI:
  ```ts
  lastItem.message_options = {
    feedback: {
      is_on: true,
      show_positive_details: false,
      show_negative_details: true,
      negative_options: {
        categories: ["Inaccurate", "Incomplete", "Too long", "Irrelevant", "Other"],
        disclaimer: "Provide content that can be shared publicly.",
      },
    },
  };
  ```
- **`feedback`** — log or persist the feedback. Leave a clear `// TODO: call your API`
  comment — do not invent a backend endpoint. Only wire up to the API if the project
  already has a feedback route.
- **`pre:send` / `pre:threadLoaded` / `restartConversation`** — delegate to
  `createDocumentViewerHandlers()` (only relevant when layout is `docview`).

### `header/languageSelector.ts`

Returns a WXO custom header dropdown for locale switching (en, fr, de, es, ja, it).
On change: call `chatInstance.updateLocale(locale)` and rebuild the header items array
to reflect the new locale text.

### `header/layoutSwitcher.ts`

Returns a WXO custom header button that toggles between the saved default layout and
fullscreen. Use Carbon's Expand/Shrink icons encoded as SVG data URIs. On click:
`saveLayoutPreference(newLayout, suffix); window.location.reload()`.

### `header/dragHandle.ts`

Float layout only. Sets up `mousedown`/`mousemove`/`mouseup` listeners on the
`.wxo-float-header` element to make the `.wxo-float` container draggable within
viewport bounds. Use a `MutationObserver` to re-attach handlers if WXO recreates the
DOM (e.g. after minimize/maximize). Initialize with a ~2 s delay to let WXO render.

### `header/documentViewer.ts`

Docview layout only. Two exports:

- **`getCustomHeaderItem()`** — WXO header button (document icon) that
  shows/hides the `#doc-viewer` panel.
- **`useDocumentViewerEffects(containerId)`** — React hook; attaches a
  `MutationObserver` to intercept link clicks inside the WXO container and open them
  in the viewer panel instead of a new tab.
- **`createDocumentViewerHandlers()`** — returns `pre:receive`, `pre:send`,
  `pre:threadLoaded`, `restartConversation` handlers that extract URLs from message
  text, display them as tabs in the viewer, and reset the viewer on new conversation.

### `core/OrchestrateChat.tsx`

The component that owns one WXO instance. Key points:

- Reads config from env via `getEnvWithSuffix("VITE_WXO_ORCHESTRATION_ID", suffix)` etc.
- Guards against double-init with a **module-level `Set`**, not a `useRef`. React
  Strict Mode mounts → unmounts → remounts every component in development, resetting
  refs; the Set persists across remounts:
  ```ts
  const initializedContainers = new Set<string>();

  // inside the useEffect:
  if (initializedContainers.has(containerId)) return;
  initializedContainers.add(containerId);
  ```
- Assigns `window.wxOConfiguration` **first**, then calls `loadWxoScript(hostURL)`,
  then calls `window.wxoLoader.init()`. Order matters — the loader reads the config
  synchronously at parse time.
- `rootElementID` is **always required**, for every layout form including `float`.
  Without it the widget has no container and silently does nothing:
  ```ts
  window.wxOConfiguration = {
    orchestrationID,
    hostURL,
    rootElementID: getWxoContainerId(suffix), // required for ALL layout forms
    // showLauncher: false is only meaningful for fullscreen-overlay; omit for float
    ...(layout !== "float" && { showLauncher: false }),
    // Auto-detect CP4D vs IBM Cloud from the host URL:
    deploymentPlatform: (hostURL ?? "").includes("cpd") ? "cp4d" : "ibmcloud",
    crn: null,
    chatOptions: { agentId, agentEnvironmentId, onLoad },
    defaultLocale: "en",
    layout: {
      showHeader: true,
      form: layout === "custom" ? "custom"
          : layout === "float"  ? "float"
          : "fullscreen-overlay",
      customElement: layout === "custom" ? containerRef.current : null,
      showOrchestrateHeader: true,
      width: "600px", height: "600px",
    },
    style: { showBackgroundGradient: true, fontFamily: "IBM Plex Sans, sans-serif" },
    header: { showResetButton: true, showAiDisclaimer: true, showAgentAvatar: false },
    features: { showThreadList: layout !== "float", showAgentMemory: false },
    // Anonymous access — empty string = no token required.
    // Replace with a real token for authenticated embedding.
    authTokenNeeded: (event) => { event.authToken = ""; },
  } satisfies WxoConfiguration;
  ```
- In `onLoad(instance)`: call `enableBodyScroll()` immediately (WXO sets
  `overflow:hidden` on both `body` and `<html>` during init). Also call
  `enableBodyScroll()` again inside the `onLoad` callback for any deferred paint.
  Then register event handlers, build the custom header items array (language selector
  + layout switcher if applicable + doc viewer button if docview), and call
  `instance.updateCustomHeaderItems(headerItems)`.
- Sync theme with `useWatsonxTheme(containerId)`.
- On unmount (non-float): call `destroyChat(containerId)`.
- Render the container div **in the React tree** (return it from JSX). Do not append
  a detached div to `document.body` — the WXO float widget still takes over the
  viewport regardless; `enableBodyScroll()` is the correct fix.
  ```tsx
  return <div id={containerId} ref={containerRef} className="h-full w-full" />;
  ```

### `core/OrchestrateLayout.tsx`

Reads the initial layout from `getInitialLayout(suffix)`, holds it in React state.
Routes to the correct wrapper:

- `custom` → `<CustomComponent>`  
- `docview` → `<OrchestrateChat>` + `<DocumentViewPanel>`  
- `float` / `fullscreen` → `<OrchestrateChat>`

Saves the default layout to localStorage on mount (`saveDefaultLayout(suffix)`).

### `core/CustomComponent.tsx`

Two-column layout using Carbon tokens and Tailwind. Left panel: branding, "How to Use"
guide, links. Right panel: `<OrchestrateChat>`. Include a button to expand the chat
to full width (hides the left panel). Use only Carbon design tokens for colors — no
hardcoded hex values. Mark the descriptive copy as placeholder text so the user knows
to replace it.

### `core/DocumentViewPanel.tsx`

A fixed right-side panel (`#doc-viewer`, initially `display:none`). Contains:

- A resizer handle (drag to resize width).
- Close and "open in new tab" buttons.
- A content area where `documentViewer.ts` renders iframes/tabs.

Uses `window.addEventListener("doc-viewer-url-change", ...)` to track the current URL
for the "open in new tab" button.

## Step 4 — Add the route

Create `frontend/src/routes/_layout/wxo.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import OrchestrateLayout from "@/components/watsonx/core/OrchestrateLayout";

export const Route = createFileRoute("/_layout/wxo")({
  component: WxoPage,
});

function WxoPage() {
  // fullscreen and docview need to fill the viewport, so override the
  // parent layout's padding (mx-auto px-4 pt-20 in _layout.tsx):
  return (
    <div className="-mx-4 -mt-20 h-dvh pt-12">
      <OrchestrateLayout />
    </div>
  );
}
```

For `float` and `custom` layouts the standard page padding is fine — remove the
negative-margin wrapper and render `<OrchestrateLayout />` directly.

## Step 5 — Add navigation

Read `frontend/src/routes/_layout.tsx`, then:

1. Add `"/wxo"` to the `AppRoute` union type.
2. Add to `navItems`: `{ to: "/wxo", label: "Chat" }`.

## Step 6 — Add env variables

Add to `frontend/.env` and `frontend/.env.example` (NOT the root `.env`). Vite's default
`envDir` is the directory containing `vite.config.ts` — i.e. `frontend/`. The root `.env`
is only read by the manual `loadEnv()` call used for `API_PORT`/`WEB_PORT` in the server
config block; it does NOT populate `import.meta.env`. Always put `VITE_*` vars in
`frontend/.env`.

> **Exception:** If `frontend/vite.config.ts` explicitly sets `envDir: "../"`, then the
> root `.env` is correct. Check before writing — never assume.

```env
# watsonx Orchestrate embedded chat
# Values from: WXO console → agent builder → Channels → Embedded agent
VITE_WXO_ORCHESTRATION_ID=
VITE_WXO_HOST_URL=
VITE_WXO_AGENT_ID=
VITE_WXO_AGENT_ENVIRONMENT_ID=
# Layout: float | custom | fullscreen | docview
VITE_WXO_LAYOUT=<chosen-layout>

# Multi-agent: suffix all four keys with _2, _3, … for additional agents
# VITE_WXO_ORCHESTRATION_ID_2=
# VITE_WXO_HOST_URL_2=
# VITE_WXO_AGENT_ID_2=
# VITE_WXO_AGENT_ENVIRONMENT_ID_2=
# VITE_WXO_LAYOUT_2=
```

## Step 7 — Theme sync (not scaffolded)

WXO theme sync is **not scaffolded** by this skill. Achieving it robustly requires a
complete set of CSS/SCSS overrides that beat WXO's own highly specific hardcoded rules
(e.g. `div.WxOChatContainer.WxOChatReset.WxOChatStyles .wxo-float-header ... svg`).
A partial implementation leaves individual surfaces with wrong colours and is harder
to debug than no implementation at all.

The `useWatsonxTheme` hook is scaffolded as a no-op placeholder. The WXO widget will
render with its own default theme regardless of the app's light/dark setting.

To implement theme sync properly:
1. Obtain the full CSS override set from your WXO embed reference project.
2. Stamp `cds--g100` (dark) / `cds--white` (light) on `<html>` from `theme-provider.tsx`.
3. Apply the overrides in the app's main stylesheet, scoped to those zone classes.

## Step 8 — Verify

Run `pnpm typecheck` inside `frontend/` — must pass with no new errors.

Then tell the user:
- The chat page is at `/wxo`.
- Fill in the four `VITE_WXO_*` variables from the WXO agent builder under
  **Channels → Embedded agent** before the widget will load.
- Security is set to **anonymous** (`authToken = ""`). To require authentication,
  enable the WXO security feature and replace the empty string with a real token
  in the `authTokenNeeded` callback in `OrchestrateChat.tsx`.
- If the `VITE_WXO_*` vars show as `undefined` at runtime, confirm that
  `frontend/vite.config.ts` sets `envDir: "../"` (see Step 6 note).

## Key constraints

- **No new npm dependencies** — `@carbon/react` and `@carbon/icons-react` are already
  in `frontend/package.json`.
- **Theme hook** — always use `resolvedTheme` from `@/components/theme-provider`, not
  `actualTheme` (that field does not exist in this starter).
- **Carbon zone classes** — WXO uses `cds--g100` / `cds--white`. The CEN Starter
  default (`cds--g90` / `cds--g10`) must be changed in `theme-provider.tsx` (Step 7)
  or theme sync and all SCSS overrides will be scoped to the wrong ancestor class.
- **Carbon tokens only** — never hardcode colors; use `cds--*` token classes or
  Tailwind mappings from `carbon-map.css`.
- **`rootElementID` always required** — set it for every layout form, including float.
- **Config before script** — `window.wxOConfiguration` must be assigned before
  `loadWxoScript()` is called; never set it inside an `onload` callback.
- **`enableBodyScroll` clears both** — must reset `overflow` on both `document.body`
  and `document.documentElement`; resetting only `body` is not enough.
- **Strict Mode guard** — use a module-level `Set`, not `useRef`, to prevent
  double-init; refs are reset during React Strict Mode's unmount/remount cycle.
- **Multi-agent** — `suffix` prop on `<OrchestrateLayout>` routes to suffixed env vars
  with fallback to the unsuffixed defaults. Pass no suffix for a single agent.
