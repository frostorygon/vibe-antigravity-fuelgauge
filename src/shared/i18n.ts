/**
 * Antigravity FuelGauge - Internationalization Support
 * i18n implementation supporting 15 languages
 */

import * as vscode from 'vscode';
import { en, ja, es, de, fr, ptBR, ru, ko, it, tr, pl, cs, ar, vi } from './translations';

/** 支持的Language */
export type SupportedLocale =
    | 'en'
    | 'en'
    | 'ja'
    | 'es'
    | 'de'
    | 'fr'
    | 'pt-br'
    | 'ru'
    | 'ko'
    | 'it'
    | 'tr'
    | 'pl'
    | 'cs'
    | 'ar'
    | 'vi';

/** LanguageShow名称映射 */
export const localeDisplayNames: Record<SupportedLocale, string> = {
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
    'de': 'Deutsch',
    'fr': 'Français',
    'es': 'Español',
    'pt-br': 'Português (Brasil)',
    'ru': 'Русский',
    'it': 'Italiano',
    'tr': 'Türkçe',
    'pl': 'Polski',
    'cs': 'Čeština',
    'ar': 'اللغة العربية',
    'vi': 'Tiếng Việt',
};

/** Translation键值对 */
interface TranslationMap {
    [key: string]: string;
}

/** Translation资源 */
const translations: Record<SupportedLocale, TranslationMap> = {
    'en': en,
    'ja': ja,
    'es': es,
    'de': de,
    'fr': fr,
    'pt-br': ptBR,
    'ru': ru,
    'ko': ko,
    'it': it,
    'tr': tr,
    'pl': pl,
    'cs': cs,
    'ar': ar,
    'vi': vi,
};

/** Language code mapping - 将 VSCode Language code mapping到我们支持的Language */
const localeMapping: Record<string, SupportedLocale> = {
    'en': 'en',
    'en-us': 'en',
    'en-gb': 'en',
    'ja': 'ja',
    'es': 'es',
    'de': 'de',
    'fr': 'fr',
    'pt-br': 'pt-br',
    'pt': 'pt-br',
    'ru': 'ru',
    'ko': 'ko',
    'it': 'it',
    'tr': 'tr',
    'pl': 'pl',
    'cs': 'cs',
    'ar': 'ar',
    'vi': 'vi',
    'vi-vn': 'vi',
};

/**
 * 规范化外部传入的Language值
 */
export function normalizeLocaleInput(languageSetting: string): string {
    const trimmed = languageSetting.trim().toLowerCase();
    if (!trimmed) {
        return languageSetting;
    }
    if (trimmed === 'auto') {
        return 'auto';
    }
    if (localeMapping[trimmed]) {
        return localeMapping[trimmed];
    }
    const prefix = trimmed.split('-')[0];
    if (localeMapping[prefix]) {
        return localeMapping[prefix];
    }
    return trimmed;
}

/** i18n Service类 */
class I18nService {
    private currentLocale: SupportedLocale = 'en';
    private manualLocale: string = 'auto'; // User手动Set的Language，'auto' 表示跟随 VS Code

    constructor() {
        this.detectLocale();
    }

    /**
     * 检测Current languageEnvironment（基于 VS Code Set）
     */
    private detectLocale(): void {
        const vscodeLocale = vscode.env.language.toLowerCase();

        // 首先尝试精确匹配
        if (localeMapping[vscodeLocale]) {
            this.currentLocale = localeMapping[vscodeLocale];
            return;
        }

        // 尝试匹配Language前缀
        const langPrefix = vscodeLocale.split('-')[0];
        if (localeMapping[langPrefix]) {
            this.currentLocale = localeMapping[langPrefix];
            return;
        }

        // Default使用英文
        this.currentLocale = 'en';
    }

    /**
     * Apply language setting
     * @param languageSetting LanguageSet值，'auto' 跟随 VS Code，其他为具体Language代码
     */
    applyLanguageSetting(languageSetting: string): boolean {
        const previousLocale = this.currentLocale;
        this.manualLocale = languageSetting;

        if (languageSetting === 'auto') {
            // 跟随 VS Code
            this.detectLocale();
        } else {
            // Validate是否为支持的Language
            const supportedLocales = Object.keys(translations) as SupportedLocale[];
            if (supportedLocales.includes(languageSetting as SupportedLocale)) {
                this.currentLocale = languageSetting as SupportedLocale;
            } else {
                // 不支持的Language，回退到 VS Code
                this.detectLocale();
            }
        }

        return this.currentLocale !== previousLocale;
    }

    /**
     * GetCurrent手动Set的Language
     */
    getManualLocale(): string {
        return this.manualLocale;
    }

    /**
     * Get translation文本
     * @param key Translation键
     * @param params 替换Parameter
     */
    t(key: string, params?: Record<string, string | number>): string {
        const translation = translations[this.currentLocale]?.[key]
            || translations['en'][key]
            || key;

        if (!params) {
            return translation;
        }

        // 替换Parameter {param} -> value
        return Object.entries(params).reduce(
            (text, [paramKey, paramValue]) =>
                text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue)),
            translation,
        );
    }

    /**
     * GetCurrent language
     */
    getLocale(): SupportedLocale {
        return this.currentLocale;
    }

    /**
     * Set language
     */
    setLocale(locale: SupportedLocale): void {
        this.currentLocale = locale;
    }

    /**
     * Get所有Translation（用于 Webview）
     */
    getAllTranslations(): TranslationMap {
        return { ...translations['en'], ...translations[this.currentLocale] };
    }

    /**
     * Get所有支持的LanguageList
     */
    getSupportedLocales(): SupportedLocale[] {
        return Object.keys(translations) as SupportedLocale[];
    }

    /**
     * GetLanguageShow名称
     */
    getLocaleDisplayName(locale: SupportedLocale): string {
        return localeDisplayNames[locale] || locale;
    }
}

// Export单例
export const i18n = new I18nService();

// 便捷函数
export const t = (key: string, params?: Record<string, string | number>) => i18n.t(key, params);
