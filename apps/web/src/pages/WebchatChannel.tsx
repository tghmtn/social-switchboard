import { ChatCircleDots } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, useApi } from '../api';
import { Icon } from '../components/Icon';
import { Field, FormError, PageHeader } from '../ui';
import { CopyText } from './Channels';
import { Page } from './Shell';

// Channels → Web chat: a chat button for the workspace's own website. Turn it on, make it look
// right, copy the embed code, and try it on a stand-in page.

type Webchat = {
  settings: {
    enabled: boolean;
    key: string | null;
    title: string;
    greeting: string;
    color: string;
  };
  /** Where the embed code loads the chat from. */
  origin: string;
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? (Object.values(err.fieldErrors())[0] ?? (err.code.includes(' ') ? err.code : fallback))
    : fallback;

export function WebchatChannel() {
  const { data, setData } = useApi<Webchat>('/webchat/settings');
  return (
    <Page>
      <Link to="/channels" className="linkbtn -mb-2 w-fit">
        ← Channels
      </Link>
      <PageHeader title="Web chat" />
      <p className="max-w-2xl text-[15px] text-muted">
        A chat button for your own website: a blog, a shop, a Ghost or WordPress site. Visitors chat
        with the same flows as on Instagram and Facebook, and their conversations land in your
        Inbox. Nothing to set up with Meta or anyone else.
      </p>
      {data && <Setup data={data} onSaved={setData} />}
    </Page>
  );
}

function Setup({ data, onSaved }: { data: Webchat; onSaved: (d: Webchat) => void }) {
  const s = data.settings;
  const [enabled, setEnabled] = useState(s.enabled);
  const [color, setColor] = useState(s.color);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setMessage(undefined);
    setErrors({});
    setBusy(true);
    try {
      const r = await api<Webchat>(
        '/webchat/settings',
        {
          enabled,
          title: String(form.get('title') ?? '').trim(),
          greeting: String(form.get('greeting') ?? '').trim(),
          color,
        },
        'PUT',
      );
      onSaved(r);
      setMessage({
        ok: true,
        text: enabled ? 'Saved. Copy the code below into your site.' : 'Saved. The chat is off.',
      });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      setMessage({ ok: false, text: errorText(err, 'Couldn’t save.') });
    } finally {
      setBusy(false);
    }
  }

  const live = s.enabled && s.key;
  const snippet = s.key
    ? `<script src="${data.origin}/webchat.js" data-key="${s.key}" async></script>`
    : '';

  return (
    <div className="grid max-w-2xl gap-6">
      <form onSubmit={save} className="card card-flat grid gap-4" autoComplete="off">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span className="grid leading-tight">
            <span className="font-bold">Show the chat on my site</span>
            <span className="text-[13px] text-muted">
              Off hides the button everywhere the code is pasted, without removing the code.
            </span>
          </span>
        </label>
        <div className="grid items-start gap-3 sm:grid-cols-[1fr_auto]">
          <Field
            label="Title"
            name="title"
            defaultValue={s.title}
            maxLength={40}
            error={errors.title}
            hint="At the top of the chat window."
          />
          <div className="grid gap-1.5">
            <label htmlFor="wc-color" className="text-sm font-bold">
              Color
            </label>
            <span className="flex items-center gap-2">
              <input
                id="wc-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-11 w-14 cursor-pointer border-2 border-edge bg-surface p-1"
              />
              <code className="text-[13px]">{color}</code>
            </span>
          </div>
        </div>
        <label className="grid gap-1.5">
          <span className="text-sm font-bold">Greeting</span>
          <textarea
            name="greeting"
            className="input min-h-20"
            defaultValue={s.greeting}
            maxLength={300}
          />
          <span className="text-[13px] text-muted">
            What visitors see before they write. Your flows answer once they do.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
          {live && (
            <a
              className="btn"
              href={`${data.origin}/webchat-demo.html?key=${encodeURIComponent(s.key ?? '')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Try it ↗
            </a>
          )}
        </div>
        {message &&
          (message.ok ? (
            <p className="text-[14px] font-bold text-success">{message.text}</p>
          ) : (
            <FormError message={message.text} />
          ))}
      </form>

      {snippet && (
        <section className="grid gap-3" aria-labelledby="wc-code-h">
          <h2 id="wc-code-h" className="font-display text-display-sm font-bold">
            Add it to your site
          </h2>
          <p className="text-[15px]">
            Paste this into every page, just before <code>{'</body>'}</code>. Once it’s there, the
            switch above turns the chat on and off.
          </p>
          <CopyText text={snippet} />
          <ul className="grid list-disc gap-1.5 pl-5 text-[14px]">
            <li>
              <b>Ghost:</b> Settings → Code injection → Site footer.
            </li>
            <li>
              <b>WordPress:</b> a header-and-footer plugin (like WPCode), in the footer box.
            </li>
            <li>
              <b>Squarespace or Wix:</b> their “code injection” or “custom code” setting, footer.
            </li>
            <li>
              <b>A button of your own</b> can open the chat too: <code>SwitchboardChat.open()</code>
              .
            </li>
          </ul>
        </section>
      )}

      <section className="grid gap-2" aria-labelledby="wc-flows-h">
        <h2 id="wc-flows-h" className="flex items-center gap-2 font-bold">
          <Icon icon={ChatCircleDots} size={22} /> What answers visitors
        </h2>
        <p className="text-[14px]">
          Your flows’ <b>welcome</b>, <b>keyword</b> and <b>default reply</b> triggers work here
          just like on Instagram. Visitors stay anonymous until a flow asks their name or email (an{' '}
          <b>Ask</b> step), and you can reply from the{' '}
          <Link to="/inbox?channel=webchat">Inbox</Link> any time: they see it in the chat, now or
          when they’re back.
        </p>
      </section>
    </div>
  );
}
