/**
 * Antigravity FuelGauge - Accounts Overview Webview
 * 独立的全屏页面，展示所有Account的QuotaState
 */

import * as vscode from 'vscode';
import { QuotaSnapshot } from '../shared/types';
import { t, i18n, localeDisplayNames, normalizeLocaleInput } from '../shared/i18n';
import { credentialStorage, oauthService, autoTriggerController } from '../auto_trigger';
import { ReactorCore } from '../engine/reactor';
import { logger } from '../shared/log_service';
import { cockpitToolsWs } from '../services/cockpitToolsWs';
import { configService } from '../shared/config_service';
import { announcementService } from '../announcement';
import { syncAccountsWithCockpitTools } from '../services/cockpitToolsSync';
import { antigravityToolsSyncService } from '../antigravityTools_sync';
import { importLocalCredential } from '../auto_trigger/local_auth_importer';
import { AccountsRefreshService } from '../services/accountsRefreshService';

// ============================================================================
// Types
// ============================================================================

interface AccountQuotaData {
    email: string;
    isCurrent: boolean;
    hasDeviceBound: boolean;
    tier: string;
    loading: boolean;
    error?: string;
    lastUpdated?: number;
    groups: Array<{
        groupId: string;
        groupName: string;
        percentage: number;
        resetTime: string;
        resetTimeFormatted: string;
        models: Array<{
            label: string;
            modelId: string;
            percentage: number;
            resetTime: string;
            resetTimeFormatted: string;
        }>;
    }>;
}

interface WebviewMessage {
    command: string;
    [key: string]: unknown;
}

// ============================================================================
// AccountsOverviewWebview Class
// ============================================================================

export class AccountsOverviewWebview {
    public static readonly viewType = 'antigravity.accountsOverview';
    
