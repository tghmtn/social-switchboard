import { graphRequest, MetaError, VERSIONS } from '../instagram/graph';

// The Facebook Graph API for Pages: Facebook Login, the Pages a person can connect, webhook
// subscriptions, Messenger's Send API, comment replies and profiles. Shapes follow Meta's docs and
// what Chatwoot (Messenger) and Postiz (Pages owned through a Business portfolio) do.

const base = () => `https://graph.facebook.com/${VERSIONS.facebook}`;

/** What Facebook Login asks for: list the Pages, message as them, read and answer comments. */
export const PAGE_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_engagement',
  'business_management',
];

/** Webhook fields a connected Page sends us. */
export const PAGE_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_referrals',
  'message_echoes',
  'feed',
];

export function pageAuthorizeUrl(
  appId: string,
  redirectUri: string,
  state: string,
  configId?: string | null,
) {
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state });
  // Facebook Login for Business names its permissions in a configuration; classic login asks here.
  if (configId) {
    params.set('config_id', configId);
    params.set('response_type', 'code');
    params.set('override_default_response_type', 'true');
  } else params.set('scope', PAGE_SCOPES.join(','));
  return `https://www.facebook.com/${VERSIONS.facebook}/dialog/oauth?${params}`;
}

/** A login code for a user token, then that token for a long-lived one (Page tokens from it last). */
export async function pageUserToken(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
) {
  const short = await graphRequest<{ access_token: string }>(
    `${base()}/oauth/access_token?${new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`,
  );
  const long = await graphRequest<{ access_token: string }>(
    `${base()}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token })}`,
  );
  return long.access_token;
}

export type ListedPage = { id: string; name: string; access_token: string; picture?: string };
type PageRow = {
  id: string;
  name: string;
  access_token?: string;
  picture?: { data?: { url?: string } };
};

/**
 * The Pages a login can act for. Meta doesn't list them in one place, so we look in each, as
 * Postiz and our Instagram login do: the person's own Pages (/me/accounts), those their Business
 * portfolios own or manage for clients, and the Pages the token itself was granted (debug_token),
 * fetched one by one. That last one catches Facebook Login for Business, whose tokens often show
 * nothing in the lists. `notes` records what each step found (counts and errors, never tokens).
 */
