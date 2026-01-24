import { EventEmitter } from 'events';
import { cockpitToolsWs, AccountTokenInfo } from './cockpitToolsWs';
import { credentialStorage } from '../auto_trigger/credential_storage';
import { oauthService } from '../auto_trigger/oauth_service';
import { logger } from '../shared/log_service';

const SYNC_COOLDOWN_MS = 10000;

let syncInProgress = false;
let lastSyncAt = 0;

export const cockpitToolsSyncEvents = new EventEmitter();

function toUnixSeconds(iso?: string): number | undefined {
    if (!iso) {
        return undefined;
    }
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
        return undefined;
    }
    return Math.floor(ms / 1000);
}

function toIsoFromUnixSeconds(seconds?: number): string {
    if (!seconds || seconds <= 0) {
        return new Date(0).toISOString();
    }
    return new Date(seconds * 1000).toISOString();
}

async function fetchRemoteAccounts(): Promise<AccountTokenInfo[]> {
    const response = await cockpitToolsWs.getAccountsWithTokens();
    return response.accounts ?? [];
}

/**
 * 双向Sync Cockpit Tools Account（仅在 WS Connect正常时Execute）
 */
export async function syncAccountsWithCockpitTools(options?: { force?: boolean; reason?: string }): Promise<void> {
    if (!cockpitToolsWs.isConnected) {
        return;
    }

    const now = Date.now();
    if (syncInProgress) {
        return;
    }
    if (!options?.force && now - lastSyncAt < SYNC_COOLDOWN_MS) {
        return;
    }

    syncInProgress = true;
    lastSyncAt = now;

    try {
        logger.info(`[Sync] Start (reason=${options?.reason ?? 'unknown'})`);
        let remoteAccounts = await fetchRemoteAccounts();
        let remoteEmails = remoteAccounts.map(acc => acc.email);
        let remoteSet = new Set(remoteEmails);

        const previousRemoteEmails = credentialStorage.getToolsAccountSnapshot();
        const previousRemoteSet = new Set(previousRemoteEmails);

        const localCredentials = await credentialStorage.getAllCredentials();
        const localEmails = Object.keys(localCredentials);
        const localSet = new Set(localEmails);

        logger.info(`[Sync] Local=${localEmails.length} Remote=${remoteAccounts.length} PrevRemote=${previousRemoteEmails.length}`);
        let pushedAny = false;
        let localChanged = false;

        // HandleLocal存在但远端不存在的Account
        for (const email of localEmails) {
            if (remoteSet.has(email)) {
                continue;
            }

            // 如果之前远端存在，现在消失，视为远端Delete
            if (previousRemoteSet.has(email)) {
                await credentialStorage.deleteCredentialForAccount(email, true);
                localSet.delete(email);
                localChanged = true;
                logger.info(`[Sync] Local delete (remote removed): ${email}`);
                continue;
            }

            const credential = localCredentials[email];
            if (!credential?.refreshToken || credential.isInvalid) {
                logger.debug(`[Sync] Skip push (missing/invalid token): ${email}`);
                continue;
            }

            const expiresAt = toUnixSeconds(credential.expiresAt);
            const result = await cockpitToolsWs.addAccount(
                email,
                credential.refreshToken,
                credential.accessToken,
                expiresAt,
            );
            if (result.success) {
                pushedAny = true;
                logger.info(`[Sync] Push to Tools: ${email}`);
            } else {
                logger.warn(`[Sync] 推送Account到 Tools Failed: ${email} - ${result.message}`);
            }
        }

        if (pushedAny) {
            remoteAccounts = await fetchRemoteAccounts();
            remoteEmails = remoteAccounts.map(acc => acc.email);
            remoteSet = new Set(remoteEmails);
        }

        // Import远端存在但Local不存在的Account
        for (const account of remoteAccounts) {
            if (localSet.has(account.email)) {
                continue;
            }
            if (!account.refresh_token) {
                logger.info(`[Sync] Skip import (missing refresh_token): ${account.email}`);
                continue;
            }

            const credential = oauthService.buildCredentialFromTokenData({
                email: account.email,
                accessToken: account.access_token || '',
                refreshToken: account.refresh_token,
                expiresAt: toIsoFromUnixSeconds(account.expires_at),
                projectId: account.project_id ?? undefined,
                isInvalid: account.disabled,
            });

            await credentialStorage.saveCredentialForAccount(account.email, credential, { skipNotifyTools: true });
            localSet.add(account.email);
            localChanged = true;
            logger.info(`[Sync] Import from Tools: ${account.email}`);
        }

        await credentialStorage.setToolsAccountSnapshot(remoteEmails);

        if (localChanged) {
            cockpitToolsSyncEvents.emit('localChanged', {
                reason: options?.reason,
            });
            logger.info('[Sync] Local changed, notify webview');
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`[Sync] 双向SyncFailed: ${err.message}`);
        if (err.message.includes('RequestTimeout')) {
            logger.warn('[Sync] 可能是桌面端未升级到支持 accounts_with_tokens 的Version');
        }
    } finally {
        syncInProgress = false;
    }
}
