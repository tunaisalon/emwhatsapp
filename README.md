# EM Bridal — WhatsApp Auto-Reply + Gown Catalog + Booking Flow

Rule-based. No AI, no API cost. The bot only ever says text **you** typed into the admin page.

## Three pages

| URL | What it's for |
|---|---|
| `/qr` | Scan once to link WhatsApp |
| `/admin` | Edit replies, upload gown photos per style, build booking flows |
| `/leads` | Bookings the bot captured — mark new / contacted / booked / lost, export CSV |

## How it behaves

Mirrors the flow you and Liwen already run by hand:

1. Bride messages (usually off a Meta ad) → **greeting**, optional banner image
2. → **info block**: studio positioning, wedding gown RM599-999, ROM RM399-599, then *"What styles of gown are you looking for ya?"* with your series listed
3. She picks a series (number, name, or a loose phrase like "modest" / "简约")
4. → *"Got it ya {name}"* — her WhatsApp display name, used automatically — then asks **event date** and **clothing size** in one message
5. She answers in any order, in one message or two. The bot pulls out whatever it recognises and asks only for what's missing
6. → *"Nicee hehe"* → **photos of her chosen series** → *"Here's some of our ROM Series, and more in studio ya"*
7. → the fitting invitation, including the "bridal gown is a very unique item" line
8. Lead saved to `/leads` with name, series, date, size and a one-tap wa.me link

Other behaviour:
- **Away message** outside business hours — off by default, toggle in Admin → Replies
- **You reply manually** → bot goes silent in that chat for 24h and drops any half-finished flow
- **`/pause` `/resume`** → type these yourself in any chat
- **`/reset`** → wipes that chat's state and replays the opening. Works from either side, so you can retest the whole flow from your own phone without waiting out the 24h greeting cooldown
- **"cancel" / "human"** mid-flow → exits cleanly; 12h of silence abandons the flow
- **Several styles in one answer** — "2 or 4", "chic and rom", "any", "都可以" all work. She gets photos of each, labelled by style, capped so it never becomes a 20-photo burst
- **Direct style mention** ("do you have long sleeve?", "有短裙吗") → sends that series' photos immediately
- Never replies in groups, status or broadcasts
- **Brand-new conversations only** — optional. When a phone is linked, WhatsApp sends its existing chats and the bot snapshots them; with this on, anyone in that snapshot is ignored and only genuinely new enquiries get the flow. Numbers on the test list are exempt, so you can keep testing from your own chat
- **Muted contacts** — numbers on the blocklist get nothing, in either direction. Set them in Admin → Replies
- **Test mode** — tick "reply only to these numbers" to run the bot live while it answers only you. Contact matching checks every identifier WhatsApp supplies (phone number and LID), so it still works on accounts where WhatsApp hides the number behind a LID

## What you control from `/admin`

**Replies tab** — greeting, away message, fallback, handoff, business hours, re-greet cooldown, pause duration, and every keyword rule (name, keywords, reply text, image URLs).

**Opening messages.** Both the greeting and each flow's opening are now block sequences: add as many text bubbles and photos as you like, reorder with ↑ ↓, delete any. Each block sends as its own WhatsApp message, photos can carry a caption, and `{name}` inserts her WhatsApp display name.

**Gowns tab** — one card per style (Long, Short, Modest/Muslimah, ROM, Lace, Satin are seeded; add your own). Per style: display name, the caption sent with the first photo, the keywords that pull it directly, a show/hide toggle, and drag-free photo management — upload multiple at once, reorder with ← →, delete. The first N photos (default 5) are what the bot sends; the rest sit greyed out as your bench. Uploads save immediately.

**Flows tab** — per flow: which keyword starts it, opening message, and for each question: the exact wording, where the answer is saved, free-text, numbered choice, **gown styles**, or **two details at once** (date + size, parsed out of free text), and the error line when the answer doesn't parse. Reorder questions with ↑↓. Then the confirmation template (use `{name}`, `{eventDate}` etc.), the success message, restart/cancel/timeout lines, and the word lists for yes/no/cancel.

Flows have a **live** toggle — build one, leave it off, flip it on when the wording is right.

Saves apply to the next incoming message. No redeploy.

## Changing the WhatsApp number

Admin → Replies → **WhatsApp connection** → *Unlink this number*. That logs the current phone out, deletes the stored session and clears the bot's per-chat memory, then reopens the QR page so you can scan with a different phone. Nothing else is touched — replies, flows, gown photos and leads all stay.

If the number is unlinked from the phone instead (WhatsApp → Linked devices → log out), the bot notices, clears the dead session by itself and shows a fresh QR.

The QR page is password-protected — open it as `/qr?pw=YOURPASSWORD`, or use the button in the admin page.

## Files

| File | Purpose |
|---|---|
| `index.js` | Baileys connection, message routing, pause logic |
| `rules.js` | Keyword matching + business hours |
| `flow.js` | Step engine, validation, lead capture |
| `catalog.js` | Gown styles, photo storage, photo sending |
| `server.js` | QR page, admin/flows/leads APIs |
| `replies.json` | Seed keyword rules |
| `flows.json` | Seed booking + browse flows |
| `catalog.json` | Seed gown styles |
| `public/admin.html`, `public/leads.html` | The two UIs |

Seed JSON is copied into `DATA_DIR` on first boot; after that the admin page is the source of truth.

## Run locally

```bash
npm install
ADMIN_PASSWORD=yourpw node index.js
```
→ http://localhost:3000/qr

## Deploy on Railway

1. Push to a new GitHub repo.
2. Railway → New Project → Deploy from GitHub.
3. Variables: `ADMIN_PASSWORD`, `AUTH_DIR=/app/data-store/auth`, `DATA_DIR=/app/data-store/data`
4. Attach a Volume mounted at `/app/data-store` — this keeps the WhatsApp session, your edited replies/flows, and the leads list across redeploys. **Without it you lose everything on each deploy.**
5. Open the Railway URL + `/qr` and scan.

## Before going live

Fill the `[bracketed]` placeholders via `/admin` → Replies:
studio address + Maps link, fitting fee, deposit amount, rental period, late/damage policy, Instagram handle.

Then **upload photos** under Gowns — until you do, the bot sends the style caption as text only. Use portrait shots, under 8MB each; the first photo of each style is the one carrying the caption, so lead with your strongest.

⚠️ **Direct-match keywords need care.** A bare keyword like `long` would fire on "how long is the rental?". The seeded keywords are deliberately phrases (`long gown`, `short dress`). Keep it that way when you add styles.

## Note

Baileys is unofficial. Keep volume low, never cold-message strangers, and take over real conversations manually — the auto-pause exists for that.
