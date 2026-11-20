# Lifer site kit

The look of the Lifer website: design tokens and a few React components, under the MIT license
(see `LICENSE`). The rest of this repository is AGPL-3.0.

- `tokens.css`: colours, radii, spacing and type, matching `apps/web/src/theme.css`. Light on
  `:root`, dark on `[data-theme="dark"]`. Override the accent in one place by redefining
  `--color-accent` and `--color-link`.
- `components/`: `Hero`, `Section`, `FeatureRow`, `ScreenshotFrame`, `DownloadCard`, `PlatformPicker`,
  `Callout`, `CardGrid`, `PartnerCard`, `ButtonLink`. They use the tokens only, through one CSS module.
- `tokens.test.ts`: fails if a shared token drifts from the app, or a text pair drops under 4.5:1.
  Run it with `npm test` in `docs/`.

See every component at `/site-kit` on a running docs site.
