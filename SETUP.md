# SETUP

This file is written for **Claude Code** to follow with you, and it works as a checklist if you do it alone.
Every step says who does it:

- **Claude does this.** Claude runs the command, or clicks in your Chrome (Claude in Chrome extension).
- **You do this manually.** Logins, your phone, and anything that touches your access token. Claude stops,
  tells you exactly what to do, and waits until you say it's done.

It takes about 20 minutes. You need:

- an **Instagram professional account** (Creator or Business; switching is free: Instagram app → Settings and
  activity → Account type and tools → Switch to professional account),
- a **second Instagram account** to send a test comment from (your own comments are skipped on purpose),
- **Node.js 20 or newer**,
- **Chrome** with the Claude in Chrome extension connected to Claude Code (without it, Claude reads each dashboard
  step to you and you click).

## Rules for Claude

1. **Never read, print, copy, screenshot or ask for the access token**, and never open `.state/token.json`. The
   person pastes the token into `npm run auth` in **their own terminal window**. While the dashboard shows the
   token (step B6), take no screenshots and read nothing on that page.
2. Stop at every **You do this manually** step, say what to do in plain words, and wait.
3. Ask before anything that publishes or changes something outside this folder: creating the privacy-policy page,
   publishing the Meta app, deploying the Worker, switching the Worker to `live`.
4. Meta renames its dashboard often. Each step gives the **goal** first. If a label differs, find the equivalent,
   and tell the person what you clicked.
5. Never run the local timer and the Worker at the same time.
6. Ask the person for anything personal (app contact email, name for the privacy policy). Don't guess.

---

## Part A. This folder

**A1. Claude does this.** In the cloned folder, run `node --version` (20 or newer) and `npm test`. All tests
pass, and there is nothing to install: the script has no dependencies.

## Part B. The Meta app

The goal: a Meta developer app with the Instagram API (Instagram Login), three permissions, your account added,
published (Live), and a token for your account stored locally.

