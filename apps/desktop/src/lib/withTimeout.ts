// A backend call should never hang a view on an indefinite spinner. If it doesn't answer in time
// (backend still starting, a region mismatch wedging an AWS call, credentials in flux), reject so
// the load resolves into an actionable error state (with Retry) instead of "Loading…" forever.
export const LOAD_TIMEOUT_MS = 20000;

export function withTimeout<T>(p: Promise<T>, label: string, ms = LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out loading your ${label}. Your backend may be in a different AWS region than your linked account, still starting up, or your AWS credentials may need attention.`,
          ),
        ),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}
