# Connect Gmail with "Sign in with Google"

The app reads HDFC alert emails over IMAP. Instead of an app password (which needs 2-Step
Verification), you can sign in with Google. You create your own free OAuth client once; the app
then keeps only a sign-in token, encrypted in your macOS Keychain.

Takes about 10 minutes. Everything here is free.

## 1. Create a Google Cloud project

1. Open https://console.cloud.google.com/ and sign in with the Gmail account that gets the HDFC alerts.
2. Project picker (top bar) → **New project** → name it `Expense Tracker` → **Create**, then select it.
   If asked to set up billing, skip it: nothing here needs billing.

## 2. Enable the Gmail API

**APIs & Services → Library** → search **Gmail API** → **Enable**.

## 3. Set up the consent screen

Open **Google Auth Platform** (or **APIs & Services → OAuth consent screen**, which redirects there) → **Get started**:

- **App name:** `Expense Tracker`. **User support email:** your Gmail.
- **Audience:** **External**.
- **Contact email:** your Gmail. Accept the policy → **Create**.

Then:

- **Data Access → Add or remove scopes** → in *Manually add scopes* paste `https://mail.google.com/`
  → **Add to table** → **Update** → **Save**.
- **Audience → Test users → Add users** → enter your Gmail → **Save**. Leave the status as **Testing**.

  In Testing, Google ends the sign-in every 7 days, so about once a week sync stops with
  *"Google sign-in has expired"*. Go to **Settings → Gmail connection → Sign in again**. It is one
  click because the app keeps the OAuth client.

  *Publish app* (no weekly sign-in) is greyed out until the **Branding** page has a homepage and
  privacy-policy URL on a domain you own and have verified in Google Search Console. That is a lot
  of setup for a private app, so skip it unless the weekly sign-in bothers you.

## 4. Create the OAuth client

**Clients → Create client** → **Application type: Desktop app** → name `Expense Tracker Mac` →
**Create**. Copy the **Client ID** and **Client secret** (you can view them again later).

## 5. Sign in from the app

1. Make sure IMAP is on: Gmail → Settings → See all settings → **Forwarding and POP/IMAP** → Enable IMAP.
2. In Expense Tracker → **Settings → Gmail connection**, paste the client ID and secret →
   **Sign in with Google**. Your browser opens.
3. Pick your account. Google warns **"Google hasn't verified this app"**, because it is your own
   private app: click **Advanced → Go to Expense Tracker (unsafe)**.
4. **Tick the Gmail permission box** ("Read, compose, send and permanently delete all your email
   from Gmail") → **Continue**. The app needs this scope to read alerts over IMAP and to move an
   alert to Trash when you delete a transaction with that option on.
5. The tab says you're signed in; the app runs a connection test.

## Troubleshooting

| Message | Fix |
| --- | --- |
| *Gmail access was not granted* | Sign in again and tick the Gmail box on the consent page. |
| *Google sign-in has expired or was revoked* | Expected about once a week in *Testing* (step 3): click **Sign in again** in Settings. |
| *Google did not accept the OAuth client* | Re-copy the ID and secret; check the client type is **Desktop app**. |
| *Access blocked: app has not completed the Google verification process* | Your Gmail is not in **Audience → Test users**. Add it and sign in again. |

To remove access at any time: **Disconnect** in Settings, or Google Account → Security →
*Your connections to third-party apps & services* → Expense Tracker → remove.
