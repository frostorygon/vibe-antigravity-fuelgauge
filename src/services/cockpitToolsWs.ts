/**
 * Cockpit Tools WebSocket Client (STUBBED)
 * 
 * This file has been stubbed to disable communication with the unauthorized 
 * "Cockpit Tools" sidecar binary.
 */

import { EventEmitter } from 'events';
import { logger } from '../shared/log_service';

// Re-export types needed by other consumers
export interface AccountInfo {
    id: string;
    email: string;
    name: string | null;
    is_current: boolean;
    disabled: boolean;
    has_fingerprint: boolean;
    last_used: number;
    subscription_tier?: string | null;
}

export interface AccountTokenInfo extends AccountInfo {
    refresh_token: string;
    access_token: string;
    expires_at: number;
    project_id?: string | null;
}

export interface AccountsResponse {
    accounts: AccountInfo[];
    current_account_id: string | null;
}

export interface AccountsWithTokensResponse {
    accounts: AccountTokenInfo[];
    current_account_id: string | null;
}

class CockpitToolsWsClient extends EventEmitter {
    /**
     * Always disconnected in the secure fork.
     */
    get isConnected(): boolean {
        return false;
    }

    /**
     * Always null.
     */
    get version(): string | null {
        return null;
    }

    connect(): void {
        logger.debug('[WS Stub] Connection disabled by security policy.');
    }

    disconnect(): void {
        // No-op
    }

    send(): boolean {
        return false;
    }

    async getAccounts(): Promise<AccountsResponse> {
        return { accounts: [], current_account_id: null };
    }

    async getAccountsWithTokens(): Promise<AccountsWithTokensResponse> {
        return { accounts: [], current_account_id: null };
    }

    async getCurrentAccount(): Promise<AccountInfo | null> {
        return null;
    }

    requestSwitchAccount(_accountId: string): boolean {
        return false;
    }

    async switchAccount(_accountId: string): Promise<{ success: boolean; message: string }> {
        return { success: false, message: 'Sidecar disabled' };
    }

    notifyDataChanged(_source: string): boolean {
        return false;
    }

    ensureConnected(): boolean {
        return false;
    }

    async addAccount(
        _email: string,
        _refreshToken: string,
        _accessToken?: string,
        _expiresAt?: number,
    ): Promise<{ success: boolean; message: string }> {
        return { success: false, message: 'Sidecar disabled' };
    }

    async deleteAccountByEmail(_email: string): Promise<{ success: boolean; message: string }> {
        return { success: false, message: 'Sidecar disabled' };
    }

    async setLanguage(_language: string, _source = 'extension'): Promise<{ success: boolean; message: string }> {
        return { success: false, message: 'Sidecar disabled' };
    }
}

export const cockpitToolsWs = new CockpitToolsWsClient();
