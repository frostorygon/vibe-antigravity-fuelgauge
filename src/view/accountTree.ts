/**
 * Account管理 Tree View
 * 
 * 三层结构：
 * - 第1层：Email (带星标表示CurrentAccount)
 * - 第2层：Group (ShowQuotaPercentage)
 * - 第3层：Model明细
 * 
 * Data来源：
 * - AccountList：Cockpit Tools (WebSocket)
 * - QuotaData：ReactorCore.fetchQuotaForAccount (Plugin端逻辑，Email匹配)
 * - 设备指纹：Cockpit Tools (WebSocket)
 */

import * as vscode from 'vscode';
import { logger } from '../shared/log_service';
import { cockpitToolsWs } from '../services/cockpitToolsWs';
import { AccountsRefreshService } from '../services/accountsRefreshService';
import { ModelQuotaInfo, QuotaGroup } from '../shared/types';
import { t } from '../shared/i18n';

// ============================================================================
// Types
// ============================================================================

// Types moved to AccountsRefreshService

// ============================================================================
// Tree Node Types
// ============================================================================

export type AccountTreeItem = AccountNode | GroupNode | ModelNode | DeviceNode | LoadingNode | ErrorNode;

/**
 * AccountNode (第1层)
 */
export class AccountNode extends vscode.TreeItem {
    constructor(
        public readonly email: string,
        public readonly isCurrent: boolean,
        public readonly hasDeviceBound: boolean,
    ) {
        super(email, vscode.TreeItemCollapsibleState.Expanded);

        // Icon with star for current account
        if (isCurrent) {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
        } else {
            this.iconPath = new vscode.ThemeIcon('account');
        }

        // Tooltip
        const parts = [
            `${t('accountTree.tooltipEmail')}: ${email}`,
            isCurrent ? t('accountTree.currentAccount') : '',
            hasDeviceBound ? t('accountTree.fingerprintBound') : t('accountTree.fingerprintUnbound'),
        ].filter(Boolean);
        this.tooltip = parts.join('\n');

        // Context for menus
        this.contextValue = isCurrent ? 'accountCurrent' : 'account';
    }
}

/**
 * GroupNode (第2层)
 */
export class GroupNode extends vscode.TreeItem {
    constructor(
        public readonly group: QuotaGroup,
        public readonly accountEmail: string,
    ) {
        super(group.groupName, vscode.TreeItemCollapsibleState.Collapsed);

        const pct = Math.round(group.remainingPercentage);
        
        // Status icon based on percentage
        let color: vscode.ThemeColor | undefined;
        if (pct <= 10) {
            color = new vscode.ThemeColor('errorForeground');
        } else if (pct <= 30) {
            color = new vscode.ThemeColor('editorWarning.foreground');
        } else {
            color = new vscode.ThemeColor('charts.green');
        }

        this.iconPath = new vscode.ThemeIcon('circle-filled', color);
        
        // 简短倒计时格式
        const resetTime = group.timeUntilResetFormatted || '-';
        this.description = `${pct}%  ${resetTime}`;
        
        this.tooltip = [
            `${t('groupNode.group')}: ${group.groupName}`,
            `${t('groupNode.quota')}: ${pct}%`,
            `${t('groupNode.reset')}: ${group.resetTimeDisplay}`,
            t('groupNode.modelsCount', { count: group.models.length.toString() }),
        ].join('\n');

        this.contextValue = 'group';
    }
}

/**
 * ModelNode (第3层)
 */
export class ModelNode extends vscode.TreeItem {
    constructor(
        public readonly model: ModelQuotaInfo,
        public readonly accountEmail: string,
    ) {
        super(model.label, vscode.TreeItemCollapsibleState.None);

        this.iconPath = new vscode.ThemeIcon('symbol-method');
        this.tooltip = `${model.label}\n${t('accountTree.tooltipModelId')}: ${model.modelId}`;
        this.contextValue = 'model';
    }
}

/**
 * 设备指纹Node
 */
