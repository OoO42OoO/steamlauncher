/**
 * Tiny i18n for the main process — needed because Electron dialogs and
 * stub data shown to the user must respect the chosen language too.
 *
 * Kept deliberately small: no library, just a flat dictionary lookup with
 * an English fallback. The renderer has the full i18next stack; we don't
 * need plurals or interpolation here.
 *
 * The list of supported codes mirrors renderer/i18n/index.ts. Keep them
 * in sync if you add a language.
 */
import { app } from 'electron';
import { getSettings } from './settings';

export const SUPPORTED_LANGUAGES = [
  'en', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'nl', 'cs', 'sk',
  'hu', 'ro', 'bg', 'uk', 'el', 'sv', 'da', 'fi', 'nb', 'tr',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

type Dict = Record<string, string>;

/**
 * Translation table for main-process user-visible strings. Keys are stable
 * IDs, values are per-language translations. English is mandatory; missing
 * keys for any other language fall back to English at lookup time.
 */
const STRINGS: Record<string, Dict> = {
  'dialog.choose_install_dir.title': {
    en: 'Folder for installed games',
    ru: 'Папка для установленных игр',
    de: 'Ordner für installierte Spiele',
    fr: "Dossier pour les jeux installés",
    es: 'Carpeta para juegos instalados',
    pt: 'Pasta para jogos instalados',
    it: 'Cartella per i giochi installati',
    pl: 'Folder dla zainstalowanych gier',
    nl: 'Map voor geïnstalleerde games',
    cs: 'Složka pro nainstalované hry',
    sk: 'Priečinok pre nainštalované hry',
    hu: 'Mappa a telepített játékoknak',
    ro: 'Folder pentru jocurile instalate',
    bg: 'Папка за инсталирани игри',
    uk: 'Папка для встановлених ігор',
    el: 'Φάκελος για εγκατεστημένα παιχνίδια',
    sv: 'Mapp för installerade spel',
    da: 'Mappe til installerede spil',
    fi: 'Kansio asennetuille peleille',
    nb: 'Mappe for installerte spill',
    tr: 'Yüklü oyunlar için klasör',
  },
  'dialog.choose_install_dir.button': {
    en: 'Choose',
    ru: 'Выбрать',
    de: 'Auswählen',
    fr: 'Choisir',
    es: 'Elegir',
    pt: 'Escolher',
    it: 'Scegli',
    pl: 'Wybierz',
    nl: 'Kiezen',
    cs: 'Vybrat',
    sk: 'Vybrať',
    hu: 'Kiválaszt',
    ro: 'Alege',
    bg: 'Избери',
    uk: 'Вибрати',
    el: 'Επιλογή',
    sv: 'Välj',
    da: 'Vælg',
    fi: 'Valitse',
    nb: 'Velg',
    tr: 'Seç',
  },
  // Dev-stub task titles. fakeRedeem mode only — these don't reach
  // production users, but localising keeps screenshots clean during demos.
  'devstub.task.review_stardew.title': {
    en: 'Watch a Stardew Valley review',
    ru: 'Посмотреть обзор Stardew Valley',
    de: 'Stardew-Valley-Test ansehen',
    fr: 'Regarder un test de Stardew Valley',
    es: 'Ver un análisis de Stardew Valley',
    pt: 'Ver uma análise de Stardew Valley',
    it: 'Guarda una recensione di Stardew Valley',
    pl: 'Obejrzyj recenzję Stardew Valley',
    nl: 'Bekijk een Stardew Valley-review',
    cs: 'Podívejte se na recenzi Stardew Valley',
    sk: 'Pozrite si recenziu Stardew Valley',
    hu: 'Stardew Valley-értékelés megtekintése',
    ro: 'Vizionați o recenzie Stardew Valley',
    bg: 'Гледайте ревю на Stardew Valley',
    uk: 'Подивіться огляд Stardew Valley',
    el: 'Δείτε μια κριτική του Stardew Valley',
    sv: 'Titta på en Stardew Valley-recension',
    da: 'Se en Stardew Valley-anmeldelse',
    fi: 'Katso Stardew Valley -arvostelu',
    nb: 'Se en Stardew Valley-anmeldelse',
    tr: "Stardew Valley incelemesi izleyin",
  },
  'devstub.task.survey.title': {
    en: 'Take a survey',
    ru: 'Пройти опрос',
    de: 'An einer Umfrage teilnehmen',
    fr: 'Répondre à un sondage',
    es: 'Realizar una encuesta',
    pt: 'Responder a uma pesquisa',
    it: 'Rispondi a un sondaggio',
    pl: 'Wypełnij ankietę',
    nl: 'Een enquête invullen',
    cs: 'Vyplňte anketu',
    sk: 'Vyplňte anketu',
    hu: 'Kérdőív kitöltése',
    ro: 'Completați un sondaj',
    bg: 'Попълнете анкета',
    uk: 'Пройдіть опитування',
    el: 'Συμμετοχή σε έρευνα',
    sv: 'Svara på en enkät',
    da: 'Tag en undersøgelse',
    fi: 'Tee kysely',
    nb: 'Ta en undersøkelse',
    tr: 'Bir anket doldurun',
  },
  'tray.show': {
    en: 'Open',
    ru: 'Открыть',
    de: 'Öffnen',
    fr: 'Ouvrir',
    es: 'Abrir',
    pt: 'Abrir',
    it: 'Apri',
    pl: 'Otwórz',
    nl: 'Openen',
    cs: 'Otevřít',
    sk: 'Otvoriť',
    hu: 'Megnyitás',
    ro: 'Deschide',
    bg: 'Отвори',
    uk: 'Відкрити',
    el: 'Άνοιγμα',
    sv: 'Öppna',
    da: 'Åbn',
    fi: 'Avaa',
    nb: 'Åpne',
    tr: 'Aç',
  },
  'tray.quit': {
    en: 'Quit',
    ru: 'Выйти',
    de: 'Beenden',
    fr: 'Quitter',
    es: 'Salir',
    pt: 'Sair',
    it: 'Esci',
    pl: 'Zakończ',
    nl: 'Afsluiten',
    cs: 'Ukončit',
    sk: 'Ukončiť',
    hu: 'Kilépés',
    ro: 'Ieșire',
    bg: 'Изход',
    uk: 'Вийти',
    el: 'Έξοδος',
    sv: 'Avsluta',
    da: 'Afslut',
    fi: 'Lopeta',
    nb: 'Avslutt',
    tr: 'Çıkış',
  },
  'devstub.task.completed_example.title': {
    en: 'Already done (example)',
    ru: 'Уже выполнено (пример)',
    de: 'Bereits erledigt (Beispiel)',
    fr: 'Déjà fait (exemple)',
    es: 'Ya hecho (ejemplo)',
    pt: 'Já feito (exemplo)',
    it: 'Già fatto (esempio)',
    pl: 'Już wykonane (przykład)',
    nl: 'Al gedaan (voorbeeld)',
    cs: 'Již hotovo (příklad)',
    sk: 'Už hotové (príklad)',
    hu: 'Már elvégezve (példa)',
    ro: 'Deja făcut (exemplu)',
    bg: 'Вече изпълнено (пример)',
    uk: 'Вже виконано (приклад)',
    el: 'Έχει ήδη γίνει (παράδειγμα)',
    sv: 'Redan gjort (exempel)',
    da: 'Allerede udført (eksempel)',
    fi: 'Jo tehty (esimerkki)',
    nb: 'Allerede utført (eksempel)',
    tr: 'Zaten yapıldı (örnek)',
  },
};

/**
 * Resolve the active language code given the saved override and the OS
 * locale. Same logic as the renderer's resolveLocale, kept in sync by hand.
 */
export function resolveActiveLanguage(): SupportedLanguage {
  const override = getSettings().language;
  const osLocale = app.getLocale();
  return resolveLocaleCode(osLocale, override);
}

export function resolveLocaleCode(osLocale: string, override: string): SupportedLanguage {
  const normalize = (raw: string): SupportedLanguage | null => {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const primary = lower.split(/[-_]/)[0] ?? '';
    // Norwegian: Electron may report the macro tag 'no' instead of 'nb'.
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
 * Look up a translation key for the active language, falling back to
 * English if a target language is missing the key. Returns the key itself
 * as a last-resort fallback so missing strings are visible in dev.
 */
export function tMain(key: string): string {
  const lng = resolveActiveLanguage();
  const dict = STRINGS[key];
  if (!dict) return key;
  return dict[lng] ?? dict.en ?? key;
}
