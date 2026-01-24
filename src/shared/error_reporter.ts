/**
 * Antigravity Cockpit - Error Reporter (DISABLED)
 * Telemetry has been disabled for the secure fork.
 */

import { logger } from './log_service';

/**
 * 初始化错误上报服务 (No-op)
 */
export function initErrorReporter(_version: string): void {
    logger.info('[ErrorReporter] Telemetry is disabled in this secure fork.');
}

/**
 * 上报错误 (Stub)
 */
export function captureError(error: Error, context?: Record<string, unknown>): void {
    // Log to local console/output channel instead of sending to Sentry
    logger.error(`[ErrorReporter] Captured Stubbed Error: ${error.message}`, context);
}

/**
 * 上报消息 (Stub)
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    logger.info(`[ErrorReporter] Captured Stubbed Message (${level}): ${message}`);
}

/**
 * 刷新待发送的事件 (Stub)
 */
export async function flushEvents(): Promise<void> {
    return Promise.resolve();
}

/**
 * 获取代理配置状态 (Stub)
 */
export function getProxyStatus(): { configured: boolean; type: string } {
    return { configured: false, type: 'none' };
}
