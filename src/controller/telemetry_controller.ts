
import * as vscode from 'vscode';
import { ReactorCore } from '../engine/reactor';
import { StatusBarController } from './status_bar_controller';
import { CockpitHUD } from '../view/hud';
import { QuickPickView } from '../view/quickpick_view';
import { configService, CockpitConfig } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { QuotaSnapshot } from '../shared/types';
import { QUOTA_THRESHOLDS, TIMING } from '../shared/constants';
import { credentialStorage, autoTriggerController } from '../auto_trigger';
import { announcementService } from '../announcement';
import { antigravityToolsSyncService } from '../antigravityTools_sync';


export class TelemetryController {
    private notifiedModels: Set<string> = new Set();
    private lastSuccessfulUpdate: Date | null = null;
    private consecutiveFailures: number = 0;
    private antigravityToolsAutoSynced: boolean = false;  // 避免重复Execute自动Sync

    constructor(
        private reactor: ReactorCore,
        private statusBar: StatusBarController,
        private hud: CockpitHUD,
        private quickPickView: QuickPickView,
        private onRetry: () => Promise<void>,
    ) {
        this.setupTelemetryHandling();
    }

    public resetNotifications(): void {
        this.notifiedModels.clear();
    }

    private setupTelemetryHandling(): void {
        this.reactor.onTelemetry(async (snapshot: QuotaSnapshot) => {
            let config = configService.getConfig();

            // Record最后SuccessUpdateTime
            this.lastSuccessfulUpdate = new Date();
            this.consecutiveFailures = 0; // Reset连续Failed计数

            // SuccessGetData，ResetErrorState
            this.statusBar.reset();

            // CheckQuota并SendNotify
            this.checkAndNotifyQuota(snapshot, config);

            // 首次InstallGroupDefaultEnable时，自动生成Group映射并重新Render
            if (config.groupingEnabled && Object.keys(config.groupMappings).length === 0 && snapshot.models.length > 0) {
                const newMappings = ReactorCore.calculateGroupMappings(snapshot.models);
                await configService.updateGroupMappings(newMappings);
                logger.info(`Auto-grouped on first run: ${Object.keys(newMappings).length} models`);
                this.reactor.reprocess();
                return;
            }

            // 自动将新Group添加到 pinnedGroups（第一次开启Group时Default全部Show在State栏）
            if (config.groupingEnabled && snapshot.groups && snapshot.groups.length > 0) {
                const currentPinnedGroups = config.pinnedGroups;
                const allGroupIds = snapshot.groups.map(g => g.groupId);

                // 如果 pinnedGroups 为空，说明是第一次开启Group，自动 pin 全部
                if (currentPinnedGroups.length === 0) {
                    logger.info(`Auto-pinning all ${allGroupIds.length} groups to status bar`);
                    await configService.updateConfig('pinnedGroups', allGroupIds);
                    // 重新GetConfig
                    config = configService.getConfig();
                }
            }

            const authorizationStatus = await credentialStorage.getAuthorizationStatus();
            const authorizedAvailable = authorizationStatus.isAuthorized;

            // Update Dashboard（使用可能已Update的 config）
            this.hud.refreshView(snapshot, {
                showPromptCredits: config.showPromptCredits,
                pinnedModels: config.pinnedModels,
                modelOrder: config.modelOrder,
                modelCustomNames: config.modelCustomNames,
                visibleModels: config.visibleModels,
                groupingEnabled: config.groupingEnabled,
                groupCustomNames: config.groupingCustomNames,
                groupingShowInStatusBar: config.groupingShowInStatusBar,
                pinnedGroups: config.pinnedGroups,
                groupOrder: config.groupOrder,
                refreshInterval: config.refreshInterval,
                notificationEnabled: config.notificationEnabled,
                warningThreshold: config.warningThreshold,
                criticalThreshold: config.criticalThreshold,
                lastSuccessfulUpdate: this.lastSuccessfulUpdate,
                statusBarFormat: config.statusBarFormat,
                profileHidden: config.profileHidden,
                quotaSource: config.quotaSource,
                authorizedAvailable,
                authorizationStatus,
                displayMode: config.displayMode,
                dataMasked: config.dataMasked,
                groupMappings: config.groupMappings,
                language: config.language,
                antigravityToolsSyncEnabled: configService.getStateFlag('antigravityToolsSyncEnabled', false),
                antigravityToolsAutoSwitchEnabled: configService.getStateFlag('antigravityToolsAutoSwitchEnabled', true),
            });

            // Update QuickPick ViewData
            this.quickPickView.updateSnapshot(snapshot);

            // UpdateState栏
            this.statusBar.update(snapshot, config);

            // SyncRefreshAnnouncementState（让PanelOpen时能自动Receive新AnnouncementModal）
            try {
                const annState = await announcementService.getState();
                this.hud.sendMessage({
                    type: 'announcementState',
                    data: annState,
                });
            } catch (error) {
                // AnnouncementRefreshFailed不影响主流程
                logger.debug(`[TelemetryController] Announcement refresh failed: ${error}`);
            }

            // 自动Sync Antigravity Tools 账户（仅Execute一次）
            if (!this.antigravityToolsAutoSynced && configService.getStateFlag('antigravityToolsSyncEnabled', false)) {
                this.antigravityToolsAutoSynced = true;
                this.performAutoSync().catch(err => {
                    logger.warn(`[TelemetryController] Auto sync failed: ${err}`);
                });
            }
        });

        this.reactor.onMalfunction(async (err: Error) => {
            const source = (err as Error & { source?: string }).source;
            const sourceInfo = source ? ` (source=${source})` : '';
            logger.error(`Reactor Malfunction${sourceInfo}: ${err.message}`);

            // 如果是Connect被拒绝（ECONNREFUSED），说明Port可能变了，或者信号中断/损坏，直接重新Scan
            if (err.message.includes('ECONNREFUSED') || 
                err.message.includes('Signal Lost') || 
                err.message.includes('Signal Corrupted')) {
                
                // 增加连续Failed计数
                this.consecutiveFailures++;
                
                // 如果连续Failed次数没超过Threshold，尝试自动重连
                if (this.consecutiveFailures <= TIMING.MAX_CONSECUTIVE_RETRY) {
                    logger.warn(`Connection issue detected (attempt ${this.consecutiveFailures}/${TIMING.MAX_CONSECUTIVE_RETRY}), initiating immediate re-scan protocol...`);
                    // 立即尝试重新Boot systems（重新ScanPort）
                    await this.onRetry();
                    return;
                } else {
                    logger.error(`Connection failed after ${this.consecutiveFailures} consecutive attempts. Stopping auto-retry.`);
                }
            }


            this.statusBar.setError(err.message);

            // Show system dialog
            vscode.window.showErrorMessage(
                `${t('notify.bootFailed')}: ${err.message}`,
                t('help.retry'),
                t('help.openLogs'),
            ).then(selection => {
                if (selection === t('help.retry')) {
                    vscode.commands.executeCommand('agCockpit.retry');
                } else if (selection === t('help.openLogs')) {
                    logger.show();
                }
            });
        });
    }

