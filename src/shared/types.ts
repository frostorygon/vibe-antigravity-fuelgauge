/**
 * Antigravity FuelGauge - Type Definitions
 * 完整的类型System，避免使用 any
 */

// ============ Quota相关类型 ============

/** Prompt Credits Info */
export interface PromptCreditsInfo {
    /** 可用积分 */
    available: number;
    /** 每月Quota */
    monthly: number;
    /** 已使用Percentage */
    usedPercentage: number;
    /** RemainingPercentage */
    remainingPercentage: number;
}

/** ModelQuotaInfo */
export interface ModelQuotaInfo {
    /** ShowLabel */
    label: string;
    /** Model ID */
    modelId: string;
    /** Remaining比例 (0-1) */
    remainingFraction?: number;
    /** RemainingPercentage (0-100) */
    remainingPercentage?: number;
    /** 是否已耗尽 */
    isExhausted: boolean;
    /** ResetTime */
    resetTime: Date;
    /** 距离Reset的毫秒数 */
    timeUntilReset: number;
    /** Format的Reset倒计时 */
    timeUntilResetFormatted: string;
    /** Format的ResetTimeShow */
    resetTimeDisplay: string;
    /** ResetTime是否可信 */
    resetTimeValid?: boolean;
    /** 是否支持图片输入 */
    supportsImages?: boolean;
    /** 是否为推荐Model */
    isRecommended?: boolean;
    /** LabelTitle（如 "New"） */
    tagTitle?: string;
    /** 支持的 MIME 类型映射 */
    supportedMimeTypes?: Record<string, boolean>;
}

/** QuotaGroup - 共享相同Quota的Model集合 */
export interface QuotaGroup {
    /** Group唯一标识 (基于 remainingFraction + resetTime 生成) */
    groupId: string;
    /** Group名称 (UserCustom或自动生成) */
    groupName: string;
    /** Group内的ModelList */
    models: ModelQuotaInfo[];
    /** 共享的RemainingPercentage */
    remainingPercentage: number;
    /** 共享的ResetTime */
    resetTime: Date;
    /** Format的ResetTimeShow */
    resetTimeDisplay: string;
    /** Format的Reset倒计时 */
    timeUntilResetFormatted: string;
    /** 是否已耗尽 */
    isExhausted: boolean;
}

/** Quota快照 */
export interface QuotaSnapshot {
    /** Time戳 */
    timestamp: Date;
    /** Prompt Credits */
    promptCredits?: PromptCreditsInfo;
    /** UserInfo */
    userInfo?: UserInfo;
    /** ModelList */
    models: ModelQuotaInfo[];
    /** OriginalModelList（未Filter） */
    allModels?: ModelQuotaInfo[];
    /** QuotaGroup (开启Group功能时生成) */
    groups?: QuotaGroup[];
    /** ConnectState */
    isConnected: boolean;
    /** ErrorInfo */
    errorMessage?: string;
    /** Local账户Email（local 模式下使用远端 API 时） */
    localAccountEmail?: string;
}

/** Quota健康State */
export enum QuotaLevel {
    /** 正常 (> 50%) */
    Normal = 'normal',
    /** Warning (20-50%) */
    Warning = 'warning',
    /** 危险 (< 20%) */
    Critical = 'critical',
    /** 已耗尽 (0%) */
    Depleted = 'depleted',
}

// ============ API Response类型 ============

/** Model或别名 */
export interface ModelOrAlias {
    model: string;
}

/** QuotaInfo */
export interface QuotaInfo {
    remainingFraction?: number;
    resetTime: string;
}

/** ClientModelConfig */
export interface ClientModelConfig {
    label: string;
    modelOrAlias?: ModelOrAlias;
    quotaInfo?: QuotaInfo;
    supportsImages?: boolean;
    isRecommended?: boolean;
    allowedTiers?: string[];
    /** LabelTitle（如 "New"） */
    tagTitle?: string;
    /** 支持的 MIME 类型映射 */
    supportedMimeTypes?: Record<string, boolean>;
}

/** 团队Config */
export interface DefaultTeamConfig {
    allowMcpServers?: boolean;
    allowAutoRunCommands?: boolean;
    allowBrowserExperimentalFeatures?: boolean;
    [key: string]: boolean | string | number | undefined;
}

/** 计划Info */
export interface PlanInfo {
    teamsTier: string;
    planName: string;
    monthlyPromptCredits: number;
    monthlyFlowCredits: number;

    // 功能开关
    browserEnabled?: boolean;
    knowledgeBaseEnabled?: boolean;
    canBuyMoreCredits?: boolean;
    hasAutocompleteFastMode?: boolean;
    cascadeWebSearchEnabled?: boolean;
    canGenerateCommitMessages?: boolean;
    hasTabToJump?: boolean;
    allowStickyPremiumModels?: boolean;
    allowPremiumCommandModels?: boolean;
    canCustomizeAppIcon?: boolean;
    cascadeCanAutoRunCommands?: boolean;
    canAllowCascadeInBackground?: boolean;

