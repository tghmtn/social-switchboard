// Instagram's APIs: OAuth, tokens, accounts, messaging and comments, for both setups Meta offers:
// - Unified login (every newer Meta app): Facebook Login for Business with a config_id, a business
//   system-user token, and calls to graph.facebook.com against the Instagram account id.
// - Instagram login (older apps): instagram.com OAuth, 60-day user tokens, graph.instagram.com.
// Instagram-login endpoints and their quirks adapted from OpenReply (MIT), lib/meta/client.ts and
// lib/meta/oauth.ts; see THIRD_PARTY_NOTICES.md. Unified login follows Meta's Instagram Platform docs.

/** Which API an account's token works with. */
export type Host = 'instagram' | 'facebook';
const VERSIONS: Record<Host, string> = {
  instagram: process.env.META_INSTAGRAM_API_VERSION ?? 'v25.0',
  facebook: process.env.META_GRAPH_API_VERSION ?? 'v26.0',
};
const base = (host: Host) =>
  host === 'facebook'
    ? `https://graph.facebook.com/${VERSIONS.facebook}`
    : `https://graph.instagram.com/${VERSIONS.instagram}`;
const GRAPH = () => base('instagram');
// Instagram Login authorizes on www.instagram.com (the old api.instagram.com/oauth/authorize
// belonged to the retired Basic Display API and now 404s); the code exchange stays on api.
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

export const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

/** Swappable for tests. */
let http: typeof fetch = (...args) => fetch(...args);
export function setHttp(impl: typeof fetch) {
  http = impl;
}

export class MetaError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly subcode?: number,
  ) {
    super(message);
  }

  /** What to tell a person, for the errors people actually hit. */
  get friendly(): string {
    if (this.code === 190)
      return 'Instagram signed this app out. Reconnect the account on the Channels page.';
    if (this.subcode === 2534037)
      return 'Another tool (like ManyChat) owns this conversation. Give this app control in Meta Business Suite → Conversation routing.';
    if (this.subcode === 2534025 || this.subcode === 2534023)
      return 'Instagram doesn’t allow a private reply to this comment (it may be too old, already answered, or deleted).';
    if (this.code === 10 && /window/i.test(this.message))
      return 'Outside Instagram’s 24-hour messaging window.';
    if (this.code === 4 || this.code === 17 || this.code === 613)
      return 'Instagram rate limit reached; it will retry later.';
    if (/developer role/i.test(this.message))
      return 'This Instagram account isn’t a tester on your Meta app yet, or hasn’t accepted the invite.';
    return this.message;
  }
}

async function call<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number };
    error_message?: string;
  };
  if (!res.ok || data.error) {
    const err = data.error;
    let path = '';
    try {
      path = ` (${new URL(res.url).pathname})`; // never the query string: it can carry the token
    } catch {}
    throw new MetaError(
      `${err?.message ?? data.error_message ?? `HTTP ${res.status}`}${path}`,
      err?.code ?? res.status,
      err?.error_subcode,
    );
  }
  return data as T;
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export function authorizeUrl(appId: string, redirectUri: string, state: string) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(','),
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/**
 * Unified login: Meta generates the Login URL (with client_id and config_id); we only set our
 * redirect and a signed state on it.
 */
export function unifiedAuthorizeUrl(loginUrl: string, redirectUri: string, state: string) {
  const url = new URL(loginUrl);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  if (!url.searchParams.has('response_type')) url.searchParams.set('response_type', 'code');
  // We open it as a whole page, not the popup the copied URL asks for.
  if (url.searchParams.get('display') === 'popup') url.searchParams.set('display', 'page');
  return url.toString();
}