export class DeviceNode extends vscode.TreeItem {
    constructor(
        public readonly accountEmail: string,
        public readonly bound: boolean,
    ) {
        super(
            bound ? t('accountTree.fingerprintLabelBound') : t('accountTree.fingerprintLabelUnbound'),
            vscode.TreeItemCollapsibleState.None,
        );

        this.iconPath = new vscode.ThemeIcon(
            bound ? 'shield' : 'unlock',
            bound ? new vscode.ThemeColor('charts.green') : undefined,
        );
        this.tooltip = bound ? t('accountTree.fingerprintTooltipBound') : t('accountTree.fingerprintTooltipUnbound');
        this.contextValue = bound ? 'deviceBound' : 'deviceUnbound';
    }
}

/**
 * LoadingNode
 */
export class LoadingNode extends vscode.TreeItem {
    constructor() {
        super(t('accountTree.loading'), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
}

/**
 * ErrorNode
 */
export class ErrorNode extends vscode.TreeItem {
    constructor(message: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        this.contextValue = 'error';
    }
}

// ============================================================================
// Tree Data Provider
// ============================================================================

export class AccountTreeProvider implements vscode.TreeDataProvider<AccountTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AccountTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private refreshSubscription: vscode.Disposable;

    constructor(private readonly refreshService: AccountsRefreshService) {
        this.refreshSubscription = this.refreshService.onDidUpdate(() => {
            this._onDidChangeTreeData.fire();
        });
    }

    dispose(): void {
        this.refreshSubscription.dispose();
    }

    /**
     * 手动Refresh（带Cooldown）
     */
    async manualRefresh(): Promise<boolean> {
        return this.refreshService.manualRefresh();
    }

    /**
     * Refresh所有Account的Quota（串行，静默Load）
     * 使用锁机制防止并发Execute，避免重复 API Request
     */
    async refreshQuotas(): Promise<void> {
        await this.refreshService.refreshQuotas();
    }

    /**
     * Refresh所有AccountList
     */
    async refresh(): Promise<void> {
        await this.refreshService.refresh();
    }

    /**
     * Load指定Account的Quota（ShowLoadState，用于首次Load）
     */
    async loadAccountQuota(email: string): Promise<void> {
        await this.refreshService.loadAccountQuota(email);
    }

    getTreeItem(element: AccountTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AccountTreeItem): Promise<AccountTreeItem[]> {
        if (!element) {
            // Root level: account list
            return this.getRootChildren();
        }

        if (element instanceof AccountNode) {
            // Account children: groups or loading
            return this.getAccountChildren(element.email);
        }

        if (element instanceof GroupNode) {
            // Group children: models
            return element.group.models.map(m => new ModelNode(m, element.accountEmail));
        }

        return [];
    }

    private getRootChildren(): AccountTreeItem[] {
        const initError = this.refreshService.getInitError();
        if (initError) {
            return [new ErrorNode(initError)];
        }

        if (!this.refreshService.isInitialized()) {
            return [new LoadingNode()];
        }

        const accounts = this.refreshService.getAccountsMap();
        if (accounts.size === 0) {
            return [new ErrorNode(t('accountTree.noAccounts'))];
        }

        // 保持AccountOriginal顺序，不按CurrentAccountSort
        const nodes: AccountNode[] = [];
        for (const [email, account] of accounts) {
            nodes.push(new AccountNode(email, account.isCurrent, account.hasDeviceBound));
        }

        return nodes;
    }

    private getAccountChildren(email: string): AccountTreeItem[] {
        const cache = this.refreshService.getQuotaCache(email);
        const account = this.refreshService.getAccount(email);
        const hasDevice = account?.hasDeviceBound ?? false;

        if (account && !account.hasPluginCredential) {
            return [
                new ErrorNode(t('accountTree.notImported')),
                new DeviceNode(email, hasDevice),
            ];
        }

        // Loading
        if (!cache || cache.loading) {
            return [new LoadingNode()];
        }

        // Error
        if (cache.error) {
            return [
                new ErrorNode(cache.error),
                new DeviceNode(email, hasDevice),
            ];
        }

        // ShowGroup
        const children: AccountTreeItem[] = [];
        const snapshot = cache.snapshot;

        if (snapshot.groups && snapshot.groups.length > 0) {
            // 有Group，ShowGroup
            for (const group of snapshot.groups) {
                children.push(new GroupNode(group, email));
            }
        } else if (snapshot.models.length > 0) {
            // 无Group但有Model，直接ShowModel
            for (const model of snapshot.models) {
                children.push(new ModelNode(model, email));
            }
        } else {
            children.push(new ErrorNode(t('accountTree.noQuotaData')));
        }

        // 设备指纹Node
        children.push(new DeviceNode(email, hasDevice));

        return children;
    }

    /**
     * GetCurrentAccount
     */
    getCurrentEmail(): string | null {
        return this.refreshService.getCurrentEmail();
    }

    /**
     * Get指定Account的 ID (从 Cockpit Tools)
     */
    async getAccountId(email: string): Promise<string | null> {
        return this.refreshService.getAccountId(email);
    }
}

// ============================================================================
// Commands
// ============================================================================

export function registerAccountTreeCommands(
    context: vscode.ExtensionContext,
    provider: AccountTreeProvider,
): void {
    // Refresh (带Cooldown)
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.refresh', async () => {
            // 手动触发重连
            cockpitToolsWs.ensureConnected();
            await provider.manualRefresh();
        }),
    );

    // Load account quota
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.loadAccountQuota', async (email: string) => {
            await provider.loadAccountQuota(email);
        }),
    );

    // Switch account (通过 WebSocket Request Cockpit Tools Execute真正的Switch)
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.switch', async (node: AccountNode) => {
            // 🆕 二次ConfirmDialog
            const currentEmail = provider.getCurrentEmail();
            const confirmMessage = currentEmail 
                ? t('account.switch.confirmWithCurrent', { current: currentEmail, target: node.email })
                : t('account.switch.confirmNoCurrent', { target: node.email });
            
            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },  // 模态Dialog，自动带有CancelButton
                t('account.switch.confirmOk'),
            );
            
            // User点击"Cancel"或CloseDialog
            if (confirm !== t('account.switch.confirmOk')) {
                return;  // 中止操作
            }
            
            // Import WebSocket Client (文件顶部已Import，这里不需要重新Import，但为了保持逻辑一致，使用顶部Import的实例)
            // const { cockpitToolsWs } = await import('../services/cockpitToolsWs');
            
            // 尝试确保Connect
            cockpitToolsWs.ensureConnected();
            
            // CheckConnectState
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

            // GetAccount ID
            const accountId = await provider.getAccountId(node.email);
            if (!accountId) {
                vscode.window.showWarningMessage(t('accountTree.cannotGetAccountId'));
                return;
            }

            // 通过 WebSocket RequestSwitch
            const sent = cockpitToolsWs.requestSwitchAccount(accountId);
            if (sent) {
                vscode.window.showInformationMessage(
                    t('accountTree.switchingTo', { email: node.email }),
                );
            } else {
                vscode.window.showErrorMessage(t('accountTree.sendSwitchFailed'));
            }
        }),
    );

    // Open Cockpit Tools
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.accountTree.openManager', async () => {
            const platform = process.platform;
            let command: string;

            if (platform === 'darwin') {
                command = 'open -a "Cockpit Tools"';
            } else if (platform === 'win32') {
                command = 'start "" "Cockpit Tools"';
            } else {
                command = 'cockpit-tools';
            }

            try {
                const { exec } = await import('child_process');
                exec(command, (error) => {
                    if (error) {
                        logger.warn('[AccountTree] Failed to open Cockpit Tools:', error);
                        vscode.window.showWarningMessage(t('accountTree.cannotOpenCockpitTools'));
                    }
                });
            } catch {
                vscode.window.showWarningMessage(t('accountTree.cannotOpenCockpitTools'));
            }
        }),
    );
}
