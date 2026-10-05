# Handoff: x402 Card — one-page demo site

## Overview
Marketing/demo landing page for **x402 Card**: virtual spend cards for AI agents, addressed by ENS name. Core message: **"Fund an agent by name. Never handle a card number."** The page is a hero with an interactive 3D card, then a five-beat scroll story (one cause → effect animation per section), a live activity feed, a CTA, and a footer stating "Sandbox demo, no real money."

## About the Design Files
`x402 Card.dc.html` is a **design reference built in HTML**: a working prototype that shows the intended look, copy, and motion. It is not production code to copy over. (It runs on a small in-house template runtime, `support.js`, which you should not port.) Rebuild the page in the target codebase's stack. If no stack exists yet, a good fit is **Next.js / React + TypeScript**, with the Web Animations API or Motion (Framer Motion) for the timelines. All animation logic lives in the `class Component` script at the bottom of the HTML file. Read it as the reference timeline: every duration, delay, and easing below comes from it.

To view the reference, open `x402 Card.dc.html` in a browser, with `support.js` next to it.

## Fidelity
**High-fidelity.** Final colors, type, spacing, copy, and motion. Recreate it pixel-accurately.

---

## Design Tokens

### Colors
| Token | Value | Use |
|---|---|---|
| bg | `#0a0b0d` | page background |
| surface | `#0f1115` | stage panels, feed panel, CTA panel |
| surface-2 | `#101216` | hero search bar |
| inset | `#0a0b0d` | inputs/record panels inside stages |
| chip | `#15181e` | merchant charge chips |
| text | `#eceef1` | primary text |
| text-2 | `#b9bdc6` | cause/effect values, secondary mono |
| muted | `#8b909a` | body copy, labels |
| dim | `#5d626c` | tertiary labels, timestamps |
| headline-muted | `#6b707a` | second clause of the H1 |
| line | `rgba(255,255,255,0.06)` | section dividers, feed rows |
| line-2 | `rgba(255,255,255,0.08)` / `0.07` / `0.10` / `0.12` | panel / stage / input / chip borders |
| **accent** | `oklch(0.74 0.19 258)` (≈ `#5b8cff`) | the single electric accent: buttons, glows, tags, fill bar |
| accent-light | `oklch(0.82 0.12 258)` / `oklch(0.86 0.1 258)` | accent text on dark, tag text |
| accent-soft | `oklch(0.74 0.19 258 / 0.12–0.14)` | tag/pill backgrounds, row highlight |
| success | `oklch(0.8 0.16 155)` | approved, active status |
| error | `oklch(0.7 0.19 25)` | declines, anomaly |
| warning | `oklch(0.84 0.14 80)` | paused / pending human |
| ice | `oklch(0.9 0.05 230)` (stamp bg `oklch(0.92 0.04 230)`) | frozen state |

Status colors (success/error/warning/ice) are semantic only. Accent is the only brand color.

### Typography
- Sans: **Geist** (300–700). Mono: **Geist Mono** (400–600). Google Fonts.
- Mono is used for **every ENS name, text record, card number, amount, status code, label/kicker**.
- H1: `clamp(42px, 6vw, 76px)`, weight 500, line-height 1.02, letter-spacing −0.035em, `text-wrap: balance`.
- H2 (sections): `clamp(30px, 3.6vw, 46px)`, 500, lh 1.08, ls −0.03em.
- CTA H2: `clamp(32px, 4.4vw, 56px)`, 500, lh 1.05, ls −0.035em.
- Body: 17px, lh 1.6, muted (hero sub is 18px).
- Kicker: mono 12px, ls 0.08em, uppercase. Step number in accent-light, label in muted.
- Cause/effect block: mono 12.5px, 2-col grid `64px 1fr`, gap `6px 12px`, labels dim, values text-2, top border line-2, padding-top 18px.
- Wordmark: `x402·card`, Geist 600, ls −0.02em, with the `·` in accent.

### Radii
Card 18px (hero 22px) · stage 24px · CTA panel 28px · search bar 14px · primary buttons 12px · inner input 12px · small button 8–10px · tags 5–6px · pills 999px.

### Shadows
- Card: `0 30px 60px -24px rgba(0,0,0,0.8)`. Hero card: `0 40px 80px -30px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.08)`.
- Accent glow: `0 0 50px oklch(0.74 0.19 258 / 0.45)`.

