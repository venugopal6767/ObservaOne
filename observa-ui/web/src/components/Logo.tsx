import { useId } from 'react';

export function Logo({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 40 40">
        <defs>
          <linearGradient id={`lg${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#60a5fa" /><stop offset="1" stopColor="#2563eb" />
          </linearGradient>
        </defs>
        <path d="M20 3 4 35h9l7-15 7 15h9z" fill={`url(#lg${id})`} />
        <circle cx="20" cy="27" r="4.5" fill="#0b1324" stroke="#93c5fd" strokeWidth="2" />
      </svg>
    </span>
  );
}
