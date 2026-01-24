
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t, i18n, normalizeLocaleInput } from '../shared/i18n';
import { WebviewMessage } from '../shared/types';
import { TIMING } from '../shared/constants';
import { autoTriggerController } from '../auto_trigger/controller';
import { credentialStorage } from '../auto_trigger';
import { previewLocalCredential, commitLocalCredential } from '../auto_trigger/local_auth_importer';
import { announcementService } from '../announcement';
import { antigravityToolsSyncService } from '../antigravityTools_sync';
import { cockpitToolsWs, AccountInfo } from '../services/cockpitToolsWs';

export class MessageController {
    // 跟踪已Notify的Model以避免重复弹窗 (虽然主要逻辑在 TelemetryController，但 CheckAndNotify 可能被Message触发吗? 不, 主要是 handleMessage)
    // 这里主要是Handle前端发来的指令
    private context: vscode.ExtensionContext;
    
    // ImportCancelToken
    private importCancelToken: { cancelled: boolean } | null = null;

    constructor(
        context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
    ) {
        this.context = context;
        this.setupMessageHandling();
    }

    private async applyQuotaSourceChange(
        source: 'local' | 'authorized',
    ): Promise<void> {
        const previousSource = configService.getConfig().quotaSource;

        if (source === 'authorized') {
            this.reactor.cancelInitRetry();
        }

        logger.info(`User changed quota source: ${previousSource} -> ${source}`);
        await configService.updateConfig('quotaSource', source);
        // ValidateSave是否Success
        const savedSource = configService.getConfig().quotaSource;
        logger.info(`QuotaSource saved: requested=${source}, actual=${savedSource}`);

        // Send loading StateTooltip
        this.hud.sendMessage({
            type: 'quotaSourceLoading',
            data: { source },
        });
        this.hud.sendMessage({
            type: 'switchTab',
            tab: 'quota',
        });

        // 如果Quota来源发生变化，触发完整Initialize流程
        if (previousSource !== source) {
            if (source === 'local') {
                await this.onRetry();
            } else {
                this.reactor.syncTelemetry();
            }
            return;
        }

        const cacheAge = this.reactor.getCacheAgeMs(source);
        const refreshIntervalMs = configService.getConfig().refreshInterval ?? TIMING.DEFAULT_REFRESH_INTERVAL_MS;
        const hasCache = this.reactor.publishCachedTelemetry(source);
        const cacheStale = cacheAge === undefined || cacheAge > refreshIntervalMs;
        if (!hasCache || cacheStale) {
            this.reactor.syncTelemetry();
        }
    }