    private checkAndNotifyQuota(snapshot: QuotaSnapshot, config: CockpitConfig): void {
        if (!config.notificationEnabled) {
            return;
        }

        const warningThreshold = config.warningThreshold ?? QUOTA_THRESHOLDS.WARNING_DEFAULT;
        const criticalThreshold = config.criticalThreshold ?? QUOTA_THRESHOLDS.CRITICAL_DEFAULT;

        const useGroups = config.groupingEnabled && Array.isArray(snapshot.groups) && snapshot.groups.length > 0;
        if (useGroups) {
            for (const group of snapshot.groups!) {
                const pct = group.remainingPercentage ?? 0;
                const keyBase = `group:${group.groupId}`;
                const notifyKey = `${keyBase}-${pct <= criticalThreshold ? 'critical' : 'warning'}`;

                // 如果已经Notify过这个State，Skip
                if (this.notifiedModels.has(notifyKey)) {
                    continue;
                }

                // 危险ThresholdNotify（红色）
                if (pct <= criticalThreshold && pct > 0) {
                    // 清除之前的 warning NotifyRecord（如果有）
                    this.notifiedModels.delete(`${keyBase}-warning`);
                    this.notifiedModels.add(notifyKey);

                    vscode.window.showWarningMessage(
                        t('threshold.notifyCritical', { model: group.groupName, percent: pct.toFixed(1) }),
                        t('dashboard.refresh'),
                    ).then(selection => {
                        if (selection === t('dashboard.refresh')) {
                            this.reactor.syncTelemetry();
                        }
                    });
                    logger.info(`Critical threshold notification sent for ${group.groupName}: ${pct}%`);
                }
                // WarningThresholdNotify（黄色）
                else if (pct <= warningThreshold && pct > criticalThreshold) {
                    this.notifiedModels.add(notifyKey);

                    vscode.window.showInformationMessage(
                        t('threshold.notifyWarning', { model: group.groupName, percent: pct.toFixed(1) }),
                    );
                    logger.info(`Warning threshold notification sent for ${group.groupName}: ${pct}%`);
                }
                // QuotaResume时清除NotifyRecord
                else if (pct > warningThreshold) {
                    this.notifiedModels.delete(`${keyBase}-warning`);
                    this.notifiedModels.delete(`${keyBase}-critical`);
                }
            }
            return;
        }

        for (const model of snapshot.models) {
            const pct = model.remainingPercentage ?? 0;
            const notifyKey = `${model.modelId}-${pct <= criticalThreshold ? 'critical' : 'warning'}`;

            // 如果已经Notify过这个State，Skip
            if (this.notifiedModels.has(notifyKey)) {
                continue;
            }

            // 危险ThresholdNotify（红色）
            if (pct <= criticalThreshold && pct > 0) {
                // 清除之前的 warning NotifyRecord（如果有）
                this.notifiedModels.delete(`${model.modelId}-warning`);
                this.notifiedModels.add(notifyKey);

                vscode.window.showWarningMessage(
                    t('threshold.notifyCritical', { model: model.label, percent: pct.toFixed(1) }),
                    t('dashboard.refresh'),
                ).then(selection => {
                    if (selection === t('dashboard.refresh')) {
                        this.reactor.syncTelemetry();
                    }
                });
                logger.info(`Critical threshold notification sent for ${model.label}: ${pct}%`);
            }
            // WarningThresholdNotify（黄色）
            else if (pct <= warningThreshold && pct > criticalThreshold) {
                this.notifiedModels.add(notifyKey);

                vscode.window.showInformationMessage(
                    t('threshold.notifyWarning', { model: model.label, percent: pct.toFixed(1) }),
                );
                logger.info(`Warning threshold notification sent for ${model.label}: ${pct}%`);
            }
            // QuotaResume时清除NotifyRecord
            else if (pct > warningThreshold) {
                this.notifiedModels.delete(`${model.modelId}-warning`);
                this.notifiedModels.delete(`${model.modelId}-critical`);
            }
        }
    }

