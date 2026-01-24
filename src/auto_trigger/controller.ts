/**
 * Antigravity FuelGauge - Auto Trigger Controller
 * Auto Trigger功能的主Controller
 * 整合 OAuth、调度器、触发器，提供统一的API
 */

import * as vscode from 'vscode';
import { credentialStorage } from './credential_storage';
import { oauthService } from './oauth_service';
import { schedulerService, CronParser } from './scheduler_service';
import { triggerService } from './trigger_service';
import {
    AutoTriggerState,
    ScheduleConfig,
    AutoTriggerMessage,
    SCHEDULE_PRESETS,
} from './types';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';

/**
 * 带有QuotaInfo的Model（用于QuotaReset检测）
 */
interface QuotaModelInfo {
    id: string;
    displayName: string;
    modelConstant: string;
    resetTime?: Date;
    remainingFraction?: number;
}

// Storage键
const SCHEDULE_CONFIG_KEY = 'scheduleConfig';

/**
 * Auto Trigger Controller
 */
class AutoTriggerController {
    private initialized = false;
    private messageHandler?: (message: AutoTriggerMessage) => void;
    /** Quota中Show的Model常量List，用于Filter可用Model */
    private quotaModelConstants: string[] = [];
    /** Model ID 到Model常量的映射 (id -> modelConstant) */
    private modelIdToConstant: Map<string, string> = new Map();
    /** Fallback Scheduled器List (时段外固定Time触发) */
    private fallbackTimers: ReturnType<typeof setTimeout>[] = [];
    /** 账户操作互斥锁，防止并发账户操作导致State不一致 */
    private accountOperationLock: Promise<void> = Promise.resolve();

    /**
     * Execute账户操作时Get互斥锁
     * 确保同一Time只有一个账户操作（Delete、Switch、Import等）在Execute
     */
    private async withAccountLock<T>(operation: () => Promise<T>): Promise<T> {
        // Waiting前一个操作Done
        const previousLock = this.accountOperationLock;
        let releaseLock: () => void;
        this.accountOperationLock = new Promise<void>(resolve => {
            releaseLock = resolve;
        });

        try {
            await previousLock;
            return await operation();
        } finally {
            releaseLock!();
        }
    }


    /**
     * SetQuotaModel常量List（从 Dashboard 的QuotaData中Get）
     */
    setQuotaModels(modelConstants: string[]): void {
        this.quotaModelConstants = modelConstants;
        logger.debug(`[AutoTriggerController] Quota model constants set: ${modelConstants.join(', ')}`);
    }

    /**
     * InitializeController
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            return;
        }

        // InitializeCredential Storage
        credentialStorage.initialize(context);

        // InitializeTrigger Service（LoadHistoryRecord）
        triggerService.initialize();

        // Resume调度Config
        const savedConfig = credentialStorage.getState<ScheduleConfig | null>(SCHEDULE_CONFIG_KEY, null);
        if (savedConfig) {
            // 互斥逻辑：wakeOnReset 优先，不StartScheduled调度器
            if (savedConfig.wakeOnReset && savedConfig.enabled) {
                logger.info('[AutoTriggerController] Wake on reset mode enabled, scheduler not started');
                // If time period policy is enabled and有 fallback Time，Start fallback Scheduled器
                if (savedConfig.timeWindowEnabled && savedConfig.fallbackTimes?.length) {
                    this.startFallbackScheduler(savedConfig);
                }
            } else if (savedConfig.enabled) {
                logger.info('[AutoTriggerController] Restoring schedule from saved config');
                schedulerService.setSchedule(savedConfig, () => this.executeTrigger());
            }
        }

        this.initialized = true;
        logger.info('[AutoTriggerController] Initialized');
    }

    /**
     * UpdateState栏Show（已整合到主Quota悬浮Tooltip中，此方法现为空操作）
     */
    private async updateStatusBar(): Promise<void> {
        // 下次触发Time现在Show在主Quota悬浮Tooltip中，不再需要单独的State栏
    }