### Spacing / layout
- Content max-width 1200px. Horizontal padding `clamp(20px,5vw,48px)`.
- Section vertical padding `clamp(72px,12vh,140px)`.
- Section grid: `repeat(auto-fit, minmax(min(100%,380px), 1fr))`, gap `clamp(36px,6vw,80px)`, center-aligned. This collapses to one column on mobile with no media queries.
- Stage: `min-height: 460px`, padding `clamp(24px,4vw,40px)`, content column max-width 360px, centered.

---

## Shared component: Agent Card
Aspect ratio **1.586** (ISO card), width 100%, max 340px (hero: 440px).
- Background `linear-gradient(140deg, #1c2029 0%, #111318 55%, #0b0c10 100%)`, border 1px `rgba(255,255,255,0.1)`, overflow hidden, padding `20px 22px`, flex column `space-between`.
- Glow overlay: `radial-gradient(90% 70% at 100% 0%, accent/0.22, transparent 60%)`.
- Top row: wordmark (15px) left, `AGENT · VIRTUAL` (mono 10px, ls 0.12em, muted) right.
- EMV chip: 36×27, radius 6, `linear-gradient(135deg,#3b404b,#22252c)`, 1px border `rgba(255,255,255,0.12)`.
- Bottom: masked number `•••• •••• •••• 7318` (mono 12.5px, ls 0.14em, muted) and ENS name (mono 14px, text).
- Hero adds a **sheen** layer: `linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.07) 50%, transparent 60%)`, 200% wide, translated with the tilt. It also adds a **glow ring** (1px accent border + accent glow) that flashes on resolve.

Build this once as `<AgentCard name last4 tags? spent? state="active|frozen" />`.

---

## Screens / Sections

