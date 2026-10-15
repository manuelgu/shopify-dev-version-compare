// Single source of truth for user settings (loaded by the content script and the popup).
window.SDV_DEFAULT_SETTINGS = Object.freeze({
  collapsed: false,      // banner collapsed by default
  inlineBadge: true,     // "since X" badge next to the page title
  memberBadges: true,    // badges on fields / arguments / enum values
  changelog: true,       // matching developer changelog entries
  prefetch: true,        // warm the schema cache in the background
  defaultTarget: 'unstable',
  newMarks: true,        // highlight what the viewed version introduced
  onlyChanges: false,    // hide sidebar entries and members that are identical in the compare target
  lastTarget: {},        // last compare target chosen per API, e.g. { 'admin-graphql': '2026-07' }
});
