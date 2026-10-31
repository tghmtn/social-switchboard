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
   Don't choose "Authenticate with Facebook Login" or anything about ads. Those break the connection or add heavy reviews.
4. **Business portfolio:** choose **I don't want to connect a business portfolio yet**.
5. Finish with **Create app**.

## step: credentials | Copy your app's IDs and secrets into Social Switchboard

Your Meta app has two pairs of keys. Copy them into the form below. They're stored encrypted on your server, and Social Switchboard never shows them again.

- **Instagram app ID and secret:** in your app, open **Use cases**, then **Manage messaging & content on Instagram**, then **Customize**, then **API setup with Instagram login**. Click **Show** next to the secret.
- **Facebook app secret:** **App settings → Basic → App secret**, then **Show**.

The Instagram app ID is a different number from the "App ID" at the top of the Basic page. Use the one from the Instagram setup page.

## step: login | Paste the login settings

Still in **API setup with Instagram login**, open **Set up Instagram business login → Business login settings** and paste:

- **OAuth redirect URIs:** `{{OAUTH_REDIRECT}}`
- **Deauthorize callback URL:** `{{DEAUTHORIZE}}`
- **Data deletion request URL:** `{{DATA_DELETION}}`

Save. Ignore the "Embed URL" Meta shows. Social Switchboard builds its own login link.

## step: tester | Add your account as an Instagram tester

Until your app is reviewed, only accounts with a role on it can connect. Even your own account needs this, and it has two halves.

**In the Meta dashboard:** open **App roles → Roles**, find **Instagram Testers**, click **Add**, and enter your Instagram username exactly. Some versions put this under **API setup with Instagram login → Generate access tokens → Add account**.

**In Instagram, on that account:**
- **App:** Profile → **☰** → **Settings and activity** → **Apps and websites** → **Tester invites** → **Accept**.
- **Computer:** log in at instagram.com, then open **instagram.com/accounts/manage_access** → **Tester invites**.

Until you accept, connecting fails with "Insufficient developer role".

## step: webhooks | Turn on webhooks

Webhooks are how Instagram tells this server about new comments and messages. In **API setup with Instagram login**, open **Configure webhooks**:

- **Callback URL:** `{{WEBHOOK}}`
- **Verify token:** `{{VERIFY_TOKEN}}`

Click **Verify and save**. Meta calls this server right away, and the check below turns green when it does.
If the button stays grey, click into the verify-token field and paste it again.

Then **subscribe** to the **comments** and **messages** fields, plus **messaging_postbacks** if it's listed.

## step: connect | Connect your Instagram account

Click **Connect Instagram** below. Instagram asks you to log in and approve. Use the account you added as a tester, then you'll come back here.

## step: publish | Publish your app

Meta only sends real comments and messages to **published** apps. In development mode only the dashboard's test button works. Publishing doesn't need an App Review for accounts that are testers on your app.

1. In **App settings → Basic**, fill in:
   - **Privacy policy URL:** `{{PRIVACY}}`
   - **Terms of service URL:** `{{TERMS}}`
   - **User data deletion:** choose the callback option and use `{{DATA_DELETION}}`
   - **App icon** (1024×1024) and **Category**, if they're still empty
2. Save, then click **Publish** in the left sidebar and follow the prompts.

The check below turns green once a real event from Instagram reaches this server, such as a comment on one of your posts.

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
