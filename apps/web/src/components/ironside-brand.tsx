export interface IronsideBrandProps {
  className?: string;
  markClassName?: string;
  nameClassName?: string;
}

export function IronsideBrand({
  className = "",
  markClassName = "size-5",
  nameClassName = ""
}: IronsideBrandProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <img
        src="/brand/ironside-mark.png"
        alt=""
        aria-hidden="true"
        className={`shrink-0 object-contain ${markClassName}`.trim()}
      />
      <span className={nameClassName}>ironside</span>
    </span>
  );
}
