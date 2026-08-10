/**
 * Steam Store genre IDs → localized display names.
 *
 * PICS appinfo (`common.genres`) carries genre IDs only, no labels. The
 * ID space is small and stable — it's the same set the Store uses in
 * `store.steampowered.com/genre/...` URLs — so we ship the mapping
 * instead of asking the rate-limited Store web API per game. Names are
 * aligned with the Store's own localized genre labels so chips look the
 * same whichever source (PICS table or web-API fallback) produced them.
 *
 * Unknown IDs are dropped by `genreNamesFor` — a title whose only IDs
 * are unmapped resolves to [] and the caller falls back to the web API,
 * which returns Steam's authoritative localized names.
 */

const NAMES: Record<string, Record<string, string>> = {
  // Action
  '1': {
    en: 'Action', ru: 'Экшены', uk: 'Екшени', bg: 'Екшън', cs: 'Akční',
    sk: 'Akčné', pl: 'Akcja', de: 'Action', nl: 'Actie', da: 'Action',
    sv: 'Action', nb: 'Action', fi: 'Toiminta', fr: 'Action', es: 'Acción',
    pt: 'Ação', it: 'Azione', ro: 'Acțiune', hu: 'Akció', el: 'Δράσης',
    tr: 'Aksiyon',
  },
  // Strategy
  '2': {
    en: 'Strategy', ru: 'Стратегии', uk: 'Стратегії', bg: 'Стратегии',
    cs: 'Strategie', sk: 'Stratégie', pl: 'Strategie', de: 'Strategie',
    nl: 'Strategie', da: 'Strategi', sv: 'Strategi', nb: 'Strategi',
    fi: 'Strategia', fr: 'Stratégie', es: 'Estrategia', pt: 'Estratégia',
    it: 'Strategia', ro: 'Strategie', hu: 'Stratégia', el: 'Στρατηγικής',
    tr: 'Strateji',
  },
  // RPG
  '3': {
    en: 'RPG', ru: 'Ролевые игры', uk: 'Рольові ігри', bg: 'Ролеви игри',
    cs: 'RPG', sk: 'RPG', pl: 'RPG', de: 'Rollenspiel', nl: 'RPG',
    da: 'Rollespil', sv: 'Rollspel', nb: 'Rollespill', fi: 'Roolipelit',
    fr: 'JDR', es: 'Rol', pt: 'RPG', it: 'GDR', ro: 'RPG',
    hu: 'Szerepjáték', el: 'Παιχνίδια ρόλων', tr: 'RPG',
  },
  // Casual
  '4': {
    en: 'Casual', ru: 'Казуальные игры', uk: 'Казуальні ігри',
    bg: 'Казуални', cs: 'Nenáročné', sk: 'Nenáročné', pl: 'Casual',
    de: 'Gelegenheitsspiele', nl: 'Casual', da: 'Casual', sv: 'Casual',
    nb: 'Casual', fi: 'Rento', fr: 'Occasionnel', es: 'Casual',
    pt: 'Casual', it: 'Casual', ro: 'Casual', hu: 'Alkalmi', el: 'Χαλαρά',
    tr: 'Gündelik',
  },
  // Racing
  '9': {
    en: 'Racing', ru: 'Гонки', uk: 'Перегони', bg: 'Състезателни',
    cs: 'Závodní', sk: 'Preteky', pl: 'Wyścigi', de: 'Rennsport',
    nl: 'Racen', da: 'Ræs', sv: 'Racing', nb: 'Racing', fi: 'Kilpa-ajo',
    fr: 'Course', es: 'Carreras', pt: 'Corridas', it: 'Corse',
    ro: 'Curse', hu: 'Verseny', el: 'Αγώνες', tr: 'Yarış',
  },
  // Sports
  '18': {
    en: 'Sports', ru: 'Спортивные игры', uk: 'Спортивні ігри',
    bg: 'Спортни', cs: 'Sportovní', sk: 'Športové', pl: 'Sportowe',
    de: 'Sport', nl: 'Sport', da: 'Sport', sv: 'Sport', nb: 'Sport',
    fi: 'Urheilu', fr: 'Sport', es: 'Deportes', pt: 'Desporto',
    it: 'Sport', ro: 'Sport', hu: 'Sport', el: 'Αθλητικά', tr: 'Spor',
  },
  // Indie
  '23': {
    en: 'Indie', ru: 'Инди', uk: 'Інді', bg: 'Инди', cs: 'Nezávislé',
    sk: 'Indie', pl: 'Indie', de: 'Indie', nl: 'Indie', da: 'Indie',
    sv: 'Indie', nb: 'Indie', fi: 'Indie', fr: 'Indé', es: 'Indie',
    pt: 'Indie', it: 'Indie', ro: 'Indie', hu: 'Indie',
    el: 'Ανεξάρτητα', tr: 'Bağımsız',
  },
  // Adventure
  '25': {
    en: 'Adventure', ru: 'Приключенческие игры', uk: 'Пригодницькі ігри',
    bg: 'Приключенски', cs: 'Dobrodružné', sk: 'Dobrodružné',
    pl: 'Przygodowe', de: 'Abenteuer', nl: 'Avontuur', da: 'Eventyr',
    sv: 'Äventyr', nb: 'Eventyr', fi: 'Seikkailu', fr: 'Aventure',
    es: 'Aventura', pt: 'Aventura', it: 'Avventura', ro: 'Aventură',
    hu: 'Kaland', el: 'Περιπέτειας', tr: 'Macera',
  },
  // Simulation
  '28': {
    en: 'Simulation', ru: 'Симуляторы', uk: 'Симулятори',
    bg: 'Симулатори', cs: 'Simulátory', sk: 'Simulátory',
    pl: 'Symulacje', de: 'Simulation', nl: 'Simulatie', da: 'Simulation',
    sv: 'Simulering', nb: 'Simulering', fi: 'Simulaatio',
    fr: 'Simulation', es: 'Simulación', pt: 'Simulação',
    it: 'Simulazione', ro: 'Simulare', hu: 'Szimuláció',
    el: 'Προσομοίωσης', tr: 'Simülasyon',
  },
  // Massively Multiplayer
  '29': {
    en: 'Massively Multiplayer', ru: 'Многопользовательские игры',
    uk: 'Багатокористувацькі ігри', bg: 'MMO', cs: 'MMO', sk: 'MMO',
    pl: 'MMO', de: 'MMO', nl: 'MMO', da: 'MMO', sv: 'MMO', nb: 'MMO',
    fi: 'MMO', fr: 'MMO', es: 'MMO', pt: 'MMO', it: 'MMO', ro: 'MMO',
    hu: 'MMO', el: 'MMO', tr: 'MMO',
  },
  // Free To Play
  '37': {
    en: 'Free To Play', ru: 'Бесплатные', uk: 'Безкоштовні',
    bg: 'Безплатни', cs: 'Free-to-play', sk: 'Free-to-play',
    pl: 'Darmowe', de: 'Free-to-Play', nl: 'Gratis', da: 'Gratis',
    sv: 'Gratis', nb: 'Gratis', fi: 'Ilmainen', fr: 'Gratuit',
    es: 'Gratis', pt: 'Gratuito', it: 'Gratis', ro: 'Gratuit',
    hu: 'Ingyenes', el: 'Δωρεάν', tr: 'Ücretsiz',
  },
  // Early Access
  '70': {
    en: 'Early Access', ru: 'Ранний доступ', uk: 'Ранній доступ',
    bg: 'Ранен достъп', cs: 'Předběžný přístup', sk: 'Predbežný prístup',
    pl: 'Wczesny dostęp', de: 'Early Access', nl: 'Early access',
    da: 'Tidlig adgang', sv: 'Early Access', nb: 'Tidlig tilgang',
    fi: 'Early Access', fr: 'Accès anticipé', es: 'Acceso anticipado',
    pt: 'Acesso Antecipado', it: 'Accesso anticipato',
    ro: 'Acces timpuriu', hu: 'Korai hozzáférés', el: 'Πρόωρη πρόσβαση',
    tr: 'Erken Erişim',
  },
};

/**
 * Map genre IDs to display names for `locale` (falling back to English
 * per ID). Unknown IDs are silently dropped; duplicates collapse.
 */
export function genreNamesFor(ids: string[], locale: string): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const entry = NAMES[id];
    if (!entry) continue;
    const name = entry[locale] ?? entry.en;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
