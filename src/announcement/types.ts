/**
 * Antigravity FuelGauge - Announcement Types
 * AnnouncementSystemType Definitions
 */

/** Announcement Types */
export type AnnouncementType = 'feature' | 'warning' | 'info' | 'urgent';

/** Announcement操作类型 */
export type AnnouncementActionType = 'tab' | 'url' | 'command';

/** Announcement操作 */
export interface AnnouncementAction {
    /** 操作类型 */
    type: AnnouncementActionType;
    /** 目标（Tab ID / URL / 命令 ID） */
    target: string;
    /** Button文字 */
    label: string;
    /** 命令Parameter（仅 type='command' 时Valid） */
    arguments?: unknown[];
}

/** Announcement操作覆盖 */
export interface AnnouncementActionOverride {
    /** Version范围 */
    targetVersions: string;
    /** 覆盖操作 */
    action: AnnouncementAction | null;
}

/** Announcement多LanguageContent */
export interface AnnouncementLocale {
    title?: string;
    summary?: string;
    content?: string;
    actionLabel?: string;
}

/** Announcement图片 */
export interface AnnouncementImage {
    /** 图片 URL */
    url: string;
    /** 图片Label（如 "QQ 群"、"微信群"） */
    label?: string;
    /** 图片替代文字 */
    alt?: string;
}

/** 单条Announcement */
export interface Announcement {
    /** 唯一标识 */
    id: string;
    /** Announcement Types */
    type: AnnouncementType;
    /** 优先级（数值越大越优先） */
    priority: number;
    /** Title */
    title: string;
    /** 简短摘要（List展示用） */
    summary: string;
    /** 完整Content */
    content: string;
    /** 操作Button（Optional） */
    action?: AnnouncementAction | null;
    /** 操作覆盖（Optional） */
    actionOverrides?: AnnouncementActionOverride[];
    /** 目标Version范围（如 ">=1.6.0", "*" 表示所有） */
    targetVersions: string;
    /** 目标LanguageList（如 ["zh-cn", "zh-tw"], ["*"] 或留空表示所有Language） */
    targetLanguages?: string[];
    /** 是否仅Show一次（标记已读后不再弹） */
    showOnce: boolean;
    /** 是否主动Modal */
    popup: boolean;
    /** CreateTime */
    createdAt: string;
    /** 过期Time（Optional） */
    expiresAt?: string | null;
    /** 多Language支持（Optional） */
    locales?: { [key: string]: AnnouncementLocale };
    /** 图片List（Optional） */
    images?: AnnouncementImage[];
}

/** Announcement API Response */
export interface AnnouncementResponse {
    /** DataVersion */
    version: string;
    /** AnnouncementList */
    announcements: Announcement[];
}

/** AnnouncementState（传递给 Webview） */
export interface AnnouncementState {
    /** 所有Announcement */
    announcements: Announcement[];
    /** 未读Announcement ID List */
    unreadIds: string[];
    /** 需要Modal的未读Announcement（优先级最高的一条） */
    popupAnnouncement: Announcement | null;
}
