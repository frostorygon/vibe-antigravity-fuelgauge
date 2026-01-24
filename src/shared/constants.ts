/**
 * Antigravity FuelGauge - Constants
 * Centralized management of all hardcoded magic values
 */

/** Quota health default thresholds */
export const QUOTA_THRESHOLDS = {
    /** Healthy state threshold (> 50%) */
    HEALTHY: 50,
    /** Warning state default threshold - yellow */
    WARNING_DEFAULT: 30,
    /** Critical state default threshold - red */
    CRITICAL_DEFAULT: 10,
} as const;

/** Feedback链接 (Removed in secure fork) */
export const FEEDBACK_URL = '';

/** Time-related constants (milliseconds)) */
export const TIMING = {
    /** Default refresh interval */
    DEFAULT_REFRESH_INTERVAL_MS: 120000,
    /** Process scan retry interval */
    PROCESS_SCAN_RETRY_MS: 100,
    /** HTTP request timeout (10s, compatible with slow environments like WSL2) */
    HTTP_TIMEOUT_MS: 10000,
    /** Process command timeout (15000ms for PowerShell cold start on some Windows systems) */
    PROCESS_CMD_TIMEOUT_MS: 15000,
    /** Refresh cooldown (seconds)) */
    REFRESH_COOLDOWN_SECONDS: 60,
    /** Max consecutive retry count for runtime sync failures */
    MAX_CONSECUTIVE_RETRY: 5,
} as const;

/** UI-related constants */
export const UI = {
    /** Status bar priority */
    STATUS_BAR_PRIORITY: 100,
    /** Card minimum width */
    CARD_MIN_WIDTH: 280,
} as const;

/** API endpoint paths */
export const API_ENDPOINTS = {
    GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
} as const;

/** Target process name mapping */
export const PROCESS_NAMES = {
    windows: 'language_server_windows_x64.exe',
    darwin_arm: 'language_server_macos_arm',
    darwin_x64: 'language_server_macos',
    linux: 'language_server_linux',
} as const;

/** Config key names */
export const CONFIG_KEYS = {
    REFRESH_INTERVAL: 'refreshInterval',
    SHOW_PROMPT_CREDITS: 'showPromptCredits',
    PINNED_MODELS: 'pinnedModels',
    MODEL_ORDER: 'modelOrder',
    MODEL_CUSTOM_NAMES: 'modelCustomNames',
    VISIBLE_MODELS: 'visibleModels',
    LOG_LEVEL: 'logLevel',
    NOTIFICATION_ENABLED: 'notificationEnabled',
    STATUS_BAR_FORMAT: 'statusBarFormat',
    GROUPING_ENABLED: 'groupingEnabled',
    GROUPING_CUSTOM_NAMES: 'groupingCustomNames',
    GROUPING_SHOW_IN_STATUS_BAR: 'groupingShowInStatusBar',
    PINNED_GROUPS: 'pinnedGroups',
    GROUP_ORDER: 'groupOrder',
    GROUP_MAPPINGS: 'groupMappings',
    WARNING_THRESHOLD: 'warningThreshold',
    CRITICAL_THRESHOLD: 'criticalThreshold',
    QUOTA_SOURCE: 'quotaSource',
    DISPLAY_MODE: 'displayMode',
    PROFILE_HIDDEN: 'profileHidden',
    DATA_MASKED: 'dataMasked',
    LANGUAGE: 'language',
} as const;

/** Status bar display formats */
export const STATUS_BAR_FORMAT = {
    /** Icon only mode: shows only🚀 */
    ICON: 'icon',
    /** Dot only mode: shows only 🟢🟡🔴 */
    DOT: 'dot',
    /** Percent only mode: shows percentage only */
    PERCENT: 'percent',
    /** Compact mode: dot + percentage */
    COMPACT: 'compact',
    /** Name+percent mode: model name + percentage (no dot) */
    NAME_PERCENT: 'namePercent',
    /** Standard mode: dot + model name + percentage (default) */
    STANDARD: 'standard',
} as const;

/** Log levels */
export const LOG_LEVELS = {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
} as const;

/** Display modes */
export const DISPLAY_MODE = {
    /** Webview panel (default) */
    WEBVIEW: 'webview',
    /** QuickPick menu (compatibility mode) */
    QUICKPICK: 'quickpick',
} as const;