/** Unified login code → business system-user token, using the Meta app ID and secret. */
export async function exchangeUnifiedCode(
  metaAppId: string,
  metaAppSecret: string,
  redirectUri: string,
  code: string,
) {
  const url = new URL(`${base('facebook')}/oauth/access_token`);
  url.searchParams.set('client_id', metaAppId);
  url.searchParams.set('client_secret', metaAppSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);
  const data = await call<{ access_token: string; expires_in?: number }>(await http(url));
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export type AssignedAccount = {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
};

/** One Instagram professional account by ID; fails unless the Unified login token may use it. */
export async function instagramAccount(token: string, igUserId: string) {
  const url = new URL(`${base('facebook')}/${igUserId}`);
  url.searchParams.set('fields', 'id,username,name,profile_picture_url');
  return call<AssignedAccount>(await http(url, { headers: bearer(token) }));
}

/** The Instagram accounts the business shared during Unified login (`/me` is the system user). */
export async function assignedInstagramAccounts(token: string): Promise<AssignedAccount[]> {
  const list = async (fields?: string) => {
    const url = new URL(`${base('facebook')}/me/assigned_instagram_accounts`);
    if (fields) url.searchParams.set('fields', fields);
    return (
      (await call<{ data?: AssignedAccount[] }>(await http(url, { headers: bearer(token) })))
        .data ?? []
    );
  };
  try {
    return await list('id,username,name,profile_picture_url');
  } catch (err) {
    if (!(err instanceof MetaError && err.code === 100)) throw err;
    // Fields not offered on this edge: list ids, then ask each account for its profile.
    const ids = await list();
    return Promise.all(
      ids.map(async (a) => {
        try {
          const url = new URL(`${base('facebook')}/${a.id}`);
          url.searchParams.set('fields', 'username,name,profile_picture_url');
          return {
            ...a,
            ...(await call<AssignedAccount>(await http(url, { headers: bearer(token) }))),
          };
        } catch {
          return a;
        }
      }),
    );
  }
}

/**
 * Which Instagram accounts a Unified login token can act for. Meta doesn't document one way to
 * list them, so we try, in order: the system user's assigned accounts, the token's granted
 * targets (debug_token), and Pages with a linked Instagram account. `notes` records what each
 * attempt returned (counts and errors, never tokens) for the logs.
 */
export async function findInstagramAccounts(
  token: string,
  metaAppId: string,
  metaAppSecret: string,
) {
  const notes: string[] = [];
  const found = new Map<string, AssignedAccount>();
  const attempt = async (label: string, list: () => Promise<AssignedAccount[]>) => {
    try {
      const accounts = await list();
      notes.push(`${label}: ${accounts.length}`);
      for (const a of accounts) found.set(a.id, { ...found.get(a.id), ...a });
    } catch (err) {
      notes.push(
        `${label}: ${err instanceof MetaError ? `error ${err.code} ${err.message}` : String(err)}`,
      );
    }
  };
  const get = async <T>(path: string, params: Record<string, string>, auth = true) => {
    const url = new URL(`${base('facebook')}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return call<T>(await http(url, auth ? { headers: bearer(token) } : undefined));
  };

  await attempt('assigned_instagram_accounts', () => assignedInstagramAccounts(token));
  if (found.size === 0) {
    await attempt('debug_token', async () => {
      const data = await get<{
        data?: {
          type?: string;
          scopes?: string[];
          granular_scopes?: { scope: string; target_ids?: string[] }[];
        };
      }>(
        'debug_token',
        { input_token: token, access_token: `${metaAppId}|${metaAppSecret}` },
        false,
      );
      const granular = data.data?.granular_scopes ?? [];
      // What the login actually granted, for the logs: permission names and how many assets each covers.
      notes.push(
        `granted: type=${data.data?.type ?? '?'} scopes=${(data.data?.scopes ?? []).join(',') || 'none'} targets=${
          granular.map((g) => `${g.scope}:${g.target_ids?.length ?? 'all'}`).join(',') || 'none'
        }`,
      );
      const ids = granular
        .filter((g) => g.scope.startsWith('instagram_'))
        .flatMap((g) => g.target_ids ?? []);
      return [...new Set(ids)].map((id) => ({ id }));
    });
  }
  if (found.size === 0) {
    let business: string | undefined;
    try {
      business = (
        await get<{ client_business_id?: string }>('me', { fields: 'id,client_business_id' })
      ).client_business_id;
      notes.push(`client business: ${business ? 'yes' : 'none'}`);
    } catch (err) {
      notes.push(
        `client business: ${err instanceof MetaError ? `error ${err.code} ${err.message}` : String(err)}`,
      );
    }
    // The business the login was for (needs business_management): each edge on its own, so
    // the logs show which exist.
    for (const edge of [
      'owned_instagram_accounts',
      'client_instagram_accounts',
      'instagram_business_accounts',
      'instagram_accounts',
    ]) {
      if (!business || found.size > 0) break;
      await attempt(`business ${edge}`, async () => {
        const listed =
          (await get<{ data?: { id: string }[] }>(`${business}/${edge}`, { fields: 'id' })).data ??
          [];
        notes.push(`business ${edge} listed: ${listed.length}`);
        // Keep the Instagram professional accounts this token can read; some edges list other kinds of ID.
        const readable = await Promise.all(
          listed.map((a) =>
            get<AssignedAccount>(a.id, { fields: 'id,username,name,profile_picture_url' }).catch(
              () => undefined,
            ),
          ),
        );
        return readable.filter((a): a is AssignedAccount => Boolean(a));
      });
    }
  }
  if (found.size === 0) {
    await attempt('me/accounts', async () => {
      const data = await get<{ data?: { instagram_business_account?: AssignedAccount }[] }>(
        'me/accounts',
        {
          fields: 'instagram_business_account{id,username,name,profile_picture_url}',
        },
      );
      notes.push(`pages granted: ${data.data?.length ?? 0}`);
      return (data.data ?? []).flatMap((p) =>
        p.instagram_business_account ? [p.instagram_business_account] : [],
      );
    });
  }

  const accounts = await Promise.all(
    [...found.values()].map(async (a) => {
      if (a.username) return a;
      try {
        return {
          ...a,
          ...(await get<AssignedAccount>(a.id, { fields: 'username,name,profile_picture_url' })),
        };
      } catch {
        return a;
      }
    }),
  );
  return { accounts, notes };
}

export async function exchangeCode(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string,
) {
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const res = await http(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await call<{ access_token: string; user_id: string | number }>(res);
  return { accessToken: data.access_token, userId: String(data.user_id) };
}

/** Short-lived (1 hour) token → long-lived (60 days). */
export async function longLivedToken(appSecret: string, shortToken: string) {
  const url = new URL(`${GRAPH()}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', shortToken);
  const data = await call<{ access_token: string; expires_in?: number }>(await http(url));
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 5_184_000 };
}

export async function refreshToken(token: string) {
  const url = new URL(`${GRAPH()}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  const data = await call<{ access_token: string; expires_in?: number }>(await http(url));
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 5_184_000 };
}

export type Profile = {
  user_id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
};

/** The connected account. `user_id` is the id webhooks use; account_type is BUSINESS or MEDIA_CREATOR. */
export async function me(token: string): Promise<Profile> {
  const get = async (fields: string) => {
    const url = new URL(`${GRAPH()}/me`);
    url.searchParams.set('fields', fields);
    return call<Profile>(await http(url, { headers: bearer(token) }));
  };
  try {
    return await get('user_id,username,name,profile_picture_url,account_type');
  } catch (err) {
    // Some app setups don't expose account_type; the rest still matters.
    if (err instanceof MetaError && err.code === 100)
      return get('user_id,username,name,profile_picture_url');
    throw err;
  }
}

/** Tells Instagram to send this account's comment and message events to our webhook. */
export async function subscribe(igUserId: string, token: string, host: Host = 'instagram') {
  const attempt = async (fields: string[]) =>
    call<{ success: boolean }>(
      await http(`${base(host)}/${igUserId}/subscribed_apps`, {
        method: 'POST',
        headers: bearer(token),
        // graph.facebook.com documents a comma-separated list; graph.instagram.com takes an array.
        body: JSON.stringify({
          subscribed_fields: host === 'facebook' ? fields.join(',') : fields,
        }),
      }),
    );
  try {
    return await attempt(['comments', 'messages', 'messaging_postbacks', 'messaging_referral']);
  } catch {
    return attempt(['comments', 'messages']);
  }
}

/** A person's username, by the id they message us from. Best effort. */
export async function lookupUsername(
  token: string,
  igsid: string,
  host: Host = 'instagram',
): Promise<string | undefined> {
  try {
    const url = new URL(`${base(host)}/${igsid}`);
    url.searchParams.set('fields', 'username,name');
    const data = await call<{ username?: string; name?: string }>(
      await http(url, { headers: bearer(token) }),
    );
    return data.username;
  } catch {
    return undefined;
  }
}

export type Recipient = { id: string } | { comment_id: string };

export async function sendMessage(
  igUserId: string,
  token: string,
  recipient: Recipient,
  message: object,
  host: Host = 'instagram',
) {
  const res = await http(`${base(host)}/${igUserId}/messages`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ recipient, message }),
  });
  return call<{ recipient_id?: string; message_id?: string }>(res);
}

export async function replyToComment(
  commentId: string,
  token: string,
  text: string,
  host: Host = 'instagram',
) {
  const res = await http(`${base(host)}/${commentId}/replies`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ message: text }),
  });
  return call<{ id: string }>(res);
}

export type Media = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
};

/** Recent posts. With Unified login `/me` is the system user, so ask the account itself. */
export async function recentMedia(
  token: string,
  host: Host = 'instagram',
  igUserId?: string,
  limit = 30,
): Promise<Media[]> {
  const url = new URL(`${base(host)}/${host === 'facebook' && igUserId ? igUserId : 'me'}/media`);
  url.searchParams.set(
    'fields',
    'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
  );
  url.searchParams.set('limit', String(limit));
  const data = await call<{ data: Media[] }>(await http(url, { headers: bearer(token) }));
  return data.data;
}
