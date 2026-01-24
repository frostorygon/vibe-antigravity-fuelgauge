/**
 * Antigravity FuelGauge - Error Reporter (DISABLED)
 * Telemetry has been disabled for the secure fork.
 */

import { logger } from './log_service';

/**
 * InitializeError Reporter Service (No-op)
 */
export function initErrorReporter(_version: string): void {
    logger.info('[ErrorReporter] Telemetry is disabled in this secure fork.');
}

/**
 * 上报Error (Stub)
 */
export function captureError(error: Error, context?: Record<string, unknown>): void {
    // Log to local console/output channel instead of sending to Sentry
    logger.error(`[ErrorReporter] Captured Stubbed Error: ${error.message}`, context);
}

/**
 * 上报Message (Stub)
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    logger.info(`[ErrorReporter] Captured Stubbed Message (${level}): ${message}`);
}

/**
 * Refresh待Send的Event (Stub)
 */
export async function flushEvents(): Promise<void> {
    return Promise.resolve();
}

/**
 * Get代理ConfigState (Stub)
 */
export function getProxyStatus(): { configured: boolean; type: string } {
    return { configured: false, type: 'none' };
}
