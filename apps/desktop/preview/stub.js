/**
 * Browser stub for `window.api` / `window.featureFlags`.
 *
 * The renderer is written against the preload bridge, which only exists
 * inside Electron. This fills the same shape with fixture data so the real
 * components can be opened in a plain browser and checked against
 * design/launcher-redesign-battlenet.html — every screen, every state, no
 * Steam account and no downloads required.
 *
 * Development aid only: it is never bundled, and nothing under apps/desktop
 * imports it.
 */
(() => {
  const noop = () => () => {};
  const ok = (v) => Promise.resolve(v);

  const GAMES = [
    { appid: 492720, game_name: 'Tropico 6', status: 'installed' },
    { appid: 550, game_name: 'Left 4 Dead 2', status: 'installed' },
    { appid: 70, game_name: 'Half-Life', status: 'not_installed' },
    { appid: 620, game_name: 'Portal 2', status: 'downloading' },
    { appid: 3768760, game_name: '007 First Light', status: 'error' },
    { appid: 232770, game_name: 'POSTAL 2', status: 'not_installed' },
    { appid: 1091500, game_name: 'Cyberpunk 2077', status: 'not_installed' },
    { appid: 292030, game_name: 'The Witcher 3: Wild Hunt', status: 'not_installed' },
    { appid: 1245620, game_name: 'ELDEN RING', status: 'not_installed', locked: true },
    { appid: 271590, game_name: 'Grand Theft Auto V', status: 'not_installed' },
    { appid: 105600, game_name: 'Terraria', status: 'installed' },
    { appid: 322330, game_name: "Don't Starve Together", status: 'not_installed' },
  ];

  const library = GAMES.map((g) => ({
    id: `acct-${g.appid}`,
    appid: g.appid,
    game_name: g.game_name,
    status: g.status,
    locked: !!g.locked,
    min_trust_level: g.locked ? 3 : 0,
    iconUrl: null,
    logoUrl: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`,
    downloadPercent: g.status === 'downloading' ? 38.4 : null,
    downloadStage: g.status === 'downloading' ? 'downloading' : null,
    downloadBytesDownloaded: g.status === 'downloading' ? 4_812_000_000 : null,
    downloadError: g.status === 'error' ? 'depot_download_failed' : null,
    downloadErrorPlatforms: null,
    guardHint: null,
  }));

  const GENRES = {
    492720: ['Стратегии', 'Симуляторы'],
    550: ['Экшены', 'Кооператив'],
    70: ['Экшены'],
    620: ['Приключения', 'Головоломки'],
    3768760: ['Экшены', 'Приключения'],
    232770: ['Экшены', 'Инди'],
    1091500: ['Ролевые игры', 'Экшены'],
    292030: ['Ролевые игры', 'Приключения'],
    1245620: ['Ролевые игры', 'Экшены'],
    271590: ['Экшены', 'Приключения'],
    105600: ['Инди', 'Приключения'],
    322330: ['Инди', 'Выживание'],
  };

  const SIZES = { 492720: 18_400_000_000, 550: 12_100_000_000, 105600: 640_000_000 };

const LONG_DESCRIPTION =
  '<h1>Об игре</h1>' +
  // Opens with the very sentence short_description carries — which is what
  // Steam actually does, and what used to print the lead twice.
  '<p>Стройте, правьте и лавируйте между сверхдержавами. Управлять надо не одним островом, а целой цепочкой — со своей логистикой, налогами и недовольными фракциями.</p>' +
  '<img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/550/header.jpg" />' +
  '<p>Продолжение самого популярного кооперативного шутера: четверо выживших пробиваются через город, захваченный заражёнными, а режиссёр подстраивает плотность толпы, погоду и расположение припасов под то, как играет ваша команда.</p>' +
  '<h2 class="bb_tag">Совместное выживание</h2>' +
  '<p>Продолжение самого популярного кооперативного шутера: четверо выживших пробиваются через город, захваченный заражёнными, а режиссёр подстраивает плотность толпы, погоду и расположение припасов под то, как играет ваша команда.</p>' +
  '<ul class="bb_ul"><li>Пять кампаний</li><li>Четыре режима</li><li>Режиссёр ИИ</li></ul>' +
  '<h2 class="bb_tag">Новое оружие</h2>' +
  '<p>Продолжение самого популярного кооперативного шутера: четверо выживших пробиваются через город, захваченный заражёнными, а режиссёр подстраивает плотность толпы, погоду и расположение припасов под то, как играет ваша команда.</p>' +
  '<p>Продолжение самого популярного кооперативного шутера: четверо выживших пробиваются через город, захваченный заражёнными, а режиссёр подстраивает плотность толпы, погоду и расположение припасов под то, как играет ваша команда.</p>' +
  '<br><br>' +
  '<p>Продолжение самого популярного кооперативного шутера: четверо выживших пробиваются через город, захваченный заражёнными, а режиссёр подстраивает плотность толпы, погоду и расположение припасов под то, как играет ваша команда.</p>';

  const details = (appid) => ({
    name: library.find((g) => g.appid === appid)?.game_name ?? 'Game',
    short_description:
      'Стройте, правьте и лавируйте между сверхдержавами. Управлять надо не одним островом, а целой цепочкой — со своей логистикой, налогами и недовольными фракциями.',
    // appid 550 carries a deliberately long body: the game page flows the
    // description in two columns, and one short paragraph never shows it.
    detailed_description:
      appid === 550
        ? LONG_DESCRIPTION
        : '<p>Шестая часть добавляет архипелаги, мосты и кражу мировых достопримечательностей. Стройте мосты и туннели между островами, отправляйте агентов за Эйфелевой башней и держите фракции в узде.</p><p>Кастомизация дворца, новые режимы исследования и переработанная торговля довершают картину.</p>',
    header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    background_raw: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg`,
    developers: ['Limbic Entertainment'],
    publishers: ['Kalypso Media'],
    release_date: { date: '27 мар. 2019 г.' },
    genres: (GENRES[appid] ?? []).map((description, id) => ({ id: String(id), description })),
    screenshots: Array.from({ length: 6 }, (_, i) => ({
      id: i,
      path_thumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
      path_full: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    })),
    movies: [],
    pc_requirements: {
      minimum:
        '<strong>Минимальные:</strong><br><ul class="bb_ul"><li><strong>ОС:</strong> Windows 10 64-bit<br></li><li><strong>Процессор:</strong> Intel Core i5-2500K / AMD FX-8320<br></li><li><strong>Оперативная память:</strong> 8 GB ОЗУ<br></li><li><strong>Видеокарта:</strong> GeForce GTX 660 / Radeon R9 270<br></li><li><strong>DirectX:</strong> Версии 11<br></li><li><strong>Место на диске:</strong> 16 GB<br></li></ul>',
      recommended:
        '<strong>Рекомендованные:</strong><br><ul class="bb_ul"><li><strong>ОС:</strong> Windows 11 64-bit<br></li><li><strong>Процессор:</strong> Intel Core i7-8700<br></li><li><strong>Оперативная память:</strong> 16 GB ОЗУ<br></li><li><strong>Видеокарта:</strong> GeForce RTX 2060<br></li><li><strong>DirectX:</strong> Версии 12<br></li><li><strong>Место на диске:</strong> 20 GB<br></li></ul>',
    },
    platforms: { windows: true, mac: false, linux: false },
  });

  const NEWS = [
    {
      gid: '1',
      title: 'Обновление 1.14: мосты, туннели и новый режим',
      url: 'https://store.steampowered.com/news/',
      contents:
        '[b]Патч 1.14[/b] добавляет строительство мостов между островами, переработанную торговлю и режим песочницы без ограничений по времени.',
      author: 'Kalypso',
      feedlabel: 'Community Announcements',
      date: Math.floor(Date.now() / 1000) - 86_400 * 3,
    },
    {
      gid: '2',
      title: 'Хотфикс: производительность на больших архипелагах',
      url: 'https://store.steampowered.com/news/',
      contents:
        'Исправлены просадки кадров на картах с более чем восемью островами и утечка памяти в режиме наблюдателя.',
      author: 'Kalypso',
      feedlabel: 'Community Announcements',
      date: Math.floor(Date.now() / 1000) - 86_400 * 11,
    },
    {
      gid: '3',
      title: 'Скидка недели — 70%',
      url: 'https://store.steampowered.com/news/',
      contents: 'До конца недели игра и все дополнения продаются со скидкой 70%.',
      author: 'Kalypso',
      feedlabel: 'Product Update',
      date: Math.floor(Date.now() / 1000) - 86_400 * 24,
    },
  ];

  window.api = {
    debug: { loggingEnabled: false },
    auth: {
      redeem: () => ok({ ok: true }),
      status: () =>
        ok({
          state: 'signed_in',
          user: { id: '4821 5590 3317', email: null, trust_level: 2, balance: 0 },
        }),
      logout: () => ok(undefined),
      onStatus: noop,
    },
    library: { list: () => ok(library) },
    tasks: {
      list: () =>
        ok([
          {
            id: 't1',
            title: 'Подписаться на канал',
            description: 'https://t.me/launcherfreebot',
            status: 'pending',
          },
          {
            id: 't2',
            title: 'Пройти опрос партнёра',
            description: 'Займёт около трёх минут',
            status: 'pending',
          },
          { id: 't3', title: 'Пригласить друга', description: null, status: 'completed' },
        ]),
      complete: () => ok({ ok: true }),
    },
    download: {
      start: () =>
        ok(
          location.hash === '#offline'
            ? { ok: false, error: 'session_check_failed' }
            : location.hash === '#no-session'
              ? { ok: false, error: 'game_session_required' }
              : { ok: true }
        ),
      cancel: () => ok({ ok: true }),
      onProgress: noop,
    },
    install: {
      remove: () => ok({ ok: true }),
      onRemoved: noop,
      size: (appid) => ok(SIZES[appid] ?? null),
      openFolder: () => ok({ ok: true }),
    },
    game: {
      launch: () =>
        ok(
          location.hash === '#offline'
            ? { ok: false, error: 'session_check_failed' }
            : location.hash === '#no-session'
              ? { ok: false, error: 'game_session_required' }
              : { ok: true }
        ),
      onLaunchProgress: noop,
      onUpdateAvailable: noop,
      onDrmWarning: noop,
      sendUpdateDecision: () => {},
    },
    ledger: { balance: () => ok(0), onBalanceUpdate: noop, onBalanceChanged: noop },
    // #no-session in the URL drives the task gate and #offline the
    // server-unreachable path, so both can be looked at without waiting for a
    // session to lapse or pulling the network cable.
    session: {
      game: () =>
        ok(
          location.hash === '#no-session'
            ? { is_active: false, remaining_seconds: 0 }
            : { is_active: true, remaining_seconds: 12_600 }
        ),
      check: () =>
        ok(
          location.hash === '#offline'
            ? 'unreachable'
            : location.hash === '#no-session'
              ? 'required'
              : 'ok'
        ),
    },
    stats: {
      gameTotals: () =>
        ok([
          { appid: 492720, name: 'Tropico 6', seconds: 47_520 },
          { appid: 550, name: 'Left 4 Dead 2', seconds: 28_800 },
          { appid: 105600, name: 'Terraria', seconds: 10_440 },
          { appid: 232770, name: 'POSTAL 2', seconds: 6_240 },
        ]),
    },
    deeplink: { takeCode: () => ok(null), onRedeem: noop },
    shell: { openExternal: () => ok(undefined) },
    steam: {
      appDetails: (appid) => ok(details(appid)),
      news: () => ok(NEWS),
      genres: (appids) =>
        ok({ known: Object.fromEntries(appids.map((a) => [a, GENRES[a] ?? []])) }),
      onGenresUpdate: noop,
    },
    settings: {
      get: () => ok({ installRoot: 'D:\\Games\\SteamLauncher', autoUpdate: true, favorites: [492720, 550] }),
      toggleFavorite: () => ok([492720, 550]),
      chooseInstallDir: () => ok(null),
      setLanguage: () => ok(undefined),
      setAutoUpdate: (v) => ok(v),
    },
    updater: {
      onChecking: noop,
      onAvailable: noop,
      onNotAvailable: noop,
      onError: noop,
      onDownloadProgress: noop,
      onDownloaded: noop,
      installAndRestart: () => ok(undefined),
    },
    drmBoot: { onProgress: noop, onDone: noop },
    i18n: { getEnv: () => ok({ locale: 'ru' }) },
    app: { getVersion: () => ok({ app: '1.1.0', platform: 'win32', electron: '41.0.0' }) },
    window: { close: () => ok(undefined), minimize: () => ok(undefined), maximizeToggle: () => ok(undefined) },
  };

  window.featureFlags = { get: () => ok({ balanceEnabled: false }), onChange: noop };
})();
