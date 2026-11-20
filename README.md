# Instagram comment-to-DM

Someone comments a keyword on your post. Within five minutes they get a DM with your link, and a reply under
their comment ("Sent! Check your DMs 📩") so they know to look. That's what ManyChat and similar tools sell. This
does it with **Instagram's own API, for free**, from a small Node script with no dependencies.

## Set it up with one prompt

Paste this into [Claude Code](https://claude.com/claude-code):

```text
Clone https://github.com/machineroom-dev/instagram-free-auto-dm and follow its SETUP.md to set up comment-to-DM on my Instagram account. Use my Chrome for the Meta developer dashboard. Stop and hand over to me at every step marked "You do this manually", and never read or print my access token.
```

Claude Code clicks through the Meta developer dashboard in your Chrome (with the Claude in Chrome extension),
adds the permissions, takes the app live and writes your config. You do the few steps only you can do: log in,
accept a tester invite on your phone, click **Generate token** and paste it into your own terminal. Every step in
[SETUP.md](SETUP.md) says which kind it is. Prefer doing it by hand? SETUP.md works as a plain checklist too.

## It worked? ⭐

If a test comment got its DM, **[star the repo](https://github.com/machineroom-dev/instagram-free-auto-dm)**.
That's how other people find it, and it costs you nothing.

## What it does

- Every 5 minutes it reads the new comments on the posts you list in `config.json`.
- A comment that asks (your keyword, see [Matching](#matching)) gets **one DM** with your message: Instagram's
  *private reply* to that comment.
- Then it replies under the comment with one of your short lines, taking them in turn so it doesn't look like spam.
- **One DM per person per post, never twice.** Every send is written to a ledger *before* the request goes out and
  again after, so a crash can't make it DM someone a second time.
- It renews its own access token when fewer than 10 days are left. Nobody refreshes anything by hand.
- It stops a post's funnel instead of failing over and over: when the very first DM your account ever sends fails
  (usually a missing permission), or after 3 failed DMs in a row. `status` tells you why; `resume` restarts it.
- Your own comments are skipped, and so are comments older than Meta's 7-day window.

```text
  comment "GUIDE"           every 5 min                      Instagram API
  ───────────────►  read new comments ──► match? ──► private reply (the DM) ──► public reply under the comment
                                          │                 │
                                          └── ledger: pending before, outcome after, one DM per person per post
```

## Two ways to run it

| | **Your computer** (`npm run timer:install`) | **Cloudflare Worker** (`npm run worker:deploy`) |
|---|---|---|
| Runs | launchd (macOS) or cron (Linux), every 5 min | a cron trigger on Cloudflare, every 5 min |
| Needs | the computer on and awake | a free Cloudflare account |
| Cost | $0 | $0 on the Workers Free plan |
| State | `.state/` in this folder | one KV namespace |

Use one or the other, never both at once (SETUP.md, part D, shows how to move from one to the other).

## Matching

A comment matches when **both** are true:

1. **A keyword appears as a whole word**, in any case: `guide`, `GUIDE pls`, `can I get the guide?` match the
   keyword `GUIDE`; `guidelines` does not. Every letter O in a keyword also matches a zero, so `0AUTH` counts for
   `OAUTH`.
2. **It reads as a request**: at most 6 words (@mentions not counted), or longer with an ask word (`note`, `notes`,
   `pdf`, `sheet`, `dm`, `send`, `share`, `link`, `please`, `pls`, `plz`). Without this, a keyword that is also
   your topic ("rebase" on a git post) DMs people who are only talking to each other.

Tips: pick a keyword people won't write by accident, and list spelling variants (`["GUIDE", "GUIDES"]`). On an
"A vs B" post people comment both words, so list both from the start.

## config.json

Copy [`config.example.json`](config.example.json) to `config.json` (it is git-ignored):

```json
{
  "account": "your_instagram_username",
  "funnels": [
    {
      "name": "free-guide",
      "post": "17900000000000001",
      "keywords": ["GUIDE", "GUIDES"],
      "message": "Here's the guide from the post: https://example.com/guide",
      "replies": ["Sent! Check your DMs 📩", "Done, it's in your DMs 📩"],
      "until": "2026-12-31"
    }
  ]
}
```

| Field | |
|---|---|
| `account` | Your Instagram username. The token must belong to it. |
| `funnels[].post` | The post's numeric media ID. `npm run posts` lists yours. One funnel per post. |
| `funnels[].keywords` | One word each: letters, digits, `-`, `_`. |
| `funnels[].message` | The DM. Up to 1,000 bytes (an emoji counts 4). Links are fine. |
| `funnels[].replies` | Optional. Short public replies, ≤ 300 characters each, used in turn. |
| `funnels[].until` | Optional. Last day (UTC) the funnel answers. Without it the funnel keeps going. |
| `funnels[].name` | Optional label for logs. |
| `maxWords`, `askWords` | Optional. Change the [request rule](#matching) (defaults 6 and the list above). |

`npm run check` checks the file without calling Instagram. Edits take effect on the next run locally; the Worker
gets them on `npm run worker:deploy`.

## Commands

| | |
|---|---|
| `npm run auth` | Paste your token (hidden while you paste). Checked and stored in `.state/token.json`, mode 600. |
| `npm run whoami` | Whose token it is and how many days it has left. Never prints the token. |
| `npm run check` | Check `config.json`, list the funnels. |
| `npm run posts` | Your latest posts with their media IDs. |
| `npm run comments -- <post>` | Read-only: a post's comments, which match, which were answered. |
| `npm run dry-run` | One run that sends nothing and writes nothing, listing what it *would* send. |
| `npm run poll` | One real run (what the timer runs). |
| `npm run status` | Funnels, counts, last run, token expiry, timer. |
| `npm run timer:install` / `timer:remove` | The local timer. |
| `node cli.mjs log [<post>]` | The ledger. |
| `node cli.mjs resume <post>` | Restart a halted funnel once you fixed the cause. |
| `node cli.mjs mark <commentId> sent\|error\|retry` | Settle a DM whose outcome is unknown (a run stopped mid-send). |
| `npm run worker:deploy` / `worker:seed` / `worker:status` / `worker:tail` | The Worker (SETUP.md, part D2). |
| `npm test` | The tests (Node's built-in runner, no install). |

## Meta's limits

- **One private reply per comment, within 7 days of the comment.** That is Instagram's rule, and why this is a
  one-message tool. A follow-up is only allowed if the person replies, within 24 hours (this script never sends one).
- **750 private replies an hour** per account. The script sends at most 60 a run, so 720 an hour.
- **DM text up to 1,000 bytes.**
- **Instagram professional accounts only** (Creator or Business). Switching is free, in the Instagram app.
- **Standard Access is enough** for your own account: no App Review. But the app must be **published (Live)**. In
  development mode the API returns no comments from anyone without a role on the app, so the script sees nothing.
- **The token lasts 60 days** and renews itself here. A password change or a Meta security reset kills it at once
  (error code 190): generate a new one and run `npm run auth` again.
- The first DM from an account someone doesn't follow lands in their **Message requests**. The public reply tells
  them to look.

## Cloudflare's limits (Workers Free)

100,000 requests a day, **50 subrequests a run** (Workers KV calls count too), **10 ms CPU a run** (time spent
waiting on the network doesn't count), 5 cron triggers per account, and Workers KV at 1,000 writes a day. A 5-minute
cron is 288 runs a day. Each run gets 45 Instagram calls and at most 5 KV operations. It writes its ledger only
when it sends something (twice: before and after), plus a short summary at most once an hour, so even a run that
sends every 5 minutes stays near 600 writes a day. A run reads the newest 250 comments of each post. When more
people ask than one run can answer, the rest go out 5 minutes later, oldest comment first.

## Safety notes

- The token never leaves your machine except to Meta, and to Cloudflare if you choose the Worker. No command prints
  it, and error messages strip it from URLs.
- `.state/`, `config.json` and `.dev.vars` are git-ignored. Don't commit them.
- A corrupt ledger line stops every run rather than being skipped: a ledger read as empty would DM everyone again.
- Remove any other comment-to-DM tool (ManyChat, etc.) from the same post. Instagram allows one private reply per
  comment, and the two would race for it.

## Privacy policy

Meta's **Publish** button needs a privacy policy URL. [`privacy-policy.md`](privacy-policy.md) is a template to
fill in and host. SETUP.md, step B7, shows two ways to host it.

## Licence

[MIT](LICENSE).
