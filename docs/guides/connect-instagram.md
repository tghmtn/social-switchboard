# Connect Instagram

The Channels page shows this guide one step at a time, with live checks. Each `## step:` section is
one step: `id | title`, then its instructions. `{{NAME}}` placeholders are filled in with this
install's addresses. Meta moves things around now and then. If a step no longer matches what you
see, please fix it here: every install fetches the latest version of this file.

## step: account | Make your Instagram a Creator or Business account

Instagram only lets apps work with professional accounts. Switching is free.

1. In the Instagram app, go to your **profile** and tap **☰** (top right).
2. Tap **Settings and activity**, then scroll to **For professionals** and tap **Account type and tools**.
3. Tap **Switch to professional account** and **Continue** through the intro screens.
4. Pick a category. Turn off **Display on profile** if you'd rather not show it.
5. Choose **Creator** (for a person) or **Business**. Either works.
6. When it offers to connect a Facebook Page, tap **Skip**. You don't need one.

**Already professional?** Your profile shows a **Professional dashboard** link under your bio.

> Professional accounts are always public. If you're moving from ManyChat or a similar tool, your
> account is already professional; see the last step before you go live.

## step: developer | Register as a Meta developer

1. Go to **developers.facebook.com** and log in with your Facebook account.
2. Click **Get Started** (top right). If it already says **My Apps**, you're registered and can skip ahead.
3. Accept the terms and verify your phone number or email when asked.

## step: app | Create your Meta app

1. Go to **developers.facebook.com/apps** and click **Create app**.
2. **App name:** something like `Social Switchboard`. People may see it when they connect. Meta rejects names containing "Instagram", "Insta", "IG", "Facebook" or "Meta".
3. **Use case:** set the filter to **All**, then choose **Manage messaging & content on Instagram**.
   Don't choose "Authenticate with Facebook Login" or anything about ads.
4. **Business portfolio:** pick yours, or create one. Instagram's login needs a portfolio to own the app. A portfolio for yourself is fine; it's free and needs no company.
5. Finish with **Create app**.
6. Open **App settings → Basic** and fill in:
   - **Privacy policy URL:** `{{PRIVACY}}`
   - **Terms of service URL:** `{{TERMS}}`
   - **User data deletion:** choose the callback option and use `{{DATA_DELETION}}`
   - **App icon** (1024×1024) and **Category**
7. Click **Save changes**.

## step: login | Set up Instagram login

In your app, open **Use cases**, then **Customize** next to **Manage messaging & content on Instagram**, then **API setup with Unified login**. Under **1. Configure your app**:

1. Click **Create configuration** (or **Create another configuration**). Keep the defaults: a **system-user access token** that **never expires**, with **Instagram accounts** as the asset.
2. **Permissions:** keep **instagram_basic**, **instagram_manage_comments** and **instagram_manage_messages**. You can remove the ads permissions and **instagram_content_publish**; Social Switchboard doesn't use them, and fewer permissions make App Review easier.
3. Under **Register a new redirect URL**, paste `{{OAUTH_REDIRECT}}` and click **Save**. It should then show in **Select the registered URL**.
4. Leave this page open. The next step needs the **Login URL** from the bottom of it.

**Older app?** If your dashboard shows **API setup with Instagram login** instead, open **Set up Instagram business login → Business login settings** there, paste `{{OAUTH_REDIRECT}}` as the redirect, `{{DEAUTHORIZE}}` as the deauthorize callback and `{{DATA_DELETION}}` for data deletion, and save. Then use the "Older app" part of the next step's form.

## step: credentials | Paste your Login URL and app secret

- **Login URL:** at the bottom of **1. Configure your app**, click **Copy** next to **Login URL**.
- **Meta app secret:** it's not on the API setup page. In the left sidebar of your app's dashboard, click **App settings**, then **Basic**. Next to **App secret**, click **Show**. Meta may ask for your Facebook password first. Copy the secret into the form below.

They're stored encrypted on your server, and Social Switchboard never shows the secret again. The Login URL isn't secret: it's the address of Meta's sign-in page for your app.

## step: tester | Add your account as an Instagram tester

Until your app passes App Review, only accounts with a role on it can connect. Even your own account needs this, and it has two halves.

**In the Meta dashboard:** open **App roles → Roles**, find **Instagram Testers**, click **Add**, and enter your Instagram username exactly.

**In Instagram, on that account:**
- **App:** Profile → **☰** → **Settings and activity** → **Apps and websites** → **Tester invites** → **Accept**.
- **Computer:** log in at instagram.com, then open **instagram.com/accounts/manage_access** → **Tester invites**.

Until you accept, connecting fails with "Insufficient developer role".

## step: webhooks | Turn on webhooks

Webhooks are how Instagram tells this server about new comments and messages. On the same **API setup** page, open **3. Configure webhooks**:

- **Callback URL:** `{{WEBHOOK}}`
- **Verify token:** `{{VERIFY_TOKEN}}`

Click **Verify and save**. Meta calls this server right away, and the check below turns green when it does.
If the button stays grey, click into the verify-token field and paste it again.

Then **subscribe** to the **comments** and **messages** fields, plus **messaging_postbacks** if it's listed.

## step: connect | Connect your Instagram account

Click **Connect Instagram** below. Meta asks you to log in, then to choose your **business portfolio** and your **Instagram account**, and to approve the permissions. Keep everything ticked. Then you'll come back here.

If it says no Instagram account was shared, connect again and make sure the account is ticked. If your account isn't in the list at all, add it to your portfolio first: **business.facebook.com → Settings → Accounts → Instagram accounts → Add**.

## step: publish | Get real comments and messages

Meta's dashboard lists **4. Complete App Review** before your app gets "live data". What that means for you depends on what Meta sends, so try it first:

1. From a **different** Instagram account, comment on one of your posts. The check below turns green when Instagram tells this server about it.
2. **Green?** You're set for your own accounts. Skip to the next step.
3. **Still waiting after a minute?** Click **Publish** in the dashboard's left sidebar, then comment again.
4. **Still nothing?** Your app needs App Review. Open **4. Complete App Review** on the API setup page. Meta asks for:
   - a **verified business portfolio** (Business settings → Security center → **Start verification**)
   - **Advanced access** to instagram_basic, instagram_manage_comments and instagram_manage_messages
   - a short screen recording of each permission in use; record a comment turning into a DM here
   - the privacy policy, terms and data deletion addresses from step 3

Review usually takes a few days. After it's approved, click **Publish**.

## step: test | Try it

1. Build a flow, publish it, and add a **Comment on a post** trigger (open the flow, then select **Start**).
2. From a **different** Instagram account, comment your keyword on that post. Comments from the connected account itself are ignored on purpose.
3. The DM should arrive within a few seconds, and the person shows up in **Contacts**.

Instagram allows **one** private reply to a comment until the person writes back. Give the first message a quick reply or a button, so tapping it continues the conversation.

You can rehearse all of this without Instagram: the **Simulator** has a "Comment" option.

## step: manychat | Moving from ManyChat or another DM tool

Skip this step if the account never used another automation tool.

Only one app can own an Instagram account's conversations. If another tool still does, your first reply to a comment works, but follow-ups (like replies to button taps) fail with "not the thread owner".

1. Rebuild and test your automations here first.
2. Disconnect the old tool from inside it (in ManyChat: **Settings → Instagram → Disconnect**).
3. In **Meta Business Suite**, open **Settings → Integrations → Conversation routing**, select the Instagram account, click **Manage** next to your app, and turn on **Access all conversations** and **Take control of conversations**.
