/**
 * The cold-start notice.
 *
 * The API and the payment provider are on Render's free tier and sleep after
 * fifteen idle minutes; the first request afterwards takes 30 to 60 seconds.
 * A skeleton that sits still for a minute reads as broken, and a spinner with
 * no explanation reads as worse.
 *
 * So this line is held back for four seconds by `.reveal-late` — a warm API
 * answers well inside that and the notice is never seen — and it appears
 * underneath the skeleton without moving it. Pure CSS, so there is no timer to
 * clean up and it costs nothing on the fast path. Under
 * `prefers-reduced-motion` it appears immediately rather than not at all,
 * because it carries information rather than delight.
 */
export function ColdStartNotice() {
  return (
    <p className="reveal-late px-4 py-3 text-xs text-ink-muted">
      Still waiting on the API. It is deployed on a free tier that sleeps after
      15 idle minutes — the first request after that takes 30–60 seconds.
    </p>
  );
}