export async function listPages(
  userToken: string,
  app?: { id: string; secret: string },
): Promise<{ pages: ListedPage[]; notes: string[] }> {
  const fields = 'id,name,access_token,picture.type(large)';
  const auth = { headers: { Authorization: `Bearer ${userToken}` } };
  const found = new Map<string, ListedPage>();
  const notes: string[] = [];
  const add = (rows: PageRow[]) => {
    let added = 0;
    for (const p of rows)
      if (p.access_token && !found.has(p.id)) {
        found.set(p.id, {
          id: p.id,
          name: p.name,
          access_token: p.access_token,
          picture: p.picture?.data?.url,
        });
        added++;
      }
    return added;
  };
  const why = (err: unknown) =>
    err instanceof MetaError ? `error ${err.code} ${err.message}` : String(err);

  try {
    const rows = (
      await graphRequest<{ data: PageRow[] }>(
        `${base()}/me/accounts?fields=${fields}&limit=100`,
        auth,
      )
    ).data;
    notes.push(`me/accounts: ${rows.length} (with tokens: ${add(rows)})`);
  } catch (err) {
    notes.push(`me/accounts: ${why(err)}`);
  }
  try {
    const businesses = await graphRequest<{ data: { id: string }[] }>(
      `${base()}/me/businesses?limit=50`,
      auth,
    );
    notes.push(`businesses: ${businesses.data.length}`);
    for (const b of businesses.data)
      for (const edge of ['owned_pages', 'client_pages']) {
        try {
          const rows = (
            await graphRequest<{ data: PageRow[] }>(
              `${base()}/${b.id}/${edge}?fields=${fields}&limit=100`,
              auth,
            )
          ).data;
          notes.push(`${edge}: ${rows.length} (with tokens: ${add(rows)})`);
        } catch (err) {
          notes.push(`${edge}: ${why(err)}`);
        }
      }
  } catch (err) {
    notes.push(`businesses: ${why(err)}`);
  }
  if (app) {
    try {
      const debug = await graphRequest<{
        data?: {
          type?: string;
          scopes?: string[];
          granular_scopes?: { scope: string; target_ids?: string[] }[];
        };
      }>(
        `${base()}/debug_token?${new URLSearchParams({ input_token: userToken, access_token: `${app.id}|${app.secret}` })}`,
      );
      const granular = debug.data?.granular_scopes ?? [];
      notes.push(
        `granted: type=${debug.data?.type ?? '?'} scopes=${(debug.data?.scopes ?? []).join(',') || 'none'} targets=${
          granular.map((g) => `${g.scope}:${g.target_ids?.length ?? 'all'}`).join(',') || 'none'
        }`,
      );
      const ids = [
        ...new Set(
          granular.filter((g) => g.scope.startsWith('pages_')).flatMap((g) => g.target_ids ?? []),
        ),
      ].filter((id) => !found.has(id));
      for (const id of ids) {
        try {
          const row = await graphRequest<PageRow>(`${base()}/${id}?fields=${fields}`, auth);
          notes.push(`granted page: ${add([row]) ? 'ok' : 'no page token'}`);
        } catch (err) {
          notes.push(`granted page: ${why(err)}`);
        }
      }
    } catch (err) {
      notes.push(`debug_token: ${why(err)}`);
    }
  }
  return { pages: [...found.values()], notes };
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** Turns on the Page's webhooks for this app. */
export async function subscribePage(pageId: string, pageToken: string) {
  return graphRequest<{ success: boolean }>(
    `${base()}/${pageId}/subscribed_apps?subscribed_fields=${PAGE_FIELDS.join(',')}`,
    { method: 'POST', headers: bearer(pageToken) },
  );
}

export async function unsubscribePage(pageId: string, pageToken: string) {
  return graphRequest<{ success: boolean }>(`${base()}/${pageId}/subscribed_apps`, {
    method: 'DELETE',
    headers: bearer(pageToken),
  });
}

export type PageRecipient = { id: string } | { comment_id: string };

/** Messenger's Send API. A reply to a comment comes back with the person's Messenger id. */
export async function sendPageMessage(
  pageId: string,
  pageToken: string,
  recipient: PageRecipient,
  message: object,
) {
  return graphRequest<{ recipient_id?: string; message_id?: string }>(
    `${base()}/${pageId}/messages`,
    {
      method: 'POST',
      headers: bearer(pageToken),
      body: JSON.stringify({ recipient, message, messaging_type: 'RESPONSE' }),
    },
  );
}

/** A public reply under a comment. */
export async function replyToPageComment(commentId: string, pageToken: string, text: string) {
  return graphRequest<{ id: string }>(`${base()}/${commentId}/comments`, {
    method: 'POST',
    headers: bearer(pageToken),
    body: JSON.stringify({ message: text }),
  });
}

/** What Messenger shares about someone who has messaged the Page. */
export async function messengerProfile(psid: string, pageToken: string) {
  return graphRequest<{ first_name?: string; last_name?: string; profile_pic?: string }>(
    `${base()}/${psid}?fields=first_name,last_name,profile_pic`,
    { headers: { Authorization: `Bearer ${pageToken}` } },
  );
}

export type PagePost = {
  id: string;
  message?: string;
  created_time?: string;
  full_picture?: string;
  permalink_url?: string;
};

/** The Page's recent posts, newest first, for comment triggers on specific posts. */
export async function pagePosts(pageId: string, pageToken: string, limit = 30) {
  const data = await graphRequest<{ data: PagePost[] }>(
    `${base()}/${pageId}/posts?fields=id,message,created_time,full_picture,permalink_url&limit=${limit}`,
    { headers: { Authorization: `Bearer ${pageToken}` } },
  );
  return data.data;
}

/** What to tell a person, for the Facebook errors people actually hit. */
export function facebookFriendly(err: MetaError) {
  if (err.code === 190)
    return 'Facebook signed this app out of the Page. Reconnect it on the Channels page.';
  if (err.code === 10 && /window/i.test(err.message))
    return 'Outside Messenger’s 24-hour window: they haven’t messaged in over a day.';
  if (err.code === 551) return 'This person isn’t available on Messenger right now.';
  if (err.subcode === 2018108 || err.subcode === 2018278)
    return 'Facebook doesn’t allow a private reply to this comment (it may be too old, already answered, or deleted).';
  if (err.subcode === 2018109) return 'Another app owns this conversation (Page inbox settings).';
  if (err.code === 200 || err.code === 230)
    return 'The Page hasn’t allowed this app to message for it. Reconnect it and allow messaging.';
  if (err.code === 4 || err.code === 17 || err.code === 32 || err.code === 613)
    return 'Facebook rate limit reached; it will retry later.';
  return err.message;
}
