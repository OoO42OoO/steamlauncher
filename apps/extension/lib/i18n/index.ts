/**
 * Lightweight i18n for the popup. Mirrors apps/desktop/src/main/i18n.ts
 * structure: a flat dictionary, no library, English fallback.
 *
 * Why not pull i18next here too: the popup is ~80 lines of UI with five
 * strings. The popup bundle stays smaller without the dependency, and
 * the extension cannot read the desktop's settings.json anyway — its
 * language must come from the browser locale.
 *
 * Source of truth for language list: shared with desktop (kept in sync
 * by hand). Add a language → update both.
 */

const SUPPORTED = [
  'en', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'nl', 'cs', 'sk',
  'hu', 'ro', 'bg', 'uk', 'el', 'sv', 'da', 'fi', 'nb', 'tr',
] as const;

type Lang = (typeof SUPPORTED)[number];

type Dict = Record<string, string>;

const STRINGS: Record<string, Dict> = {
  'popup.balance_label': {
    en: 'play balance',
    ru: 'игровой баланс',
    de: 'Spielguthaben',
    fr: 'solde de jeu',
    es: 'saldo de juego',
    pt: 'saldo de jogo',
    it: 'credito di gioco',
    pl: 'saldo gry',
    nl: 'speelsaldo',
    cs: 'herní zůstatek',
    sk: 'herný zostatok',
    hu: 'játékegyenleg',
    ro: 'sold de joc',
    bg: 'игрови баланс',
    uk: 'ігровий баланс',
    el: 'υπόλοιπο παιχνιδιού',
    sv: 'spelsaldo',
    da: 'spilsaldo',
    fi: 'pelisaldo',
    nb: 'spillsaldo',
    tr: 'oyun bakiyesi',
  },
  'popup.activity': {
    en: 'activity',
    ru: 'активность',
    de: 'Aktivität',
    fr: 'activité',
    es: 'actividad',
    pt: 'atividade',
    it: 'attività',
    pl: 'aktywność',
    nl: 'activiteit',
    cs: 'aktivita',
    sk: 'aktivita',
    hu: 'aktivitás',
    ro: 'activitate',
    bg: 'активност',
    uk: 'активність',
    el: 'δραστηριότητα',
    sv: 'aktivitet',
    da: 'aktivitet',
    fi: 'aktiivisuus',
    nb: 'aktivitet',
    tr: 'etkinlik',
  },
  'popup.hint': {
    en: 'The extension records time spent on websites and reports it to the client. Tasks and balance are managed by the service.',
    ru: 'Расширение фиксирует время, проведённое на сайтах, и отправляет его в клиент. Задания и баланс управляются сервисом.',
    de: 'Die Erweiterung erfasst die auf Websites verbrachte Zeit und sendet sie an den Client. Aufgaben und Guthaben werden vom Dienst verwaltet.',
    fr: "L'extension enregistre le temps passé sur les sites et l'envoie au client. Les tâches et le solde sont gérés par le service.",
    es: 'La extensión registra el tiempo en los sitios y lo envía al cliente. Las tareas y el saldo los gestiona el servicio.',
    pt: 'A extensão registra o tempo gasto em sites e o envia ao cliente. Tarefas e saldo são gerenciados pelo serviço.',
    it: "L'estensione registra il tempo trascorso sui siti e lo invia al client. Attività e credito sono gestiti dal servizio.",
    pl: 'Rozszerzenie rejestruje czas spędzony na stronach i przesyła go do klienta. Zadaniami i saldem zarządza usługa.',
    nl: 'De extensie registreert de tijd op websites en stuurt deze naar de client. Taken en saldo worden door de dienst beheerd.',
    cs: 'Rozšíření zaznamenává čas strávený na webech a odesílá jej do klienta. Úkoly a zůstatek spravuje služba.',
    sk: 'Rozšírenie zaznamenáva čas strávený na weboch a odosiela ho do klienta. Úlohy a zostatok spravuje služba.',
    hu: 'A bővítmény rögzíti a webhelyeken töltött időt, és elküldi a kliensnek. A feladatokat és az egyenleget a szolgáltatás kezeli.',
    ro: 'Extensia înregistrează timpul petrecut pe site-uri și îl trimite clientului. Sarcinile și soldul sunt gestionate de serviciu.',
    bg: 'Разширението записва времето, прекарано в сайтове, и го изпраща към клиента. Задачите и балансът се управляват от услугата.',
    uk: 'Розширення фіксує час, проведений на сайтах, і надсилає його в клієнт. Завдання та баланс керує сервіс.',
    el: 'Η επέκταση καταγράφει τον χρόνο σε ιστότοπους και τον στέλνει στον πελάτη. Οι εργασίες και το υπόλοιπο διαχειρίζονται από την υπηρεσία.',
    sv: 'Tillägget registrerar tid på webbplatser och skickar den till klienten. Uppgifter och saldo hanteras av tjänsten.',
    da: 'Udvidelsen registrerer tid på websteder og sender den til klienten. Opgaver og saldo administreres af tjenesten.',
    fi: 'Laajennus tallentaa sivustoilla käytetyn ajan ja lähettää sen asiakkaalle. Tehtäviä ja saldoa hallinnoi palvelu.',
    nb: 'Utvidelsen registrerer tid brukt på nettsteder og sender den til klienten. Oppgaver og saldo administreres av tjenesten.',
    tr: 'Uzantı, sitelerde geçirilen süreyi kaydeder ve istemciye gönderir. Görevler ve bakiye hizmet tarafından yönetilir.',
  },
  'popup.offline': {
    en: 'client not running',
    ru: 'клиент не запущен',
    de: 'Client läuft nicht',
    fr: 'client non démarré',
    es: 'cliente no iniciado',
    pt: 'cliente não iniciado',
    it: 'client non avviato',
    pl: 'klient nie jest uruchomiony',
    nl: 'client draait niet',
    cs: 'klient neběží',
    sk: 'klient nebeží',
    hu: 'a kliens nem fut',
    ro: 'clientul nu rulează',
    bg: 'клиентът не е стартиран',
    uk: 'клієнт не запущено',
    el: 'ο πελάτης δεν εκτελείται',
    sv: 'klienten körs inte',
    da: 'klienten kører ikke',
    fi: 'asiakas ei ole käynnissä',
    nb: 'klienten kjører ikke',
    tr: 'istemci çalışmıyor',
  },
  'popup.relative.seconds': {
    en: '{n}s ago',
    ru: '{n}с назад',
    de: 'vor {n}s',
    fr: 'il y a {n}s',
    es: 'hace {n}s',
    pt: 'há {n}s',
    it: '{n}s fa',
    pl: '{n}s temu',
    nl: '{n}s geleden',
    cs: 'před {n}s',
    sk: 'pred {n}s',
    hu: '{n} mp.',
    ro: 'acum {n}s',
    bg: 'преди {n}с',
    uk: '{n}с тому',
    el: 'πριν από {n}δ',
    sv: 'för {n}s sedan',
    da: 'for {n}s siden',
    fi: '{n}s sitten',
    nb: 'for {n}s siden',
    tr: '{n}sn önce',
  },
  'popup.relative.minutes': {
    en: '{n}m ago',
    ru: '{n}м назад',
    de: 'vor {n}min',
    fr: 'il y a {n}min',
    es: 'hace {n}min',
    pt: 'há {n}min',
    it: '{n}min fa',
    pl: '{n}min temu',
    nl: '{n}min geleden',
    cs: 'před {n}min',
    sk: 'pred {n}min',
    hu: '{n} p.',
    ro: 'acum {n}min',
    bg: 'преди {n}мин',
    uk: '{n}хв тому',
    el: 'πριν {n}λ',
    sv: 'för {n}min sedan',
    da: 'for {n}min siden',
    fi: '{n}min sitten',
    nb: 'for {n}min siden',
    tr: '{n}dk önce',
  },
  'popup.relative.hours': {
    en: '{n}h ago',
    ru: '{n}ч назад',
    de: 'vor {n}h',
    fr: 'il y a {n}h',
    es: 'hace {n}h',
    pt: 'há {n}h',
    it: '{n}h fa',
    pl: '{n}g temu',
    nl: '{n}u geleden',
    cs: 'před {n}h',
    sk: 'pred {n}h',
    hu: '{n} ó.',
    ro: 'acum {n}h',
    bg: 'преди {n}ч',
    uk: '{n}год тому',
    el: 'πριν {n}ώ',
    sv: 'för {n}h sedan',
    da: 'for {n}t siden',
    fi: '{n}t sitten',
    nb: 'for {n}t siden',
    tr: '{n}sa önce',
  },
  'popup.relative.days': {
    en: '{n}d ago',
    ru: '{n}д назад',
    de: 'vor {n}T',
    fr: 'il y a {n}j',
    es: 'hace {n}d',
    pt: 'há {n}d',
    it: '{n}g fa',
    pl: '{n}d temu',
    nl: '{n}d geleden',
    cs: 'před {n}d',
    sk: 'pred {n}d',
    hu: '{n} n.',
    ro: 'acum {n}z',
    bg: 'преди {n}д',
    uk: '{n}д тому',
    el: 'πριν {n}μ',
    sv: 'för {n}d sedan',
    da: 'for {n}d siden',
    fi: '{n}p sitten',
    nb: 'for {n}d siden',
    tr: '{n}g önce',
  },
};

function getActiveLang(): Lang {
  // chrome.i18n.getUILanguage() returns BCP-47 like 'en-US'. Fall back to
  // navigator.language for non-extension contexts (e.g. unit tests in JSDOM).
  const raw =
    (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()) ||
    (typeof navigator !== 'undefined' ? navigator.language : '') ||
    'en';
  const primary = raw.toLowerCase().split(/[-_]/)[0] ?? 'en';
  const mapped = primary === 'no' ? 'nb' : primary;
  return (SUPPORTED as readonly string[]).includes(mapped) ? (mapped as Lang) : 'en';
}

export function tExt(key: string, vars?: Record<string, string | number>): string {
  const lng = getActiveLang();
  const dict = STRINGS[key];
  if (!dict) return key;
  let template = dict[lng] ?? dict.en ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}
