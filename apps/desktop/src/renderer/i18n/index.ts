/**
 * i18n bootstrap for the renderer.
 *
 * - `init(initialLng)` is called once from main.tsx before mounting React.
 * - `setLanguage(code)` switches at runtime (used by the language picker).
 * - `resolveLocale(osLocale, override)` decides which language to load:
 *     1. explicit `override` if it's in SUPPORTED_LANGUAGES,
 *     2. otherwise OS locale's primary tag (de-AT → de) if supported,
 *     3. otherwise English.
 *
 * Bundles are imported statically — total weight is small (~30 KB gzipped
 * for 21 locales) and avoids extra IPC roundtrips on cold start.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ru from './locales/ru.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import it from './locales/it.json';
import pl from './locales/pl.json';
import nl from './locales/nl.json';
import cs from './locales/cs.json';
import sk from './locales/sk.json';
import hu from './locales/hu.json';
import ro from './locales/ro.json';
import bg from './locales/bg.json';
import uk from './locales/uk.json';
import el from './locales/el.json';
import sv from './locales/sv.json';
import da from './locales/da.json';
import fi from './locales/fi.json';
import nb from './locales/nb.json';
import tr from './locales/tr.json';

/** Supported UI language codes (ISO 639-1, except `nb` for Norwegian Bokmål). */
export const SUPPORTED_LANGUAGES = [
  'en',
  'ru',
  'de',
  'fr',
  'es',
  'pt',
  'it',
  'pl',
  'nl',
  'cs',
  'sk',
  'hu',
  'ro',
  'bg',
  'uk',
  'el',
  'sv',
  'da',
  'fi',
  'nb',
  'tr',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Native names of each language as it would label itself in a picker. */
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  pl: 'Polski',
  nl: 'Nederlands',
  cs: 'Čeština',
  sk: 'Slovenčina',
  hu: 'Magyar',
  ro: 'Română',
  bg: 'Български',
  uk: 'Українська',
  el: 'Ελληνικά',
  sv: 'Svenska',
  da: 'Dansk',
  fi: 'Suomi',
  nb: 'Norsk',
  tr: 'Türkçe',
};

/** Flag emoji per language. Country picked by primary speaker community,
 *  not by linguistic origin (pt → Portugal, en → UK). */
export const LANGUAGE_FLAGS: Record<SupportedLanguage, string> = {
  en: '🇬🇧',
  ru: '🇷🇺',
  de: '🇩🇪',
  fr: '🇫🇷',
  es: '🇪🇸',
  pt: '🇵🇹',
  it: '🇮🇹',
  pl: '🇵🇱',
  nl: '🇳🇱',
  cs: '🇨🇿',
  sk: '🇸🇰',
  hu: '🇭🇺',
  ro: '🇷🇴',
  bg: '🇧🇬',
  uk: '🇺🇦',
  el: '🇬🇷',
  sv: '🇸🇪',
  da: '🇩🇰',
  fi: '🇫🇮',
  nb: '🇳🇴',
  tr: '🇹🇷',
};

const RESOURCES: Record<SupportedLanguage, { translation: Record<string, unknown> }> = {
  en: { translation: en },
  ru: { translation: ru },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
  pt: { translation: pt },
  it: { translation: it },
  pl: { translation: pl },
  nl: { translation: nl },
  cs: { translation: cs },
  sk: { translation: sk },
  hu: { translation: hu },
  ro: { translation: ro },
  bg: { translation: bg },
  uk: { translation: uk },
  el: { translation: el },
  sv: { translation: sv },
  da: { translation: da },
  fi: { translation: fi },
  nb: { translation: nb },
  tr: { translation: tr },
};

/**
 * Pick the language code we'll actually use, given (a) what the OS reports
 * and (b) the user's manual override (or 'auto'). The result is always one
 * of SUPPORTED_LANGUAGES.
 *
 * BCP-47 mapping: 'de-AT' → 'de'. Special-case 'no' → 'nb' (Bokmål) since
 * Electron sometimes returns the macro language tag for Norwegian.
 */
export function resolveLocale(osLocale: string, override: string): SupportedLanguage {
  const normalize = (raw: string): SupportedLanguage | null => {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const primary = lower.split(/[-_]/)[0] ?? '';
    const mapped = primary === 'no' ? 'nb' : primary;
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(mapped)
      ? (mapped as SupportedLanguage)
      : null;
  };

  if (override && override !== 'auto') {
    const explicit = normalize(override);
    if (explicit) return explicit;
  }
  return normalize(osLocale) ?? 'en';
}

/**
 * Keep `<html lang>` in step with the UI language.
 *
 * The redesign leans on `text-transform: uppercase` for buttons and section
 * labels, and CSS case mapping is language-sensitive: Blink reads the
 * document language, so with a hardcoded `lang="en"` Turkish "i" uppercases
 * to "I" instead of "İ", and Greek keeps accents that are dropped in real
 * uppercase orthography. Setting it here covers both the boot path and the
 * language picker.
 */
function syncDocumentLanguage(code: string): void {
  document.documentElement.lang = code;
}

export async function init(initialLng: SupportedLanguage): Promise<void> {
  if (i18next.isInitialized) {
    if (i18next.language !== initialLng) await i18next.changeLanguage(initialLng);
    syncDocumentLanguage(initialLng);
    return;
  }
  await i18next.use(initReactI18next).init({
    lng: initialLng,
    fallbackLng: 'en',
    resources: RESOURCES,
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
  });
  syncDocumentLanguage(initialLng);
}

export async function setLanguage(code: SupportedLanguage): Promise<void> {
  if (i18next.language === code) return;
  await i18next.changeLanguage(code);
  syncDocumentLanguage(code);
}
