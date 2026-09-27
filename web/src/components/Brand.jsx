import React from 'react';

/** The graph8 mark: a geometric lowercase "g" stroked with the brand
    cyan -> blue -> violet gradient. Each instance needs its own gradient id,
    otherwise a second copy on the page reuses the first one's coordinates. */
let seq = 0;

export function G8Mark({ size = 32, className = '' }) {
  const id = React.useMemo(() => `g8grad${++seq}`, []);
  return (
    <svg
      className={`g8-mark ${className}`}
      width={size}
      height={size * 1.14}
      viewBox="0 0 34 39"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="2" y1="34" x2="32" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#4f8ff7" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <circle cx="14.5" cy="14" r="9.2" stroke={`url(#${id})`} strokeWidth="5" />
      <path
        d="M23.7 14 V25.8 C23.7 32.4 19.2 36 13.2 35.2"
        stroke={`url(#${id})`}
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The wordmark as it appears in graph8's own brand lockup: the product name
    in near-black, the suffix carrying the gradient. */
export function ProductMark({ head = 'Procurement', tail = 'OS' }) {
  return (
    <span className="product-mark">
      {head} <span className="grad-text">{tail}</span>
    </span>
  );
}
