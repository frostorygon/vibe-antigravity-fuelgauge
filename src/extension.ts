/**
 * Antigravity FuelGauge - Extension Entry Point
 * Main entry point for the VS Code extension
 */

import * as vscode from 'vscode';
import { ProcessHunter } from './engine/hunter';
import { ReactorCore } from './engine/reactor';
import { logger } from './shared/log_service';
import { configService, CockpitConfig } from './shared/config_service';
import { t, i18n, normalizeLocaleInput } from './shared/i18n';
import { CockpitHUD } from './view/hud';
import { QuickPickView } from './view/quickpick_view';
import { AccountsOverviewWebview } from './view/accountsOverviewWebview';
import { initErrorReporter, captureError, flushEvents } from './shared/error_reporter';
import { AccountsRefreshService } from './services/accountsRefreshService';

// Controllers
import { StatusBarController } from './controller/status_bar_controller';
import { CommandController } from './controller/command_controller';
import { MessageController } from './controller/message_controller';
import { TelemetryController } from './controller/telemetry_controller';
import { autoTriggerController } from './auto_trigger/controller';
import { credentialStorage } from './auto_trigger';
import { announcementService } from './announcement';

// Account Tree View
import { AccountTreeProvider, registerAccountTreeCommands } from './view/accountTree';

// WebSocket Client
import { cockpitToolsWs } from './services/cockpitToolsWs';
import { cockpitToolsSyncEvents } from './services/cockpitToolsSync';

// Global module instances
let hunter: ProcessHunter;
let reactor: ReactorCore;
let hud: CockpitHUD;
let accountsOverview: AccountsOverviewWebview;
let quickPickView: QuickPickView;
let accountsRefreshService: AccountsRefreshService;

// Controllers
let statusBar: StatusBarController;
let _commandController: CommandController;
let _messageController: MessageController;
let _telemetryController: TelemetryController;

let systemOnline = false;
let lastQuotaSource: 'local' | 'authorized';

// Auto-retry counter
let autoRetryCount = 0;
const MAX_AUTO_RETRY = 3;
const AUTO_RETRY_DELAY_MS = 5000;

