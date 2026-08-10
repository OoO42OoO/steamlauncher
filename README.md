# Steam Client

A desktop client for Steam.

It is an Electron application: a catalog and library of games, per-title
pages built from Steam's public store data, downloads with resume, local
playtime statistics, and a settings surface — in 21 languages.

---

## Stack

| Layer | Technologies |
| --- | --- |
| Application | Electron, TypeScript |
| Interface | React, Tailwind CSS, i18next |
| Build | electron-vite, Vite, esbuild, electron-builder |
| Data | SQLite (better-sqlite3), Zod |
| Tests | Vitest |
| Monorepo | pnpm workspaces |

## Layout

```
apps/desktop      Electron app — main, preload and renderer
apps/extension    Companion browser extension
packages/shared   Types and schemas shared across the workspace
scripts           Build helpers
```

The three Electron processes are kept strictly apart. The renderer holds no
privilege of its own and reaches the system only through a narrow, audited
preload bridge; every filesystem, network and process operation lives in the
main process. Anything the app persists locally is either SQLite or a file
encrypted through the OS keyring.

## Internationalisation

The interface ships in 21 languages, held at exact key parity — a string
added in one locale is added in all of them. Language follows the OS by
default and can be pinned in settings.

---

## Standing on other people's work

This project would not exist in this shape without the people who did the
hard parts first, in the open:

- **[gbe_fork](https://github.com/Detanup01/gbe_fork)** — the maintained fork
  of the Goldberg Steam emulator. Years of careful reverse engineering,
  given away. The client leans on it directly, and the debt is worth saying
  out loud rather than burying in a dependency list.
- **[DepotDownloader](https://github.com/SteamRE/DepotDownloader)** — SteamRE's
  depot client. Everything this app downloads, it downloads through it.
- **[Steamless](https://github.com/atom0s/Steamless)** — atom0s's SteamStub
  unpacker.
- **[Electron](https://www.electronjs.org/)**, **[React](https://react.dev/)**
  and the rest of the toolchain above, each maintained by people who mostly
  never hear thank you.

### What is not in this repository

Deliberately: **no third-party binaries are committed here.** No emulator
build, no depot client, no unpacker — the tree carries source, and nothing
that someone else compiled.

That means a checkout builds the application but does not produce a fully
functional one. To assemble a complete build, fetch gbe_fork and the other
components above from their own projects and place them where the build
expects them:

```
vendor/win-x64/gbe_fork/     gbe_fork release artifacts
vendor/win-x64/steamless/    Steamless
vendor/<platform>/           DepotDownloader
```

Go to the upstream projects for those. They are the ones doing the work, and
their releases are the ones worth trusting.

Service endpoints are configuration rather than source, and are likewise
absent — the build reads them from the environment.
