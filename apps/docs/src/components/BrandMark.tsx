export function BrandMark({ size }: Readonly<{ size: number }>) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
    >
      <path
        fill="var(--mantine-primary-color-filled)"
        d="M35.688 5.758A26.5 26.5 0 1 0 54.95 18.75A5.5 5.5 0 0 0 45.423 24.25A15.5 15.5 0 1 1 34.157 16.651A5.5 5.5 0 0 0 35.688 5.758Z"
      />
      <circle
        fill="var(--mantine-color-verdigris-2)"
        cx="35.2"
        cy="32"
        r="6.8"
      />
    </svg>
  );
}
