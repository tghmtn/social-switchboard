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

**Where:** developers.facebook.com/apps

1. Click **Create app**.
2. **App name:** something like `Social Switchboard`. People may see it when they connect. Meta rejects names containing "Instagram", "Insta", "IG", "Facebook" or "Meta".
3. **Use case:** set the filter to **All**, then choose **Manage messaging & content on Instagram**.
   Don't choose "Authenticate with Facebook Login" or anything about ads.
4. **Business portfolio:** pick yours, or create one. Instagram's login needs a portfolio to own the app. A portfolio for yourself is fine; it's free and needs no company.
5. Finish with **Create app**. You land on your app's dashboard, with a sidebar on the left.

## step: basics | Fill in the app's basic settings and copy its secret

**Where in Meta:** left sidebar → **App settings** → **Basic**. These belong to the whole app, so they're not on the Instagram setup pages.

1. Fill in:
   - **Privacy policy URL:** `{{PRIVACY}}`
   - **Terms of service URL:** `{{TERMS}}`
   - **User data deletion:** choose the callback option and use `{{DATA_DELETION}}`
   - **App icon** (1024×1024) and **Category**
2. Click **Save changes**.
3. Next to **App secret**, click **Show**. Meta may ask for your Facebook password first. Paste the secret below.

The secret is how this server finishes logging you in and checks that messages really come from Meta. It's stored encrypted, and Social Switchboard never shows it again.

## step: login | Set up Instagram login and copy the Login URL

**Where in Meta:** left sidebar → **Use cases** → **Customize** next to **Manage messaging & content on Instagram** → **API setup with Unified login** → **1. Configure your app**.

1. Click **Create configuration** (or **Create another configuration**). Keep the defaults: a **system-user access token** that **never expires**, with **Instagram accounts** as the asset.
2. **Permissions:** keep **instagram_basic**, **instagram_manage_comments** and **instagram_manage_messages**. You can remove the ads permissions and **instagram_content_publish**; Social Switchboard doesn't use them, and fewer permissions make App Review easier.
3. Under **Register a new redirect URL**, paste `{{OAUTH_REDIRECT}}` and click **Save**. It then shows under **Select the registered URL**.
4. Under **Login URL**, click **Copy** and paste it below. It isn't secret: it's the address of Meta's sign-in page for your app.

**Older app?** If your dashboard shows **API setup with Instagram login** instead, open **Set up Instagram business login → Business login settings** there, paste `{{OAUTH_REDIRECT}}` as the redirect, `{{DEAUTHORIZE}}` as the deauthorize callback and `{{DATA_DELETION}}` for data deletion, and save. Then fill in "Older app" below instead of the Login URL.

## step: tester | Add your Instagram account to the app

**Where in Meta:** the same page, **2. Generate access tokens**.

Until your app passes App Review, only accounts with a role on it can connect, even your own.

1. **Give the account the tester role:** left sidebar → **App roles** → **Roles** → **Instagram Testers** → **Add**, and enter the username exactly.
2. **Accept the invite, in Instagram, on that account:**
   - **App:** Profile → **☰** → **Settings and activity** → **Apps and websites** → **Tester invites** → **Accept**.
   - **Computer:** log in at instagram.com, then open **instagram.com/accounts/manage_access** → **Tester invites**.
3. Back under **2. Generate access tokens**, click **Add account** and log in as that account. It shows up in the list.

Skip **Generate token**: the next step gets a token straight into Social Switchboard, so it never sits on your clipboard. **Webhook Subscription** still says **Off** for now; that's expected.

## step: connect | Connect your Instagram account

**Where:** right here. This does what Meta's **Generate token** button does.

Click **Connect Instagram** below. Meta asks you to log in, then to choose your **business portfolio** and your **Instagram account**, and to approve the permissions. Keep everything ticked. Then you'll come back here.

If it says no Instagram account was shared, connect again and make sure the account is ticked. If your account isn't in the list at all, add it to your portfolio first: **business.facebook.com → Settings → Accounts → Instagram accounts → Add**.

## step: webhooks | Turn on webhooks

**Where in Meta:** the same API setup page, **3. Configure webhooks**.

Webhooks are how Instagram tells this server about new comments and messages.

1. **Callback URL:** `{{WEBHOOK}}`
2. **Verify token:** `{{VERIFY_TOKEN}}`
3. Click **Verify and save**. Meta calls this server right away, and the check below turns green when it does. If the button stays grey, click into the verify-token field and paste it again.
4. **Subscribe** to the **comments** and **messages** fields, plus **messaging_postbacks** if it's listed.

Once the check is green, the **Webhook Subscription** switch next to your account under **2. Generate access tokens** should say **On** (reload Meta's page). If it still says Off, switch it on there.

## step: publish | Get real comments and messages

**Where in Meta:** the same API setup page, **4. Complete App Review**, and **Publish** in the left sidebar.

Meta says App Review comes before "live data". What that means for your own accounts is easiest to find out by trying:

1. From a **different** Instagram account, comment on one of your posts. The check below turns green when Instagram tells this server about it.
2. **Green?** You're set for your own accounts. Skip to the next step.
3. **Still waiting after a minute?** Click **Publish** in the left sidebar, then comment again.
4. **Still nothing?** Your app needs App Review. Open **4. Complete App Review**. Meta asks for:
   - a **verified business portfolio** (business.facebook.com → Settings → **Security center** → **Start verification**)
   - **Advanced access** to instagram_basic, instagram_manage_comments and instagram_manage_messages
   - a short screen recording of each permission in use; record a comment turning into a DM here
   - the privacy policy, terms and data deletion addresses from the basic settings step

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
