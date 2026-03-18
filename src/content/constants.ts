export const SELECTORS = {
  modernListRoot: '[data-testid="list-view"]',
  classicListRoot: ".js-navigation-container",
  modernRows: '[data-testid="list-view"] li[class*="ListItem-module__listItem"]',
  classicRows: 'div[id^="issue_"].js-issue-row',
  modernTitleLink: '[data-testid="issue-pr-title-link"]',
  classicTitleLink: "a.markdown-title",
  modernMeta: '[data-testid="created-at"]',
  classicMeta: ".opened-by"
} as const;

export const MAX_CONCURRENT_FETCHES = 4;
export const HYDRATION_ROOT_MARGIN_PX = 320;
export const FRESH_CACHE_MS = 5 * 60 * 1000;
export const BRANCH_SUMMARY_OWNER_PREFIX_LENGTH = 6;
export const VERBOSE_BRANCH_SUMMARY_LENGTH = 26;
export const AUTO_REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
export const AUTO_REFRESH_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
export const MANAGED_NATIVE_META_ATTR = "data-bgpv-managed-native-meta";