/**
 * Extension activation entry
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Initialize logger
    logger.init();
    await configService.initialize(context);

    // Apply saved language settings
    const savedLanguage = configService.getConfig().language;
    if (savedLanguage) {
        i18n.applyLanguageSetting(savedLanguage);
    }

    // Startup sync: Read shared config file and merge based on timestamp comparison
    try {
        const { mergeSettingOnStartup } = await import('./services/syncSettings');
        const mergedLanguage = mergeSettingOnStartup('language', savedLanguage || 'auto');
        if (mergedLanguage) {
            logger.info(`[SyncSettings] Merged language setting on startup: ${savedLanguage} -> ${mergedLanguage}`);
            await configService.updateConfig('language', mergedLanguage);
            i18n.applyLanguageSetting(mergedLanguage);
        }
    } catch (err) {
        logger.debug(`[SyncSettings] Startup sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Get extension version
    const packageJson = await import('../package.json');
    const version = packageJson.version || 'unknown';

    // Initialize error reporter (after logger, before other modules)
    initErrorReporter(version);

    logger.info(`Antigravity FuelGauge v${version} - Systems Online`);

    // Initialize core modules
    hunter = new ProcessHunter();
    reactor = new ReactorCore();
    accountsRefreshService = new AccountsRefreshService(reactor);
    hud = new CockpitHUD(context.extensionUri, context);
    accountsOverview = new AccountsOverviewWebview(context.extensionUri, context, reactor, accountsRefreshService);
    quickPickView = new QuickPickView();
    lastQuotaSource = configService.getConfig().quotaSource === 'authorized' ? 'authorized' : 'local';

    // Set accounts overview close callback
    // Note: No longer auto-reopening Dashboard, keeping users last view state
    accountsOverview.onClose(() => {
        // When user manually closes panel, no longer auto-open Dashboard
        // Next time user clicks status bar, view opens based on saved state
        logger.info('[AccountsOverview] Panel closed');
    });

    // Register accounts overview command
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.openAccountsOverview', async () => {
            // Save view state: user selected accounts overview
            await configService.setStateValue('lastActiveView', 'accountsOverview');
            // Close Dashboard first
            hud.dispose();
            // Open accounts overview
            await accountsOverview.show();
        }),
    );

    // Register command to return from accounts overview to Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('agCockpit.backToDashboard', async () => {
            // Save view state: user selected return to Dashboard
            await configService.setStateValue('lastActiveView', 'dashboard');
            accountsOverview.dispose();
            // Open Dashboard (use forceView to ensure Dashboard opens instead of state-based)
            setTimeout(() => {
                vscode.commands.executeCommand('agCockpit.open', { forceView: 'dashboard' });
            }, 100);
        }),
    );

    // Register Webview Panel Serializer to restore panel reference after reload
    context.subscriptions.push(hud.registerSerializer());

    // Set QuickPick refresh callback
    quickPickView.onRefresh(() => {
        reactor.syncTelemetry();
    });

    // Initialize status bar controller
    statusBar = new StatusBarController(context);

    // Define retry/boot callback
    const onRetry = async () => {
        systemOnline = false;
        await bootSystems();
    };

    // Initialize other controllers
    _telemetryController = new TelemetryController(reactor, statusBar, hud, quickPickView, onRetry);
    _messageController = new MessageController(context, hud, reactor, onRetry);
    _commandController = new CommandController(context, hud, quickPickView, accountsOverview, reactor, onRetry);

    // Initialize auto-trigger controller
    autoTriggerController.initialize(context);

    // Auto-sync to client current account on startup
    // Must wait for sync to complete to avoid race conditions
    try {
        const syncResult = await autoTriggerController.syncToClientAccountOnStartup();
        if (syncResult === 'switched') {
            logger.info('[Startup] Auto-switched to client account');
        }
    } catch (err) {
        logger.debug(`[Startup] Account sync skipped: ${err instanceof Error ? err.message : err}`);
    }

    // Initialize announcement service
    announcementService.initialize(context);

    // Initialize Account Tree View
    const accountTreeProvider = new AccountTreeProvider(accountsRefreshService);
    const accountTreeView = vscode.window.createTreeView('agCockpit.accountTree', {
        treeDataProvider: accountTreeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(accountTreeView);
    context.subscriptions.push({ dispose: () => accountsRefreshService.dispose() });
    registerAccountTreeCommands(context, accountTreeProvider);

    // Connect to Cockpit Tools WebSocket
    cockpitToolsWs.connect();

    cockpitToolsSyncEvents.on('localChanged', () => {
        logger.info('[Sync] Webview refreshAccounts');
        hud.sendMessage({ type: 'refreshAccounts' });
    });
    
    // Refresh account tree after WebSocket connection
    cockpitToolsWs.on('connected', () => {
        logger.info('[WS] Connected, refreshing account list');
        void accountsRefreshService.refresh({ reason: 'ws.connected' });
    });
    
    // Listen for data change events
    cockpitToolsWs.on('dataChanged', async (payload: { source?: string }) => {
        const source = payload?.source ?? 'unknown';
        logger.info('[WS] Received data change notification, starting sync');
        await accountsRefreshService.refresh({ forceSync: true, reason: `dataChanged:${source}` });
        // Notify Webview to refresh account data
        hud.sendMessage({ type: 'refreshAccounts' });
    });
    
    cockpitToolsWs.on('accountSwitched', async (payload: { email: string }) => {
        logger.info(`[WS] Account switched: ${payload.email}`);
        
        // Sync local Active Account state, skip notifying Tools
        await credentialStorage.setActiveAccount(payload.email, true);

        await accountsRefreshService.refresh({ reason: 'ws.accountSwitched' });
        // Notify Webview to refresh
        hud.sendMessage({ type: 'accountSwitched', email: payload.email });
        vscode.window.showInformationMessage(t('ws.accountSwitched', { email: payload.email }));
    });
    
    cockpitToolsWs.on('switchError', (payload: { message: string }) => {
        vscode.window.showErrorMessage(t('ws.switchFailed', { message: payload.message }));
    });

    cockpitToolsWs.on('languageChanged', async (payload: { language: string; source?: string }) => {
        const language = payload?.language;
        if (!language) {
            return;
        }
        if (payload?.source === 'extension') {
            return;
        }
        const normalizedLanguage = normalizeLocaleInput(language);
        const currentLanguage = normalizeLocaleInput(configService.getConfig().language);
        if (currentLanguage === normalizedLanguage) {
            return;
        }

        logger.info(`[WS] Language synced: ${normalizedLanguage}`);
        await configService.updateConfig('language', normalizedLanguage);
        const localeChanged = i18n.applyLanguageSetting(normalizedLanguage);
        if (localeChanged) {
            hud.dispose();
            setTimeout(() => {
                vscode.commands.executeCommand('agCockpit.open');
            }, 100);
        }
    });

    cockpitToolsWs.on('wakeupOverride', async (payload: { enabled: boolean }) => {
        if (!payload?.enabled) {
            return;
        }
        try {
            const state = await autoTriggerController.getState();
            await autoTriggerController.saveSchedule({
                ...state.schedule,
                enabled: false,
                wakeOnReset: false,
            });
            vscode.window.showInformationMessage(t('ws.wakeupOverride'));
        } catch (err) {
            logger.warn(`[WS] Failed to disable extension wakeup: ${err instanceof Error ? err.message : String(err)}`);
        }
    });

    // Listen for config changes
    context.subscriptions.push(
        configService.onConfigChange(handleConfigChange),
    );

    // Boot systems
    await bootSystems();

    logger.info('Antigravity FuelGauge Fully Operational');
}

/**
 * Handle config change
 */