    /**
     * 后台自动Sync Antigravity Tools 账户（仅Import，不Switch）
     */
    private async performAutoSync(): Promise<void> {
        try {
            const autoSyncEnabled = configService.getStateFlag('antigravityToolsSyncEnabled', false);
            if (!autoSyncEnabled) {
                return;
            }
            const detection = await antigravityToolsSyncService.detect();

            // 未检测到 AntigravityTools Data，静默Skip
            if (!detection || !detection.currentEmail) {
                return;
            }

            // 只Import新账户，不Switch（账户Switch由LocalClientSync逻辑控制）
            if (detection.newEmails.length > 0) {
                if (this.hud.isVisible()) {
                    // PanelVisible，SendModalMessage（autoConfirmImportOnly=true 只Import不Switch）
                    this.hud.sendMessage({
                        type: 'antigravityToolsSyncPrompt',
                        data: {
                            promptType: 'new_accounts',
                            newEmails: detection.newEmails,
                            currentEmail: detection.currentEmail,
                            sameAccount: false,
                            autoConfirm: true,
                            autoConfirmImportOnly: true, // 始终只Import，不Switch
                        },
                    });
                } else {
                    // Panel不Visible，静默Import（importOnly=true 只Import不Switch）
                    const activeEmail = await credentialStorage.getActiveAccount();
                    await antigravityToolsSyncService.importAndSwitch(activeEmail, true);
                    // RefreshState
                    const state = await autoTriggerController.getState();
                    this.hud.sendMessage({ type: 'autoTriggerState', data: state });
                    this.hud.sendMessage({ type: 'antigravityToolsSyncComplete', data: { success: true } });
                    vscode.window.showInformationMessage(
                        t('antigravityToolsSync.autoImported', { email: detection.currentEmail }) 
                        || `已自动Import账户: ${detection.currentEmail}`,
                    );
                    logger.info(`AntigravityTools Sync: Auto-imported ${detection.newEmails.join(', ')} (no switch)`);
                }
            }
            // 不再自动Switch账户，账户Switch完全由LocalClientSync逻辑控制
        } catch (error: unknown) {
            const err = error instanceof Error ? error.message : String(error);
            logger.warn(`AntigravityTools Sync auto-sync failed: ${err}`);
        }
    }
}