    // 限制Config
    maxNumChatInputTokens?: string | number;
    maxNumPremiumChatMessages?: string | number;
    maxCustomChatInstructionCharacters?: string | number;
    maxNumPinnedContextItems?: string | number;
    maxLocalIndexSize?: string | number;
    monthlyFlexCreditPurchaseAmount?: number;

    // 团队Config
    defaultTeamConfig?: DefaultTeamConfig;

    /** Extension字段 - 支持 API Return的其他属性 */
    [key: string]: string | number | boolean | object | undefined;
}

/** 计划State */
export interface PlanStatus {
    planInfo: PlanInfo;
    availablePromptCredits: number;
    availableFlowCredits: number;
}

/** ModelSortGroup */
export interface ModelSortGroup {
    modelLabels: string[];
}

/** ClientModelSort */
export interface ClientModelSort {
    name: string;
    groups: ModelSortGroup[];
}

/** Cascade ModelConfigData */
export interface CascadeModelConfigData {
    clientModelConfigs: ClientModelConfig[];
    clientModelSorts?: ClientModelSort[];
}

/** UserState */
export interface UserStatus {
    name: string;
    email: string;
    planStatus?: PlanStatus;
    cascadeModelConfigData?: CascadeModelConfigData;
    acceptedLatestTermsOfService?: boolean;
    userTier?: {
        name: string;
        id: string;
        description: string;
        upgradeSubscriptionUri?: string;
        upgradeSubscriptionText?: string;
    };
}

/** Service端UserStateResponse */
export interface ServerUserStatusResponse {
    userStatus: UserStatus;
    /** Service端Return的ErrorMessage */
    message?: string;
    /** Service端Return的Error代码 */
    code?: string;
}

// ============ Process检测类型 ============

/** EnvironmentScan结果 */
export interface EnvironmentScanResult {
    /** ExtensionPort */
    extensionPort: number;
    /** ConnectPort */
    connectPort: number;
    /** CSRF Token */
    csrfToken: string;
}

/** Scan诊断Info */
export interface ScanDiagnostics {
    /** Scan方式 */
    scan_method: 'process_name' | 'keyword' | 'unknown';
    /** 目标Process名 */
    target_process: string;
    /** Scan尝试次数 */
    attempts: number;
    /** 候选Process数量 */
    found_candidates: number;
    /** 候选PortList */
    ports?: number[];
    /** 通过Validate的Port */
    verified_port?: number | null;
    /** 是否ValidateSuccess */
    verification_success?: boolean;
}

/** ProcessInfo */
export interface ProcessInfo {
    /** Process ID */
    pid: number;
    /** ExtensionPort */
    extensionPort: number;
    /** CSRF Token */
    csrfToken: string;
}

/** User详细Info */
export interface UserInfo {
    name: string;
    email: string;
    planName: string;
    tier: string;
    browserEnabled: boolean;
    knowledgeBaseEnabled: boolean;
    canBuyMoreCredits: boolean;
    hasAutocompleteFastMode: boolean;
    monthlyPromptCredits: number;
    monthlyFlowCredits: number;
    availablePromptCredits: number;
    availableFlowCredits: number;
    cascadeWebSearchEnabled: boolean;
    canGenerateCommitMessages: boolean;
    allowMcpServers: boolean;
    maxNumChatInputTokens: string;
    tierDescription: string;
    upgradeUri: string;
    upgradeText: string;
    // New fields
    teamsTier: string;
    hasTabToJump: boolean;
    allowStickyPremiumModels: boolean;
    allowPremiumCommandModels: boolean;
    maxNumPremiumChatMessages: string;
    maxCustomChatInstructionCharacters: string;
    maxNumPinnedContextItems: string;
    maxLocalIndexSize: string;
    monthlyFlexCreditPurchaseAmount: number;
    canCustomizeAppIcon: boolean;
    cascadeCanAutoRunCommands: boolean;
    canAllowCascadeInBackground: boolean;
    allowAutoRunCommands: boolean;
    allowBrowserExperimentalFeatures: boolean;
    acceptedLatestTermsOfService: boolean;
    userTierId: string;
}

// ============ UI 相关类型 ============

