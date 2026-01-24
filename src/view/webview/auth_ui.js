/**
 * Antigravity FuelGauge - Shared Authentication UI
 * 用于统一 Dashboard 和 Auto Trigger 两个View的AccountAuthorization和SyncConfig UI
 */

(function () {
    'use strict';

    // i18n辅助
    const i18n = window.__i18n || {};
    const t = (key) => i18n[key] || key;

    class AuthenticationUI {
        constructor(vscodeApi) {
            this.vscode = vscodeApi;
            this.state = {
                authorization: null,
                antigravityToolsSyncEnabled: false,
                antigravityToolsAutoSwitchEnabled: true
            };
            this.elements = {};
        }

        updateState(authorization, antigravityToolsSyncEnabled, antigravityToolsAutoSwitchEnabled) {
            this.state.authorization = authorization;
            if (antigravityToolsSyncEnabled !== undefined) {
                this.state.antigravityToolsSyncEnabled = antigravityToolsSyncEnabled;
            }
            if (antigravityToolsAutoSwitchEnabled !== undefined) {
                this.state.antigravityToolsAutoSwitchEnabled = antigravityToolsAutoSwitchEnabled;
            }
        }

        /**
         * RenderAuthorization行 (Auth Row)
         * @param {HTMLElement} container ContainerElement
         * @param {Object} options Config项
         * @param {boolean} options.showSyncToggleInline 是否内联ShowSync开关（否则ShowConfigButton）
         */
        renderAuthRow(container, options = {}) {
            if (!container) return;

            const { authorization, antigravityToolsSyncEnabled } = this.state;
            const accounts = authorization?.accounts || [];
            const hasAccounts = accounts.length > 0;
            const activeAccount = authorization?.activeAccount;
            const activeEmail = activeAccount || (hasAccounts ? accounts[0].email : null);
            const isAuthorized = authorization?.isAuthorized || hasAccounts;

            // Common Buttons - Accounts OverviewButton
            const overviewBtn = `<button class="quota-account-overview-btn" title="${t('accountsOverview.openBtn') || 'Accounts Overview'}">📊 ${t('accountsOverview.openBtn') || 'Accounts Overview'}</button>`;

            // Sync UI Elements
            let syncActionsHtml = '';

            if (options.showSyncToggleInline) {
                // Inline Style (Like Auto Trigger Tab)
                syncActionsHtml = `
                    <label class="antigravityTools-sync-toggle">
                        <input type="checkbox" class="at-sync-checkbox" ${antigravityToolsSyncEnabled ? 'checked' : ''}>
                        <span>${t('autoTrigger.antigravityToolsSync')}</span>
                    </label>
                    <button class="at-btn at-btn-secondary at-import-btn">${t('autoTrigger.importFromAntigravityTools')}</button>
                `;
            } else {
                // Compact Style (Like Dashboard Tab)
                syncActionsHtml = `
                    <button class="at-btn at-btn-primary at-sync-config-btn" title="${t('atSyncConfig.title') || 'AccountSyncConfig'}">
                        ⚙ ${t('atSyncConfig.btnText') || 'AccountSyncConfig'}
                    </button>
                `;
            }

            if (isAuthorized && activeEmail) {
                const extraCount = Math.max(accounts.length - 1, 0);
                const accountCountBadge = extraCount > 0
                    ? `<span class="account-count-badge" title="${t('autoTrigger.manageAccounts')}">+${extraCount}</span>`
                    : '';

                // Switch至Current登录账户Button - 使用和"管理Account"相同的Style
                const switchToClientBtn = `<button class="quota-account-manage-btn at-switch-to-client-btn" title="${t('autoTrigger.switchToClientAccount')}">${t('autoTrigger.switchToClientAccount')}</button>`;

                container.innerHTML = `
                    <div class="quota-auth-info quota-auth-info-clickable" title="${t('autoTrigger.manageAccounts')}">
                        <span class="quota-auth-icon">✅</span>
                        <span class="quota-auth-text">${t('autoTrigger.authorized')}</span>
                        <span class="quota-auth-email">${activeEmail}</span>
                        ${accountCountBadge}
                        ${overviewBtn}
                        ${switchToClientBtn}
                    </div>
                    <div class="quota-auth-actions">
                        ${syncActionsHtml}
                    </div>
                 `;
            } else {
                // Unauthorized
                container.innerHTML = `
                    <div class="quota-auth-info">
                        <span class="quota-auth-icon">⚠️</span>
                        <span class="quota-auth-text">${t('autoTrigger.unauthorized') || 'Unauthorized'}</span>
                    </div>
                    <div class="quota-auth-actions">
                        ${syncActionsHtml}
                        <button class="at-btn at-btn-primary at-authorize-btn">${t('autoTrigger.authorizeBtn') || 'Authorize'}</button>
                    </div>
                `;
            }

            this._bindEvents(container);
        }

        _bindEvents(container) {
            // Bind generic events
            const postMessage = (msg) => this.vscode.postMessage(msg);

            // Manage Accounts / Click Info
            container.querySelector('.quota-auth-info-clickable')?.addEventListener('click', () => {
                this.openAccountManageModal();
            });
            container.querySelector('.quota-account-overview-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.vscode.postMessage({ command: 'executeCommand', commandId: 'agCockpit.openAccountsOverview' });
            });

            // Authorize
            container.querySelector('.at-authorize-btn')?.addEventListener('click', () => {
                this.openLoginChoiceModal();
            });

            // Sync Config (Compact Mode)
            container.querySelector('.at-sync-config-btn')?.addEventListener('click', () => {
                this.openSyncConfigModal();
            });

            // Inline Sync Toggle
            container.querySelector('.at-sync-checkbox')?.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                // Update local state immediately for UI consistency
                this.state.antigravityToolsSyncEnabled = enabled;
                postMessage({ command: 'antigravityToolsSync.toggle', enabled });
            });

            // Inline Import
            container.querySelector('.at-import-btn')?.addEventListener('click', () => {
                postMessage({ command: 'antigravityToolsSync.import' });
            });

            // Switch to Client Account - Switch至Current登录账户
            container.querySelector('.at-switch-to-client-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                postMessage({ command: 'antigravityToolsSync.switchToClient' });
            });

            // Import local credential (moved to sync config modal)
        }

        // ============ Modals ============

        openAccountManageModal() {
            let modal = document.getElementById('account-manage-modal');
            if (!modal) {
                modal = this._createModal('account-manage-modal', `
                    <div class="modal-content account-manage-content">
                        <div class="modal-header">
                            <h3>${t('autoTrigger.manageAccounts') || 'Manage Accounts'}</h3>
                            <button class="close-btn" id="close-account-manage-modal">×</button>
                        </div>
                        <div class="modal-hint" style="padding: 8px 16px; font-size: 12px; color: var(--text-muted); background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);">
                            <span style="margin-right: 12px;">💡 ${t('autoTrigger.manageAccountsHintClick') || '点击Email可Switch查看Quota'}</span>
                            <span>🔄 ${t('autoTrigger.manageAccountsHintSwitch') || '点击"Switch登录"可SwitchClient登录账户'}</span>
                        </div>
                        <div class="modal-body" id="account-manage-body"></div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end;">
                            <button id="add-new-account-btn" class="at-btn at-btn-primary">
                                ➕ ${t('autoTrigger.addAccount') || 'Add Account'}
                            </button>
                        </div>
                    </div>
                `);

                // Bind Modal specific static events (close, add)
                document.getElementById('close-account-manage-modal')?.addEventListener('click', () => modal.classList.add('hidden'));
                document.getElementById('add-new-account-btn')?.addEventListener('click', () => {
                    this.vscode.postMessage({ command: 'autoTrigger.addAccount' });
                });
            }

            this.renderAccountManageList();
            modal.classList.remove('hidden');
        }

        renderAccountManageList() {
            const body = document.getElementById('account-manage-body');
            if (!body) return;

            const accounts = this.state.authorization?.accounts || [];
            const activeAccount = this.state.authorization?.activeAccount;

            if (accounts.length === 0) {
                body.innerHTML = `<div class="account-manage-empty">${t('autoTrigger.noAccounts') || 'No accounts authorized'}</div>`;
                return;
            }

            body.innerHTML = `<div class="account-manage-list">${accounts.map(acc => {
                const isActive = acc.email === activeAccount;
                const isInvalid = acc.isInvalid === true;
                const icon = isInvalid ? '⚠️' : (isActive ? '✅' : '👤');
                const badges = [
                    isActive && !isInvalid ? `<span class="account-manage-badge">${t('autoTrigger.accountActive')}</span>` : '',
                    isInvalid ? `<span class="account-manage-badge expired">${t('autoTrigger.tokenExpired')}</span>` : ''
                ].join('');

                // Switch登录Button（所有Account都Show）
                const switchLoginBtn = `<button class="at-btn at-btn-small at-btn-primary account-switch-login-btn" data-email="${acc.email}">${t('autoTrigger.switchLoginBtn') || 'Switch登录'}</button>`;

                return `
                    <div class="account-manage-item ${isActive ? 'active' : ''} ${isInvalid ? 'expired' : ''}" data-email="${acc.email}">
                        <div class="account-manage-info">
                            <span class="account-manage-icon">${icon}</span>
                            <span class="account-manage-email">${acc.email}</span>
                            ${badges}
                        </div>
                        <div class="account-manage-actions">
                            ${switchLoginBtn}
                            <button class="at-btn at-btn-small at-btn-danger account-remove-btn" data-email="${acc.email}">${t('autoTrigger.deleteBtn') || 'Delete'}</button>
                        </div>
                    </div>
                `;
            }).join('')}</div>`;

            // 绑定点击整行Switch查看Quota
            body.querySelectorAll('.account-manage-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
                    if (item.classList.contains('active')) return;
                    const email = item.dataset.email;
                    if (email) {
                        this.vscode.postMessage({ command: 'autoTrigger.switchAccount', email });
                        document.getElementById('account-manage-modal')?.classList.add('hidden');
                    }
                });
            });

            // 绑定Switch登录Button（需Confirm）
            body.querySelectorAll('.account-switch-login-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const email = btn.dataset.email;
                    if (email) {
                        this.showSwitchLoginConfirmModal(email);
                    }
                })
            );

            // 绑定DeleteButton
            body.querySelectorAll('.account-remove-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (typeof window.openRevokeModalForEmail === 'function') {
                        window.openRevokeModalForEmail(btn.dataset.email);
                    } else {
                        this.vscode.postMessage({ command: 'autoTrigger.removeAccount', email: btn.dataset.email });
                    }
                })
            );
        }

        /**
         * ShowSwitch登录Confirm弹窗
         */
        showSwitchLoginConfirmModal(email) {
            let modal = document.getElementById('switch-login-confirm-modal');
            if (!modal) {
                modal = this._createModal('switch-login-confirm-modal', `
                    <div class="modal-content" style="max-width: 400px;">
                        <div class="modal-header">
                            <h3>${t('autoTrigger.switchLoginTitle') || 'Switch登录账户'}</h3>
                            <button class="close-btn" id="switch-login-confirm-close">×</button>
                        </div>
                        <div class="modal-body" style="padding: 20px;">
                            <p style="margin-bottom: 10px;">${t('autoTrigger.switchLoginConfirmText') || '确定要Switch到以下账户吗？'}</p>
                            <p style="font-weight: bold; color: var(--accent-color); margin-bottom: 15px;" id="switch-login-target-email"></p>
                            <p style="color: var(--warning-color); font-size: 0.9em;">⚠️ ${t('autoTrigger.switchLoginWarning') || '此操作将重启 Antigravity Client以Done账户Switch。'}</p>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end; padding: 15px 20px;">
                            <button class="at-btn at-btn-secondary" id="switch-login-confirm-cancel">${t('common.cancel') || 'Cancel'}</button>
                            <button class="at-btn at-btn-primary" id="switch-login-confirm-ok">${t('common.confirm') || 'Confirm'}</button>
                        </div>
                    </div>
                `);

                document.getElementById('switch-login-confirm-close')?.addEventListener('click', () => modal.classList.add('hidden'));
                document.getElementById('switch-login-confirm-cancel')?.addEventListener('click', () => modal.classList.add('hidden'));
            }

            // Set目标Email
            document.getElementById('switch-login-target-email').textContent = email;

            // 绑定ConfirmButton（替换以避免重复绑定）
            const okBtn = document.getElementById('switch-login-confirm-ok');
            const newOkBtn = okBtn.cloneNode(true);
            okBtn.parentNode.replaceChild(newOkBtn, okBtn);
            newOkBtn.addEventListener('click', () => {
                modal.classList.add('hidden');
                this.vscode.postMessage({ command: 'autoTrigger.switchLoginAccount', email });
                document.getElementById('account-manage-modal')?.classList.add('hidden');
            });

            modal.classList.remove('hidden');
        }

        openSyncConfigModal() {
            let modal = document.getElementById('at-sync-config-modal');
            if (!modal) {
                modal = this._createModal('at-sync-config-modal', `
                    <div class="modal-content at-sync-config-content">
                        <div class="modal-header">
                        <h3>⚙ ${t('atSyncConfig.title') || 'AccountSyncConfig'}</h3>
                            <button class="close-btn" id="close-at-sync-config-modal">×</button>
                        </div>
                        <div class="modal-body at-sync-config-body">
                            <div class="at-sync-section at-sync-info-section">
                                <details class="at-sync-details at-sync-info-details">
                                    <summary class="at-sync-details-summary">
                                        <div class="at-sync-section-title-row">
                                            <div class="at-sync-section-title">ℹ️ ${t('atSyncConfig.featureTitle') || '功能说明'}</div>
                                            <span class="at-sync-details-link">
                                                ${t('atSyncConfig.dataAccessDetails') || 'ExpandDetails说明'}
                                            </span>
                                        </div>
                                        <div class="at-sync-description at-sync-info-summary">${t('atSyncConfig.featureSummary') || '查看Data访问与Sync/Import规则。'}</div>
                                    </summary>
                                    <div class="at-sync-details-body">
                                        <div class="at-sync-info-block">
                                            <div class="at-sync-info-subtitle">🛡️ ${t('atSyncConfig.dataAccessTitle') || 'Data访问说明'}</div>
                                            <div class="at-sync-description">${t('atSyncConfig.dataAccessDesc') || '本功能会读取您Local Antigravity Tools 与 Antigravity Client的账户Info，仅用于本PluginAuthorization/Switch。'}</div>
                                            <div class="at-sync-path-info">
                                                <span class="at-sync-path-label">${t('atSyncConfig.readPathTools') || 'Antigravity Tools Path'}:</span>
                                                <code class="at-sync-path">~/.antigravity_tools/</code>
                                            </div>
                                            <div class="at-sync-path-info">
                                                <span class="at-sync-path-label">${t('atSyncConfig.readPathLocal') || 'Antigravity ClientPath'}:</span>
                                                <code class="at-sync-path">.../Antigravity/User/globalStorage/state.vscdb</code>
                                            </div>
                                            <div class="at-sync-data-list">
                                                <span class="at-sync-data-label">${t('atSyncConfig.readData') || '读取Content'}:</span>
                                                <span class="at-sync-data-items">${t('atSyncConfig.readDataItems') || '账户Email、Refresh Token（Local读取）'}</span>
                                            </div>
                                        </div>
                                        <div class="at-sync-info-block">
                                            <div class="at-sync-info-line">
                                                <span class="at-sync-info-label">${t('atSyncConfig.autoSyncTitle') || '自动Sync'}：</span>
                                                <span class="at-sync-info-text">${t('atSyncConfig.autoSyncDesc') || 'Enable后检测到 Antigravity Tools 新Account时自动Import。'}</span>
                                            </div>
                                            <div class="at-sync-info-line">
                                                <span class="at-sync-info-label">${t('atSyncConfig.manualImportTitle') || '手动Import'}：</span>
                                                <span class="at-sync-info-text">${t('atSyncConfig.manualImportDesc') || '分别ImportLocal账户或 Antigravity Tools 账户，仅Execute一次。'}</span>
                                            </div>
                                        </div>
                                    </div>
                                </details>
                        </div>
                        <div class="at-sync-section">
                            <div class="at-sync-toggle-grid">
                                <div class="at-sync-toggle-card">
                                    <label class="at-sync-toggle-label">
                                        <input type="checkbox" id="at-sync-modal-checkbox">
                                        <span>${t('atSyncConfig.enableAutoSync') || '自动SyncAntigravity Tools账户'}</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                            <div class="at-sync-section">
                                <div class="at-sync-section-title">📥 ${t('atSyncConfig.manualImportTitle') || '手动Import'}</div>
                                <div class="at-sync-import-actions">
                                    <button id="at-sync-modal-import-local-btn" class="at-btn at-btn-primary at-sync-import-btn">${t('atSyncConfig.importLocal') || 'ImportLocal账户'}</button>
                                    <button id="at-sync-modal-import-tools-btn" class="at-btn at-btn-primary at-sync-import-btn">${t('atSyncConfig.importTools') || 'Import Antigravity Tools 账户'}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                `);
                document.getElementById('close-at-sync-config-modal')?.addEventListener('click', () => modal.classList.add('hidden'));

                modal.querySelector('#at-sync-modal-checkbox')?.addEventListener('change', (e) => {
                    this.state.antigravityToolsSyncEnabled = e.target.checked;
                    this.vscode.postMessage({ command: 'antigravityToolsSync.toggle', enabled: e.target.checked });
                });
                modal.querySelector('#at-sync-modal-import-local-btn')?.addEventListener('click', () => {
                    if (typeof window.showLocalAuthImportLoading === 'function') {
                        window.showLocalAuthImportLoading();
                    }
                    this.vscode.postMessage({ command: 'autoTrigger.importLocal' });
                    modal.classList.add('hidden');
                });
                modal.querySelector('#at-sync-modal-import-tools-btn')?.addEventListener('click', () => {
                    this.vscode.postMessage({ command: 'antigravityToolsSync.import' });
                    modal.classList.add('hidden');
                });
            }

            const checkbox = modal.querySelector('#at-sync-modal-checkbox');
            if (checkbox) checkbox.checked = this.state.antigravityToolsSyncEnabled;
            modal.querySelectorAll('.at-sync-details').forEach((detail) => {
                detail.removeAttribute('open');
            });

            modal.classList.remove('hidden');
        }

        openLoginChoiceModal() {
            let modal = document.getElementById('auth-choice-modal');
            if (!modal) {
                modal = this._createModal('auth-choice-modal', `
                    <div class="modal-content auth-choice-content">
                        <div class="modal-header">
                            <h3>${t('authChoice.title') || 'Select登录方式'}</h3>
                            <button class="close-btn" id="close-auth-choice-modal">×</button>
                        </div>
                        <div class="modal-body auth-choice-body">
                            <div class="auth-choice-info">
                                <div class="auth-choice-desc">${t('authChoice.desc') || '请Select读取Local已AuthorizationAccount或Authorization登录。'}</div>
                                <div class="auth-choice-tip">${t('authChoice.tip') || 'Authorization登录适用于无Client；Local读取仅对Current机器生效。'}</div>
                            </div>
                            <div class="auth-choice-grid">
                                <div class="auth-choice-card">
                                    <div class="auth-choice-header">
                                        <span class="auth-choice-icon">🖥️</span>
                                        <div>
                                            <div class="auth-choice-title">${t('authChoice.localTitle') || '读取Local已AuthorizationAccount'}</div>
                                            <div class="auth-choice-text">${t('authChoice.localDesc') || '读取本机 Antigravity Client已AuthorizationAccount，不Reauthorize，仅复用现有Authorization。'}</div>
                                        </div>
                                    </div>
                                    <button id="auth-choice-local-btn" class="at-btn at-btn-primary auth-choice-btn">
                                        ${t('authChoice.localBtn') || '读取LocalAuthorization'}
                                    </button>
                                </div>
                                <div class="auth-choice-card">
                                    <div class="auth-choice-header">
                                        <span class="auth-choice-icon">🔐</span>
                                        <div>
                                            <div class="auth-choice-title">${t('authChoice.oauthTitle') || 'Authorization登录（云端Authorization）'}</div>
                                            <div class="auth-choice-text">${t('authChoice.oauthDesc') || '通过 Google OAuth 新Authorization，适用于无Client场景，可撤销。'}</div>
                                        </div>
                                    </div>
                                    <button id="auth-choice-oauth-btn" class="at-btn at-btn-primary auth-choice-btn">
                                        ${t('authChoice.oauthBtn') || '去Authorization登录'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `);
                document.getElementById('close-auth-choice-modal')?.addEventListener('click', () => modal.classList.add('hidden'));
                modal.querySelector('#auth-choice-oauth-btn')?.addEventListener('click', () => {
                    this.vscode.postMessage({ command: 'autoTrigger.authorize' });
                    modal.classList.add('hidden');
                });
                modal.querySelector('#auth-choice-local-btn')?.addEventListener('click', () => {
                    if (typeof window.showLocalAuthImportLoading === 'function') {
                        window.showLocalAuthImportLoading();
                    }
                    this.vscode.postMessage({ command: 'autoTrigger.importLocal' });
                    modal.classList.add('hidden');
                });
            }

            modal.classList.remove('hidden');
        }

        _createModal(id, html) {
            const modal = document.createElement('div');
            modal.id = id;
            modal.className = 'modal hidden';
            modal.innerHTML = html;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
            return modal;
        }
    }

    // Export to window
    window.AntigravityAuthUI = AuthenticationUI;

})();