**B1. You do this manually.** Claude opens [developers.facebook.com/apps](https://developers.facebook.com/apps)
in Chrome. You log in with Facebook. The first time, Meta asks you to register as a developer (accept the terms,
confirm a phone number or email). Tell Claude when you see the **My Apps** page.

**B2. Claude does this.** Create the app.
- **Create app** → app name: something like "<your brand> DMs". Meta refuses names that contain "Instagram",
  "IG" or "Meta".
- App contact email: **ask the person** which one.
- Use case: **Manage messaging & content on Instagram** (the Instagram API with Instagram Login).
- Business portfolio: **I don't want to connect a business portfolio yet**.
- Finish with **Create app**. If Meta asks for the Facebook password again, that is the person's step: hand over.

**B3. Claude does this.** Add the permissions. In the app: **Use cases** → the Instagram use case →
**Customize** (or **API setup with Instagram business login**) → permissions. Add these three (an
**Add all required permissions** button does it in one click when it is there):
- `instagram_business_basic`
- `instagram_business_manage_comments`: read the comments
- `instagram_business_manage_messages`: send the DM

Skip webhooks and "business login settings": this script asks Instagram for new comments every 5 minutes, so it
needs no public URL.

**B4. Claude, then you.** Add your Instagram account. In the same setup page, section **Generate access tokens**
→ **Add account**.
- **You do this manually:** log in to your Instagram professional account in the window that opens.
- **If Meta says the account has a pending tester invite** (it often does), **you do this manually** on your
  **phone**: open **Safari** (or any mobile browser, *not* the Instagram app), go to
  `instagram.com/accounts/manage_access/`, log in, open the **Tester invites** tab, and tap **Accept**. The
  Instagram app doesn't show this tab, and logging in on a desktop browser can loop on "Login failed"; the phone's
  browser is the way that works. Then tell Claude, and Claude reloads the dashboard page.

**B5. You do this manually.** Let tools send DMs for you. In the **Instagram app** on your phone: Settings and
activity → **Messages and story replies** → **Message controls** → **Connected tools** → turn on
**Allow access to messages**. Without it every DM fails with a permission error.

**B6. You do this manually.** The token. Claude stops looking at the browser for this step.
1. In the dashboard, click **Generate token** beside your account, log in if asked, tick the box, and **copy** the token.
2. Open **your own terminal window** (Terminal on macOS: it is *not* this Claude Code session). Claude tells you
   the folder path. Run:
   ```
   cd <the folder Claude gives you>
   npm run auth
   ```
3. Paste the token and press Enter. **Nothing shows while you paste. That's on purpose.** It prints your
   username and how many days the token is valid.
4. Close the token dialog in the dashboard, then tell Claude "done".

**Claude does this:** `npm run whoami`. It should print your username and about 60 days. It never prints the token.

**B7. Claude does this, with your answers.** A privacy policy page. Meta's **Publish** button needs one.
1. Fill in the template [`privacy-policy.md`](privacy-policy.md). **Ask the person** for the name or brand to
   show and a contact email. Replace every `{{…}}`.
2. Host it. **Ask the person** which way:
   - **A public GitHub Gist** (quickest). If `gh auth status` shows they're logged in, Claude runs
     `gh gist create --public --desc "Privacy policy" privacy-policy.md` *after they say yes* and uses the URL it
     prints. Otherwise the person pastes the file at [gist.github.com](https://gist.github.com) as a public gist.
   - **A page on their own website**, if they have one.
   - (Any public page with the text works too, such as a Google Doc via File → Share → Publish to web.)
3. In the app: **App settings → Basic** → **Privacy policy URL** = that link. Under **User data deletion**, choose
   **Data deletion instructions URL** and paste the same link (the template has a "Deleting your data" section).
   If Publish later asks for an app icon or a category, fill those here too. **Save changes**.

**B8. Claude does this, after asking.** Publish the app: **Publish** in the left menu → **Publish**.
Why: in development mode the API returns **no comments from anyone without a role on the app**. You get
`data: []` while the post clearly has comments, so the script would never see a keyword. Publishing fixes it at
once. It needs no App Review: Standard Access covers your own account.

**B9. Claude does this.** Check it works.
- `npm run posts` → your latest posts, each with its media ID.
- `npm run comments -- <the ID of a post that has comments from other people>` → those comments are listed.
- **Empty while the post has comments** → the app is still in development mode: go back to B8.
- **An error with "(#10)" or "permission"** → a permission is missing (B3), or the account was added before the
  permissions were: generate the token again (B6).

## Part C. Your first funnel

**C1. Claude does this, with your answers.** Ask the person:
- **which post** (show them `npm run posts`),
- the **keyword(s)**: a word people won't write by accident, plus spelling variants (and both words on an "A vs B"
  post),
- the **DM text** with their link (up to 1,000 bytes),
- 1 to 3 short **public reply** lines, like "Sent! Check your DMs 📩",
- an **end date**, if they want one.

Copy `config.example.json` to `config.json`, fill it in, run `npm run check`.

**C2. You do this manually.** From your **second** Instagram account, comment the keyword on that post.

**C3. Claude does this.** `npm run dry-run`. It should list `would DM @<the second account>`. Then `npm run poll`
sends it for real: `DM sent to @…` and `replied under …`.

**C4. You do this manually.** On the second account, open your DMs. The first DM from an account you don't follow
lands in **Message requests**. Check the link works, and check the reply under the comment.

**C5. Claude does this.** Tell the person it worked, and ask: *"If it saved you a paid plan, star the repo so other
people find it: https://github.com/machineroom-dev/instagram-free-auto-dm"*.

## Part D. Keep it running

**Claude asks the person which one.** Their computer (simplest, but it must stay on) or a Cloudflare Worker (runs
around the clock on the free plan, ten more minutes of setup).

### D1. On your computer

**Claude does this.** `npm run timer:install`. On macOS that's a launchd agent, on Linux a cron line. It runs
`npm run poll` every 5 minutes, and once right away. After 5 minutes, `npm run status` shows the last run.
A sleeping laptop skips runs and catches up when it wakes. Comments stay answerable for 7 days.

### D2. On a Cloudflare Worker

1. **You do this manually.** If you have no Cloudflare account, make a free one at
   [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). Then `npm run worker:login`, and click **Allow** in
   the browser tab it opens.
2. **Claude does this.** `npm run worker:kv` creates the KV namespace and prints its `id`. Put that id in
   `wrangler.jsonc` in place of `PUT_YOUR_KV_NAMESPACE_ID_HERE`.
3. **Claude does this, after asking.** `npm run worker:deploy`. The Worker starts in `"MODE": "dry-run"`: it reads
   comments and logs what it would send, and sends nothing.
4. **You do this manually**, in **your own terminal window**: `npm run worker:seed`. It hands your stored token
   to the Worker as the secret `IG_TOKEN`, and nothing is printed.
5. **Claude does this.** Wait for the next 5-minute mark, then `npm run worker:status`. It shows the token's
   username and days left, and any "would DM" lines. `npm run worker:tail` streams the Worker's log live.
6. **Claude does this, after asking.** Go live:
   - if the local timer is installed: `npm run timer:remove`, and then `npm run worker:import`, which copies the local
     ledger to the Worker so nobody answered locally is answered again;
   - set `"MODE": "live"` in `wrangler.jsonc`, then `npm run worker:deploy`;
   - after the next run, `npm run worker:status` shows the funnels live. If you imported, check the Worker's count
     of DMs matches `npm run status`. If not, run `npm run worker:import` again (it is safe to repeat).
7. A test comment from the second account (C2) should get its DM within 5 minutes.

Changing funnels later: edit `config.json`, then `npm run check` and `npm run worker:deploy`. The config ships
inside the Worker.

## Part E. Day to day

- **How is it doing?** `npm run status` (Worker: `npm run worker:status`).
- **A new post:** add a funnel to `config.json` (one per post).
- **A funnel says HALTED:** status gives the reason (often a permission). Fix it, then `node cli.mjs resume <post>`
  (Worker: `node cli.mjs worker resume <post>`).
- **"unknown outcome":** a run stopped in the middle of a send. Look in Instagram's sent DMs, then
  `node cli.mjs mark <commentId> sent` if it went, or `retry` if it didn't (Worker: `node cli.mjs worker mark …`).
- **The token:** it renews itself when under 10 days are left. If Instagram kills it (you changed your password, or
  Meta reset your session: errors mention code 190), repeat **B6**, and for the Worker run `npm run worker:seed`
  again. Comments that came in meanwhile are answered on the next run, as long as they are under 7 days old.
- **Another tool on the same post** (ManyChat or similar): remove its rule. Instagram allows one private reply per
  comment, and the two would race for it.
