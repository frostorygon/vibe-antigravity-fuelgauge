/**
 * Antigravity FuelGauge - Credential Storage
 * OAuth Credentials的安全StorageService
 * 使用 VS Code 的 SecretStorage API 安全Storage敏感Info
 * 
 * Supports multiple accounts with active account selection
 */

import * as vscode from 'vscode';
import { OAuthCredential, AuthorizationStatus, AccountInfo } from './types';
import { logger } from '../shared/log_service';

// Multi-account storage keys
const CREDENTIALS_KEY = 'antigravity.autoTrigger.credentials';
const ACTIVE_ACCOUNT_KEY = 'antigravity.autoTrigger.activeAccount';
const TOOLS_ACCOUNT_SNAPSHOT_KEY = 'antigravity.autoTrigger.toolsAccountSnapshot';

/**
 * Multi-account credentials storage format
 */
interface CredentialsStorage {
    accounts: Record<string, OAuthCredential>;
}

/**
 * Credential StorageService
 * 单例模式，通过 initialize() Initialize
 * Supports multiple accounts
 */
class CredentialStorage {
    private secretStorage?: vscode.SecretStorage;
    private globalState?: vscode.Memento;
    private initialized = false;

    /**
     * InitializeStorageService
     * @param context VS Code Extension上下文
     */
    initialize(context: vscode.ExtensionContext): void {
        this.secretStorage = context.secrets;
        this.globalState = context.globalState;
        this.initialized = true;
        logger.info('[CredentialStorage] Initialized (Secure Mode)');
    }

    /**
     * Check是否已Initialize
     */
    private ensureInitialized(): void {
        if (!this.initialized || !this.secretStorage || !this.globalState) {
            throw new Error('CredentialStorage not initialized. Call initialize() first.');
        }
    }

    // ============ Multi-Account Methods ============

