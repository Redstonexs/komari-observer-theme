# Third-party notices

The built theme (`dist/`, and therefore the released `.zip`) bundles third-party
code. This file records what and under which terms.

---

## GSAP — **not** an open-source licence

Observer bundles [GSAP](https://gsap.com) and `@gsap/react`.

GSAP is distributed under the **GSAP Standard "No Charge" License**
(© Webflow, Inc.), *not* MIT and *not* any OSI-approved licence:

> https://gsap.com/standard-license

Points that matter for anyone redistributing or forking this theme:

- **Free for this use.** Since GSAP 3.13.0 (released 2025-04-30) the entire
  toolset — including every formerly Club-only plugin such as SplitText,
  MorphSVG, DrawSVG, Flip and ScrambleText — is free for commercial use. Observer
  uses `gsap`, `Flip`, `DrawSVGPlugin` and `ScrambleTextPlugin`.
- **Permitted use.** The licence's "Prohibited Uses" clause is narrowly scoped to
  building a no-code visual animation builder that competes with Webflow. A
  server-monitoring dashboard is squarely a permitted use.
- **Redistribution is allowed, sublicensing is not.** The grant covers
  reproducing and displaying GSAP, which is what bundling it into this theme's
  ZIP does. It does **not** grant the right to sublicense. This repository's own
  licence therefore does **not** cover the bundled GSAP bytes — GSAP remains
  under its own terms wherever this theme is redistributed.
- **Do not strip the notices.** Section III forbids removing proprietary notices.
  Minifiers drop comments by default, so `vite.config.ts` sets
  `esbuild.legalComments: "inline"` to keep GSAP's `/*! ... @license ... */`
  banners in the output. `scripts/verify-dist.mjs` fails the build if they go
  missing. Do not "clean up" either of those.

> **Note for anyone reading older material:** the restrictive *"Plain English
> Summary"* still present in the licence page's HTML (the one about end users
> being charged a fee) is wrapped in HTML comments — it is dead legacy text from
> the pre-2025 licence and is quoted by a lot of out-of-date blog posts. It is
> not part of the current terms.

---

## MIT-licensed dependencies

The following are bundled under the MIT licence:

| Package | Project |
| --- | --- |
| `react`, `react-dom` | https://github.com/facebook/react |
| `react-router` | https://github.com/remix-run/react-router |
| `zustand` | https://github.com/pmndrs/zustand |
| `i18next`, `react-i18next` | https://github.com/i18next/i18next |
| `tailwindcss` | https://github.com/tailwindlabs/tailwindcss |

Build-time only (not shipped in `dist/`): `vite`, `typescript`, `esbuild`,
`@vitejs/plugin-react`, `@tailwindcss/vite`.

---

## Komari

Observer is a third-party theme for [Komari Monitor](https://github.com/komari-monitor/komari)
and is not affiliated with or endorsed by the Komari project. The
"Powered by Komari Monitor." attribution in the footer is required by Komari's
theme guidelines and must not be removed.