async function handleConfigChange(config: CockpitConfig): Promise<void> {
    logger.debug('Configuration changed', config);

    const currentQuotaSource = config.quotaSource === 'authorized' ? 'authorized' : 'local';
    const quotaSourceChanged = currentQuotaSource !== lastQuotaSource;
    if (quotaSourceChanged) {
        logger.info(`Quota source changed: ${lastQuotaSource} -> ${currentQuotaSource}, skipping reprocess`);
        lastQuotaSource = currentQuotaSource;
    }

    // Restart Reactor only when refresh interval changes
    const newInterval = configService.getRefreshIntervalMs();

    // Ignore if Reactor is running and interval unchanged
    if (systemOnline && reactor.currentInterval !== newInterval) {
        logger.info(`Refresh interval changed from ${reactor.currentInterval}ms to ${newInterval}ms. Restarting Reactor.`);
        reactor.startReactor(newInterval);
    }

    // For any config change, immediately reprocess recent data to update UI (e.g., status bar format)
    // This ensures data in lastSnapshot is re-rendered with new config
    if (!quotaSourceChanged) {
        reactor.reprocess();
    }
}

/**
 * Boot systems
 */
async function bootSystems(): Promise<void> {
    if (systemOnline) {
        return;
    }

    const quotaSource = configService.getConfig().quotaSource;
    if (quotaSource === 'authorized') {
        logger.info('Authorized quota source active, starting reactor with background local scan');
        reactor.startReactor(configService.getRefreshIntervalMs());
        systemOnline = true;
        autoRetryCount = 0;
        statusBar.setLoading();
        hunter.scanEnvironment(1)
            .then(info => {
                if (info) {
                    reactor.engage(info.connectPort, info.csrfToken, hunter.getLastDiagnostics());
                    logger.info('Local Antigravity connection detected in authorized mode');
                }
            })
            .catch(err => {
                const error = err instanceof Error ? err : new Error(String(err));
                logger.debug(`Background local scan skipped: ${error.message}`);
            });
        return;
    }

    statusBar.setLoading();

    try {
        const info = await hunter.scanEnvironment(3);

        if (info) {
            reactor.engage(info.connectPort, info.csrfToken, hunter.getLastDiagnostics());
            reactor.startReactor(configService.getRefreshIntervalMs());
            systemOnline = true;
            autoRetryCount = 0; // Reset counter
            statusBar.setReady();
            logger.info('System boot successful');
        } else {
            // Auto-retry mechanism
            if (autoRetryCount < MAX_AUTO_RETRY) {
                autoRetryCount++;
                logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
                statusBar.setLoading(`(${autoRetryCount}/${MAX_AUTO_RETRY})`);

                setTimeout(() => {
                    bootSystems();
                }, AUTO_RETRY_DELAY_MS);
            } else {
                autoRetryCount = 0; // Reset counter
                handleOfflineState();
            }
        }
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error('Boot Error', error);
        captureError(error, {
            phase: 'boot',
            retryCount: autoRetryCount,
            maxRetries: MAX_AUTO_RETRY,
            retryDelayMs: AUTO_RETRY_DELAY_MS,
            refreshIntervalMs: configService.getRefreshIntervalMs(),
            scan: hunter.getLastDiagnostics(),
        });

        // Auto-retry mechanism（异常情况也自动Retry）
        if (autoRetryCount < MAX_AUTO_RETRY) {
            autoRetryCount++;
            logger.info(`Auto-retry ${autoRetryCount}/${MAX_AUTO_RETRY} after error in ${AUTO_RETRY_DELAY_MS / 1000}s...`);
            statusBar.setLoading(`(${autoRetryCount}/${MAX_AUTO_RETRY})`);

            setTimeout(() => {
                bootSystems();
            }, AUTO_RETRY_DELAY_MS);
        } else {
            autoRetryCount = 0; // Reset counter
            statusBar.setError(error.message);

            // Show system dialog
            vscode.window.showErrorMessage(
                `${t('notify.bootFailed')}: ${error.message}`,
                t('help.retry'),
                t('help.openLogs'),
            ).then(selection => {
                if (selection === t('help.retry')) {
                    vscode.commands.executeCommand('agCockpit.retry');
                } else if (selection === t('help.openLogs')) {
                    logger.show();
                }
            });
        }
    }
}

