// From the theme package (components/Icon.tsx): Phosphor duotone icons, recolored lime by the
// .icon rules in index.css. Use SquareIcon for nav, feature cards and empty states instead.
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

type Props = {
  /** Pass the component, e.g. icon={CalendarBlank}. Import icons by name so they tree-shake. */
  icon: PhosphorIcon;
  /** 20 for inline UI, 24 default, 40 for feature cards. */
  size?: number;
  /** Set only if the icon carries meaning on its own. */
  label?: string;
  /** Plain stroke following the text color (arrows, chevrons). */
  line?: boolean;
  className?: string;
};

export function Icon({ icon: Glyph, size = 24, label, line = false, className = '' }: Props) {
  return (
    <Glyph
      size={size}
      weight={line ? 'bold' : 'duotone'}
      className={`${line ? 'icon-line' : 'icon'} ${className}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}
