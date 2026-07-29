import { useEffect, useRef } from "react";
import { cn } from "./cn";

// A single requestAnimationFrame ticker shared by every spinner.
//
// A plain CSS `animate-spin` FREEZES on macOS WKWebView after this window's iframe is hidden and
// re-shown: WebKit tears down the compositor layer and doesn't repaint the animation on return.
// That's exactly what happens running as an AgentsPoppy extension when you leave a domain setup
// mid-flow (e.g. to the Dashboard) and come back — the spinners appear stuck. Driving the rotation
// from JS forces a real repaint every animation frame the page is visible, so spinners resume the
// instant you return instead of staying frozen. Nodes are mutated directly (not via React state),
// so N spinners share ONE rAF loop with zero per-frame re-renders.
const nodes = new Set<HTMLElement>();
let rafId: number | null = null;
let lastT = 0;
let angle = 0;

function tick(t: number): void {
  if (lastT) angle = (angle + (t - lastT) * 0.36) % 360; // 0.36 deg/ms ≈ one turn per second
  lastT = t;
  const transform = `rotate(${angle}deg)`;
  for (const n of nodes) n.style.transform = transform;
  rafId = nodes.size ? requestAnimationFrame(tick) : null;
}

function register(node: HTMLElement): () => void {
  nodes.add(node);
  if (rafId === null) {
    lastT = 0;
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    nodes.delete(node);
    if (nodes.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

const PETAL =
  "M 0 -52 C -66 -74, -92 -152, -54 -196 C -22 -232, 22 -232, 54 -196 C 92 -152, 66 -74, 0 -52 Z";

// The loading spinner: the poppy mark (this app IS a poppy) turning continuously, tinted with the
// app's own colour via `currentColor`. Same shared-rAF rotation as before, so it never freezes.
export function Spinner({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => (ref.current ? register(ref.current) : undefined), []);
  return (
    <span ref={ref} aria-hidden className={cn("inline-block size-4 text-primary align-[-3px]", className)}>
      <svg
        viewBox="0 0 512 512"
        className="size-full"
        fill="none"
        stroke="currentColor"
        strokeWidth={30}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g transform="translate(256 256) rotate(-10)">
          <path d={PETAL} />
          <path d={PETAL} transform="rotate(90)" />
          <path d={PETAL} transform="rotate(180)" />
          <path d={PETAL} transform="rotate(270)" />
          <circle r={30} strokeWidth={26} />
          <g strokeWidth={22}>
            <line x1={40} y1={-40} x2={56} y2={-56} />
            <line x1={40} y1={40} x2={56} y2={56} />
            <line x1={-40} y1={40} x2={-56} y2={56} />
            <line x1={-40} y1={-40} x2={-56} y2={-56} />
          </g>
        </g>
      </svg>
    </span>
  );
}
