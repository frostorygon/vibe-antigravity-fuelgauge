/**
 * OfflineConfigSyncModule
 * 用于在 WebSocket Offline时，通过共享文件SyncConfig
 * 
 * 设计说明:
 * - Online时: 通过 WebSocket 实时Sync，不写入共享文件
 * - Offline时: 写入共享文件，等对方Start时读取Merge
 * - Start时: 读取共享文件，与LocalConfig比较Time戳后Merge
 * 
 * 可Extension性:
 * - 目前支持 language Config
 * - 可Extension支持 theme、accounts 等其他Config
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../shared/log_service';

/** 共享Config目录 */
const SHARED_DIR = path.join(os.homedir(), '.antigravity_cockpit');

/** SyncConfig文件名 */
const SYNC_SETTINGS_FILE = 'sync_settings.json';

/** Config项类型 */
export type SyncSettingKey = 'language' | 'theme';

/** 单个Config项结构 */
export interface SyncSettingValue {
    value: string;
    updated_at: number;
    updated_by: 'plugin' | 'desktop';
}

/** SyncConfig文件结构 */
export interface SyncSettings {
    language?: SyncSettingValue;
    theme?: SyncSettingValue;
    // 可Extension其他Config项
}

/**
 * GetSyncConfig文件Path
 */
function getSyncSettingsPath(): string {
    return path.join(SHARED_DIR, SYNC_SETTINGS_FILE);
}

/**
 * 确保共享目录存在
 */
function ensureSharedDir(): void {
    if (!fs.existsSync(SHARED_DIR)) {
        fs.mkdirSync(SHARED_DIR, { recursive: true });
    }
}

/**
 * 读取SyncConfig文件
 * @returns SyncConfig，如果文件不存在或损坏则Return空对象
 */
export function readSyncSettings(): SyncSettings {
    try {
        const filePath = getSyncSettingsPath();
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as SyncSettings;
        }
    } catch (error) {
        logger.warn('[SyncSettings] 读取SyncConfigFailed, Return空Config:', error);
    }
    return {};
}

/**
 * 写入单个SyncConfig项
 * 用于Offline时SaveConfig，等对方Start时读取
 * 
 * @param key Config项键名
 * @param value Config项值
 */
export function writeSyncSetting(key: SyncSettingKey, value: string): void {
    try {
        ensureSharedDir();
        
        const settings = readSyncSettings();
        settings[key] = {
            value,
            updated_at: Date.now(),
            updated_by: 'plugin',
        };
        
        const filePath = getSyncSettingsPath();
        fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
        
        logger.info(`[SyncSettings] 写入OfflineConfig: ${key} = ${value}`);
    } catch (error) {
        logger.error('[SyncSettings] 写入SyncConfigFailed:', error);
    }
}

/**
 * 清除单个SyncConfig项
 * 用于已Sync后清理，避免下次重复Sync
 * 
 * @param key Config项键名
 */
export function clearSyncSetting(key: SyncSettingKey): void {
    try {
        const settings = readSyncSettings();
        if (settings[key]) {
            delete settings[key];
            
            const filePath = getSyncSettingsPath();
            fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
            
            logger.info(`[SyncSettings] 清除已SyncConfig: ${key}`);
        }
    } catch (error) {
        logger.error('[SyncSettings] 清除SyncConfigFailed:', error);
    }
}

/**
 * Get单个SyncConfig项
 * 
 * @param key Config项键名
 * @returns Config项值，如果不存在则Return undefined
 */
export function getSyncSetting(key: SyncSettingKey): SyncSettingValue | undefined {
    const settings = readSyncSettings();
    return settings[key];
}

/**
 * 比较并MergeConfig
 * Return是否需要UpdateLocalConfig
 * 
 * @param key Config项键名
 * @param localValue LocalCurrent值
 * @param localUpdatedAt LocalUpdateTime（如果有的话）
 * @returns 如果需要UpdateLocal，Return新值；否则Return undefined
 */
export function mergeSettingOnStartup(
    key: SyncSettingKey,
    localValue: string,
    localUpdatedAt?: number,
): string | undefined {
    const syncSetting = getSyncSetting(key);
    
    if (!syncSetting) {
        // 共享文件没有这个Config，不需要Update
        return undefined;
    }
    
    // 如果共享文件的值和Local相同，不需要Update
    if (syncSetting.value === localValue) {
        // 清除共享文件中的Config（已一致）
        clearSyncSetting(key);
        return undefined;
    }
    
    // 如果共享文件UpdateTime更晚，或者Local没有UpdateTimeRecord，使用共享文件的值
    if (!localUpdatedAt || syncSetting.updated_at > localUpdatedAt) {
        logger.info(`[SyncSettings] MergeConfig ${key}: 共享文件 "${syncSetting.value}" > Local "${localValue}"`);
        // 清除共享文件中的Config（已Merge）
        clearSyncSetting(key);
        return syncSetting.value;
    }
    
    // LocalUpdateTime更晚，不需要UpdateLocal，但也不清除共享文件（对方可能还需要）
    return undefined;
}

// ExportModule
export const syncSettings = {
    read: readSyncSettings,
    write: writeSyncSetting,
    clear: clearSyncSetting,
    get: getSyncSetting,
    merge: mergeSettingOnStartup,
};
