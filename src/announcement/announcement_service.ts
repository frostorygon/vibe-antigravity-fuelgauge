/**
 * Antigravity Cockpit - Announcement Service (Stubbed)
 * Remote announcements have been disabled for security and privacy.
 */

import * as vscode from 'vscode';
import { Announcement, AnnouncementState } from './types';
import { logger } from '../shared/log_service';

class AnnouncementService {
    private initialized = false;

    initialize(_context: vscode.ExtensionContext): void {
        this.initialized = true;
        logger.info('[AnnouncementService] Initialized (Stubbed)');
    }

    async fetchAnnouncements(): Promise<Announcement[]> {
        return [];
    }

    async getState(): Promise<AnnouncementState> {
        return {
            announcements: [],
            unreadIds: [],
            popupAnnouncement: null,
        };
    }

    async getUnreadCount(): Promise<number> {
        return 0;
    }

    async markAsRead(_id: string): Promise<void> {
        // No-op
    }

    async markAllAsRead(): Promise<void> {
        // No-op
    }

    isRead(_id: string): boolean {
        return true;
    }

    async clearCache(): Promise<void> {
        // No-op
    }

    async forceRefresh(): Promise<AnnouncementState> {
        return this.getState();
    }
}

export const announcementService = new AnnouncementService();