/** Webview Message类型 */
export type WebviewMessageType =
    | 'init'
    | 'refresh'
    | 'togglePin'
    | 'toggleCredits'
    | 'updateOrder'
    | 'resetOrder'
    | 'retry'
    | 'openLogs'
    | 'rerender'
    | 'renameGroup'
    | 'toggleGrouping'
    | 'promptRenameGroup'
    | 'toggleGroupPin'
    | 'updateGroupOrder'
    | 'autoGroup'
    | 'updateNotificationEnabled'
    | 'updateThresholds'
    | 'renameModel'
    | 'updateStatusBarFormat'
    | 'toggleProfile'
    | 'updateQuotaSource'
    | 'quotaSourceGuideComplete'
    | 'quotaSourceGuideDismiss'
    | 'updateDisplayMode'
    | 'updateDataMasked'
    | 'updateLanguage'
    | 'openCustomGrouping'
    | 'saveCustomGrouping'
    | 'previewAutoGroup'
    // Auto Trigger
    | 'tabChanged'
    | 'autoTrigger.authorize'
    | 'autoTrigger.revoke'
    | 'autoTrigger.addAccount'
    | 'autoTrigger.removeAccount'
    | 'autoTrigger.switchAccount'
    | 'autoTrigger.switchLoginAccount'
    | 'autoTrigger.reauthorizeAccount'
    | 'autoTrigger.importLocal'
    | 'autoTrigger.importLocalConfirm'
    | 'autoTrigger.saveSchedule'
    | 'autoTrigger.test'
    | 'autoTrigger.validateCrontab'
    | 'autoTrigger.getState'
    | 'getAutoTriggerState'
    | 'autoTrigger.clearHistory'
    // Feature Guide
    | 'guide.checkItOut'
    | 'guide.dontShowAgain'
    // Announcements
    | 'announcement.getState'
    | 'announcement.markAsRead'
    | 'announcement.markAllAsRead'
    // Antigravity Tools Sync
    | 'antigravityToolsSync.import'
    | 'antigravityToolsSync.importAuto'
    | 'antigravityToolsSync.importConfirm'
    | 'antigravityToolsSync.importJson'
    | 'antigravityToolsSync.cancel'
    | 'antigravityToolsSync.toggle'
    | 'antigravityToolsSync.toggleAutoSwitch'
    | 'antigravityToolsSync.switchToClient'
    // General
    | 'openUrl'
    | 'executeCommand'
    | 'updateVisibleModels';

/** Webview Message */
export interface WebviewMessage {
    command: WebviewMessageType;
    modelId?: string;
    order?: string[];
    /** Group ID */
    groupId?: string;
    /** Group新名称 */
    groupName?: string;
    /** GroupCurrent名称 (用于 promptRenameGroup) */
    currentName?: string;
    /** Group内所有Model ID */
    modelIds?: string[];
    /** 是否EnableNotify (updateThresholds) */
    notificationEnabled?: boolean;
    /** WarningThreshold (updateThresholds) */
    warningThreshold?: number;
    /** 危险Threshold (updateThresholds) */
    criticalThreshold?: number;
    /** State栏Show格式 (updateStatusBarFormat) */
    statusBarFormat?: string;
    /** Quota来源 (updateQuotaSource) */
    quotaSource?: 'local' | 'authorized';
    /** Show模式 (updateDisplayMode) */
    displayMode?: 'webview' | 'quickpick';
    /** Data遮罩State (updateDataMasked) */
    dataMasked?: boolean;
    /** Antigravity Tools Sync开关 */
    enabled?: boolean;
    /** LanguageSet (updateLanguage) */
    language?: string;
    /** CustomGroup映射 (saveCustomGrouping) */
    customGroupMappings?: Record<string, string>;
    /** CustomGroup名称 (saveCustomGrouping) */
    customGroupNames?: Record<string, string>;
    /** VisibleModelList */
    visibleModels?: string[];
    /** Antigravity Tools JSON Import */
    jsonText?: string;
    // Auto Trigger
    /** Tab 名称 (tabChanged) */
    tab?: string;
    /** 调度Config (autoTrigger.saveSchedule) */
    schedule?: ScheduleConfig;
    /** Crontab 表达式 (autoTrigger.validateCrontab) */
    crontab?: string;
    /** 手动TestModelList (autoTrigger.test) */
    models?: string[];
    /** 最大输出 token (autoTrigger.test) */
    maxOutputTokens?: number;
    /** AccountEmail (autoTrigger.removeAccount, autoTrigger.switchAccount) */
    email?: string;
    // Announcements
    /** Announcement ID (announcement.markAsRead) */
    id?: string;
    /** URL (openUrl) */
    url?: string;
    /** 命令 ID (executeCommand) */
    commandId?: string;
    /** 命令Parameter (executeCommand) */
    commandArgs?: unknown[];
    /** 仅Import不Switch (antigravityToolsSync.importConfirm) */
    importOnly?: boolean;
    /** 仅Switch不Import (antigravityToolsSync.importConfirm) */
    switchOnly?: boolean;
    /** 目标SwitchEmail (antigravityToolsSync.importConfirm) */
    targetEmail?: string;
    /** 是否覆盖已有Account (autoTrigger.importLocalConfirm) */
    overwrite?: boolean;
}

