// Social Switchboard's web chat, for your own website. Paste where the page ends:
//   <script src="https://your-switchboard.example/webchat.js" data-key="wc_…" async></script>
// It draws a chat button in the corner; the chat opens in a frame from your Switchboard.
// A button of your own can open it too: SwitchboardChat.open().
(() => {
  const script = document.currentScript;
  const key = script?.dataset.key;
  if (!script || !key || window.SwitchboardChat) return;
  const origin = new URL(script.src).origin;
  const api = { open: () => {}, close: () => {} };
  window.SwitchboardChat = api;

  fetch(`${origin}/api/webchat/${encodeURIComponent(key)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((look) => {
      if (look) mount(look);
    })
    .catch(() => {});

  const CHAT_ICON =
    '<svg width="28" height="28" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,24A104,104,0,0,0,36.18,176.88L24.83,210.93a16,16,0,0,0,20.24,20.24l34.05-11.35A104,104,0,1,0,128,24Zm0,192a87.87,87.87,0,0,1-44.06-11.81,8,8,0,0,0-6.54-.67L40,216,52.47,178.6a8,8,0,0,0-.66-6.54A88,88,0,1,1,128,216Z"/></svg>';
  const CLOSE_ICON =
    '<svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';

  function mount(look) {
    const color = /^#[0-9a-f]{6}$/i.test(look.color) ? look.color : '#5b2ef0';
    const host = document.createElement('div');
    host.setAttribute('data-switchboard-chat', '');
    // Its own shadow root, so the site's styles and ours never mix.
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      .launcher {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
        width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer;
        display: grid; place-items: center; color: #fff; background: ${color};
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
      }
      .launcher:focus-visible { outline: 3px solid #111; outline-offset: 3px; }
      .panel {
        position: fixed; right: 20px; bottom: 92px; z-index: 2147483000;
        width: 380px; height: min(640px, calc(100vh - 120px));
        border-radius: 16px; overflow: hidden; background: #fff;
        box-shadow: 0 12px 48px rgba(0, 0, 0, 0.3);
      }
      .panel[hidden] { display: none; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
      @media (max-width: 480px) {
        .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; }
        .open .launcher { display: none; }
      }
    </style>
    <div class="wrap"><div class="panel" hidden></div><button class="launcher" type="button"></button></div>`;
    const wrap = root.querySelector('.wrap');
    const panel = root.querySelector('.panel');
    const launcher = root.querySelector('.launcher');
    launcher.setAttribute('aria-label', String(look.title || 'Chat'));
    launcher.innerHTML = CHAT_ICON;
    let frame;

    const tell = (type) => frame?.contentWindow?.postMessage({ type }, origin);
    api.open = () => {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.title = String(look.title || 'Chat');
        frame.src = `${origin}/webchat.html?key=${encodeURIComponent(key)}`;
        panel.append(frame);
      }
      panel.hidden = false;
      wrap.classList.add('open');
      launcher.innerHTML = CLOSE_ICON;
      launcher.setAttribute('aria-expanded', 'true');
      tell('switchboard:open');
    };
    api.close = () => {
      panel.hidden = true;
      wrap.classList.remove('open');
      launcher.innerHTML = CHAT_ICON;
      launcher.setAttribute('aria-expanded', 'false');
      tell('switchboard:close');
      launcher.focus();
    };
    launcher.addEventListener('click', () => (panel.hidden ? api.open() : api.close()));
    // The chat's own close button (it's in the frame, so it asks).
    window.addEventListener('message', (e) => {
      if (e.origin === origin && e.source === frame?.contentWindow && e.data?.type === 'close')
        api.close();
    });
    document.body.append(host);
  }
})();
