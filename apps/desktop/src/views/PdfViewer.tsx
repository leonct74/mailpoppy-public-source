// In-app PDF rendering via Mozilla's pdf.js. The webview's built-in PDF plugin
// doesn't run inside the sandboxed AgentsPoppy iframe (a blob <iframe> renders a
// blank page), so pages are rasterised to <canvas> instead — identical behaviour
// in the standalone app, the container, and a plain browser. pdf.js is imported
// dynamically so the inbox bundle stays lean and tests never load it.
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../ui";

/** A mail attachment, not a book — cap the render work. */
const MAX_PAGES = 100;

export function PdfViewer({ bytes }: { bytes: Uint8Array }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // Real-worker loading can fail inside the sandboxed (opaque-origin) iframe;
        // pdf.js then falls back to its main-thread "fake worker" — slower but
        // correct, and mail-sized PDFs are small.
        pdfjs.GlobalWorkerOptions.workerSrc = (
          await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
        ).default;
        // pdf.js TRANSFERS (detaches) the buffer it's given — hand it a copy so the
        // caller's bytes stay usable (the preview's "Save to Downloads" button).
        const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (cancelled) return;
        const host = hostRef.current;
        if (!host) return;
        host.innerHTML = "";
        const width = Math.min(host.clientWidth || 800, 1000);
        const dpr = window.devicePixelRatio || 1;
        for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
          const page = await pdf.getPage(i);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = (width - 24) / base.width;
          const viewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          canvas.className = "mx-auto mb-3 block rounded bg-paper shadow-lg";
          host.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  return (
    <div className="h-full w-full overflow-y-auto p-3">
      {state === "loading" && (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-on-surface-variant">
          <Spinner /> Rendering PDF…
        </p>
      )}
      {state === "error" && (
        <p className="py-10 text-center text-sm text-on-surface-variant">
          This PDF can&rsquo;t be previewed here — use &ldquo;Save to Downloads&rdquo; to open it in your PDF app.
        </p>
      )}
      <div ref={hostRef} />
    </div>
  );
}