/** 调度Config */
export interface ScheduleConfig {
    enabled: boolean;
    repeatMode: 'daily' | 'weekly' | 'interval';
    dailyTimes?: string[];
    weeklyDays?: number[];
    weeklyTimes?: string[];
    intervalHours?: number;
    intervalStartTime?: string;
    intervalEndTime?: string;
    crontab?: string;
    selectedModels: string[];
    maxOutputTokens?: number;
}

/** Dashboard AuthorizationState */
export interface DashboardAuthorizationStatus {
    isAuthorized: boolean;
    email?: string;
    expiresAt?: string;
    accounts?: Array<{
        email: string;
        isActive: boolean;
        expiresAt?: string;
        isInvalid?: boolean;
    }>;
    activeAccount?: string;
}

/** Dashboard Config */
export interface DashboardConfig {
    /** 是否Show Prompt Credits */
    showPromptCredits: boolean;
    /** Pin的Model */
    pinnedModels: string[];
    /** Model顺序 */
    modelOrder: string[];
    /** ModelCustom名称映射 (modelId -> displayName) */
    modelCustomNames?: Record<string, string>;
    /** VisibleModelList（为空时Show全部） */
    visibleModels?: string[];
    /** 是否EnableGroupShow */
    groupingEnabled: boolean;
    /** GroupCustom名称映射 (modelId -> groupName) */
    groupCustomNames: Record<string, string>;
    /** 是否在State栏ShowGroup */
    groupingShowInStatusBar: boolean;
    /** Pin的Group */
    pinnedGroups: string[];
    /** Group顺序 */
    groupOrder: string[];
    /** RefreshCooldownTime（秒） */
    refreshInterval: number;
    /** 是否EnableNotify */
    notificationEnabled: boolean;
    /** WarningThreshold (%) */
    warningThreshold?: number;
    /** 危险Threshold (%) */
    criticalThreshold?: number;
    /** 最后SuccessUpdateTime */
    lastSuccessfulUpdate?: Date | null;
    /** State栏Show格式 */
    statusBarFormat?: string;
    /** 是否Hidden计划DetailsPanel */
    profileHidden?: boolean;
    /** Quota来源 (local | authorized) */
    quotaSource?: string;
    /** 是否CompletedAuthorization */
    authorizedAvailable?: boolean;
    /** AuthorizationStateDetails */
    authorizationStatus?: DashboardAuthorizationStatus;
    /** Show模式 (webview | quickpick) */
    displayMode?: string;
    /** 是否遮罩敏感Data */
    dataMasked?: boolean;
    /** External URL */
    url?: string;
    /** Group映射 (modelId -> groupId) */
    groupMappings?: Record<string, string>;
    /** LanguageSet（'auto' 跟随 VS Code，或具体Language代码） */
    language?: string;
    /** 是否开启 AntigravityTools Sync（来自 globalState） */
    antigravityToolsSyncEnabled?: boolean;
    /** 是否开启 AntigravityTools 自动Switch（来自 globalState） */
    antigravityToolsAutoSwitchEnabled?: boolean;
}

/** State栏UpdateData */
export interface StatusBarUpdate {
    /** Show文本 */
    text: string;
    /** 工具Tooltip */
    tooltip: string;
    /** 背景颜色 */
    backgroundColor?: string;
    /** 最低Percentage（用于颜色判断） */
    minPercentage: number;
}

// ============ Platform Strategies类型 ============

/** Platform类型 */
export type PlatformType = 'windows' | 'darwin' | 'linux';

/** Platform StrategiesAPI */
export interface PlatformStrategy {
    /** GetProcessList命令 */
    getProcessListCommand(processName: string): string;
    /** ParseProcessInfo */
    parseProcessInfo(stdout: string): ProcessInfo[];
    /** GetPortList命令 */
    getPortListCommand(pid: number): string;
    /** ParseListenPort */
    parseListeningPorts(stdout: string): number[];
    /** Get诊断命令（列出所有相关Process，用于Debug） */
    getDiagnosticCommand(): string;
    /** GetErrorInfo */
    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    };
}

// ============ 遗留类型别名（向后兼容） ============

/** @deprecated 使用 ModelQuotaInfo */
export type model_quota_info = ModelQuotaInfo;

/** @deprecated 使用 PromptCreditsInfo */
export type prompt_credits_info = PromptCreditsInfo;

/** @deprecated 使用 QuotaSnapshot */
export type quota_snapshot = QuotaSnapshot;

/** @deprecated 使用 QuotaLevel */
export const quota_level = QuotaLevel;

/** @deprecated 使用 ServerUserStatusResponse */
export type server_user_status_response = ServerUserStatusResponse;

/** @deprecated 使用 EnvironmentScanResult */
export type environment_scan_result = EnvironmentScanResult;
