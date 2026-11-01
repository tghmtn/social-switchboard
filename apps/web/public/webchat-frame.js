// The chat window inside the frame /webchat.js opens on a website. It talks to
// /api/webchat/<key>/… with a random token this browser keeps, so the conversation is still there
// when the visitor comes back. Plain JS on purpose: no app bundle to load on someone's site.
(() => {
  const key = new URLSearchParams(location.search).get('key') ?? '';
  const api = `/api/webchat/${encodeURIComponent(key)}`;
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const quick = $('quick');
  const errorLine = $('error');
  const box = $('text');
  const sendButton = $('send');

  // The visitor's token: made once, kept in this browser (in memory if storage is blocked).
  const TOKEN = `ss-webchat-${key}`;
  let token;
  try {
    token = localStorage.getItem(TOKEN);
  } catch {}
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    try {
      localStorage.setItem(TOKEN, token);
    } catch {}
  }

  let greeting = '';
  let messages = [];
  let lastSeq = 0;
  let waiting = false;
  let open = true;

  const post = async (path, body) => {
    const res = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, after: lastSeq, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Couldn’t reach the chat. Try again in a moment.');
    return data;
  };

  const take = (incoming) => {
    const seen = new Set(messages.map((m) => m.seq));
    const fresh = incoming.filter((m) => !seen.has(m.seq));
    if (!fresh.length) return false;
    messages = [...messages, ...fresh].sort((a, b) => a.seq - b.seq);
    lastSeq = messages[messages.length - 1].seq;
    return true;
  };

  // Text with its links made tappable, without ever writing their text as HTML.
  const textWithLinks = (el, text) => {
    const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
    for (const part of parts) {
      if (/^https?:\/\//.test(part)) {
        const a = document.createElement('a');
        a.href = part;
        a.textContent = part;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        el.append(a);
      } else if (part) {
        el.append(part);
      }
    }
  };

  const bubble = (text) => {
    const div = document.createElement('div');
    div.className = 'bubble';
    textWithLinks(div, text);
    return div;
  };

  const choiceButton = (label, onTap) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'choice';
    b.textContent = label;
    b.addEventListener('click', onTap);
    return b;
  };

  function render() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren();
    if (!messages.length && greeting) {
      const g = document.createElement('div');
      g.className = 'msg us';
      g.append(bubble(greeting));
      log.append(g);
    }
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = `msg ${m.from}`;
      if (m.from === 'visitor') {
        row.append(bubble(m.text));
      } else {
        for (const p of m.parts ?? []) {
          if (p.type === 'text') row.append(bubble(p.text));
          else if (p.type === 'image') {
            const img = document.createElement('img');
            img.src = p.url;
            img.alt = p.alt ?? '';
            img.loading = 'lazy';
            row.append(img);
          } else if (p.type === 'file') {
            const wrap = document.createElement('div');
            wrap.className = 'bubble';
            const a = document.createElement('a');
            a.href = p.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = `📄 ${p.name}`;
            wrap.append(a);
            row.append(wrap);
          }
        }
        for (const b of m.buttons ?? []) {
          if (b.kind === 'url') {
            const a = document.createElement('a');
            a.className = 'choice';
            a.href = b.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = b.label;
            row.append(a);
          } else {
            row.append(choiceButton(b.label, () => send({ choice: { seq: m.seq, id: b.id } })));
          }
        }
      }
      log.append(row);
    }
    if (waiting) {
      const t = document.createElement('div');
      t.className = 'typing';
      t.textContent = '…';
      log.append(t);
    }
    // Quick replies belong to our latest message, until they answer it.
    quick.replaceChildren();
    const last = messages[messages.length - 1];
    if (last?.from === 'us' && !waiting)
      for (const q of last.quickReplies ?? [])
        quick.append(choiceButton(q.label, () => send({ choice: { seq: last.seq, id: q.id } })));
    if (atBottom || waiting) log.scrollTop = log.scrollHeight;
  }

  async function send(body) {
    if (waiting) return;
    errorLine.textContent = '';
    waiting = true;
    sendButton.disabled = true;
    render();
    log.scrollTop = log.scrollHeight;
    try {
      const data = await post('/send', body);
      take(data.messages ?? []);
      if (body.text) box.value = '';
    } catch (err) {
      errorLine.textContent = err.message;
    } finally {
      waiting = false;
      sendButton.disabled = false;
      grow();
      render();
      log.scrollTop = log.scrollHeight;
    }
  }

  async function poll() {
    if (!open || waiting || document.visibilityState !== 'visible') return;
    try {
      const data = await post('/poll', {});
      if (take(data.messages ?? [])) render();
    } catch {
      // A missed check; the next one catches up.
    }
  }

  // The box grows with what's typed (its 2px of border on top of what scrollHeight counts).
  const grow = () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, 120)}px`;
    box.style.overflowY = box.scrollHeight + 2 > 120 ? 'auto' : 'hidden';
  };
  box.addEventListener('input', grow);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (text) send({ text });
  });
  // The close button is ours, but the chat window is the site's: ask it to close.
  $('close').addEventListener('click', () => window.parent.postMessage({ type: 'close' }, '*'));
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'switchboard:open') {
      open = true;
      void poll();
      box.focus();
    }
    if (e.data?.type === 'switchboard:close') open = false;
  });

  fetch(api)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((look) => {
      $('title').textContent = look.title;
      document.title = look.title;
      greeting = look.greeting ?? '';
      if (/^#[0-9a-f]{6}$/i.test(look.color))
        document.documentElement.style.setProperty('--accent', look.color);
      render();
    })
    .catch(() => {
      errorLine.textContent = 'This chat isn’t available right now.';
    });
  void poll();
  setInterval(poll, 3000);
  box.focus();
})();