    /**
     * Get all credentials storage
     */
    private async getCredentialsStorage(): Promise<CredentialsStorage> {
        this.ensureInitialized();
        try {
            const json = await this.secretStorage!.get(CREDENTIALS_KEY);
            if (!json) {
                return { accounts: {} };
            }
            return JSON.parse(json) as CredentialsStorage;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[CredentialStorage] Failed to get credentials storage: ${err.message}`);
            return { accounts: {} };
        }
    }

    /**
     * Save all credentials storage
     */
    private async saveCredentialsStorage(
        storage: CredentialsStorage
    ): Promise<void> {
        this.ensureInitialized();
        try {
            const json = JSON.stringify(storage);
            await this.secretStorage!.store(CREDENTIALS_KEY, json);
            logger.info('[CredentialStorage] Credentials storage saved');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[CredentialStorage] Failed to save credentials storage: ${err.message}`);
            throw err;
        }
    }

    /**
     * Check if an account with given email already exists
     */
    async hasAccount(email: string): Promise<boolean> {
        const storage = await this.getCredentialsStorage();
        return email in storage.accounts;
    }

    /**
     * Save credential for a specific account
     * @returns 'added' if new account, 'duplicate' if already exists
     */
    async saveCredentialForAccount(
        email: string,
        credential: OAuthCredential
    ): Promise<'added' | 'duplicate'> {
        const storage = await this.getCredentialsStorage();

        // Check for duplicate
        if (email in storage.accounts) {
            logger.warn(`[CredentialStorage] Account ${email} already exists, skipping`);
            return 'duplicate';
        }

        // Add new account
        storage.accounts[email] = credential;
        await this.saveCredentialsStorage(storage);

        // Set as active if it's the first account
        const accountCount = Object.keys(storage.accounts).length;
        if (accountCount === 1) {
            await this.setActiveAccount(email);
        }

        logger.info(`[CredentialStorage] Account ${email} added successfully`);
        return 'added';
    }

    /**
     * Get credential for a specific account
     */
    async getCredentialForAccount(email: string): Promise<OAuthCredential | null> {
        const storage = await this.getCredentialsStorage();
        return storage.accounts[email] || null;
    }

    /**
     * Get all credentials
     */
    async getAllCredentials(): Promise<Record<string, OAuthCredential>> {
        const storage = await this.getCredentialsStorage();
        return storage.accounts;
    }

    /**
     * Delete credential for a specific account
     */
    async deleteCredentialForAccount(email: string): Promise<void> {
        const storage = await this.getCredentialsStorage();

        if (!(email in storage.accounts)) {
            logger.warn(`[CredentialStorage] Account ${email} not found`);
            return;
        }

        delete storage.accounts[email];
        await this.saveCredentialsStorage(storage);

        // If deleted account was active, set another as active
        const activeAccount = await this.getActiveAccount();
        if (activeAccount === email) {
            const remainingEmails = Object.keys(storage.accounts);
            if (remainingEmails.length > 0) {
                await this.setActiveAccount(remainingEmails[0]);
            } else {
                await this.setActiveAccount(null);
            }
        }

        logger.info(`[CredentialStorage] Account ${email} deleted`);
    }

    /**
     * 与RemoteAccountListSync（DeleteLocal多余的Account）
     */
    async syncWithRemoteAccountList(remoteEmails: string[]): Promise<void> {
        const storage = await this.getCredentialsStorage();
        const localEmails = Object.keys(storage.accounts);
        const remoteEmailSet = new Set(remoteEmails);

        let changed = false;

        for (const email of localEmails) {
            if (!remoteEmailSet.has(email)) {
                logger.info(`[CredentialStorage] Syncing: Account ${email} not found in remote, deleting locally`);
                await this.deleteCredentialForAccount(email);
                changed = true;
            }
        }

        if (changed) {
            logger.info('[CredentialStorage] Synced with remote account list');
        }
    }

    /**
     * Mark an account as invalid (refresh token failed)
     */
    async markAccountInvalid(email: string, invalid: boolean = true): Promise<void> {
        const storage = await this.getCredentialsStorage();

        if (!(email in storage.accounts)) {
            logger.warn(`[CredentialStorage] Account ${email} not found for marking invalid`);
            return;
        }

        storage.accounts[email].isInvalid = invalid;
        await this.saveCredentialsStorage(storage);

        logger.info(`[CredentialStorage] Account ${email} marked as ${invalid ? 'invalid' : 'valid'}`);
    }

    /**
     * Clear invalid status when re-authorization succeeds
     */
    async clearAccountInvalid(email: string): Promise<void> {
        await this.markAccountInvalid(email, false);
    }

    /**
     * Get Cockpit Tools Account快照（用于Sync判定）
     */
    getToolsAccountSnapshot(): string[] {
        this.ensureInitialized();
        return this.globalState!.get<string[]>(TOOLS_ACCOUNT_SNAPSHOT_KEY, []);
    }

    /**
     * Save Cockpit Tools Account快照
     */
    async setToolsAccountSnapshot(emails: string[]): Promise<void> {
        this.ensureInitialized();
        const unique = Array.from(new Set(emails));
        await this.globalState!.update(TOOLS_ACCOUNT_SNAPSHOT_KEY, unique);
    }

    /**
     * Set the active account
     */
    async setActiveAccount(email: string | null): Promise<void> {
        this.ensureInitialized();
        await this.globalState!.update(ACTIVE_ACCOUNT_KEY, email);
        logger.info(`[CredentialStorage] Active account set to: ${email || 'none'}`);
    }

    /**
     * Get the active account email
     */
    async getActiveAccount(): Promise<string | null> {
        this.ensureInitialized();
        return this.globalState!.get<string | null>(ACTIVE_ACCOUNT_KEY, null);
    }

    /**
     * Get all account info for UI display
     */
    async getAccountInfoList(): Promise<AccountInfo[]> {
        const storage = await this.getCredentialsStorage();
        const activeAccount = await this.getActiveAccount();

        return Object.entries(storage.accounts).map(([email, credential]) => ({
            email,
            isActive: email === activeAccount,
            expiresAt: credential.expiresAt,
            isInvalid: credential.isInvalid,
        }));
    }

    // ============ Legacy Compatibility Methods (Deprecated but kept for interface/migration safety) ============

    /**
     * Save OAuth Credentials (Legacy - saves to active account or first account)
     * @deprecated Use saveCredentialForAccount instead
     */
    async saveCredential(credential: OAuthCredential): Promise<void> {
        if (!credential.email) {
            throw new Error('Credential must have an email');
        }

        const storage = await this.getCredentialsStorage();
        storage.accounts[credential.email] = credential;
        await this.saveCredentialsStorage(storage);

        // Set as active if no active account
        const activeAccount = await this.getActiveAccount();
        if (!activeAccount) {
            await this.setActiveAccount(credential.email);
        }

        logger.info(`[CredentialStorage] Credential saved for ${credential.email}`);
    }

    /**
     * Get OAuth Credentials (Returns active account's credential)
     */
    async getCredential(): Promise<OAuthCredential | null> {
        const activeAccount = await this.getActiveAccount();
        if (!activeAccount) {
            // Check if there are any accounts
            const storage = await this.getCredentialsStorage();
            const emails = Object.keys(storage.accounts);
            if (emails.length > 0) {
                // Auto-set first account as active
                await this.setActiveAccount(emails[0]);
                return storage.accounts[emails[0]];
            }
            return null;
        }

        return await this.getCredentialForAccount(activeAccount);
    }

    /**
     * Delete OAuth Credentials (Deletes all accounts)
     */
    async deleteCredential(): Promise<void> {
        this.ensureInitialized();
        try {
            await this.secretStorage!.delete(CREDENTIALS_KEY);
            await this.setActiveAccount(null);
            logger.info('[CredentialStorage] All credentials deleted');
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(`[CredentialStorage] Failed to delete credentials: ${err.message}`);
            throw err;
        }
    }

    /**
     * Check是否有ValidCredentials
     */
    async hasValidCredential(): Promise<boolean> {
        const credential = await this.getCredential();
        if (!credential) {
            return false;
        }

        // Check是否有 refresh_token（有 refresh_token 就可以Refresh access_token）
        if (!credential.refreshToken) {
            return false;
        }

        return true;
    }

    /**
     * GetAuthorizationState (includes all accounts)
     */
    async getAuthorizationStatus(): Promise<AuthorizationStatus> {
        const credential = await this.getCredential();
        const accounts = await this.getAccountInfoList();
        const activeAccount = await this.getActiveAccount();

        if (!credential || !credential.refreshToken) {
            return {
                isAuthorized: false,
                accounts,
                activeAccount: activeAccount || undefined,
            };
        }

        return {
            isAuthorized: true,
            email: credential.email,
            expiresAt: credential.expiresAt,
            accounts,
            activeAccount: activeAccount || undefined,
        };
    }

    /**
     * Update access_token（Refresh后调用）
     */
    async updateAccessToken(accessToken: string, expiresAt: string): Promise<void> {
        const activeAccount = await this.getActiveAccount();
        if (!activeAccount) {
            throw new Error('No active account to update');
        }

        const credential = await this.getCredentialForAccount(activeAccount);
        if (!credential) {
            throw new Error('No credential to update');
        }

        credential.accessToken = accessToken;
        credential.expiresAt = expiresAt;

        const storage = await this.getCredentialsStorage();
        storage.accounts[activeAccount] = credential;
        await this.saveCredentialsStorage(storage);

        logger.info(`[CredentialStorage] Access token updated for ${activeAccount}`);
    }

    /**
     * Update指定Account的 access_token（多Account）
     */
    async updateAccessTokenForAccount(email: string, accessToken: string, expiresAt: string): Promise<void> {
        const credential = await this.getCredentialForAccount(email);
        if (!credential) {
            throw new Error(`No credential to update for ${email}`);
        }

        credential.accessToken = accessToken;
        credential.expiresAt = expiresAt;

        const storage = await this.getCredentialsStorage();
        storage.accounts[email] = credential;
        await this.saveCredentialsStorage(storage);

        logger.info(`[CredentialStorage] Access token updated for ${email}`);
    }

    /**
     * Update指定Account的 projectId
     */
    async updateProjectIdForAccount(email: string, projectId: string): Promise<void> {
        const credential = await this.getCredentialForAccount(email);
        if (!credential) {
            throw new Error(`No credential to update for ${email}`);
        }

        credential.projectId = projectId;
        const storage = await this.getCredentialsStorage();
        storage.accounts[email] = credential;
        await this.saveCredentialsStorage(storage);

        logger.info(`[CredentialStorage] Project ID updated for ${email}`);
    }
}

export const credentialStorage = new CredentialStorage();