    private setupMessageHandling(): void {
        // Set autoTriggerController 的MessageHandle器，使其能够推送StateUpdate到 webview
        autoTriggerController.setMessageHandler((message) => {
            if (message.type === 'auto_trigger_state_update') {
                this.hud.sendMessage({
                    type: 'autoTriggerState',
                    data: message.data,
                });
            }
        });

        this.hud.onSignal(async (message: WebviewMessage) => {
            switch (message.command) {
                case 'togglePin':
                    logger.info(`Received togglePin signal: ${JSON.stringify(message)}`);
                    if (message.modelId) {
                        await configService.togglePinnedModel(message.modelId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('togglePin signal missing modelId');
                    }
                    break;

                case 'toggleCredits':
                    logger.info('User toggled Prompt Credits display');
                    await configService.toggleShowPromptCredits();
                    this.reactor.reprocess();
                    break;

                case 'updateOrder':
                    if (message.order) {
                        logger.info(`User updated model order. Count: ${message.order.length}`);
                        await configService.updateModelOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateOrder signal missing order data');
                    }
                    break;

                case 'updateVisibleModels':
                    if (Array.isArray(message.visibleModels)) {
                        logger.info(`User updated visible models. Count: ${message.visibleModels.length}`);
                        await configService.updateVisibleModels(message.visibleModels);
                        if (configService.getConfig().quotaSource === 'authorized') {
                            await configService.setStateFlag('visibleModelsInitializedAuthorized', true);
                        }
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateVisibleModels signal missing visibleModels');
                    }
                    break;

                case 'resetOrder': {
                    const currentConfig = configService.getConfig();
                    if (currentConfig.groupingEnabled) {
                        logger.info('User reset group order to default');
                        await configService.resetGroupOrder();
                    } else {
                        logger.info('User reset model order to default');
                        await configService.resetModelOrder();
                    }
                    this.reactor.reprocess();
                    break;
                }

                case 'refresh':
                    logger.info('User triggered manual refresh');
                    // 尝试确保 WebSocket Connect（如果Disconnect则触发重连）
                    cockpitToolsWs.ensureConnected();
                    this.reactor.syncTelemetry();
                    {
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'init':
                    if (this.reactor.hasCache) {
                        logger.info('Dashboard initialized (reprocessing cached data)');
                        this.reactor.reprocess();
                    } else {
                        logger.info('Dashboard initialized (no cache, performing full sync)');
                        this.reactor.syncTelemetry();
                    }
                    // SendAnnouncementState
                    {
                        const annState = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: annState,
                        });
                    }

                    break;

                case 'retry':
                    logger.info('User triggered connection retry');
                    await this.onRetry();
                    break;

                case 'openLogs':
                    logger.info('User opened logs');
                    logger.show();
                    break;

                case 'rerender':
                    logger.info('Dashboard requested re-render');
                    this.reactor.reprocess();
                    break;

                case 'toggleGrouping': {
                    logger.info('User toggled grouping display');
                    const enabled = await configService.toggleGroupingEnabled();
                    // User期望：Switch到Group模式时，State栏Default也ShowGroup
                    if (enabled) {
                        const config = configService.getConfig();
                        if (!config.groupingShowInStatusBar) {
                            await configService.updateConfig('groupingShowInStatusBar', true);
                        }

                        // 首次开启Group时（groupMappings 为空），自动ExecuteGroup
                        if (Object.keys(config.groupMappings).length === 0) {
                            const latestSnapshot = this.reactor.getLatestSnapshot();
                            if (latestSnapshot && latestSnapshot.models.length > 0) {
                                const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                                await configService.updateGroupMappings(newMappings);
                                logger.info(`First-time grouping: auto-grouped ${Object.keys(newMappings).length} models`);
                            }
                        }
                    }
                    // 使用CacheData重新Render
                    this.reactor.reprocess();
                    break;
                }

                case 'renameGroup':
                    if (message.modelIds && message.groupName) {
                        logger.info(`User renamed group to: ${message.groupName}`);
                        await configService.updateGroupName(message.modelIds, message.groupName);
                        // 使用CacheData重新Render
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameGroup signal missing required data');
                    }
                    break;

                case 'promptRenameGroup':
                    if (message.modelIds && message.currentName) {
                        const newName = await vscode.window.showInputBox({
                            prompt: t('grouping.renamePrompt'),
                            value: message.currentName,
                            placeHolder: t('grouping.rename'),
                        });
                        if (newName && newName.trim() && newName !== message.currentName) {
                            logger.info(`User renamed group to: ${newName}`);
                            await configService.updateGroupName(message.modelIds, newName.trim());
                            this.reactor.reprocess();
                        }
                    } else {
                        logger.warn('promptRenameGroup signal missing required data');
                    }
                    break;

                case 'toggleGroupPin':
                    if (message.groupId) {
                        logger.info(`Toggling group pin: ${message.groupId}`);
                        await configService.togglePinnedGroup(message.groupId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('toggleGroupPin signal missing groupId');
                    }
                    break;

                case 'updateGroupOrder':
                    if (message.order) {
                        logger.info(`User updated group order. Count: ${message.order.length}`);
                        await configService.updateGroupOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateGroupOrder signal missing order data');
                    }
                    break;

                case 'autoGroup': {
                    logger.info('User triggered auto-grouping');
                    // GetLatest的快照Data
                    const latestSnapshot = this.reactor.getLatestSnapshot();
                    if (latestSnapshot && latestSnapshot.models.length > 0) {
                        // 计算新的Group映射
                        const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                        await configService.updateGroupMappings(newMappings);
                        logger.info(`Auto-grouped ${Object.keys(newMappings).length} models`);

                        // 清除之前的 pinnedGroups（因为 groupId 已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // 重新HandleData以Refresh UI
                        this.reactor.reprocess();
                    } else {
                        logger.warn('No snapshot data available for auto-grouping');
                    }
                    break;
                }

                case 'updateNotificationEnabled':
                    // HandleNotify开关变更
                    if (message.notificationEnabled !== undefined) {
                        const enabled = message.notificationEnabled as boolean;
                        await configService.updateConfig('notificationEnabled', enabled);
                        logger.info(`Notification enabled: ${enabled}`);
                        vscode.window.showInformationMessage(
                            enabled ? t('notification.enabled') : t('notification.disabled'),
                        );
                    }
                    break;

                case 'updateThresholds':
                    // HandleThresholdUpdate
                    if (message.warningThreshold !== undefined && message.criticalThreshold !== undefined) {
                        const warningVal = message.warningThreshold as number;
                        const criticalVal = message.criticalThreshold as number;

                        if (criticalVal < warningVal && warningVal >= 5 && warningVal <= 80 && criticalVal >= 1 && criticalVal <= 50) {
                            await configService.updateConfig('warningThreshold', warningVal);
                            await configService.updateConfig('criticalThreshold', criticalVal);
                            logger.info(`Thresholds updated: warning=${warningVal}%, critical=${criticalVal}%`);
                            vscode.window.showInformationMessage(
                                t('threshold.updated', { value: `Warning: ${warningVal}%, Critical: ${criticalVal}%` }),
                            );
                            // 注意：notifiedModels 清理逻辑通常在 TelemetryController，这里可能无法直接访问
                            // 我们可以让 reactor 重新SendData，如果 TelemetryController Listen了 configChange 或Data变化，会自动Handle？
                            // 最好是这里只Update config，reprocess 会触发 reactor 的逻辑。
                            // 但 notifiedModels 是内存State。
                            // Temporary方案：不清理，或者通过 reactor Send一个Event？
                            // 观察 extension.ts，'notifiedModels.clear()' 是直接调用的。
                            // 我们可以将 notifiedModels 移入 TelemetryController 并提供一个 reset 方法。
                            // 这里先保留注释。
                            this.reactor.reprocess();
                        } else {
                            logger.warn('Invalid threshold values received from dashboard');
                        }
                    }
                    break;

                case 'renameModel':
                    if (message.modelId && message.groupName !== undefined) {
                        logger.info(`User renamed model ${message.modelId} to: ${message.groupName}`);
                        await configService.updateModelName(message.modelId, message.groupName);
                        // 使用CacheData重新Render
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameModel signal missing required data');
                    }
                    break;

                case 'updateStatusBarFormat':
                    if (message.statusBarFormat) {
                        logger.info(`User changed status bar format to: ${message.statusBarFormat}`);
                        await configService.updateConfig('statusBarFormat', message.statusBarFormat);
                        // 立即RefreshState栏
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateStatusBarFormat signal missing statusBarFormat');
                    }
                    break;

                case 'toggleProfile':
                    // Switch计划DetailsShow/Hidden
                    logger.info('User toggled profile visibility');
                    {
                        const currentConfig = configService.getConfig();
                        await configService.updateConfig('profileHidden', !currentConfig.profileHidden);
                        this.reactor.reprocess();
                    }
                    break;

                case 'updateDisplayMode':
                    if (message.displayMode) {
                        logger.info(`User changed display mode to: ${message.displayMode}`);
                        await configService.updateConfig('displayMode', message.displayMode);

                        if (message.displayMode === 'quickpick') {
                            // 1. Close Webview
                            this.hud.dispose();
                            // 2. RefreshState栏
                            this.reactor.reprocess();
                            // 3. 立即弹出 QuickPick (通过命令)
                            vscode.commands.executeCommand('agCockpit.open');
                        } else {
                            this.reactor.reprocess();
                        }
                    }
                    break;

                case 'updateQuotaSource':
                    if (message.quotaSource) {
                        await this.applyQuotaSourceChange(message.quotaSource);
                    } else {
                        logger.warn('updateQuotaSource signal missing quotaSource');
                    }
                    break;



                case 'updateDataMasked':
                    // UpdateData遮罩State
                    if (message.dataMasked !== undefined) {
                        logger.info(`User changed data masking to: ${message.dataMasked}`);
                        await configService.updateConfig('dataMasked', message.dataMasked);
                        this.reactor.reprocess();
                    }
                    break;

                case 'antigravityToolsSync.import':
                    await this.handleAntigravityToolsImport(false);
                    break;

                case 'antigravityToolsSync.importAuto':
                    await this.handleAntigravityToolsImport(true);
                    break;

                case 'antigravityToolsSync.importConfirm':
                    {
                        const activeEmail = await credentialStorage.getActiveAccount();
                        const importOnly = message.importOnly === true;
                        const switchOnly = message.switchOnly === true;
                        const targetEmail = message.targetEmail as string | undefined;

                        if (switchOnly && targetEmail) {
                            // 纯Switch场景：直接调用快速Switch，无需网络Request
                            await antigravityToolsSyncService.switchOnly(targetEmail);
                            const state = await autoTriggerController.getState();
                            this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                            this.hud.sendMessage({ type: 'antigravityToolsSyncComplete', data: { success: true } });
                            // 修复：Switch account后必须强制Execute syncTelemetry 来Get新AccountQuota，而不是 reprocess 旧Cache
                            if (configService.getConfig().quotaSource === 'authorized') {
                                const usedCache = await this.reactor.tryUseQuotaCache('authorized', targetEmail);
                                if (!usedCache) {
                                    this.reactor.syncTelemetry();
                                }
                            }
                            vscode.window.showInformationMessage(
                                t('autoTrigger.accountSwitched', { email: targetEmail }) 
                                || `已Switch至Account: ${targetEmail}`,
                            );
                        } else {
                            // 需要Import的场景
                            await this.performAntigravityToolsImport(activeEmail, false, importOnly);
                        }
                    }
                    break;

                case 'antigravityToolsSync.importJson':
                    if (typeof message.jsonText === 'string') {
                        await this.performAntigravityToolsJsonImport(message.jsonText);
                    } else {
                        const err = 'JSON Content为空';
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncComplete',
                            data: { success: false, error: err },
                        });
                        vscode.window.showWarningMessage(err);
                    }
                    break;

                case 'antigravityToolsSync.cancel':
                    // UserCancelImport
                    if (this.importCancelToken) {
                        this.importCancelToken.cancelled = true;
                        logger.info('[AntigravityToolsSync] UserCancel了Import操作');
                    }
                    break;

                case 'antigravityToolsSync.toggle':
                    if (typeof message.enabled === 'boolean') {
                        await configService.setStateFlag('antigravityToolsSyncEnabled', message.enabled);
                        const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncStatus',
                            data: { autoSyncEnabled: message.enabled, autoSwitchEnabled },
                        });
                        if (message.enabled) {
                            await this.handleAntigravityToolsImport(true);
                        }
                    }
                    break;
                case 'antigravityToolsSync.toggleAutoSwitch':
                    if (typeof message.enabled === 'boolean') {
                        await configService.setStateFlag('antigravityToolsAutoSwitchEnabled', message.enabled);
                        const autoSyncEnabled = configService.getStateFlag('antigravityToolsSyncEnabled', false);
                        this.hud.sendMessage({
                            type: 'antigravityToolsSyncStatus',
                            data: { autoSyncEnabled, autoSwitchEnabled: message.enabled },
                        });
                        if (message.enabled) {
                            await this.handleAntigravityToolsImport(true);
                        }
                    }
                    break;

                case 'antigravityToolsSync.switchToClient':
                    // Switch至Current登录账户
                    await this.handleSwitchToClientAccount();
                    break;

                case 'updateLanguage':
                    // UpdateLanguageSet
                    if (message.language !== undefined) {
                        const rawLanguage = String(message.language);
                        const newLanguage = normalizeLocaleInput(rawLanguage);
                        logger.info(`User changed language to: ${newLanguage}`);
                        await configService.updateConfig('language', newLanguage);
                        // 应用新LanguageSet
                        i18n.applyLanguageSetting(newLanguage);
                        const languageForSync = newLanguage === 'auto' ? i18n.getLocale() : newLanguage;
                        
                        // SyncLanguage到桌面端
                        if (cockpitToolsWs.isConnected) {
                            // Online：通过 WebSocket Sync
                            const syncResult = await cockpitToolsWs.setLanguage(languageForSync, 'extension');
                            if (!syncResult.success) {
                                logger.warn(`[WS] SyncLanguage到桌面端Failed: ${syncResult.message}`);
                            }
                        } else {
                            // Offline：写入共享文件，等桌面端Start时读取
                            const { writeSyncSetting } = await import('../services/syncSettings');
                            writeSyncSetting('language', languageForSync);
                            logger.info(`[SyncSettings] Language写入共享文件（Offline模式）: ${languageForSync}`);
                        }
                        
                        // CloseCurrentPanel并重新Open
                        this.hud.dispose();
                        // 短暂Delay后重新OpenPanel，确保旧Panel完全Close
                        setTimeout(() => {
                            vscode.commands.executeCommand('agCockpit.open');
                        }, 100);
                    }
                    break;

                case 'saveCustomGrouping': {
                    // SaveCustomGroup
                    const { customGroupMappings, customGroupNames } = message;
                    if (customGroupMappings) {
                        logger.info(`User saved custom grouping: ${Object.keys(customGroupMappings).length} models`);
                        await configService.updateGroupMappings(customGroupMappings);

                        // 清除之前的 pinnedGroups（因为 groupId 可能已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // SaveGroup名称（如果有）
                        if (customGroupNames) {
                            await configService.updateConfig('groupingCustomNames', customGroupNames);
                        }

                        // Refresh UI
                        this.reactor.reprocess();
                    }
                    break;
                }

                // ============ Auto Trigger ============
                case 'tabChanged':
                    // Tab Switch时，如果切到Auto Trigger Tab，SendStateUpdate
                    if (message.tab === 'auto-trigger') {
                        logger.debug('Switched to Auto Trigger tab');
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'autoTrigger.authorize':
                    logger.info('User triggered OAuth authorization');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Authorization failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Authorization failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.importLocal':
                    await this.handleLocalAuthImport();
                    break;
                case 'autoTrigger.importLocalConfirm':
                    await this.handleLocalAuthImportConfirm(message.overwrite === true);
                    break;

                case 'autoTrigger.revoke':
                    logger.info('User revoked OAuth authorization');
                    await autoTriggerController.revokeActiveAccount();
                    {
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    if (configService.getConfig().quotaSource === 'authorized') {
                        this.reactor.syncTelemetry();
                    }
                    break;

                case 'autoTrigger.saveSchedule':
                    if (message.schedule) {
                        logger.info('User saved auto trigger schedule');
                        await autoTriggerController.saveSchedule(message.schedule);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        vscode.window.showInformationMessage(t('autoTrigger.saved'));
                    }
                    break;

                case 'autoTrigger.test':
                    logger.info('User triggered manual test');
                    try {
                        // 从Message中GetCustomModelList
                        const rawModels = (message as { models?: unknown }).models;
                        const testModels = Array.isArray(rawModels)
                            ? rawModels.filter((model): model is string => typeof model === 'string' && model.length > 0)
                            : undefined;
                        // GetCustomWakeup词
                        const customPrompt = (message as { customPrompt?: string }).customPrompt;
                        const rawMaxOutputTokens = (message as { maxOutputTokens?: unknown }).maxOutputTokens;
                        const parsedMaxOutputTokens = typeof rawMaxOutputTokens === 'number'
                            ? rawMaxOutputTokens
                            : (typeof rawMaxOutputTokens === 'string' ? Number(rawMaxOutputTokens) : undefined);
                        const maxOutputTokens = typeof parsedMaxOutputTokens === 'number'
                            && Number.isFinite(parsedMaxOutputTokens)
                            && parsedMaxOutputTokens > 0
                            ? Math.floor(parsedMaxOutputTokens)
                            : undefined;
                        const rawAccounts = (message as { accounts?: unknown }).accounts;
                        const testAccounts = Array.isArray(rawAccounts)
                            ? rawAccounts.filter((email): email is string => typeof email === 'string' && email.length > 0)
                            : undefined;
                        const result = await autoTriggerController.triggerNow(testModels, customPrompt, testAccounts, maxOutputTokens);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (result.success) {
                            // ShowSuccessMessage和 AI 回复
                            const successMsg = t('autoTrigger.triggerSuccess').replace('{duration}', String(result.duration));
                            const responsePreview = result.response
                                ? `\n${result.response.substring(0, 200)}${result.response.length > 200 ? '...' : ''}`
                                : '';
                            vscode.window.showInformationMessage(successMsg + responsePreview);
                        } else {
                            vscode.window.showErrorMessage(
                                t('autoTrigger.triggerFailed').replace('{message}', result.error || 'Unknown error'),
                            );
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        vscode.window.showErrorMessage(
                            t('autoTrigger.triggerFailed').replace('{message}', err.message),
                        );
                    }
                    break;

                case 'autoTrigger.validateCrontab':
                    if (message.crontab) {
                        const result = autoTriggerController.validateCrontab(message.crontab);
                        this.hud.sendMessage({
                            type: 'crontabValidation',
                            data: result,
                        });
                    }
                    break;

                case 'autoTrigger.clearHistory':
                    {
                        logger.info('User cleared trigger history');
                        await autoTriggerController.clearHistory();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        vscode.window.showInformationMessage(t('autoTrigger.historyCleared'));
                    }
                    break;

                case 'getAutoTriggerState':
                case 'autoTrigger.getState':
                    {
                        const state = await autoTriggerController.getState();
                        const accountCount = state.authorization?.accounts?.length ?? 0;
                        const activeAccount = state.authorization?.activeAccount ?? state.authorization?.email ?? 'none';
                        logger.info(`[Webview] autoTriggerState accounts=${accountCount} active=${activeAccount}`);
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'autoTrigger.addAccount':
                    // Same as authorize - adds a new account
                    logger.info('User adding new account');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Add account failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Add account failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.removeAccount':
                    if (message.email) {
                        logger.info(`User removing account: ${message.email}`);
                        await autoTriggerController.removeAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } else {
                        logger.warn('removeAccount missing email');
                    }
                    break;

                case 'autoTrigger.switchAccount':
                    if (message.email) {
                        logger.info(`User switching to account: ${message.email}`);
                        await autoTriggerController.switchAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            const usedCache = await this.reactor.tryUseQuotaCache('authorized', message.email);
                            if (!usedCache) {
                                this.reactor.syncTelemetry();
                            }
                        }
                    } else {
                        logger.warn('switchAccount missing email');
                    }
                    break;

                case 'autoTrigger.switchLoginAccount':
                    // Switch登录账户（实际SwitchClient账户，需要Notify Cockpit Tools）
                    if (message.email) {
                        logger.info(`User switching login account to: ${message.email}`);
                        
                        // Check WebSocket ConnectState
                        if (!cockpitToolsWs.isConnected) {
                            const action = await vscode.window.showWarningMessage(
                                'Cockpit Tools 未Running，无法Switch account',
                                'Start Cockpit Tools',
                                '下载 Cockpit Tools',
                            );
                            
                            if (action === 'Start Cockpit Tools') {
                                vscode.commands.executeCommand('agCockpit.accountTree.openManager');
                            } else if (action === '下载 Cockpit Tools') {
                                vscode.env.openExternal(vscode.Uri.parse('https://github.com/self-hosted/antigravity-cockpit-tools/releases'));
                            }
                            return;
                        }
                        
                        try {
                            // 通过 WebSocket Notify Cockpit Tools Switch account
                            const resp = await cockpitToolsWs.getAccounts();
                            const account = resp.accounts.find((a: AccountInfo) => a.email === message.email);
                            
                            if (account && account.id) {
                                const result = await cockpitToolsWs.switchAccount(account.id);
                                if (result.success) {
                                    vscode.window.showInformationMessage(t('autoTrigger.switchLoginSuccess') || `已Switch登录账户至 ${message.email}`);
                                } else {
                                    vscode.window.showErrorMessage(t('autoTrigger.switchLoginFailed') || `Switch登录账户Failed: ${result.message}`);
                                }
                            } else {
                                vscode.window.showErrorMessage(t('autoTrigger.accountNotFound') || '未找到该账户');
                            }
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error));
                            logger.error(`Switch login account failed: ${err.message}`);
                            vscode.window.showErrorMessage(t('autoTrigger.switchLoginFailed') || `Switch登录账户Failed: ${err.message}`);
                        }
                    } else {
                        logger.warn('switchLoginAccount missing email');
                    }
                    break;

                case 'autoTrigger.reauthorizeAccount':
                    // 重新Authorization指定Account（先Delete再重新Authorization）
                    if (message.email) {
                        logger.info(`User reauthorizing account: ${message.email}`);
                        try {
                            // 重新走Authorization流程，会覆盖该Account的 token
                            await autoTriggerController.reauthorizeAccount(message.email);
                            const state = await autoTriggerController.getState();
                            this.hud.sendMessage({
                                type: 'autoTriggerState',
                                data: state,
                            });
                            if (configService.getConfig().quotaSource === 'authorized') {
                                this.reactor.syncTelemetry();
                            }
                            vscode.window.showInformationMessage(t('autoTrigger.reauthorizeSuccess'));
                        } catch (error) {
                            const err = error instanceof Error ? error : new Error(String(error));
                            logger.error(`Reauthorize account failed: ${err.message}`);
                            vscode.window.showErrorMessage(`Reauthorize failed: ${err.message}`);
                        }
                    } else {
                        logger.warn('reauthorizeAccount missing email');
                    }
                    break;


                // ============ Announcements ============
                case 'announcement.getState':
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAsRead':
                    if (message.id) {
                        await announcementService.markAsRead(message.id);
                        logger.debug(`Marked announcement as read: ${message.id}`);
                        // Update前端State
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAllAsRead':
                    await announcementService.markAllAsRead();
                    logger.debug('Marked all announcements as read');
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'openUrl':
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;

                case 'executeCommand':
                    if (message.commandId) {
                        const args = message.commandArgs;
                        if (args && Array.isArray(args) && args.length > 0) {
                            await vscode.commands.executeCommand(message.commandId, ...args);
                        } else {
                            await vscode.commands.executeCommand(message.commandId);
                        }
                    }
                    break;

            }
        });
    }

    private async handleLocalAuthImport(): Promise<void> {
        try {
            const snapshotEmail = this.reactor.getLatestSnapshot()?.userInfo?.email;
            const fallbackEmail = snapshotEmail && snapshotEmail !== 'N/A' && snapshotEmail.includes('@')
                ? snapshotEmail
                : undefined;
            const preview = await previewLocalCredential(fallbackEmail);
            this.hud.sendMessage({
                type: 'localAuthImportPrompt',
                data: {
                    email: preview.email,
                    exists: preview.exists,
                },
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[LocalAuthImport] Failed: ${err.message}`);
            this.hud.sendMessage({
                type: 'localAuthImportError',
                data: {
                    message: err.message,
                },
            });
            vscode.window.showErrorMessage(
                t('quotaSource.importLocalFailed', { message: err.message })
                || `Import failed: ${err.message}`,
            );
        }
    }

    private async handleLocalAuthImportConfirm(overwrite: boolean): Promise<void> {
        try {
            const snapshotEmail = this.reactor.getLatestSnapshot()?.userInfo?.email;
            const fallbackEmail = snapshotEmail && snapshotEmail !== 'N/A' && snapshotEmail.includes('@')
                ? snapshotEmail
                : undefined;
            const result = await commitLocalCredential({ overwrite, fallbackEmail });
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });
            if (configService.getConfig().quotaSource === 'authorized') {
                this.reactor.syncTelemetry();
            }
            vscode.window.showInformationMessage(
                t('quotaSource.importLocalSuccess', { email: result.email })
                || `Imported account: ${result.email}`,
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[LocalAuthImport] Confirm failed: ${err.message}`);
            vscode.window.showErrorMessage(
                t('quotaSource.importLocalFailed', { message: err.message })
                || `Import failed: ${err.message}`,
            );
        }
    }

    /**
     * 读取 AntigravityTools Account，必要时ModalTooltipUserConfirm
     * @param isAuto 是否自动模式
     */
    private async handleAntigravityToolsImport(isAuto: boolean): Promise<void> {
        try {
            const autoSyncEnabled = configService.getStateFlag('antigravityToolsSyncEnabled', false);
            const autoSwitchEnabled = configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true);
            if (isAuto && !autoSyncEnabled && !autoSwitchEnabled) {
                return;
            }
            const detection = await antigravityToolsSyncService.detect();
            const activeEmail = await credentialStorage.getActiveAccount();
            
            // 场景 A：未检测到 AntigravityTools Data
            if (!detection || !detection.currentEmail) {
                if (!isAuto) {
                    // 手动触发时，Tooltip未检测到
                    this.hud.sendMessage({
                        type: 'antigravityToolsSyncPrompt',
                        data: {
                            promptType: 'not_found',
                        },
                    });
                }
                return;
            }

            const sameAccount = activeEmail
                ? detection.currentEmail.toLowerCase() === activeEmail.toLowerCase()
                : false;

            // 场景 B：有新账户需要Import
            if (detection.newEmails.length > 0) {
                if (isAuto) {
                    if (autoSyncEnabled) {
                        // 自动模式：根据PanelVisible性决定Modal或静默
                        if (this.hud.isVisible()) {
                            // PanelVisible，Modal + 自动Confirm
                            this.hud.sendMessage({
                                type: 'antigravityToolsSyncPrompt',
                                data: {
                                    promptType: 'new_accounts',
                                    newEmails: detection.newEmails,
                                    currentEmail: detection.currentEmail,
                                    sameAccount,
                                    autoConfirm: true,
                                    autoConfirmImportOnly: !autoSwitchEnabled,
                                },
                            });
                        } else {
                            // Panel不Visible，静默Import
                            await this.performAntigravityToolsImport(activeEmail, true, !autoSwitchEnabled);
                            vscode.window.showInformationMessage(
                                t('antigravityToolsSync.autoImported', { email: detection.currentEmail }) 
                                || `已自动Sync账户: ${detection.currentEmail}`,
                            );
                        }
                        return;
                    }
                } else {
                    // 手动模式，Modal让UserSelect
                    this.hud.sendMessage({
                        type: 'antigravityToolsSyncPrompt',
                        data: {
                            promptType: 'new_accounts',
                            newEmails: detection.newEmails,
                            currentEmail: detection.currentEmail,
                            sameAccount,
                            autoConfirm: false,
                        },
                    });
                }
                if (!isAuto) {
                    return;
                }
            }

            // 场景 C：无新增，且Account一致则无需Switch
            if (sameAccount) {
                if (!isAuto) {
                    vscode.window.showInformationMessage(t('antigravityToolsSync.alreadySynced') || '已Sync，无需Switch');
                }
                return;
            }

            // 场景 D：无新增账户，但账户不一致
            if (isAuto) {
                if (!autoSwitchEnabled) {
                    return;
                }
                // 自动模式：静默Switch（无需网络Request，瞬间Done）
                await antigravityToolsSyncService.switchOnly(detection.currentEmail);
                // RefreshState
                const state = await autoTriggerController.getState();
                this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                this.hud.sendMessage({ type: 'antigravityToolsSyncComplete', data: { success: true } });
                // 修复：AccountSwitch后必须立即RequestGet新Account的QuotaData
                if (configService.getConfig().quotaSource === 'authorized') {
                    this.reactor.syncTelemetry();
                }
                logger.info(`AntigravityTools Sync: Auto-switched to ${detection.currentEmail}`);
            } else {
                // 手动模式：Modal询问
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncPrompt',
                    data: {
                        promptType: 'switch_only',
                        currentEmail: detection.currentEmail,
                        localEmail: activeEmail,
                        currentEmailExistsLocally: detection.currentEmailExistsLocally,
                        autoConfirm: false,
                    },
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools sync detection failed: ${err}`);
            if (!isAuto) {
                vscode.window.showWarningMessage(err);
            }
        }
    }

    /**
     * 真正ExecuteImport + Switch，并Refresh前端State
     * @param importOnly 如果为 true，仅Import账户而不Switch
     */
    private async performAntigravityToolsImport(activeEmail?: string | null, isAuto: boolean = false, importOnly: boolean = false): Promise<void> {
        // CreateCancelToken
        this.importCancelToken = { cancelled: false };
        
        try {
            // ProgressCallback：将ProgressSend到前端
            const onProgress = (current: number, total: number, email: string) => {
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncProgress',
                    data: { current, total, email },
                });
            };

            const result = await antigravityToolsSyncService.importAndSwitch(activeEmail, importOnly, onProgress, this.importCancelToken);
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });

            // Notify前端ImportDone
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: true },
            });

            // 如果Quota来源是Authorization模式，自动RefreshQuotaData
            if (configService.getConfig().quotaSource === 'authorized' && result.currentAvailable) {
                this.reactor.syncTelemetry();
            }

            if (result.skipped.length > 0) {
                const skipMsg = `已Skip ${result.skipped.length} 个InvalidAccount`;
                logger.warn(`[AntigravityToolsSync] ${skipMsg}`);
                if (!isAuto) {
                    vscode.window.showWarningMessage(skipMsg);
                }
            }

            if (!result.currentAvailable && !importOnly) {
                const warnMsg = 'CurrentAccountImportFailed，已SkipSwitch';
                logger.warn(`[AntigravityToolsSync] ${warnMsg}`);
                if (!isAuto) {
                    vscode.window.showWarningMessage(warnMsg);
                }
            }

            if (!isAuto) {
                let message: string;
                if (importOnly) {
                    message = t('antigravityToolsSync.imported');
                } else {
                    message = result.switched
                        ? t('antigravityToolsSync.switched', { email: result.currentEmail })
                        : t('antigravityToolsSync.alreadySynced');
                }
                vscode.window.showInformationMessage(message);
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools import failed: ${err}`);

            // Notify前端ImportFailed
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: false, error: err },
            });

            vscode.window.showWarningMessage(err);
        } finally {
            // 清理CancelToken
            this.importCancelToken = null;
        }
    }

    /**
     * 手动Import Antigravity Tools JSON Account
     */
    private async performAntigravityToolsJsonImport(jsonText: string): Promise<void> {
        // CreateCancelToken
        this.importCancelToken = { cancelled: false };
        
        try {
            // ProgressCallback：将ProgressSend到前端
            const onProgress = (current: number, total: number, email: string) => {
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncProgress',
                    data: { current, total, email },
                });
            };

            const result = await antigravityToolsSyncService.importFromJson(jsonText, onProgress, this.importCancelToken);
            const state = await autoTriggerController.getState();
            this.hud.sendMessage({
                type: 'autoTriggerState',
                data: state,
            });

            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: true },
            });

            if (configService.getConfig().quotaSource === 'authorized') {
                this.reactor.syncTelemetry();
            }

            if (result.skipped.length > 0) {
                const skipMsg = `已Skip ${result.skipped.length} 个InvalidAccount`;
                logger.warn(`[AntigravityToolsSync] ${skipMsg}`);
                vscode.window.showWarningMessage(skipMsg);
            }

            const importedMsg = t('antigravityToolsSync.imported') || '已ImportAccount';
            vscode.window.showInformationMessage(importedMsg);
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`Antigravity Tools JSON import failed: ${err}`);
            this.hud.sendMessage({
                type: 'antigravityToolsSyncComplete',
                data: { success: false, error: err },
            });
            vscode.window.showWarningMessage(err);
        } finally {
            // 清理CancelToken
            this.importCancelToken = null;
        }
    }

    /**
     * Switch至Current登录账户
     * 优先检测Local Antigravity Client的Current账户，其次检测 Antigravity Tools：
     * - 如果账户已存在于 Cockpit，直接Switch
     * - 如果账户不存在，走ImportModal流程
     */
    private async handleSwitchToClientAccount(): Promise<void> {
        try {
            let currentEmail: string | null = null;
            const source = 'local' as const;
            
            // 仅检测Local Antigravity Client读取Current账户
            try {
                const preview = await previewLocalCredential();
                if (preview?.email) {
                    currentEmail = preview.email;
                    logger.info(`[SwitchToClient] Found local client account: ${currentEmail}`);
                }
            } catch (localErr) {
                logger.debug(`[SwitchToClient] Local client detection failed: ${localErr instanceof Error ? localErr.message : localErr}`);
            }
            
            if (!currentEmail) {
                vscode.window.showWarningMessage(
                    t('antigravityToolsSync.noClientAccount') || '未检测到Client登录账户',
                );
                return;
            }

            const activeEmail = await credentialStorage.getActiveAccount();
            const currentEmailLower = currentEmail.toLowerCase();
            
            // Check是否已是Current账户
            if (activeEmail && activeEmail.toLowerCase() === currentEmailLower) {
                vscode.window.showInformationMessage(
                    t('antigravityToolsSync.alreadySynced') || '已是Current账户',
                );
                return;
            }

            // Check账户是否已存在于 Cockpit
            const accounts = await credentialStorage.getAllCredentials();
            const existingEmail = Object.keys(accounts).find(
                email => email.toLowerCase() === currentEmailLower,
            );

            if (existingEmail) {
                // 账户已存在，通过 autoTriggerController Switch（使用互斥锁保护）
                logger.info(`[SwitchToClient] Switching to existing account: ${existingEmail}`);
                await autoTriggerController.switchAccount(existingEmail);
                const state = await autoTriggerController.getState();
                this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                
                // RefreshQuota
                const source = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';
                const usedCache = await this.reactor.tryUseQuotaCache(source, existingEmail);
                if (!usedCache) {
                    this.reactor.syncTelemetry();
                }
                
                vscode.window.showInformationMessage(
                    t('autoTrigger.accountSwitched', { email: existingEmail }) 
                    || `已Switch至: ${existingEmail}`,
                );
            } else {
                // 账户不存在，走ImportModal流程
                logger.info(`[SwitchToClient] Account not found, showing import prompt for: ${currentEmail} (source: ${source})`);
                this.hud.sendMessage({
                    type: 'antigravityToolsSyncPrompt',
                    data: {
                        promptType: 'new_accounts',
                        newEmails: [currentEmail],
                        currentEmail: currentEmail,
                        localEmail: source === 'local' ? currentEmail : undefined,
                        sameAccount: false,
                        autoConfirm: false,
                    },
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`[SwitchToClient] Failed: ${err}`);
            vscode.window.showWarningMessage(
                t('antigravityToolsSync.switchFailed', { message: err }) || `SwitchFailed: ${err}`,
            );
        }
    }
}