    private panel: vscode.WebviewPanel | undefined;
    private accountsData: Map<string, AccountQuotaData> = new Map();
    private disposables: vscode.Disposable[] = [];
    private onCloseCallback?: () => void;
    private oauthCompletionPromise: Promise<void> | null = null;
    private refreshSubscription?: vscode.Disposable;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly reactor: ReactorCore,
        private readonly refreshService: AccountsRefreshService,
    ) {}

    /**
     * SetCloseCallback
     */
    onClose(callback: () => void): void {
        this.onCloseCallback = callback;
    }

    /**
     * ShowAccounts Overview Page
     */
    async show(): Promise<boolean> {
        // 如果已存在，直接Show
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            await this.refreshAllAccounts();
            return true;
        }

        // Create新Panel
        this.panel = vscode.window.createWebviewPanel(
            AccountsOverviewWebview.viewType,
            t('accountsOverview.title') || 'Accounts Overview',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.extensionUri, 'out', 'view', 'webview'),
                ],
            },
        );

        // Set HTML Content
        this.panel.webview.html = this.generateHtml(this.panel.webview);

        // ListenMessage
        this.panel.webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables,
        );

        this.refreshSubscription = this.refreshService.onDidUpdate(() => {
            this.syncFromRefreshService();
        });
        this.disposables.push(this.refreshSubscription);

        // ListenPanelClose
        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                this.disposables.forEach(d => d.dispose());
                this.disposables = [];
                oauthService.cancelAuthorizationSession();
                if (this.onCloseCallback) {
                    this.onCloseCallback();
                }
            },
            null,
            this.disposables,
        );

        // InitializeData
        this.syncFromRefreshService();
        await this.refreshAllAccounts();

        return true;
    }

    /**
     * ClosePanel
     */
    dispose(): void {
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
        oauthService.cancelAuthorizationSession();
    }

    /**
     * Refresh所有Account的QuotaData
     */
    private async refreshAllAccounts(): Promise<void> {
        await this.refreshService.refresh();
        this.syncFromRefreshService();
    }

    /**
     * Refresh单个Account的Quota
     */
    private async refreshAccount(email: string): Promise<void> {
        await this.refreshService.loadAccountQuota(email);
        this.syncFromRefreshService();
    }

    /**
     * 转换QuotaGroupData
     */
    private convertGroups(snapshot: QuotaSnapshot): AccountQuotaData['groups'] {
        if (!snapshot.groups || snapshot.groups.length === 0) {
            // 如果没有Group，按ModelCreate单独的"Group"
            return snapshot.models.map(model => ({
                groupId: model.modelId || model.label,
                groupName: model.label,
                percentage: model.remainingPercentage ?? 0,
                resetTime: model.resetTimeDisplay,
                resetTimeFormatted: model.timeUntilResetFormatted,
                models: [{
                    label: model.label,
                    modelId: model.modelId,
                    percentage: model.remainingPercentage ?? 0,
                    resetTime: model.resetTimeDisplay,
                    resetTimeFormatted: model.timeUntilResetFormatted,
                }],
            }));
        }

        return snapshot.groups.map(group => ({
            groupId: group.groupId,
            groupName: group.groupName,
            percentage: group.remainingPercentage ?? 0,
            resetTime: group.resetTimeDisplay,
            resetTimeFormatted: group.timeUntilResetFormatted,
            models: group.models.map(model => ({
                label: model.label,
                modelId: model.modelId,
                percentage: model.remainingPercentage ?? 0,
                resetTime: model.resetTimeDisplay,
                resetTimeFormatted: model.timeUntilResetFormatted,
            })),
        }));
    }

    /**
     * SendAccountDataUpdate到 Webview
     */
    private sendAccountsUpdate(): void {
        if (!this.panel) {return;}

        const accounts = Array.from(this.accountsData.values());
        this.panel.webview.postMessage({
            type: 'accountsUpdate',
            data: {
                accounts,
                i18n: this.getI18nStrings(),
                config: configService.getConfig(),
            },
        });
    }

    private syncFromRefreshService(): void {
        if (!this.panel) {return;}

        const accounts = this.refreshService.getAccountsMap();
        const quotaCache = this.refreshService.getQuotaCacheMap();

        const nextData = new Map<string, AccountQuotaData>();
        for (const [email, account] of accounts) {
            const cache = quotaCache.get(email);
            const hasCache = Boolean(cache);
            const loading = cache?.loading ?? !hasCache;
            const error = cache?.error;
            const lastUpdated = cache?.fetchedAt;
            const groups = cache ? this.convertGroups(cache.snapshot) : [];

            nextData.set(email, {
                email,
                isCurrent: account.isCurrent,
                hasDeviceBound: account.hasDeviceBound,
                tier: account.tier || '',
                loading,
                error,
                lastUpdated,
                groups,
            });
        }

        this.accountsData = nextData;
        this.sendAccountsUpdate();
    }

    private postActionResult(payload: { status: 'success' | 'error'; message: string; context?: string; closeModal?: boolean }): void {
        if (!this.panel) {return;}
        this.panel.webview.postMessage({
            type: 'actionResult',
            data: payload,
        });
    }

    private postActionProgress(payload: { message: string; context?: string }): void {
        if (!this.panel) {return;}
        this.panel.webview.postMessage({
            type: 'actionProgress',
            data: payload,
        });
    }

    /**
     * Geti18n字符串
     */
    private getI18nStrings(): Record<string, string> {
        return {
            'title': t('accountsOverview.title') || 'Accounts Overview',
            'subtitle': t('accountsOverview.subtitle') || 'Real-time monitoring of all account quotas',
            'back': t('accountsOverview.back') || 'Back to Dashboard',
            'totalAccounts': t('accountsOverview.totalAccounts') || '{count} Accounts',
            'search': t('accountsOverview.search') || 'Search accounts...',
            'all': t('accountsOverview.all') || 'All',
            'sortBy': t('accountsOverview.sortBy') || 'Sort by',
            'sortOverall': t('accountsOverview.sortOverall') || 'Overall Quota',
            'sortLabel': t('accountsOverview.sortLabel') || 'Sort',
            'refreshAll': t('accountsOverview.refreshAll') || 'Refresh All',
            'addAccount': t('accountsOverview.addAccount') || 'Add Account',
            'export': t('accountsOverview.export') || 'Export',
            'current': t('accountsOverview.current') || 'Current',
            'loading': t('accountsOverview.loading') || 'Loading...',
            'error': t('accountsOverview.error') || 'Error',
            'refresh': t('accountsOverview.refresh') || 'Refresh',
            'switch': t('accountsOverview.switch') || 'Switch',
            'delete': t('accountsOverview.delete') || 'Delete',
            'fingerprint': t('accountsOverview.fingerprint') || 'Fingerprint',
            'bound': t('accountsOverview.bound') || 'Bound',
            'unbound': t('accountsOverview.unbound') || 'Unbound',
            'updated': t('accountsOverview.updated') || 'Updated',
            'confirmDelete': t('accountsOverview.confirmDelete') || 'Confirm delete account?',
            'confirmDeleteBatch': t('accountsOverview.confirmDeleteBatch') || 'Confirm delete {count} selected accounts?',
            'deleteSelected': t('accountsOverview.deleteSelected') || 'Delete Selected',
            'selectAll': t('accountsOverview.selectAll') || 'Select All',
            'deselectAll': t('accountsOverview.deselectAll') || 'Deselect All',
            'noAccounts': t('accountsOverview.noAccounts') || 'No accounts found',
            'addFirstAccount': t('accountsOverview.addFirstAccount') || 'Add your first account to get started',
            'noMatchTitle': t('accountsOverview.noMatchTitle') || 'No matching accounts',
            'noMatchDesc': t('accountsOverview.noMatchDesc') || 'No accounts match the current filters',
            'switchConfirm': t('accountsOverview.switchConfirm') || 'Switch to this account?',
            'switchWarning': t('accountsOverview.switchWarning') || 'This will restart Antigravity client to complete the switch.',
            'confirm': t('common.confirm') || 'Confirm',
            'cancel': t('common.cancel') || 'Cancel',
            'close': t('common.close') || 'Close',
            'viewList': t('accountsOverview.viewList') || 'List',
            'viewGrid': t('accountsOverview.viewGrid') || 'Grid',
            'filterLabel': t('accountsOverview.filterLabel') || 'Filter',
            'filterAll': t('accountsOverview.filterAll') || 'All',
            'filterPro': t('accountsOverview.filterPro') || 'PRO',
            'filterUltra': t('accountsOverview.filterUltra') || 'ULTRA',
            'filterFree': t('accountsOverview.filterFree') || 'FREE',
            'columnEmail': t('accountsOverview.columnEmail') || 'Email',
            'columnFingerprint': t('accountsOverview.columnFingerprint') || 'Fingerprint',
            'columnQuota': t('accountsOverview.columnQuota') || 'Quota',
            'columnActions': t('accountsOverview.columnActions') || 'Actions',
            'quotaDetails': t('accountsOverview.quotaDetails') || 'Quota Details',
            'details': t('accountsOverview.details') || 'Details',
            'noQuotaData': t('accountsOverview.noQuotaData') || 'No quota data',
            // Add Account Modal
            'authorize': t('accountsOverview.authorize') || 'Authorization',
            'import': t('accountsOverview.import') || 'Import',
            'oauthHint': t('accountsOverview.oauthHint') || '推荐使用浏览器Done Google Authorization',
            'startOAuth': t('accountsOverview.startOAuth') || 'Start OAuth Authorization',
            'oauthContinue': t('accountsOverview.oauthContinue') || '我已Authorization，Continue',
            'oauthLinkLabel': t('accountsOverview.oauthLinkLabel') || 'Authorization链接',
            'oauthGenerating': t('accountsOverview.oauthGenerating') || '正在生成链接...',
            'copy': t('common.copy') || 'Copy',
            'oauthStarting': t('accountsOverview.oauthStarting') || 'Authorization中...',
            'oauthContinuing': t('accountsOverview.oauthContinuing') || 'WaitingAuthorization中...',
            'copySuccess': t('accountsOverview.copySuccess') || '已Copy',
            'copyFailed': t('accountsOverview.copyFailed') || 'CopyFailed',
            'tokenHint': t('accountsOverview.tokenHint') || '输入 Refresh Token 直接添加Account',
            'tokenPlaceholder': t('accountsOverview.tokenPlaceholder') || 'Paste refresh_token 或 JSON 数组',
            'tokenImportStart': t('accountsOverview.tokenImportStart') || 'StartImport',
            'tokenInvalid': t('accountsOverview.tokenInvalid') || 'refresh_token Invalid',
            'tokenImportProgress': t('accountsOverview.tokenImportProgress') || '正在Import {current}/{total}',
            'tokenImportSuccess': t('accountsOverview.tokenImportSuccess') || 'ImportSuccess',
            'tokenImportPartial': t('accountsOverview.tokenImportPartial') || '部分ImportDone',
            'tokenImportFailed': t('accountsOverview.tokenImportFailed') || 'ImportFailed',
            'email': t('accountsOverview.email') || 'Email',
            'importHint': t('accountsOverview.importHint') || '从 JSON 文件或剪贴板ImportAccount',
            'content': t('accountsOverview.content') || 'Content',
            'paste': t('accountsOverview.paste') || 'Paste',
            'importFromExtension': t('accountsOverview.importFromExtension') || '从PluginImport',
            'importFromExtensionDesc': t('accountsOverview.importFromExtensionDesc') || 'Sync Cockpit Tools Account',
            'importFromLocal': t('accountsOverview.importFromLocal') || '从LocalData库Import',
            'importFromLocalDesc': t('accountsOverview.importFromLocalDesc') || '读取本机 Antigravity 登录Account',
            'importFromTools': t('accountsOverview.importFromTools') || 'Import Antigravity Tools',
            'importFromToolsDesc': t('accountsOverview.importFromToolsDesc') || '从 ~/.antigravity_tools/ 迁移HistoryAccount',
            'importNoAccounts': t('accountsOverview.importNoAccounts') || '未找到可ImportAccount',
            'importSuccess': t('accountsOverview.importSuccess') || 'ImportSuccess',
            'importFailed': t('accountsOverview.importFailed') || 'ImportFailed',
            'importLocalSuccess': t('accountsOverview.importLocalSuccess') || 'ImportDone',
            'importProgress': t('accountsOverview.importProgress') || '正在Import {current}/{total}: {email}',
            'importingExtension': t('accountsOverview.importingExtension') || 'Import中...',
            'importingLocal': t('accountsOverview.importingLocal') || 'Import中...',
            'importingTools': t('accountsOverview.importingTools') || 'Import中...',
            // Settings & Announcements
            'settings': t('accountsOverview.settings') || 'Set',
            'announcements': t('accountsOverview.announcements') || 'Announcement',
            'noAnnouncements': t('accountsOverview.noAnnouncements') || '暂无Announcement',
            'autoRefresh': t('accountsOverview.autoRefresh') || '自动Refresh',
            'autoRefreshDesc': t('accountsOverview.autoRefreshDesc') || 'Open页面时自动RefreshQuota',
            'openDashboard': t('accountsOverview.openDashboard') || 'OpenQuota监视器',
            'openDashboardDesc': t('accountsOverview.openDashboardDesc') || 'ReturnQuota监视器主界面',
            'go': t('accountsOverview.go') || '前往',
        };
    }

    /**
     * Handle来自 Webview 的Message
     */
    private async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                await this.refreshAllAccounts();
                {
                    const annState = await announcementService.getState();
                    this.panel?.webview.postMessage({
                        type: 'announcementState',
                        data: annState,
                    });
                }
                break;

            case 'back':
                // 调用Return命令，由命令Handle dispose 和Open Dashboard
                vscode.commands.executeCommand('agCockpit.backToDashboard');
                break;

            case 'refreshAll':
                await this.refreshAllAccounts();
                break;

            case 'refreshAccount':
                if (typeof message.email === 'string') {
                    await this.refreshAccount(message.email);
                }
                break;

            case 'switchAccount':
                if (typeof message.email === 'string') {
                    await this.handleSwitchAccount(message.email);
                }
                break;

            case 'deleteAccount':
                if (typeof message.email === 'string') {
                    await this.handleDeleteAccount(message.email);
                }
                break;

            case 'deleteAccounts':
                if (Array.isArray(message.emails)) {
                    await this.handleDeleteAccounts(message.emails as string[]);
                }
                break;

            case 'addAccount':
                await this.handleAddAccount(typeof message.mode === 'string' ? message.mode : undefined);
                break;

            case 'importTokens':
                if (typeof message.content === 'string') {
                    await this.handleImportTokens(message.content);
                }
                break;

            case 'importFromExtension':
                await this.handleImportFromExtension();
                break;

            case 'importFromLocal':
                await this.handleImportFromLocal();
                break;

            case 'importFromTools':
                await this.handleImportFromTools();
                break;

            case 'exportAccounts':
                if (Array.isArray(message.emails)) {
                    await this.handleExportAccounts(message.emails as string[]);
                }
                break;

            case 'announcement.getState': {
                const annState = await announcementService.getState();
                this.panel?.webview.postMessage({
                    type: 'announcementState',
                    data: annState,
                });
                break;
            }

            case 'announcement.markAsRead':
                if (typeof message.id === 'string') {
                    await announcementService.markAsRead(message.id);
                    const annState = await announcementService.getState();
                    this.panel?.webview.postMessage({
                        type: 'announcementState',
                        data: annState,
                    });
                }
                break;

            case 'announcement.markAllAsRead': {
                await announcementService.markAllAsRead();
                const annState = await announcementService.getState();
                this.panel?.webview.postMessage({
                    type: 'announcementState',
                    data: annState,
                });
                break;
            }

            case 'openUrl':
                if (typeof message.url === 'string') {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;

            case 'executeCommand':
                if (typeof message.commandId === 'string') {
                    const args = Array.isArray(message.commandArgs) ? message.commandArgs : [];
                    vscode.commands.executeCommand(message.commandId, ...args);
                }
                break;

            case 'openDashboard':
                this.dispose();
                if (typeof message.tab === 'string') {
                    vscode.commands.executeCommand('agCockpit.open', { tab: message.tab });
                } else {
                    vscode.commands.executeCommand('agCockpit.open');
                }
                break;

            case 'updateLanguage':
                if (message.language !== undefined) {
                    const rawLanguage = String(message.language);
                    const newLanguage = normalizeLocaleInput(rawLanguage);
                    await configService.updateConfig('language', newLanguage);
                    i18n.applyLanguageSetting(newLanguage);

                    const languageForSync = newLanguage === 'auto' ? i18n.getLocale() : newLanguage;
                    if (cockpitToolsWs.isConnected) {
                        const syncResult = await cockpitToolsWs.setLanguage(languageForSync, 'extension');
                        if (!syncResult.success) {
                            logger.warn(`[WS] SyncLanguage到桌面端Failed: ${syncResult.message}`);
                        }
                    } else {
                        const { writeSyncSetting } = await import('../services/syncSettings');
                        writeSyncSetting('language', languageForSync);
                    }

                    this.dispose();
                    setTimeout(() => {
                        this.show();
                    }, 100);
                }
                break;

            case 'updateStatusBarFormat':
                if (typeof message.statusBarFormat === 'string') {
                    await configService.updateConfig('statusBarFormat', message.statusBarFormat);
                    this.reactor.reprocess();
                    this.sendAccountsUpdate();
                }
                break;

            case 'updateNotificationEnabled':
                if (typeof message.notificationEnabled === 'boolean') {
                    await configService.updateConfig('notificationEnabled', message.notificationEnabled);
                    this.reactor.reprocess();
                    this.sendAccountsUpdate();
                }
                break;

            case 'updateThresholds':
                if (typeof message.warningThreshold === 'number' && typeof message.criticalThreshold === 'number') {
                    const warning = Math.min(80, Math.max(5, message.warningThreshold));
                    const critical = Math.min(50, Math.max(1, message.criticalThreshold));
                    if (critical < warning) {
                        await configService.updateConfig('warningThreshold', warning);
                        await configService.updateConfig('criticalThreshold', critical);
                        if (typeof message.notificationEnabled === 'boolean') {
                            await configService.updateConfig('notificationEnabled', message.notificationEnabled);
                        }
                        this.reactor.reprocess();
                        this.sendAccountsUpdate();
                    }
                }
                break;

            case 'updateDisplayMode':
                if (typeof message.displayMode === 'string') {
                    await configService.updateConfig('displayMode', message.displayMode);
                    if (message.displayMode === 'quickpick') {
                        this.dispose();
                        this.reactor.reprocess();
                        vscode.commands.executeCommand('agCockpit.open');
                    } else {
                        this.reactor.reprocess();
                        this.sendAccountsUpdate();
                    }
                }
                break;

            default:
                logger.warn(`[AccountsOverview] Unknown command: ${message.command}`);
        }
    }

    /**
     * HandleSwitchAccount
     */
    private async handleSwitchAccount(email: string): Promise<void> {
        try {
            const currentEmail = this.refreshService.getCurrentEmail();
            const confirmMessage = currentEmail
                ? t('account.switch.confirmWithCurrent', { current: currentEmail, target: email })
                : t('account.switch.confirmNoCurrent', { target: email });

            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                t('account.switch.confirmOk'),
            );

            if (confirm !== t('account.switch.confirmOk')) {
                return;
            }

            cockpitToolsWs.ensureConnected();
            if (!cockpitToolsWs.isConnected) {
                const launchAction = t('accountTree.launchCockpitTools');
                const downloadAction = t('accountTree.downloadCockpitTools');
                const action = await vscode.window.showWarningMessage(
                    t('accountTree.cockpitToolsNotRunning'),
                    launchAction,
                    downloadAction,
                );

                if (action === launchAction) {
                    vscode.commands.executeCommand('agCockpit.accountTree.openManager');
                } else if (action === downloadAction) {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/self-hosted/antigravity-cockpit-tools/releases'));
                }
                return;
            }

            // GetAccountList找到对应的 account ID
            const accountsResp = await cockpitToolsWs.getAccounts();
            const account = accountsResp.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
            
            if (!account) {
                throw new Error('Account not found in Cockpit Tools');
            }

            // 通过 Cockpit Tools Switch
            const result = await cockpitToolsWs.switchAccount(account.id);
            if (result.success) {
                await credentialStorage.setActiveAccount(email);
                await this.refreshAllAccounts();
                this.postActionResult({
                    status: 'success',
                    message: t('accountsOverview.switchSuccess', { email }) || `Switched to ${email}`,
                });
            } else {
                throw new Error(result.message || 'Switch request failed');
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.switchFailed', { error: err.message }) || `Failed to switch: ${err.message}`,
            });
        }
    }

    /**
     * HandleDeleteAccount
     */
    private async handleDeleteAccount(email: string): Promise<void> {
        try {
            await autoTriggerController.removeAccount(email);
            await this.refreshAllAccounts();
            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.deleteSuccess', { email }) || `Deleted ${email}`,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.deleteFailed', { error: err.message }) || `Failed to delete: ${err.message}`,
            });
        }
    }

    /**
     * Handle批量DeleteAccount
     */
    private async handleDeleteAccounts(emails: string[]): Promise<void> {
        let successCount = 0;
        for (const email of emails) {
            try {
                await autoTriggerController.removeAccount(email);
                successCount++;
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.warn(`[AccountsOverview] Failed to delete ${email}: ${err.message}`);
            }
        }
        await this.refreshAllAccounts();
        this.postActionResult({
            status: 'success',
            message: t('accountsOverview.deleteBatchSuccess', { count: successCount }) || `Deleted ${successCount} accounts`,
        });
    }

    /**
     * Handle添加Account
     */
    private async handleAddAccount(mode?: string): Promise<void> {
        const normalizedMode = (mode || '').toLowerCase();
        if (normalizedMode === 'prepare') {
            await this.prepareOauthSession();
            return;
        }
        if (normalizedMode === 'cancel') {
            this.cancelOauthSession();
            return;
        }
        if (normalizedMode === 'start') {
            await this.startOauthFlow();
            return;
        }
        if (normalizedMode === 'continue') {
            this.ensureOauthCompletion();
            return;
        }

        try {
            const success = await oauthService.startAuthorization();
            if (success) {
                await this.refreshAllAccounts();
                this.postActionResult({
                    status: 'success',
                    message: t('accountsOverview.addSuccess') || 'Authorization completed',
                    context: 'add',
                    closeModal: true,
                });
            } else {
                this.postActionResult({
                    status: 'error',
                    message: t('accountsOverview.addFailed', { error: 'Authorization failed' }) || 'Authorization failed',
                    context: 'add',
                });
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.addFailed', { error: err.message }) || `Failed to add: ${err.message}`,
                context: 'add',
            });
        }
    }

    private postOauthUrl(url: string): void {
        if (!this.panel) {return;}
        this.panel.webview.postMessage({
            type: 'oauthUrl',
            data: { url },
        });
    }

    private async prepareOauthSession(): Promise<void> {
        try {
            const url = await oauthService.prepareAuthorizationSession();
            this.postOauthUrl(url);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.addFailed', { error: err.message }) || `Failed to prepare OAuth: ${err.message}`,
                context: 'add',
            });
        }
    }

    private cancelOauthSession(): void {
        oauthService.cancelAuthorizationSession();
        this.oauthCompletionPromise = null;
    }

    private async startOauthFlow(): Promise<void> {
        let url = '';
        try {
            url = await oauthService.prepareAuthorizationSession();
            this.postOauthUrl(url);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.addFailed', { error: err.message }) || `Failed to prepare OAuth: ${err.message}`,
                context: 'add',
            });
            return;
        }

        if (url) {
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) {
                try {
                    await vscode.env.clipboard.writeText(url);
                } catch {
                    // ignore clipboard errors
                }
                this.postActionResult({
                    status: 'error',
                    message: t('oauth.browserOpenFailed') || 'Failed to open browser automatically',
                    context: 'add',
                });
            }
        }

        this.postActionProgress({
            context: 'add',
            message: t('accountsOverview.oauthStarting') || 'Authorizing...',
        });
        this.ensureOauthCompletion();
    }

    private ensureOauthCompletion(): void {
        if (this.oauthCompletionPromise) {return;}
        this.oauthCompletionPromise = this.completeOauthSession()
            .catch(() => undefined)
            .finally(() => {
                this.oauthCompletionPromise = null;
            });
    }

    private async completeOauthSession(): Promise<void> {
        try {
            this.postActionProgress({
                context: 'add',
                message: t('accountsOverview.oauthContinuing') || 'Waiting for authorization...',
            });
            const success = await oauthService.completeAuthorizationSession();
            if (success) {
                await this.refreshAllAccounts();
                this.postActionResult({
                    status: 'success',
                    message: t('accountsOverview.addSuccess') || 'Authorization completed',
                    context: 'add',
                    closeModal: true,
                });
                return;
            }
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.addFailed', { error: 'Authorization failed' }) || 'Authorization failed',
                context: 'add',
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.addFailed', { error: err.message }) || `Failed to add: ${err.message}`,
                context: 'add',
            });
        }
    }

    private extractRefreshTokens(input: string): string[] {
        const tokens: string[] = [];
        const trimmed = input.trim();
        if (!trimmed) {
            return tokens;
        }

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            const pushToken = (value: unknown) => {
                if (typeof value === 'string' && value.startsWith('1//')) {
                    tokens.push(value);
                }
            };

            if (Array.isArray(parsed)) {
                parsed.forEach(item => {
                    if (typeof item === 'string') {
                        pushToken(item);
                        return;
                    }
                    if (item && typeof item === 'object') {
                        const token = (item as { refresh_token?: string; refreshToken?: string }).refresh_token
                            || (item as { refresh_token?: string; refreshToken?: string }).refreshToken;
                        pushToken(token);
                    }
                });
            } else if (parsed && typeof parsed === 'object') {
                const token = (parsed as { refresh_token?: string; refreshToken?: string }).refresh_token
                    || (parsed as { refresh_token?: string; refreshToken?: string }).refreshToken;
                pushToken(token);
            }
        } catch {
            // ignore JSON parse errors
        }

        if (tokens.length === 0) {
            const matches = trimmed.match(/1\/\/[a-zA-Z0-9_-]+/g);
            if (matches) {
                tokens.push(...matches);
            }
        }

        return Array.from(new Set(tokens));
    }

    private async handleImportTokens(content: string): Promise<void> {
        const tokens = this.extractRefreshTokens(content);
        if (tokens.length === 0) {
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.tokenInvalid') || 'Invalid refresh token',
                context: 'add',
            });
            return;
        }

        let success = 0;
        let fail = 0;

        for (let i = 0; i < tokens.length; i++) {
            this.postActionProgress({
                context: 'add',
                message: (t('accountsOverview.tokenImportProgress', { current: i + 1, total: tokens.length }) || `Importing ${i + 1}/${tokens.length}`),
            });
            try {
                const credential = await oauthService.buildCredentialFromRefreshToken(tokens[i]);
                const result = await credentialStorage.saveCredentialForAccount(credential.email, credential);
                await credentialStorage.clearAccountInvalid(credential.email);
                if (result === 'added') {
                    success++;
                } else {
                    fail++;
                }
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.warn(`[AccountsOverview] Token import failed: ${err.message}`);
                fail++;
            }
            await new Promise(resolve => setTimeout(resolve, 120));
        }

        if (success > 0) {
            await this.refreshAllAccounts();
        }

        if (success === tokens.length) {
            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.tokenImportSuccess', { count: success }) || `Imported ${success} accounts`,
                context: 'add',
                closeModal: true,
            });
        } else if (success > 0) {
            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.tokenImportPartial', { success, fail }) || `Imported ${success}, failed ${fail}`,
                context: 'add',
            });
        } else {
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.tokenImportFailed') || 'Import failed',
                context: 'add',
            });
        }
    }

    private async handleImportFromExtension(): Promise<void> {
        try {
            const before = await credentialStorage.getAllCredentials();
            const beforeSet = new Set(Object.keys(before));
            await syncAccountsWithCockpitTools({ force: true, reason: 'accountsOverview.importExtension' });
            const after = await credentialStorage.getAllCredentials();
            const added = Object.keys(after).filter(email => !beforeSet.has(email));

            await this.refreshAllAccounts();

            if (added.length === 0) {
                this.postActionResult({
                    status: 'error',
                    message: t('accountsOverview.importNoAccounts') || 'No accounts found',
                    context: 'add',
                });
                return;
            }

            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.importSuccess', { count: added.length }) || `Imported ${added.length} accounts`,
                context: 'add',
                closeModal: true,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.importFailed', { error: err.message }) || `Import failed: ${err.message}`,
                context: 'add',
            });
        }
    }

    private async handleImportFromLocal(): Promise<void> {
        try {
            const result = await importLocalCredential();
            await this.refreshAllAccounts();
            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.importLocalSuccess', { email: result.email }) || `Imported ${result.email}`,
                context: 'add',
                closeModal: true,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.importFailed', { error: err.message }) || `Import failed: ${err.message}`,
                context: 'add',
            });
        }
    }

    private async handleImportFromTools(): Promise<void> {
        try {
            const before = await credentialStorage.getAllCredentials();
            const beforeSet = new Set(Object.keys(before));
            const activeEmail = await credentialStorage.getActiveAccount();

            await antigravityToolsSyncService.importAndSwitch(
                activeEmail,
                true,
                (current, total, email) => {
                    this.postActionProgress({
                        context: 'add',
                        message: t('accountsOverview.importProgress', { current, total, email }) || `Importing ${current}/${total}: ${email}`,
                    });
                },
            );

            const after = await credentialStorage.getAllCredentials();
            const added = Object.keys(after).filter(email => !beforeSet.has(email));

            await this.refreshAllAccounts();

            if (added.length === 0) {
                this.postActionResult({
                    status: 'error',
                    message: t('accountsOverview.importNoAccounts') || 'No accounts found',
                    context: 'add',
                });
                return;
            }

            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.importSuccess', { count: added.length }) || `Imported ${added.length} accounts`,
                context: 'add',
                closeModal: true,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.importFailed', { error: err.message }) || `Import failed: ${err.message}`,
                context: 'add',
            });
        }
    }

    /**
     * HandleExportAccount
     */
    private async handleExportAccounts(emails: string[]): Promise<void> {
        try {
            const credentials = await credentialStorage.getAllCredentials();
            const exportData = emails
                .filter(email => email in credentials)
                .map(email => ({
                    email,
                    refresh_token: credentials[email]?.refreshToken || '',
                }));

            const jsonContent = JSON.stringify(exportData, null, 2);

            // Copy到剪贴板
            await vscode.env.clipboard.writeText(jsonContent);
            this.postActionResult({
                status: 'success',
                message: t('accountsOverview.exportSuccess', { count: exportData.length }) || `Exported ${exportData.length} accounts to clipboard`,
            });
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.postActionResult({
                status: 'error',
                message: t('accountsOverview.exportFailed', { error: err.message }) || `Failed to export: ${err.message}`,
            });
        }
    }

    /**
     * Get Webview 资源 URI
     */
    private getWebviewUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
        return webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'view', 'webview', ...pathSegments),
        );
    }

    /**
     * Generate HTML Content
     */
    private generateHtml(webview: vscode.Webview): string {
        const nonce = this.generateNonce();
        const sharedModalCssUri = this.getWebviewUri(webview, 'shared_modals.css');
        const cssUri = this.getWebviewUri(webview, 'accounts_overview.css');
        const jsUri = this.getWebviewUri(webview, 'accounts_overview.js');

        const i18nStrings = this.getI18nStrings();
        const translationsJson = JSON.stringify(i18n.getAllTranslations());
        const i18nScript = `window.__i18n = ${translationsJson}; window.__accountsOverviewI18n = ${JSON.stringify(i18nStrings)};`;

        return `<!DOCTYPE html>
<html lang="${i18n.getLocale()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
    <link href="${sharedModalCssUri}" rel="stylesheet">
    <link href="${cssUri}" rel="stylesheet">
    <title>${i18nStrings.title}</title>
</head>
<body>
    <div class="accounts-overview-container">
        <header class="ao-header">
            <button id="ao-back-btn" class="ao-back-btn" title="${i18nStrings.back}">
                <span class="ao-back-icon">←</span>
                <span>${i18nStrings.back}</span>
            </button>
            <div class="ao-header-actions">
                <button id="announcement-btn" class="refresh-btn icon-only" title="${i18nStrings.announcements || 'Announcements'}">
                    🔔<span id="announcement-badge" class="notification-badge hidden">0</span>
                </button>
                <button id="settings-btn" class="refresh-btn icon-only" title="${i18nStrings.settings || 'Settings'}">⚙️</button>
            </div>
        </header>

        <main class="main-content accounts-page">
            <section class="page-heading">
                <div>
                    <h1 id="ao-title">${i18nStrings.title}</h1>
                    <p id="ao-subtitle">${i18nStrings.subtitle}</p>
                </div>
                <div class="page-badges">
                    <span id="ao-total-accounts" class="pill pill-soft"></span>
                    <span id="ao-current-account" class="pill pill-emphasis hidden"></span>
                </div>
            </section>

            <div class="toolbar">
                <div class="toolbar-left">
                    <div class="search-box">
                        <span class="search-icon">🔍</span>
                        <input type="text" id="ao-search-input" placeholder="${i18nStrings.search}" />
                    </div>

                    <div class="view-switcher">
                        <button id="ao-view-list" class="view-btn" title="${i18nStrings.viewList || 'List'}">☰</button>
                        <button id="ao-view-grid" class="view-btn active" title="${i18nStrings.viewGrid || 'Grid'}">▦</button>
                    </div>

                    <div class="filter-select">
                        <select id="ao-filter-select" aria-label="${i18nStrings.filterLabel || 'Filter'}">
                            <option value="all">${i18nStrings.filterAll || i18nStrings.all}</option>
                            <option value="PRO">PRO</option>
                            <option value="ULTRA">ULTRA</option>
                            <option value="FREE">FREE</option>
                        </select>
                    </div>

                    <div class="sort-select">
                        <span class="sort-icon">⇅</span>
                        <select id="ao-sort-select" aria-label="${i18nStrings.sortLabel || 'Sort'}">
                            <option value="overall">${i18nStrings.sortOverall}</option>
                        </select>
                    </div>
                </div>

                <div class="toolbar-right">
                    <button id="ao-add-btn" class="btn btn-primary icon-only" title="${i18nStrings.addAccount}" aria-label="${i18nStrings.addAccount}">＋</button>
                    <button id="ao-refresh-all-btn" class="btn btn-secondary icon-only" title="${i18nStrings.refreshAll}" aria-label="${i18nStrings.refreshAll}">⟳</button>
                    <button id="ao-import-btn" class="btn btn-secondary icon-only" title="${i18nStrings.import || 'Import'}" aria-label="${i18nStrings.import || 'Import'}">⤵</button>
                    <button id="ao-export-btn" class="btn btn-secondary export-btn icon-only" title="${i18nStrings.export}" aria-label="${i18nStrings.export}">⤴</button>
                    <button id="ao-delete-selected-btn" class="btn btn-danger icon-only hidden" title="${i18nStrings.delete || 'Delete'}" aria-label="${i18nStrings.delete || 'Delete'}">🗑</button>
                </div>
            </div>

            <div id="ao-action-message" class="action-message hidden">
                <span id="ao-action-message-text" class="action-message-text"></span>
                <button id="ao-action-message-close" class="action-message-close" aria-label="${i18nStrings.close || 'Close'}">×</button>
            </div>

            <div id="ao-loading" class="empty-state hidden">
                <div class="loading-spinner" style="width: 40px; height: 40px;"></div>
            </div>

            <div id="ao-empty-state" class="empty-state hidden">
                <div class="icon">🚀</div>
                <h3>${i18nStrings.noAccounts}</h3>
                <p>${i18nStrings.addFirstAccount}</p>
                <button id="ao-add-first-btn" class="btn btn-primary">＋ ${i18nStrings.addAccount}</button>
            </div>

            <div id="ao-empty-match" class="empty-state hidden">
                <h3>${i18nStrings.noMatchTitle || 'No matching accounts'}</h3>
                <p>${i18nStrings.noMatchDesc || 'No accounts match the current filters'}</p>
            </div>

            <div id="ao-accounts-grid" class="accounts-grid"></div>

            <div id="ao-accounts-table" class="account-table-container hidden">
                <table class="account-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;">
                                <input type="checkbox" id="ao-select-all" />
                            </th>
                            <th style="width: 240px;">${i18nStrings.columnEmail || 'Email'}</th>
                            <th style="width: 140px;">${i18nStrings.columnFingerprint || 'Fingerprint'}</th>
                            <th>${i18nStrings.columnQuota || 'Quota'}</th>
                            <th class="sticky-action-header table-action-header">${i18nStrings.columnActions || 'Actions'}</th>
                        </tr>
                    </thead>
                    <tbody id="ao-accounts-tbody"></tbody>
                </table>
            </div>
        </main>
    </div>

    <div id="ao-add-modal" class="modal-overlay hidden">
        <div class="modal-card modal-lg add-account-modal">
            <div class="modal-header">
                <h2>${i18nStrings.addAccount}</h2>
                <button id="ao-add-close" class="close-btn" aria-label="${i18nStrings.close || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <div class="add-tabs">
                    <button class="add-tab active" data-tab="oauth">🌐 ${i18nStrings.authorize || 'OAuth'}</button>
                    <button class="add-tab" data-tab="token">🔑 Refresh Token</button>
                    <button class="add-tab" data-tab="import">📋 ${i18nStrings.import || 'Import'}</button>
                </div>

                <div class="add-panel" data-panel="oauth">
                    <div class="oauth-hint">
                        🌐 <span>${i18nStrings.oauthHint || 'Recommended: Complete Google authorization in browser'}</span>
                    </div>
                    <div class="oauth-actions">
                        <button class="btn btn-primary" id="ao-oauth-start">🌐 ${i18nStrings.startOAuth || 'Start OAuth Authorization'}</button>
                        <button class="btn btn-secondary" id="ao-oauth-continue">${i18nStrings.oauthContinue || 'I already authorized, continue'}</button>
                    </div>
                    <div class="oauth-link">
                        <label>${i18nStrings.oauthLinkLabel || 'Authorization link'}</label>
                        <div class="oauth-link-row">
                            <input type="text" id="ao-oauth-link" value="${i18nStrings.oauthGenerating || 'Generating link...'}" readonly />
                            <button class="btn btn-secondary icon-only" id="ao-oauth-copy" title="${i18nStrings.copy || 'Copy'}">⧉</button>
                        </div>
                    </div>
                </div>

                <div class="add-panel hidden" data-panel="token">
                    <p class="add-panel-desc">${i18nStrings.tokenHint || 'Enter Refresh Token to add account directly'}</p>
                    <textarea id="ao-token-input" class="token-input" rows="6" placeholder="${i18nStrings.tokenPlaceholder || 'Paste refresh_token or JSON array'}"></textarea>
                    <div class="modal-actions">
                        <button class="btn btn-primary" id="ao-token-import">🔑 ${i18nStrings.tokenImportStart || 'Start Import'}</button>
                    </div>
                </div>

                <div class="add-panel hidden" data-panel="import">
                    <div class="import-options">
                        <button class="import-option" id="ao-import-local">
                            <div class="import-option-icon">🗄️</div>
                            <div class="import-option-content">
                                <div class="import-option-title">${i18nStrings.importFromLocal || 'Import from Local DB'}</div>
                                <div class="import-option-desc">${i18nStrings.importFromLocalDesc || 'Read local Antigravity login account'}</div>
                            </div>
                        </button>
                        <button class="import-option" id="ao-import-tools">
                            <div class="import-option-icon">🚀</div>
                            <div class="import-option-content">
                                <div class="import-option-title">${i18nStrings.importFromTools || 'Import Antigravity Tools'}</div>
                                <div class="import-option-desc">${i18nStrings.importFromToolsDesc || 'Migrate accounts from ~/.antigravity_tools/'}</div>
                            </div>
                        </button>
                    </div>
                </div>

                <div id="ao-add-feedback" class="add-feedback hidden"></div>
            </div>
        </div>
    </div>

    <div id="ao-confirm-modal" class="modal-overlay hidden">
        <div class="modal-card">
            <div class="modal-header">
                <h2 id="ao-confirm-title">${i18nStrings.confirm || 'Confirm'}</h2>
                <button id="ao-confirm-close" class="close-btn" aria-label="${i18nStrings.close || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <p id="ao-confirm-message"></p>
            </div>
            <div class="modal-footer">
                <button id="ao-confirm-cancel" class="btn btn-secondary">${i18nStrings.cancel || 'Cancel'}</button>
                <button id="ao-confirm-ok" class="btn btn-primary">${i18nStrings.confirm || 'Confirm'}</button>
            </div>
        </div>
    </div>

    <div id="ao-quota-modal" class="modal-overlay hidden">
        <div class="modal-card modal-lg">
            <div class="modal-header">
                <h2>${i18nStrings.quotaDetails || 'Quota Details'}</h2>
                <div id="ao-quota-badges" class="badges"></div>
                <button id="ao-quota-close" class="close-btn" aria-label="${i18nStrings.close || 'Close'}">×</button>
            </div>
            <div class="modal-body">
                <div id="ao-quota-list" class="quota-list"></div>
                <div class="modal-actions">
                    <button id="ao-quota-close-btn" class="btn btn-secondary">${i18nStrings.close || 'Close'}</button>
                    <button id="ao-quota-refresh" class="btn btn-primary">${i18nStrings.refresh || 'Refresh'}</button>
                </div>
            </div>
        </div>
    </div>

    <div id="announcement-list-modal" class="modal hidden">
        <div class="modal-content modal-content-medium">
            <div class="modal-header">
                <h3>🔔 ${i18nStrings.announcements || 'Announcements'}</h3>
                <button id="announcement-list-close" class="close-btn">×</button>
            </div>
            <div class="modal-body announcement-list-body">
                <div class="announcement-toolbar">
                    <button id="announcement-mark-all-read" class="btn-secondary btn-small">${t('announcement.markAllRead') || 'Mark all read'}</button>
                </div>
                <div id="announcement-list" class="announcement-list">
                    <div class="announcement-empty">${t('announcement.empty') || 'No notifications'}</div>
                </div>
            </div>
        </div>
    </div>

    <div id="announcement-popup-modal" class="modal hidden">
        <div class="modal-content modal-content-medium announcement-popup-content">
            <div class="modal-header notification-header">
                <button id="announcement-popup-back" class="icon-btn back-btn hidden">←</button>
                <div class="announcement-header-title">
                    <span id="announcement-popup-type" class="announcement-type-badge"></span>
                    <h3 id="announcement-popup-title"></h3>
                </div>
                <button id="announcement-popup-close" class="close-btn">×</button>
            </div>
            <div class="modal-body announcement-popup-body">
                <div id="announcement-popup-content" class="announcement-content"></div>
            </div>
            <div class="modal-footer">
                <button id="announcement-popup-later" class="btn-secondary">${t('announcement.later') || 'Later'}</button>
                <button id="announcement-popup-action" class="btn-primary hidden"></button>
                <button id="announcement-popup-got-it" class="btn-primary">${t('announcement.gotIt') || 'Got it'}</button>
            </div>
        </div>
    </div>

    <div id="settings-modal" class="modal hidden">
        <div class="modal-content modal-content-wide">
            <div class="modal-header">
                <h3>⚙️ ${t('threshold.settings')}</h3>
                <button id="close-settings-btn" class="close-btn">×</button>
            </div>
            <div class="modal-body">
                <div class="setting-item">
                    <label for="language-select">🌐 ${t('language.title') || 'Language'}</label>
                    <select id="language-select" class="setting-select">
                        <option value="auto">${t('language.auto') || 'Auto (Follow VS Code)'}</option>
                        ${this.generateLanguageOptions()}
                    </select>
                    <p class="setting-hint">${t('language.hint') || 'Override VS Code language for this extension'}</p>
                </div>

                <hr class="setting-divider">

                <div class="setting-item">
                    <label for="statusbar-format">📊 ${t('statusBarFormat.title')}</label>
                    <select id="statusbar-format" class="setting-select">
                        <option value="icon">${t('statusBarFormat.iconDesc')} - ${t('statusBarFormat.icon')}</option>
                        <option value="dot">${t('statusBarFormat.dotDesc')} - ${t('statusBarFormat.dot')}</option>
                        <option value="percent">${t('statusBarFormat.percentDesc')} - ${t('statusBarFormat.percent')}</option>
                        <option value="compact">${t('statusBarFormat.compactDesc')} - ${t('statusBarFormat.compact')}</option>
                        <option value="namePercent">${t('statusBarFormat.namePercentDesc')} - ${t('statusBarFormat.namePercent')}</option>
                        <option value="standard">${t('statusBarFormat.standardDesc')} - ${t('statusBarFormat.standard')}</option>
                    </select>
                </div>

                <hr class="setting-divider">

                <div class="setting-item">
                    <label for="notification-enabled" class="checkbox-label">
                        <input type="checkbox" id="notification-enabled" checked>
                        <span>🔔 ${t('threshold.enableNotification')}</span>
                    </label>
                    <p class="setting-hint">${t('threshold.enableNotificationHint')}</p>
                </div>
                <div class="setting-item">
                    <label for="warning-threshold">🟡 ${t('threshold.warning')}</label>
                    <div class="setting-input-group">
                        <input type="number" id="warning-threshold" min="5" max="80" value="30">
                        <span class="unit">%</span>
                        <span class="range-hint">(5-80)</span>
                    </div>
                    <p class="setting-hint">${t('threshold.warningHint')}</p>
                </div>
                <div class="setting-item">
                    <label for="critical-threshold">🔴 ${t('threshold.critical')}</label>
                    <div class="setting-input-group">
                        <input type="number" id="critical-threshold" min="1" max="50" value="10">
                        <span class="unit">%</span>
                        <span class="range-hint">(1-50)</span>
                    </div>
                    <p class="setting-hint">${t('threshold.criticalHint')}</p>
                </div>

                <hr class="setting-divider">

                <div class="setting-item">
                    <label for="display-mode-select">🖥️ ${t('displayMode.title') || 'Display Mode'}</label>
                    <select id="display-mode-select" class="setting-select">
                        <option value="webview">🎨 ${t('displayMode.webview') || 'Dashboard'}</option>
                        <option value="quickpick">⚡ ${t('displayMode.quickpick') || 'QuickPick'}</option>
                    </select>
                </div>
            </div>
        </div>
    </div>

    <div id="toast" class="toast hidden"></div>

    <script nonce="${nonce}">${i18nScript}</script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }

    private generateLanguageOptions(): string {
        const locales = i18n.getSupportedLocales();
        return locales.map(locale => {
            const displayName = localeDisplayNames[locale] || locale;
            return `<option value="${locale}">${displayName}</option>`;
        }).join('\n                        ');
    }

    /**
     * 生成随机 nonce
     */
    private generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }
}
