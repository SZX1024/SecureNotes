import { ICON_SIZES, ICON_STROKE, icons, type IconName } from "./icons";

/**
 * One icon, drawn at the interface's size and weight.
 *
 * Decorative by default: an icon usually repeats something the surrounding text already says, and a screen reader
 * announcing "pencil" next to "Rename" is noise. When an icon *is* the control's only content, `label` gives it the
 * meaning it would otherwise lose.
 */
export function Icon({
  name,
  size = ICON_SIZES.default,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  const Shape = icons[name];
  return (
    <Shape
      size={size}
      strokeWidth={ICON_STROKE}
      className={className}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : "img"}
      focusable="false"
    />
  );
}
