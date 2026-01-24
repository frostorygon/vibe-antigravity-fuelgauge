/**
 * Antigravity FuelGauge - Auto Trigger Types
 * Auto Trigger功能的Type Definitions
 */

/**
 * OAuth CredentialsData
 */
export interface OAuthCredential {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string;  // ISO 8601 格式
    projectId?: string;
    scopes: string[];
    email?: string;
    /** True if refresh token is invalid (marked when refresh fails) */
    isInvalid?: boolean;
}

/**
 * Account info for UI display (multi-account support)
 */
export interface AccountInfo {
    email: string;
    isActive: boolean;
    expiresAt?: string;
    /** True if refresh token is invalid (marked when refresh fails) */
    isInvalid?: boolean;
}

/**
 * AuthorizationState (supports multiple accounts)
 */
export interface AuthorizationStatus {
    isAuthorized: boolean;
    email?: string;
    expiresAt?: string;
    lastRefresh?: string;
    /** All authorized accounts */
    accounts?: AccountInfo[];
    /** Currently active account email */
    activeAccount?: string;
}

/**
 * 调度重复模式
 */
export type ScheduleRepeatMode = 'daily' | 'weekly' | 'interval';

/**
 * 星期几
 */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Sunday

/**
 * 调度Config
 */
export interface ScheduleConfig {
    enabled: boolean;
    repeatMode: ScheduleRepeatMode;

    // 每天模式
    dailyTimes?: string[];  // ["07:00", "12:00", "17:00"]

    // 每周模式
    weeklyDays?: number[];  // [1, 2, 3, 4, 5] = 工作日 (0 = Sunday)
    weeklyTimes?: string[];

    // Interval模式
    intervalHours?: number;
    intervalStartTime?: string;  // "07:00"
    intervalEndTime?: string;    // "22:00" (Optional，不填则全天)

    // 高级: Original crontab 表达式
    crontab?: string;

    /** 选中的ModelList (用于触发) */
    selectedModels: string[];

    /** 选中的AccountList（用于自动Wakeup，多Account） */
    selectedAccounts?: string[];

    /** QuotaReset时自动Wakeup */
    wakeOnReset?: boolean;

    /** 时段策略：Enable后，满额Reset只在指Scheduled段内生效 */
    timeWindowEnabled?: boolean;

    /** 满额Reset生效的Time窗口StartTime (如 "09:00") */
    timeWindowStart?: string;

    /** 满额Reset生效的Time窗口EndTime (如 "18:00") */
    timeWindowEnd?: string;

    /** 时段外使用固定Time触发 (如 ["22:00", "07:00"]) */
    fallbackTimes?: string[];

    /** CustomWakeup词 (Default: "hi") */
    customPrompt?: string;

    /** 最大输出 token 数 (Default: 8) */
    maxOutputTokens?: number;
}

/**
 * 触发Record
 */
export interface TriggerRecord {
    timestamp: string;  // ISO 8601
    success: boolean;
    prompt?: string;    // Send的RequestContent
    message?: string;   // AI 的回复
    duration?: number;  // ms
    totalTokens?: number; // 消耗的 token（总数）
    promptTokens?: number; // Tooltip词 token
    completionTokens?: number; // 生成 token
    traceId?: string; // Request traceId
    triggerType?: 'manual' | 'auto'; // 触发类型：手动Test | Auto Trigger
    triggerSource?: 'manual' | 'scheduled' | 'crontab' | 'quota_reset'; // Auto Trigger来源
    accountEmail?: string; // 触发Account
}

/**
 * ModelInfo（用于Auto Trigger）
 */
export interface ModelInfo {
    /** Model ID (用于 API 调用，如 gemini-3-pro-high) */
    id: string;
    /** Show名称 (如 Gemini 3 Pro (High)) */
    displayName: string;
    /** Model常量 (用于与Quota匹配，如 MODEL_PLACEHOLDER_M8) */
    modelConstant: string;
}

/**
 * Auto TriggerState
 */
export interface AutoTriggerState {
    authorization: AuthorizationStatus;
    schedule: ScheduleConfig;
    lastTrigger?: TriggerRecord;
    recentTriggers: TriggerRecord[];  // 最近 10 条
    nextTriggerTime?: string;  // ISO 8601
    /** Optional的ModelList（已Filter，只包含Quota中Show的Model） */
    availableModels: ModelInfo[];
}

/**
 * Webview Message类型
 */
export interface AutoTriggerMessage {
    type:
    | 'auto_trigger_get_state'
    | 'auto_trigger_start_auth'
    | 'auto_trigger_revoke_auth'
    | 'auto_trigger_save_schedule'
    | 'auto_trigger_test_trigger'
    | 'auto_trigger_state_update';
    data?: {
        models?: string[];
        [key: string]: unknown;
    };
}

/**
 * Crontab Parse结果
 */
export interface CrontabParseResult {
    valid: boolean;
    description?: string;  // 人类可读Description
    nextRuns?: Date[];     // 接下来几次RunningTime
    error?: string;
}

/**
 * 预设调度Template
 */
export interface SchedulePreset {
    id: string;
    name: string;
    description: string;
    config: Partial<ScheduleConfig>;
}

/**
 * 预设调度TemplateList
 */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
    {
        id: 'morning',
        name: '早间预触发',
        description: '每天早上 7:00 触发一次',
        config: {
            repeatMode: 'daily',
            dailyTimes: ['07:00'],
            selectedModels: ['gemini-3-flash'],
        },
    },
    {
        id: 'workday',
        name: '工作日预触发',
        description: '工作日早上 8:00 触发',
        config: {
            repeatMode: 'weekly',
            weeklyDays: [1, 2, 3, 4, 5],
            weeklyTimes: ['08:00'],
            selectedModels: ['gemini-3-flash'],
        },
    },
    {
        id: 'every4h',
        name: '每 4 小时触发',
        description: '从 7:00 Start，每 4 小时触发一次',
        config: {
            repeatMode: 'interval',
            intervalHours: 4,
            intervalStartTime: '07:00',
            intervalEndTime: '23:00',
            selectedModels: ['gemini-3-flash'],
        },
    },
];