    /**
     * GetCurrentState
     */
    async getState(): Promise<AutoTriggerState> {
        const authorization = await credentialStorage.getAuthorizationStatus();
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            dailyTimes: ['08:00'],
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });

        const nextRunTime = schedulerService.getNextRunTime();
        // 传入QuotaModel常量进行Filter
        const availableModels = await triggerService.fetchAvailableModels(this.quotaModelConstants);

        // Update ID 到常量的映射
        this.modelIdToConstant.clear();
        for (const model of availableModels) {
            if (model.id && model.modelConstant) {
                this.modelIdToConstant.set(model.id, model.modelConstant);
            }
        }
        logger.debug(`[AutoTriggerController] Updated modelIdToConstant mapping: ${this.modelIdToConstant.size} entries`);

        return {
            authorization,
            schedule,
            lastTrigger: triggerService.getLastTrigger(),
            recentTriggers: triggerService.getRecentTriggers(),
            nextTriggerTime: nextRunTime?.toISOString(),
            availableModels,
        };
    }

    /**
     * StartAuthorization流程
     */
    async startAuthorization(): Promise<boolean> {
        return await oauthService.startAuthorization();
    }

    /**
     * StartAuthorization流程（别名）
     */
    async authorize(): Promise<boolean> {
        return this.startAuthorization();
    }

    /**
     * 撤销Authorization
     */
    async revokeAuthorization(): Promise<void> {
        await oauthService.revokeAuthorization();
        // Stop调度器
        schedulerService.stop();
        // Disable调度
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        schedule.enabled = false;
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
        this.updateStatusBar();
    }

    /**
     * 撤销CurrentAccountAuthorization
     */
    async revokeActiveAccount(): Promise<void> {
        const activeAccount = await credentialStorage.getActiveAccount();
        if (!activeAccount) {
            await this.revokeAuthorization();
            return;
        }
        await this.removeAccount(activeAccount);
    }

    /**
     * 移除指定Account
     * @param email 要移除的AccountEmail
     */
    async removeAccount(email: string): Promise<void> {
        return this.withAccountLock(async () => {
            await oauthService.revokeAccount(email);

            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            const remainingCredentials = await credentialStorage.getAllCredentials();
            const remainingEmails = Object.keys(remainingCredentials);
            const _activeAccount = await credentialStorage.getActiveAccount();
            let scheduleChanged = false;

            if (Array.isArray(schedule.selectedAccounts)) {
                const filtered = schedule.selectedAccounts.filter(account => remainingEmails.includes(account));
                if (filtered.length !== schedule.selectedAccounts.length) {
                    schedule.selectedAccounts = filtered;
                    scheduleChanged = true;

                    // 如果勾选的Account被全部移除，自动Close自动Wakeup
                    if (filtered.length === 0 && schedule.enabled) {
                        schedule.enabled = false;
                        schedulerService.stop();
                        this.stopFallbackScheduler();
                        logger.info('[AutoTriggerController] All selected accounts removed, disabling schedule');
                    }
                }
            }

            // Check if there are remaining accounts
            const hasAuth = await credentialStorage.hasValidCredential();
            if (!hasAuth) {
                // No accounts left, stop scheduler and disable schedule
                schedulerService.stop();
                if (schedule.enabled) {
                    schedule.enabled = false;
                    scheduleChanged = true;
                }
            }

            if (scheduleChanged) {
                await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
            }

            this.updateStatusBar();
            this.notifyStateUpdate();
        });
    }

    /**
     * Switch活跃Account
     * @param email 要Switch到的AccountEmail
     */
    async switchAccount(email: string): Promise<void> {
        return this.withAccountLock(async () => {
            await credentialStorage.setActiveAccount(email);
            logger.info(`[AutoTriggerController] Switched to account: ${email}`);
            this.notifyStateUpdate();
        });
    }

    /**
     * 重新Authorization指定Account（先Switch到该Account再重新Authorization）
     * @param email 要重新Authorization的AccountEmail
     */
    async reauthorizeAccount(email: string): Promise<void> {
        // 先Switch到该Account
        await credentialStorage.setActiveAccount(email);
        logger.info(`[AutoTriggerController] Reauthorizing account: ${email}`);
        
        // Execute重新Authorization流程
        const success = await oauthService.startAuthorization();
        if (!success) {
            throw new Error('Reauthorization cancelled or failed');
        }
        
        this.notifyStateUpdate();
    }

    /**
     * Save scheduleConfig
     */
    async saveSchedule(config: ScheduleConfig): Promise<void> {
        // ValidateConfig
        if (config.crontab) {
            const result = schedulerService.validateCrontab(config.crontab);
            if (!result.valid) {
                throw new Error(`Invalid的 crontab 表达式: ${result.error}`);
            }
        }

        // SaveConfig
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, config);

        // 互斥逻辑：三选一
        // 1. wakeOnReset = true → QuotaReset触发（不需要Scheduled器）
        // 2. wakeOnReset = false + enabled = true → Scheduled/Crontab 触发
        // 3. 都为 false → 不触发
        if (config.wakeOnReset) {
            // QuotaReset模式：StopScheduled调度器
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, wakeOnReset mode enabled');
            // If time period policy is enabled and有 fallback Time，Start fallback Scheduled器
            if (config.timeWindowEnabled && config.fallbackTimes?.length) {
                this.startFallbackScheduler(config);
            }
        } else if (config.enabled) {
            // Scheduled/Crontab 模式
            this.stopFallbackScheduler();
            const accounts = await this.resolveAccountsFromList(config.selectedAccounts);
            if (accounts.length === 0) {
                throw new Error('请先DoneAuthorization');
            }
            schedulerService.setSchedule(config, () => this.executeTrigger());
            logger.info(`[AutoTriggerController] Schedule saved, enabled=${config.enabled}`);
        } else {
            // 都不Enable
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, all triggers disabled');
        }

        this.updateStatusBar();
    }

    /**
     * Parse可用AccountList（多Account）
     */
    private async resolveAccountsFromList(requestedAccounts?: string[]): Promise<string[]> {
        const allCredentials = await credentialStorage.getAllCredentials();
        const allEmails = Object.keys(allCredentials);
        if (allEmails.length === 0) {
            return [];
        }

        // 如果明确传入了AccountList（包括空List），则严格遵守该List，不再走备用逻辑。
        // 除非 requestedAccounts 为 undefined (表示从未Config过此项)。
        if (Array.isArray(requestedAccounts)) {
            return requestedAccounts.filter(email => (email in allCredentials) && Boolean(allCredentials[email]?.refreshToken));
        }

        // 备用逻辑：仅在Config缺失时使用。优先使用活跃Account，其次使用第一个可用Account。
        const candidates: string[] = [];
        const active = await credentialStorage.getActiveAccount();
        if (active && (active in allCredentials)) {
            candidates.push(active);
        } else if (allEmails.length > 0) {
            candidates.push(allEmails[0]);
        }

        return candidates.filter(email => Boolean(allCredentials[email]?.refreshToken));
    }

    /**
     * Get调度触发AccountList（多Account）
     */
    private async resolveScheduleAccounts(schedule: ScheduleConfig): Promise<string[]> {
        return this.resolveAccountsFromList(schedule.selectedAccounts);
    }

    /**
     * 手动触发一次
     * @param models Optional的CustomModelList
     */
    async testTrigger(models?: string[], accounts?: string[], maxOutputTokens?: number): Promise<void> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            vscode.window.showErrorMessage(t('autoTrigger.authRequired'));
            return;
        }

        vscode.window.showInformationMessage(t('autoTrigger.triggeringNotify'));

        // 如果传入了CustomModelList，使用Custom的；否则使用Config中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }
        const resolvedMaxOutputTokens = this.resolveMaxOutputTokens(maxOutputTokens);

        let anySuccess = false;
        let totalDuration = 0;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', undefined, 'manual', email, resolvedMaxOutputTokens);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        if (anySuccess) {
            vscode.window.showInformationMessage(t('autoTrigger.testTriggerSuccess', { duration: totalDuration }));
        } else {
            vscode.window.showErrorMessage(t('autoTrigger.testTriggerFailed', { error: firstError || t('common.unknownError') }));
        }

        // Notify UI Update
        this.notifyStateUpdate();
    }

    /**
     * 立即触发（别名，Return结果）
     * @param models Optional的CustomModelList，如果不传则使用Config中的Model
     * @param customPrompt Optional的CustomWakeup词
     */
    async triggerNow(
        models?: string[],
        customPrompt?: string,
        accounts?: string[],
        maxOutputTokens?: number,
    ): Promise<{ success: boolean; duration?: number; error?: string; response?: string }> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            return { success: false, error: '请先DoneAuthorization' };
        }

        // 如果传入了CustomModelList，使用Custom的；否则使用Config中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
                maxOutputTokens: 0,
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }
        const resolvedMaxOutputTokens = this.resolveMaxOutputTokens(maxOutputTokens);

        let anySuccess = false;
        let totalDuration = 0;
        let firstResponse: string | undefined;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', customPrompt, 'manual', email, resolvedMaxOutputTokens);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
                if (!firstResponse) {
                    firstResponse = result.message;
                }
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        // Notify UI Update
        this.notifyStateUpdate();

        return {
            success: anySuccess,
            duration: totalDuration || undefined,
            error: anySuccess ? undefined : (firstError || 'Unknown error'),
            response: anySuccess ? firstResponse : undefined,  // AI 回复Content
        };
    }

    /**
     * ClearHistoryRecord
     */
    async clearHistory(): Promise<void> {
        triggerService.clearHistory();
        this.notifyStateUpdate();
    }

    /**
     * Execute触发（由调度器调用）
     */
    private async executeTrigger(): Promise<void> {
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        const triggerSource = schedule.crontab ? 'crontab' : 'scheduled';
        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Scheduled trigger skipped: no valid accounts');
            return;
        }

        for (const email of accounts) {
            const result = await triggerService.trigger(
                schedule.selectedModels,
                'auto',
                schedule.customPrompt,
                triggerSource,
                email,
                schedule.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Scheduled trigger executed successfully for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Scheduled trigger failed for ${email}: ${result.message}`);
            }
        }

        // Notify UI Update
        this.notifyStateUpdate();
    }

    /**
     * CheckQuotaReset并Auto TriggerWakeup（多Account独立检测Version）
     * 遍历所有选中Account，为每个Account独立GetQuota并检测
     * 由ScheduledRefresh或手动触发调用
     */
    async checkAndTriggerOnQuotaReset(): Promise<void> {
        logger.debug('[AutoTriggerController] checkAndTriggerOnQuotaReset called (multi-account)');

        // Get调度Config
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });

        logger.debug(`[AutoTriggerController] Schedule config: enabled=${schedule.enabled}, wakeOnReset=${schedule.wakeOnReset}, selectedAccounts=${JSON.stringify(schedule.selectedAccounts)}, selectedModels=${JSON.stringify(schedule.selectedModels)}`);

        if (!schedule.enabled) {
            logger.debug('[AutoTriggerController] Wake-up disabled, skipping');
            return;
        }

        // Check是否Enable了"QuotaReset时自动Wakeup"
        if (!schedule.wakeOnReset) {
            logger.debug('[AutoTriggerController] Wake on reset is disabled, skipping');
            return;
        }

        // Check时段策略
        if (schedule.timeWindowEnabled) {
            const inWindow = this.isInTimeWindow(schedule.timeWindowStart, schedule.timeWindowEnd);
            if (!inWindow) {
                logger.debug('[AutoTriggerController] Outside time window, quota reset trigger skipped (will use fallback times)');
                return;
            }
        }

        // Get所有选中的Account
        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.debug('[AutoTriggerController] Wake on reset: No valid accounts, skipping');
            return;
        }

        const selectedModels = schedule.selectedModels || [];
        if (selectedModels.length === 0) {
            logger.debug('[AutoTriggerController] Wake on reset: No models selected, skipping');
            return;
        }

        logger.info(`[AutoTriggerController] Wake on reset: Checking ${accounts.length} accounts, ${selectedModels.length} models`);

        // 遍历每个选中的Account，独立检测Quota
        for (const email of accounts) {
            await this.checkAndTriggerForAccount(email, schedule, selectedModels);
        }
    }

    /**
     * 为单个AccountCheckQuota并触发Wakeup
     * @param email AccountEmail
     * @param schedule 调度Config
     * @param selectedModels 选中的ModelList
     */
    private async checkAndTriggerForAccount(
        email: string,
        schedule: ScheduleConfig,
        selectedModels: string[],
    ): Promise<void> {
        logger.debug(`[AutoTriggerController] Checking quota for account: ${email}`);

        try {
            // Get该Account的QuotaData
            const models = await this.fetchQuotaModelsForAccount(email);
            if (!models || models.length === 0) {
                logger.debug(`[AutoTriggerController] No quota data for ${email}, skipping`);
                return;
            }

            // 构建Model ID 到Quota的映射
            const quotaMap = new Map<string, { id: string; resetAt?: string; remaining: number; limit: number }>();
            for (const model of models) {
                if (!model.modelConstant) {
                    continue;
                }
                const resetAtMs = model.resetTime?.getTime();
                if (!resetAtMs || Number.isNaN(resetAtMs)) {
                    continue;
                }
                
                quotaMap.set(model.modelConstant, {
                    id: model.modelConstant,
                    resetAt: model.resetTime!.toISOString(),
                    remaining: model.remainingFraction !== undefined ? Math.floor(model.remainingFraction * 100) : 0,
                    limit: 100,  // 使用Percentage，limit 固定为 100
                });
                // 同时用Model ID 作为 key
                if (model.id) {
                    quotaMap.set(model.id, quotaMap.get(model.modelConstant)!);
                }
            }

            // Check每个选中的Model是否需要触发
            const modelsToTrigger: string[] = [];

            for (const modelId of selectedModels) {
                const modelConstant = this.modelIdToConstant.get(modelId);
                const triggerKey = `${email}:${modelConstant || modelId}`;

                // 查找QuotaData
                const modelQuota = quotaMap.get(modelConstant || '') || quotaMap.get(modelId);
                if (!modelQuota) {
                    logger.debug(`[AutoTriggerController] Model ${modelId} not found in quota for ${email}`);
                    continue;
                }
                if (!modelQuota.resetAt) {
                    logger.debug(`[AutoTriggerController] Model ${modelId} has no resetAt for ${email}`);
                    continue;
                }

                logger.debug(`[AutoTriggerController] [${email}] Model ${modelId}: remaining=${modelQuota.remaining}%, resetAt=${modelQuota.resetAt}`);

                // Check是否应该触发 - 使用 email:modelConstant 作为 key 来区分不同Account
                if (triggerService.shouldTriggerOnReset(triggerKey, modelQuota.resetAt, modelQuota.remaining, modelQuota.limit)) {
                    logger.debug(`[AutoTriggerController] [${email}] Model ${modelId} should trigger!`);
                    modelsToTrigger.push(modelId);
                    // 立即标记已触发，防止重复
                    triggerService.markResetTriggered(triggerKey, modelQuota.resetAt);
                } else {
                    logger.debug(`[AutoTriggerController] [${email}] Model ${modelId} should NOT trigger`);
                }
            }

            if (modelsToTrigger.length === 0) {
                logger.debug(`[AutoTriggerController] [${email}] No models to trigger`);
                return;
            }

            // 触发Wakeup
            logger.info(`[AutoTriggerController] Wake on reset: Triggering ${email} for models: ${modelsToTrigger.join(', ')}`);
            const result = await triggerService.trigger(
                modelsToTrigger,
                'auto',
                schedule.customPrompt,
                'quota_reset',
                email,
                schedule.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Wake on reset: Trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Wake on reset: Trigger failed for ${email}: ${result.message}`);
            }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.warn(`[AutoTriggerController] Failed to check quota for ${email}: ${error}`);
        }

        // Notify UI Update
        this.notifyStateUpdate();
    }

    /**
     * Get指定Account的QuotaModelList
     * @param email AccountEmail
     * @returns 带有QuotaInfo的ModelList
     */
    private async fetchQuotaModelsForAccount(email: string): Promise<QuotaModelInfo[] | null> {
        try {
            // Get该Account的 token
            const tokenResult = await oauthService.getAccessTokenStatusForAccount(email);
            if (tokenResult.state !== 'ok' || !tokenResult.token) {
                logger.debug(`[AutoTriggerController] Token unavailable for ${email}: ${tokenResult.state}`);
                return null;
            }

            // Get projectId
            const credential = await credentialStorage.getCredentialForAccount(email);
            const projectId = credential?.projectId;

            // GetQuotaModel（复用 triggerService 的方法）
            await triggerService.fetchAvailableModels(this.quotaModelConstants);
            
            // 注意：这里需要通过真正的Quota API Get带有 resetTime 的ModelData
            // 使用 cloudCodeClient Get完整QuotaInfo
            const { cloudCodeClient } = await import('../shared/cloudcode_client');
            const quotaData = await cloudCodeClient.fetchAvailableModels(
                tokenResult.token,
                projectId,
                { logLabel: 'AutoTriggerController', timeoutMs: 30000 },
            );

            if (!quotaData?.models) {
                return null;
            }

            // 转换为 QuotaModelInfo 格式，包含 resetTime
            const result: QuotaModelInfo[] = [];
            for (const [id, info] of Object.entries(quotaData.models)) {
                const quotaInfo = (info as { quotaInfo?: { remainingFraction?: number; resetTime?: string } }).quotaInfo;
                const resetTimeStr = quotaInfo?.resetTime;
                const resetTime = resetTimeStr ? new Date(resetTimeStr) : undefined;
                const remainingFraction = quotaInfo?.remainingFraction;

                result.push({
                    id,
                    displayName: (info as { displayName?: string }).displayName || id,
                    modelConstant: (info as { model?: string }).model || '',
                    resetTime,
                    remainingFraction,
                });
            }

            logger.debug(`[AutoTriggerController] Fetched ${result.length} models for ${email}`);
            return result;
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.warn(`[AutoTriggerController] Failed to fetch quota models for ${email}: ${error}`);
            return null;
        }
    }

    /**
     * Get调度Description
     */
    describeSchedule(config: ScheduleConfig): string {
        return schedulerService.describeSchedule(config);
    }

    /**
     * Get预设Template
     */
    getPresets(): typeof SCHEDULE_PRESETS {
        return SCHEDULE_PRESETS;
    }

    /**
     * 将Config转换为 crontab
     */
    configToCrontab(config: ScheduleConfig): string {
        return schedulerService.configToCrontab(config);
    }

    /**
     * Validate crontab
     */
    validateCrontab(crontab: string): { valid: boolean; description?: string; error?: string } {
        const result = CronParser.parse(crontab);
        return {
            valid: result.valid,
            description: result.description,
            error: result.error,
        };
    }

    /**
     * Get下次RunningTime的Format字符串
     */
    getNextRunTimeFormatted(): string | null {
        const nextRun = schedulerService.getNextRunTime();
        if (!nextRun) {
            return null;
        }

        const now = new Date();
        const diff = nextRun.getTime() - now.getTime();

        if (diff < 0) {
            return null;
        }

        // 如果是今天，ShowTime
        if (nextRun.toDateString() === now.toDateString()) {
            return nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }

        // 如果是明天，Show "明天 HH:MM"
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (nextRun.toDateString() === tomorrow.toDateString()) {
            return `${t('common.tomorrow')} ${nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
        }

        // 其他情况ShowDate和Time
        return nextRun.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    /**
     * Handle来自 Webview 的Message
     */
    async handleMessage(message: AutoTriggerMessage): Promise<void> {
        switch (message.type) {
            case 'auto_trigger_get_state':
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_start_auth':
                await this.startAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_revoke_auth':
                await this.revokeAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_save_schedule':
                try {
                    await this.saveSchedule(message.data as unknown as ScheduleConfig);
                    this.notifyStateUpdate();
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(err.message);
                }
                break;

            case 'auto_trigger_test_trigger':
                await this.testTrigger(
                    message.data?.models,
                    message.data?.accounts as string[] | undefined,
                    message.data?.maxOutputTokens as number | undefined,
                );
                break;

            default:
                logger.warn(`[AutoTriggerController] Unknown message type: ${message.type}`);
        }
    }

    /**
     * SetMessageHandle器（用于向 Webview SendUpdate）
     */
    setMessageHandler(handler: (message: AutoTriggerMessage) => void): void {
        this.messageHandler = handler;
    }

    /**
     * NotifyStateUpdate
     */
    private async notifyStateUpdate(): Promise<void> {
        // UpdateState栏
        this.updateStatusBar();

        if (this.messageHandler) {
            const state = await this.getState();
            this.messageHandler({
                type: 'auto_trigger_state_update',
                data: state as unknown as Record<string, unknown>,
            });
        }
    }

    /**
     * 判断CurrentTime是否在指定的Time窗口内
     * @param startTime StartTime (如 "09:00")
     * @param endTime EndTime (如 "18:00")
     * @returns true 如果在窗口内
     */
    private isInTimeWindow(startTime?: string, endTime?: string): boolean {
        if (!startTime || !endTime) {
            return true; // 未Config时Default在窗口内
        }

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const parseTime = (timeStr: string): number => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        const startMinutes = parseTime(startTime);
        const endMinutes = parseTime(endTime);

        // Handle跨天情况 (如 22:00 - 06:00)
        if (startMinutes <= endMinutes) {
            // 正常情况: 09:00 - 18:00
            return currentMinutes >= startMinutes && currentMinutes < endMinutes;
        } else {
            // 跨天情况: 22:00 - 06:00
            return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
    }

    /**
     * Start fallback Scheduled器（在时段外的固定Time点触发）
     */
    private startFallbackScheduler(config: ScheduleConfig): void {
        this.stopFallbackScheduler();

        const fallbackTimes = config.fallbackTimes || [];
        if (fallbackTimes.length === 0) {
            return;
        }

        logger.info(`[AutoTriggerController] Starting fallback scheduler with times: ${fallbackTimes.join(', ')}`);

        const scheduleNextFallback = () => {
            const now = new Date();
            const currentMinutes = now.getHours() * 60 + now.getMinutes();

            // 找到下一个触发Time点
            const parseTime = (timeStr: string): number => {
                const [h, m] = timeStr.split(':').map(Number);
                return h * 60 + m;
            };

            const times = fallbackTimes.map(t => parseTime(t)).sort((a, b) => a - b);
            let nextTime = times.find(t => t > currentMinutes);

            // 如果今天没有更多Time点，取明天第一个
            const isNextDay = nextTime === undefined;
            if (isNextDay) {
                nextTime = times[0];
            }

            // 如果还是没有Time点，Exit
            if (nextTime === undefined) {
                logger.warn('[AutoTriggerController] No fallback times available');
                return;
            }

            // 计算Delay毫秒数
            let delayMinutes = nextTime - currentMinutes;
            if (isNextDay) {
                delayMinutes += 24 * 60;
            }
            const delayMs = delayMinutes * 60 * 1000;

            logger.info(`[AutoTriggerController] Next fallback trigger in ${delayMinutes} minutes (${(nextTime / 60) | 0}:${String(nextTime % 60).padStart(2, '0')})`);

            const timer = setTimeout(async () => {
                // 再次Check是否仍然在时段外
                if (config.timeWindowEnabled) {
                    const inWindow = this.isInTimeWindow(config.timeWindowStart, config.timeWindowEnd);
                    if (inWindow) {
                        logger.info('[AutoTriggerController] Fallback trigger skipped: now inside time window');
                        scheduleNextFallback();
                        return;
                    }
                }

                logger.info('[AutoTriggerController] Fallback trigger firing');
                await this.executeFallbackTrigger(config);
                scheduleNextFallback();
            }, delayMs);

            this.fallbackTimers.push(timer);
        };

        scheduleNextFallback();
    }

    /**
     * Stop所有 fallback Scheduled器
     */
    private stopFallbackScheduler(): void {
        for (const timer of this.fallbackTimers) {
            clearTimeout(timer);
        }
        this.fallbackTimers = [];
        logger.debug('[AutoTriggerController] Fallback scheduler stopped');
    }

    /**
     * Execute fallback 触发
     */
    private async executeFallbackTrigger(config: ScheduleConfig): Promise<void> {
        const accounts = await this.resolveAccountsFromList(config.selectedAccounts);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Fallback trigger skipped: no valid accounts');
            return;
        }

        const selectedModels = config.selectedModels || ['gemini-3-flash'];
        for (const email of accounts) {
            const result = await triggerService.trigger(
                selectedModels,
                'auto',
                config.customPrompt,
                'scheduled', // 标记为 scheduled 类型
                email,
                config.maxOutputTokens,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Fallback trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Fallback trigger failed for ${email}: ${result.message}`);
            }
        }

        this.notifyStateUpdate();
    }

    private resolveMaxOutputTokens(maxOutputTokens?: number): number {
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
            return Math.floor(maxOutputTokens);
        }
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
            maxOutputTokens: 0,
        });
        // 0 means no limit, so return it directly
        return typeof schedule.maxOutputTokens === 'number' && schedule.maxOutputTokens >= 0
            ? Math.floor(schedule.maxOutputTokens)
            : 0;
    }

    /**
     * Auto-sync to client current account on startup
     * 优先检测Local Antigravity Client，其次检测 Antigravity Tools：
     * - 如果Client账户已存在于 Cockpit，自动Switch
     * - 如果账户不存在，静默Skip（不Modal打扰User）
     * @returns Switch结果：'switched' 已Switch, 'same' 已是Current账户, 'not_found' 未检测到账户, 'not_exists' 账户未Import
     */
    async syncToClientAccountOnStartup(): Promise<'switched' | 'same' | 'not_found' | 'not_exists'> {
        return this.withAccountLock(async () => {
            try {
                let currentEmail: string | null = null;
                const source = 'local' as const;
                
                // DynamicImport，避免循环依赖
                const { previewLocalCredential } = await import('./local_auth_importer');
                
                // 仅检测Local Antigravity Client读取Current账户
                try {
                    const preview = await previewLocalCredential();
                    if (preview?.email) {
                        currentEmail = preview.email;
                        logger.debug(`[AutoTriggerController] Startup sync: found local client account: ${currentEmail}`);
                    }
                } catch (localErr) {
                    logger.debug(`[AutoTriggerController] Startup sync: local client detection failed: ${localErr instanceof Error ? localErr.message : localErr}`);
                }
                
                if (!currentEmail) {
                    logger.debug('[AutoTriggerController] Startup sync: no local client account detected');
                    return 'not_found';
                }

                const activeEmail = await credentialStorage.getActiveAccount();
                const currentEmailLower = currentEmail.toLowerCase();
                
                // Check是否已是Current账户
                if (activeEmail && activeEmail.toLowerCase() === currentEmailLower) {
                    logger.debug(`[AutoTriggerController] Startup sync: already using account ${activeEmail}`);
                    return 'same';
                }

                // Check账户是否已存在于 Cockpit
                const accounts = await credentialStorage.getAllCredentials();
                const existingEmail = Object.keys(accounts).find(
                    email => email.toLowerCase() === currentEmailLower,
                );

                if (existingEmail) {
                    // 账户已存在，直接Switch
                    logger.info(`[AutoTriggerController] Startup sync: switching to existing account: ${existingEmail} (source: ${source})`);
                    await credentialStorage.setActiveAccount(existingEmail);
                    this.notifyStateUpdate();
                    return 'switched';
                } else {
                    // 账户不存在，静默Import并Switch
                    logger.info(`[AutoTriggerController] Startup sync: account ${currentEmail} not found, importing silently...`);
                    try {
                        const { importLocalCredential } = await import('./local_auth_importer');
                        const result = await importLocalCredential();
                        if (result?.email) {
                            logger.info(`[AutoTriggerController] Startup sync: imported and switched to ${result.email}`);
                            this.notifyStateUpdate();
                            return 'switched';
                        }
                    } catch (importErr) {
                        logger.warn(`[AutoTriggerController] Startup sync: silent import failed: ${importErr instanceof Error ? importErr.message : importErr}`);
                    }
                    return 'not_exists';
                }
            } catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                logger.warn(`[AutoTriggerController] Startup sync failed: ${err}`);
                return 'not_found';
            }
        });
    }

    /**
     * DisposeController
     */
    dispose(): void {
        schedulerService.stop();
        this.stopFallbackScheduler();
        logger.info('[AutoTriggerController] Disposed');
    }
}

// Export单例
export const autoTriggerController = new AutoTriggerController();
