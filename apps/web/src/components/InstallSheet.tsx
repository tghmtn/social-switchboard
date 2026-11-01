import { DotsThree, DotsThreeVertical, Export, PlusSquare } from '@phosphor-icons/react';
import { type ReactNode, useEffect } from 'react';
import { type InstallWay, promptInstall } from '../install';
import { Icon } from './Icon';

// "Get the app": a sheet that suggests adding Switchboard to the Home Screen. Android's browsers
// install from our button; on an iPhone only the browser's own Share menu can, so we show where.

export function InstallSheet({ way, onClose }: { way: InstallWay; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-h"
        className="sheet absolute inset-x-0 bottom-0 mx-auto grid max-w-lg gap-4 border-t-2 border-edge bg-surface px-5 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))] min-[540px]:border-x-2"
      >
        <span className="mx-auto h-1.5 w-10 bg-line" aria-hidden />
        <div className="flex items-center gap-3.5">
          <img
            src="/icon-192.png"
            alt=""
            className="size-14 shrink-0 border-2 border-edge shadow-hard-sm"
          />
          <div className="grid gap-0.5">
            <h2 id="install-h" className="font-display text-[20px] leading-tight font-bold">
              Get the Switchboard app
            </h2>
            <p className="text-[14px] text-muted">
              Add it to your Home Screen: it opens full screen like any app
              {way === 'ios-safari' || way === 'ios-chrome'
                ? ', and it’s how iPhones get notifications for new messages.'
                : ', and new messages can notify you.'}
            </p>
          </div>
        </div>

        {way === 'prompt' && (
          <button
            type="button"
            className="btn btn-primary w-full"
            // The browser's own dialog takes it from here, yes or no.
            onClick={() => void promptInstall().finally(onClose)}
          >
            Install Switchboard
          </button>
        )}

        {way === 'ios-safari' && (
          <Steps>
            <Step n={1}>
              Tap <Glyph icon={DotsThree} /> at the bottom right, then{' '}
              <strong className="whitespace-nowrap">
                Share <Glyph icon={Export} />
              </strong>
              . If you see <Glyph icon={Export} /> in the toolbar, tap that instead.
            </Step>
            <Step n={2}>
              Scroll down and tap{' '}
              <strong className="whitespace-nowrap">
                Add to Home Screen <Glyph icon={PlusSquare} />
              </strong>
              . (It may be under <strong>View More</strong>.)
            </Step>
            <Step n={3}>
              Leave <strong>Open as Web App</strong> on, and tap <strong>Add</strong>.
            </Step>
            <Step n={4}>Open Switchboard from your Home Screen and sign in once more.</Step>
          </Steps>
        )}

        {way === 'ios-chrome' && (
          <Steps>
            <Step n={1}>
              Tap{' '}
              <strong className="whitespace-nowrap">
                Share <Glyph icon={Export} />
              </strong>{' '}
              at the right of the address bar.
            </Step>
            <Step n={2}>
              Tap{' '}
              <strong className="whitespace-nowrap">
                Add to Home Screen <Glyph icon={PlusSquare} />
              </strong>
              , then <strong>Add</strong>.
            </Step>
            <Step n={3}>Open Switchboard from your Home Screen and sign in once more.</Step>
          </Steps>
        )}

        {way === 'android' && (
          <Steps>
            <Step n={1}>
              Open your browser’s menu: <Glyph icon={DotsThreeVertical} /> at the top right (or the
              bottom bar).
            </Step>
            <Step n={2}>
              Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>, then{' '}
              <strong>Install</strong>.
            </Step>
          </Steps>
        )}

        {way === 'in-app' && (
          <Steps>
            <Step n={1}>
              This is the app’s built-in browser, which can’t add to your Home Screen. Tap{' '}
              <Glyph icon={DotsThree} /> at the top right.
            </Step>
            <Step n={2}>
              Choose <strong>Open in browser</strong> (or <strong>Open in Safari</strong>), and add
              it from there.
            </Step>
          </Steps>
        )}

        <button type="button" className="btn w-full" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="grid gap-2.5">{children}</ol>;
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[15px] leading-snug">
      <span className="grid size-7 shrink-0 place-items-center border-2 border-edge bg-surface-2 text-[13px] font-bold tabular-nums">
        {n}
      </span>
      <span className="min-w-0 pt-0.5">{children}</span>
    </li>
  );
}

/** A browser button drawn the way it looks, inline in a step. */
function Glyph({ icon }: { icon: Parameters<typeof Icon>[0]['icon'] }) {
  return (
    <span className="mx-0.5 inline-grid size-7 place-items-center border-2 border-line bg-surface-2 align-middle">
      <Icon icon={icon} size={18} line />
    </span>
  );
}
