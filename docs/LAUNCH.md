# Going live: step by step

This takes you from now to a public stoned-mango site at a free `pages.dev` address, with Cash App and crypto
donations and the source code public. It's about **1 hour of your time**, spread over a few sittings. No coding.

| # | Step | Who | Time |
|---|---|---|---|
| 1 | Create a Cloudflare account | you | 5 min |
| 2 | Copy your Account ID and make an API token | you | 5 min |
| 3 | Add both to GitHub as secrets | you | 5 min |
| 4 | Publish a preview and test it on your phone | you | 10 min |
| 5 | Send me your Cash App tag and crypto addresses | you, then me | 5 min |
| 6 | Check the Donate page on the preview | you | 5 min |
| 7 | Move to a fresh, clean repository | you, then me | 10 min |
| 8 | Make the new repository public | you | 2 min |
| 9 | Go live: merge the pull request | you (or ask me) | 5 min |
| 10 | Final checks on the live site | you | 5 min |

Do them in order. You can stop after any step and pick up later; nothing goes public until step 8.

---

## Step 1: Create a Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up** and sign up (email and password). It's free, and no card is needed for Pages.
2. Confirm your email address from the message Cloudflare sends.

## Step 2: Copy your Account ID and make an API token

**Account ID** (not secret, but you'll paste it in step 3):
1. In the Cloudflare dashboard, open **Workers & Pages** in the left menu.
2. Copy the **Account ID** shown on the right. It's 32 letters and numbers.
   (Another place to find it is the address bar: `dash.cloudflare.com/<your account id>/...`.)

**API token** (this one *is* secret: never paste it in our chat or anywhere public):
1. Click the person icon at the top right → **My Profile** → **API Tokens** → **Create Token**. (An *Account* API token, under **Manage Account → Account API Tokens**, works too.)
2. Next to **Create Custom Token**, click **Get started**.
3. Fill in:
   - **Token name:** `stoned-mango GitHub`
   - **Permissions:** `Account` → `Cloudflare Pages` → `Edit`
   - **Account Resources:** `Include` → your account
4. Click **Continue to summary** → **Create Token**.
5. **Copy the token now.** Cloudflare shows it only once. Keep the tab open until step 3 is done.

**Check the permission:** without **Cloudflare Pages → Edit**, publishing fails with "Authentication error [code: 10000]". If that happens, edit the token (**⋯ → Edit**) and add the permission. The token's text stays the same, so GitHub needs no change.

## Step 3: Add both to GitHub as secrets

1. Open **https://github.com/freener0x/stoned-mango** (log in first).
2. Click **Settings** (the tab at the top of the repository, not your profile settings).
3. In the left menu: **Secrets and variables** → **Actions** → **New repository secret**.
4. **Name:** `CLOUDFLARE_API_TOKEN` · **Secret:** paste the token → **Add secret**.
5. **New repository secret** again. **Name:** `CLOUDFLARE_ACCOUNT_ID` · **Secret:** paste the Account ID → **Add secret**.

Type the names exactly as shown: capitals and underscores. When pasting the values, don't press Enter afterwards. (The publishing step now ignores a stray space or line break anyway; one in the Account ID was the cause of the first failed run.) After this, every change to the project is built and published automatically: changes to the main version go to the real site, and everything else gets its own preview link.

## Step 4: Publish a preview and test it on your phone

1. On GitHub, open the **Actions** tab → click **Deploy** in the left list.
2. Click **Run workflow** (on the right). A small box opens: under **Branch**, choose `claude/audio-key-detection-khkh02`, then click the green **Run workflow** button *inside the box*. (Use this rather than **Re-run** on an old run: a re-run uses the old version of the steps.)
3. Wait about 3–5 minutes until the run shows a green check mark. A red cross means something went wrong: tell me and I'll look at it.
4. **Find the preview link.** In Cloudflare: **Workers & Pages** → **stoned-mango** → **Deployments** → the newest one → **Visit**.
   - The real site's address is also shown there, usually `https://stoned-mango.pages.dev`.
   - If someone else already has that name, Cloudflare adds a few letters to the end. Whatever it shows is your address.
5. **On your phone**, open the preview link and check:
   - The page loads and shows "Engine ready".
   - **Add files** with a song from your phone: you get a key and a Camelot code.
   - Open the song: the timeline plays.
   - **Settings** opens, and the skins change.
   - Turn on **airplane mode** and reload the page: it still opens and analyses. This is the offline mode.
   - Optional: **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen).
6. Tell me how it went, and anything that looked wrong or slow. This is also the real-phone speed test from the plan.

## Step 5: Send me your Cash App tag and crypto addresses

Paste these into our chat. They're meant to be public, since they will be on the site:

```
Cash App: $yourtag
BTC: ...
ETH: ...   (and which network: Ethereum mainnet, or another)
SOL: ...
XMR: ...
```

- Include only the coins you actually want. Leave the others out.
- **Copy each address from your wallet app's "Receive" screen.** Never type one by hand: one wrong character and donations are lost.
- I add them to the Donate page and to GitHub's "Sponsor" button. The build refuses a malformed address. Then I publish a new preview.

## Step 6: Check the Donate page on the preview

The preview link from step 4 updates within a few minutes after I tell you it's ready.

1. Open **Donate** (bottom of the page).
2. **Cash App:** tap the link. It should open *your* Cash App profile.
3. **Each crypto address:** compare the **first 6 and last 6 characters** with your wallet's Receive screen.
4. **Each QR code:** scan it with your wallet app's **Send** screen (don't send anything). It should fill in the same address.
5. Optional, for peace of mind: send yourself a tiny amount to each address.

## Step 7: Move to a fresh, clean repository

Once a repository is public, its whole history is visible, old versions of pull requests included. This repository's history holds the Gmail address of your GitHub account (in the very first commit, the one GitHub made when you created the project) and the totals from your music library (in old commit messages and old versions of the reports). Rewriting the history wouldn't remove them: GitHub keeps the old commits reachable through the pull request. So the public project starts fresh, under the same name, and this one stays private with all its history.

**You (about 10 minutes):**
1. **Rename this repository:** https://github.com/freener0x/stoned-mango → **Settings** → **General** → **Repository name** → `stoned-mango-dev` → **Rename**.
2. **Create the new one:** https://github.com/new → **Repository name** `stoned-mango` → **Private** (for now) → leave README, .gitignore and licence **off**, so it starts empty → **Create repository**.
3. **Give me access to it:** https://github.com/settings/installations → **Claude** → **Configure**. If it says "Only select repositories", add `stoned-mango` → **Save**. ("All repositories" needs nothing.)
4. **A fresh copy of the Cloudflare token** (the old copy can't be shown again): Cloudflare → person icon → **My Profile** → **API Tokens** → **⋯** next to `stoned-mango GitHub` → **Roll** → copy it. This also stops the old repository from publishing.
5. **Add both secrets to the new repository**, as in step 3: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**: `CLOUDFLARE_API_TOKEN` (the new token) and `CLOUDFLARE_ACCOUNT_ID` (from **Workers & Pages**).
6. **Protect future commits:** GitHub → your profile picture → **Settings** → **Emails** → tick **Keep my email addresses private** and **Block command line pushes that expose my email**.
7. Optional: rename the Cloudflare account (**Account Home** → **⋯** next to the account → **Rename**), so a failed publishing run can never print your email address in its log.
8. Tell me **"done"**.

**Me:** I push the current version as one clean starting point: no email address, no library totals, no file names. It goes on the same branch name, with a new pull request. The site address, the "Source code" link and the ZIP download link stay the same. Every report and guide comes along; only the step-by-step history stays behind in `stoned-mango-dev`. I check that the new repository builds and publishes a preview, and send you the pull request's link.

## Step 8: Make the new repository public

1. New repository → **Settings** → **General** → scroll down to **Danger Zone**.
2. **Change repository visibility** → **Change to public** → confirm, typing the repository name when asked.

From now on:
- the "Source code" link on the site works for everyone
- people can check the privacy promise for themselves
- the download link for the PC scripts no longer needs a login

## Step 9: Go live: merge the pull request

1. Open the new repository's pull request (I send you the link in step 7).
2. Click **Ready for review** (the PR is a draft until now).
3. Click **Merge pull request** → **Confirm merge**.

Or just tell me **"merge it"** and I'll do it.

This puts everything into the main version, and the Deploy workflow publishes it to the real address from step 4 in about 3–5 minutes.

## Step 10: Final checks on the live site

1. Open the real address (for example `https://stoned-mango.pages.dev`) on your phone and your computer.
2. Analyse a song, open **Privacy**, **Accuracy** and **Donate**, and check **Source code** opens the GitHub page.
3. On a computer, the privacy check anyone can do: open the browser's developer tools → **Network** tab → analyse a song. Nothing is sent anywhere.
4. Share the link.

---

## After launch

- **Changes:** I work on a branch. Every change gets its own preview link to try first, and goes live when it's merged into main (step 9 again, or "merge it").
- **PC scripts:** the download link and steps in the [Windows guide](phase2/TRAINING-ON-WINDOWS.md#getting-the-latest-version-whenever-i-change-the-scripts) keep working.
- **A custom domain** can be added any time: Cloudflare → **Workers & Pages** → **stoned-mango** → **Custom domains**.
- **Taxes:** depending on where you live, donations may count as income. Worth checking.