### Nav (sticky)
Background `rgba(10,11,13,0.72)` + `backdrop-filter: blur(14px)`, bottom border line. Left: wordmark 17px + `SANDBOX` pill (mono 10.5px, ls 0.1em, 1px border, radius 999). Right: links "How it works" (#beat-1), "Activity" (#feed) in muted 14px, and an "Issue card" pill button (bg text color, dark text, hover → accent-light).

### Hero
Two-column grid (`minmax(min(100%,440px),1fr)`). Padding top `clamp(56px,10vh,120px)`.
- **Left:** kicker `SPEND CARDS FOR AI AGENTS · ADDRESSED BY ENS`. H1 "Fund an agent by name." followed by "Never handle a card number." in headline-muted. Sub copy: "x402 Card issues virtual cards to AI agents, addressed by ENS name. Policy lives in text records. Humans approve the exceptions." (max-width 480).
- **Search bar:** surface-2, 1px border, radius 14, padding `14px 14px 14px 18px`. Contents: magnifier icon, a real `<input>` (mono 15px, placeholder `yourbot.x402card.eth`), and a `RESOLVED` pill (mono 11px, accent-light on accent-soft) that fades in on resolve.
- **Buttons:** primary "Issue an agent card" (accent bg, `#0a0b0d` text, 15px/500, padding 13×20, radius 12, hover `oklch(0.8 0.17 258)`). Secondary "See how it works" (1px border `rgba(255,255,255,0.14)`, `white-space: nowrap`).
- **Right:** stage with `perspective: 1200px`, min-height `clamp(300px,40vw,460px)`, a blurred accent radial "floor glow" under the card, and the hero card. Below it is a mono 12px resolver line: `researcher.x402card.eth → card ••4021 · active`.

### 01 — Name → Card
Copy: H2 "A name is the whole interface." Body: "Type an ENS name and a virtual card is issued against it. The 16-digit number exists, but your agent never sees it. It pays by name." Cause/effect: type scout.x402card.eth → card issued, number masked.
Stage: fake input (placeholder "type an ENS name", blinking accent caret, "Issue" button), then a card (initially hidden), then the caption "number: never exposed · handle: scout.x402card.eth".

### 02 — Policy lives in ENS
H2 "Limits are just text records." Body: "Spend rules are stored on the name itself. Change a record and every charge is checked against the new value. No dashboard, no redeploy."
Stage: an ENS text-record panel (header `researcher.x402card.eth` / `TEXT`) with rows `card.limit.tx 50`, `card.limit.monthly 500`, `card.mcc.allow software`. Below it is a card with three hidden tags stacked on the right edge: `tx ≤ $50`, `month ≤ $500`, `mcc: software`. Tag style: mono 10.5px, accent-light text, accent-soft bg, 1px accent/0.5 border, radius 6.

### 03 — Spend
H2 "In-policy charges clear. The rest bounce." Body: "Every authorization is checked against the card’s records in real time. A decline tells the agent exactly which rule it hit, so it can adapt instead of retrying."
Stage: charge chip slot (two pill chips stacked: `$42.00 ModelHub API · MCC 5734` and `$18.00 SpinPalace · MCC 7995`), then a card showing static tags (`tx ≤ $50`, `mcc: software`) and a `SPENT / MO $0 / $500` readout, then a result slot: green `✓ APPROVED · $42 ≤ card.limit.tx` or red `✕ MERCHANT_CATEGORY_NOT_ALLOWED` with `7995 ∉ card.mcc.allow` underneath.

### 04 — Funding by name
H2 "The agent asks. A human says yes." Body: "When an agent needs more than its policy allows, the request pauses. You approve once; the allowance and the ENS record update together."
Stage (vertical flow joined by 1px × 22px connectors): request box (`researcher.x402card.eth` · "requests funds · dataset license" · `+$300`), then a policy engine row (status dot + `policy` + status text), then an "Approve $300" button with a pulse ring and the note "human in the loop · alice.eth", then the allowance block: label "Monthly allowance", value `$500`, an 8px track with accent fill at 50% (scale $0–$1,000), and the record line `card.limit.monthly = 500`.

### 05 — Kill switch
H2 "Anomaly in. Card frozen." Body: "Velocity spikes, new IPs, odd merchants. The engine freezes the card and writes the status to ENS, so every resolver sees it at once."
Stage: a 28-bar velocity chart (96px tall, bars `rgba(255,255,255,0.16)`, gap 3px, labels `tx / 10s`, `last 5 min`), the hidden alert `ANOMALY · 38 tx in 60s · 12× baseline` (error color), a card with a hidden frost overlay and `FROZEN` stamp, the record `card.status = active` (in success color), and the hidden line `next charge → CARD_FROZEN`.
Frost overlay: two soft white radials + `linear-gradient(160deg, rgba(210,228,255,.20), rgba(170,200,240,.10))`, `backdrop-filter: blur(7px) saturate(.5)`, inset ring `rgba(220,235,255,.35)` + inner glow.

### Activity feed (#feed)
Left: live dot (success, pulsing) + `LIVE · SANDBOX STREAM`. H2 "Every agent, every charge, by name." Body: "One feed across your fleet. Declines carry their rule, holds wait for a human, freezes show up the moment they happen."
Right: a surface panel with rows. Row grid is `62px minmax(0,1fr) auto`, gap 14, padding 14px 0, top border line. Columns: time (mono 11.5px, dim, HH:MM:SS) · agent ENS (mono 13px) over merchant (13px, muted) · amount (mono 13px) over a status pill (mono 10px, ls 0.06em, radius 5).
Status pills: `APPROVED` success · `MCC_NOT_ALLOWED` error · `PENDING_HUMAN` warning · `FUNDED` accent · `FROZEN` ice. Each uses its color on a 10–14% tint of the same color.

### CTA
Centered panel, radius 28, `radial-gradient(80% 120% at 50% 0%, accent/0.12, transparent 60%)` over surface. H2 "Give your agent a name, not a number." Sub: "Pick a name, set three records, and it can pay. Takes about a minute in the sandbox." Button "Issue an agent card" (16px, padding 15×26).

### Footer
Wordmark (muted) left. Mono 12px **"Sandbox demo, no real money."** right. Top border line.

---

## Interactions & Behavior

### Global principles
- Motion explains cause → effect and is never ambient decoration (the hero bob is the one exception).
- Animate only `transform`, `opacity`, `filter`, `box-shadow`, and `background`/`color`, so it stays at 60fps.
- Default easing: `cubic-bezier(.2,.8,.2,1)`.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no tilt, no bob, no loops. Every beat jumps straight to its end state (durations ≈ 1ms, waits ≤ 20ms). Hero is pre-filled and resolved. Smooth scroll is off.

### Hero tilt
- Pointer position relative to the card center is normalized to −1..1 and clamped.
- On mobile, `deviceorientation` replaces it: `gamma/30`, `(beta−45)/30`. On iOS 13+ you may need a `DeviceOrientationEvent.requestPermission()` call on first tap.
- Each rAF frame lerps toward the target (factor 0.07) and applies: `translateY(sin(t/1500)*6px) rotateX(-y*10deg) rotateY(x*14deg)`.
- Sheen translates `x*22%`.

### Hero resolve
- Auto-types `researcher.x402card.eth` starting at 700ms, with 55–100ms per character.
- While the name is incomplete, progress `p = min(1, len/target.len)*0.9` drives the card: opacity `0.12 + 0.45p`, `blur(12(1−p)px)`, `translateY(18(1−p)px) scale(0.94 + 0.03p)` (250ms transitions).
- The card name mirrors the input live.
- **Resolve condition:** the input matches `/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i`. Then the card animates to opacity 1, blur 0, transform none (opacity/filter 700ms `cubic-bezier(.2,.9,.2,1)`, transform 800ms `cubic-bezier(.2,1.2,.3,1)` slight overshoot). The glow ring flashes (0→1→0, 1100ms). The `RESOLVED` pill and resolver line fade in.
- Last 4 digits: `4021` for the default name, otherwise a deterministic hash of the name.
- When the user focuses or types, auto-typing stops and their input drives the card. Editing back to an invalid name un-resolves it.
- **Every "Issue an agent card"/"Issue card" button:** smooth-scroll to top, clear the input, focus it (after 450ms).

### Beat triggering
- An IntersectionObserver (threshold 0.45) plays each stage once on first view.
- The `↻ replay` pill (top-right of the stage) resets and replays. Reset cancels all animations, restores the original text, and removes clones.
- Starting a new run cancels the old one (token check after every await).

### Beat 1 timeline
1. Wait 350ms. Placeholder fades out (150ms). Caret blinks (1s step loop).
2. Type `scout.x402card.eth` (55–85ms/char).
3. Wait 250ms. Issue button press: scale 1→0.93→1 (260ms), plus an accent ring expanding 0→14px and fading (450ms).
4. Card enters: opacity 0→1, `translateY(28px) scale(.96)` → none (700ms).
5. Number **scrambles**: 12 frames × 45ms of random 16 digits, then settles to `•••• •••• •••• 5880`. This shows the number exists but is masked.
6. Name types onto the card (26ms/char). Caption fades up (500ms).

### Beat 2 timeline
For each of the 3 records:
1. The row highlights to accent-soft (280ms).
2. A **clone of the target tag** spawns centered on the record value and flies to its card slot (700ms, `cubic-bezier(.45,0,.2,1)`). Mid-flight it scales up to 1.06 and its glow peaks.
3. The real tag appears and the clone is removed.
4. The row highlight fades out (500ms). Wait 180ms.

Finally the card border pulses accent once (900ms).

### Beat 3 timeline
1. The `$42` chip drops in (450ms) and holds for 450ms.
2. It flies into the card center: translateY to the card center, scale 0.4, fade out (560ms, ease-in `cubic-bezier(.55,0,.8,.2)`).
3. The card pulses (scale 1.025 + green ring/glow, 800ms).
4. Spent changes to `$42 / $500` (flashes green). `✓ APPROVED` fades up. Hold 1500ms, then fade out.
5. The `$18` chip drops in. It moves 50% of the way to the card (380ms ease-in), then turns red (border + tint). The card nudges 4px.
6. The chip **bounces back** (−12px) and shakes on X (−9, 8, −5, 3, 0px) over 800ms ease-out. The red `MERCHANT_CATEGORY_NOT_ALLOWED` fades in after 350ms.

### Beat 4 timeline
1. Request box fades down in (450ms). Connector 1 grows (scaleY, 300ms). Policy row fades in. Status `evaluating…` with a white dot (800ms).
2. Status becomes `PAUSED · $300 > card.limit.tx` in warning color. Row border turns warning. Dot pulses (warning ring 0→7px, 1.2s loop).
3. Connector 2 grows. The approve area goes from opacity 0.25 to 1. An accent ring pulses around the button (scale 1→1.18 fading, 1.4s loop).
4. **The timeline waits for a real click on "Approve $300"** (no auto-approve).
5. On click: button press, label becomes `Approved ✓` on a success background. Status becomes `RELEASED · approved by alice.eth` in success color; the dot turns solid green.
6. After 250ms the record becomes `card.limit.monthly = 800` (flashes accent-light). The fill animates `scaleX(.5 → .8)` (1100ms `cubic-bezier(.4,0,.2,1)`) while the value counts `$500 → $800` with ease-out cubic.

### Beat 5 timeline
1. The last 8 bars spike one after another, 85ms apart. Each scales to a target height of `min(92, 46 + i*7)px` and turns error red (380ms, overshoot `cubic-bezier(.3,1.3,.5,1)`).
2. The anomaly alert fades up. Wait 400ms.
3. The **frost overlay** fades in (1100ms `cubic-bezier(.3,.6,.3,1)`) while the card picks up an icy outer glow.
4. The status record **flips**: rotateX 0→90° (170ms ease-in), the text swaps to `frozen` in ice color, then −90→0° (220ms ease-out).
5. The `FROZEN` stamp appears (scale 1.15→1, 380ms). `next charge → CARD_FROZEN` fades in.

### Activity feed
- Starts with 6 seeded rows, timestamps a few seconds to minutes in the past.
- Every 2600ms a new event is prepended (rotating through the event list below) with the current time. It enters from `translateY(-8px)` with an accent tint flash (900ms). Show a maximum of 6 rows; the oldest drops off.
- Sample events (agent → merchant · amount · status): researcher → ModelHub API · inference $4.12 APPROVED; scout → Vectorbase · storage $11.00 APPROVED; travel-bot → SkyFare · airline $389.00 PENDING_HUMAN; ops-copilot → Computa · GPU hours $27.40 APPROVED; pricing-bot → SpinPalace · gambling $18.00 MCC_NOT_ALLOWED; researcher → alice.eth · top-up +$300.00 FUNDED; scout → DataLoom · datasets $46.00 APPROVED; ledger-bot → velocity anomaly — FROZEN; ops-copilot → MailRelay · email API $2.80 APPROVED; travel-bot → GeoTile · maps API $6.50 APPROVED; pricing-bot → LuxeGoods · retail $129.00 MCC_NOT_ALLOWED. All agents are `<name>.x402card.eth`. All merchant names are fictional.
- In production, swap the timer for a WebSocket/SSE sandbox stream.

### Hover states
- Primary buttons: accent → `oklch(0.8 0.17 258)`.
- Ghost button: border to `rgba(255,255,255,0.3)`.
- Replay pill: text and border brighten.
- Nav links: muted → text.

### Responsive
Every two-column grid collapses through `auto-fit/minmax`. Type uses `clamp()`. Cards scale with width (they keep their aspect ratio). Stages keep `min-height: 460px`. Feed rows truncate the agent and merchant with ellipsis. There are no fixed widths beyond max-widths.

## State Management
- Hero: `inputValue`, `autoTyping` (stops on user focus/input), and derived `progress` and `resolved`.
- Per beat: `runToken` for cancellation and replay, and `hasPlayed` (from the IntersectionObserver). Beat 4 also needs `awaitingApproval` (a promise or resolver) and the derived `allowance` (500 → 800).
- Feed: a `rows[]` capped at 6, fed by an interval or a stream.
- `prefersReducedMotion`, from `matchMedia` (listen for changes too).
- Everything is client-side and mocked: a sandbox with no real money. Real integrations later: ENS text-record reads/writes, card issuing, and the authorization stream.

## Assets
No raster assets. Icons: an inline magnifier SVG (a circle plus a line), and the ✓ / ✕ / ↻ glyphs. Fonts: Geist and Geist Mono from Google Fonts. Card chip and gradients are pure CSS.

## Files
- `x402 Card.dc.html`: the full reference (markup with inline styles, plus a `class Component` script holding every animation timeline: `initTilt`, `initHero`, `beat1`–`beat5`, `initFeed`).
- `support.js`: runtime needed only to open the reference in a browser. Do not port it.