/**
 * Handle offline state
 */
function handleOfflineState(): void {
    if (configService.getConfig().quotaSource === 'authorized') {
        logger.info('Skipping local offline state due to authorized quota source');
        return;
    }
    statusBar.setOffline();

    // Show message with action buttons
    vscode.window.showErrorMessage(
        t('notify.offline'),
        t('help.retry'),
        t('help.openLogs'),
    ).then(selection => {
        if (selection === t('help.retry')) {
            vscode.commands.executeCommand('agCockpit.retry');
        } else if (selection === t('help.openLogs')) {
            logger.show();
        }
    });

    // Update Dashboard to show offline state
    hud.refreshView(ReactorCore.createOfflineSnapshot(t('notify.offline')), {
        showPromptCredits: false,
        pinnedModels: [],
        modelOrder: [],
        groupingEnabled: false,
        groupCustomNames: {},
        groupingShowInStatusBar: false,
        pinnedGroups: [],
        groupOrder: [],
        refreshInterval: 120,
        notificationEnabled: false,
        language: configService.getConfig().language,
        quotaSource: 'local', // Must pass quotaSource, otherwise frontend switch logic cannot complete
    });
}

/**
 * Extension deactivation
 */
export async function deactivate(): Promise<void> {
    logger.info('Antigravity FuelGauge: Shutting down...');

    // Disconnect WebSocket
    cockpitToolsWs.disconnect();

    // Flush pending error events
    await flushEvents();

    reactor?.shutdown();
    hud?.dispose();
    logger.dispose();
}
