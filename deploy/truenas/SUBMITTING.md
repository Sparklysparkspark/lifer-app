# Submitting Lifer to truenas/apps

Checklist for the PR. None of this file goes into the PR itself.

## When to submit

Wait until Lifer has been on a stable 1.0.0 release for about a month. Reviewers weigh stability,
and every Lifer release becomes an update PR in their catalog.

## Before submitting

1. Use the current stable release (1.0.0 or later). It must contain the non-root image
   (runs as 568:568, `lifer-admin` on PATH).
2. In `ix-dev/community/lifer/`, bump to that release:
   - `app.yaml`: `app_version`
   - `ix_values.yaml`: `images.image.tag`
   - `app.yaml`: `date_added` to the day you open the PR
   - `PR_DESCRIPTION.md`: "App Version", and delete the reminder comment in Special Notes
3. Open an issue in truenas/apps to discuss the addition, and tick that box in the PR description.
4. Copy `ix-dev/community/lifer/` into your fork of truenas/apps, then from the fork's root run:

   ```bash
   devbox run copy-lib
   ./.github/scripts/generate_metadata.py --app lifer --train community
   ./.github/scripts/port_validation.py
   ./.github/scripts/ci.py --app lifer --train community --test-file basic-values.yaml
   ./.github/scripts/ci.py --app lifer --train community --test-file extra-values.yaml
   ```

   - `generate_metadata.py` must leave `app.yaml` unchanged on a second run. If it bumps
     `version`, set it back to `1.0.0` (a new app starts there) and run it again.
   - If `port_validation.py` reports a duplicate for 30504, use the next free port it prints
     (it appears in `questions.yaml`).
   - On an Apple Silicon Mac, their validation image can fail with `openat2 ... Function not
     implemented` under Rosetta. Run these on Linux (or in GitHub Actions on your fork) instead.
5. Attach the icon and screenshots to the PR (see `PR_DESCRIPTION.md`).
