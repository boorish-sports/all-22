# Submitting to the Chrome Web Store — walkthrough

Steps marked **[Boorish]** need your Google account, a card, or a signature.
Everything else is prepared in this repo.

## 0. Before registering

- Decide which Google account owns the listing. Policy strikes attach to the
  developer account, not the item. If you have (or might have) other
  extensions, register with an account you can afford to lose. Google's own
  advice is a dedicated address you check often, because rejection and
  takedown notices go there.
- The account needs **2-Step Verification** turned on.

## 1. Register **[Boorish]**

1. Go to https://chrome.google.com/webstore/devconsole and sign in.
2. Accept the developer agreement and policies.
3. Pay the one-time **US$5** registration fee.
4. In *Account* (left sidebar): fill in the publisher display name (no NFL
   marks), a contact email (it is shown publicly on the listing), and verify
   the email.
5. **Trader / non-trader declaration** (EU Digital Services Act). The
   dashboard will not let you publish until this is answered. A free tool with
   a tip jar is normally *non-trader*; confirm with your accountant alongside
   the VAT question in HANDOFF §5.1 if you are unsure. Non-trader listings
   show a notice to EU users that consumer-protection law may not apply, which
   is accurate here.

## 2. Publish the landing page and privacy policy **[Boorish, one click]**

The privacy URL must resolve before the review starts.

1. Push this repo to GitHub as `boorish-sports/all-22` (public).
2. Repo *Settings → Pages → Build and deployment*: Source "Deploy from a
   branch", branch `main`, folder `/docs`. Save.
3. After a minute, check https://boorish-sports.github.io/all-22/privacy.html
   loads.
4. Edit `docs/index.html`: replace `TIP_URL_PLACEHOLDER` with your Ko-fi (or
   Gumroad) URL. `CWS_URL_PLACEHOLDER` gets the store URL after step 4.

## 3. Build the package

    ./build_zip.sh

produces `dist/all-22-film-search-<version>.zip`. The same file is the
self-hosted fallback: attach it to a GitHub Release tagged `v<version>`.

## 4. Create the item **[Boorish]**

1. Dashboard → *New item* → upload the zip.
2. **Store listing** tab: paste from `store/LISTING.md`. Upload
   `store/icon128.png`, `store/promo-440x280.png`, and your screenshots.
3. **Privacy practices** tab: paste the single-purpose text, each permission
   justification, the remote-code answer, tick nothing under data collection,
   certify the three statements, enter the privacy URL.
4. **Distribution** tab: Visibility **Unlisted**, all regions, free.
5. *Submit for review*. Leave "publish automatically after review" on.

## 5. While it is in review

- Typical: a few days. Up to a few weeks. Contact support after three.
- Rejection arrives by email with the policy cited. Fix, re-upload, resubmit;
  or *Appeal* from the item page if the citation is wrong. Support answers
  within about three days.
- Do not resubmit unchanged; each resubmission goes to the back of the queue.

## 6. After approval

1. Copy the store URL into `docs/index.html` (`CWS_URL_PLACEHOLDER`), commit,
   push. Pages redeploys on its own.
2. Hand the URL to the small group from the Twitter thread. Unlisted means
   anyone with the link can install; it is just not searchable.
3. When you are ready: *Distribution → Visibility → Public*. No second review.
4. Version bumps: edit `version` in `extension/manifest.json`, run
   `./build_zip.sh`, upload the zip in the dashboard, submit. Existing installs
   auto-update within hours of approval.

## If it is rejected or later removed

- The fallback is already live: the GitHub Release zip plus the "Load
  unpacked" instructions on the landing page.
- Microsoft Edge Add-ons (https://partner.microsoft.com/dashboard/microsoftedge)
  accepts the same zip with its own review. Free registration.
- Firefox is not a fallback without a port: it has no `offscreen` API.
