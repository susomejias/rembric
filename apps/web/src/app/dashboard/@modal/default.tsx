/**
 * The `@modal` slot's unmatched state: every dashboard route that is not an
 * intercepted detail link renders no panel. Without this file Next has no
 * fallback for the slot on a hard navigation and the whole route 404s.
 */
export default function DashboardModalDefault() {
  return null;
}
