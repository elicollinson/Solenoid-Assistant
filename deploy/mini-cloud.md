# Deploying through mini-cloud

Solenoid Assistant publishes a native Linux ARM64 image and asks mini-cloud to
open a digest-pinning promotion PR. Building an image does not deploy it:
merging the mini-cloud PR chooses the artifact, and `make apply` on the appliance
makes that desired state live. Reverting the promotion PR restores the previous
image digest.

See [mini-cloud deployment network flow](mini-cloud-network-flow.md) for the
GitHub, GHCR, Tailscale, and appliance trust boundaries.

## Pipeline

`.github/workflows/release.yml` runs on deployable changes to `main` and on a
manual dispatch:

1. Typecheck and test the application.
2. Build Linux ARM64 with the same recipe as mini-cloud's
   `build-publish.yml`, publish `ghcr.io/elicollinson/solenoid-assistant`, and
   reject HIGH/CRITICAL vulnerabilities with Trivy.
3. Send mini-cloud a `promote-image` repository dispatch containing
   `app=solenoid-assistant` and the immutable image reference.
4. mini-cloud runs `scripts/promote` and opens a PR that pins the digest in
   `compose/apps/solenoid-assistant.yaml`.

The image tag is the source commit SHA for debugging; deployment always uses the
digest emitted by the build.

## One-time GitHub setup

Create a fine-grained personal access token limited to the
`elicollinson/mini-cloud` repository with **Contents: write** permission. Store
it in the Solenoid Assistant repository as the Actions secret
`MINI_CLOUD_DISPATCH_TOKEN`.

mini-cloud should also have `PROMOTE_TOKEN`: a fine-grained token with Contents
and Pull requests write access to mini-cloud. Without it, the promotion workflow
can fall back to `GITHUB_TOKEN`, but GitHub will not run the validation workflow
on the PR created by that token.

Merge mini-cloud's Solenoid manifest/route change before merging this workflow.
Otherwise the first dispatch correctly fails because `scripts/promote` refuses
to create an app definition it has never reviewed.

The image contains no credentials or personal data, so making the GHCR package
public is the simplest pull setup. If it stays private, log the appliance's
Docker daemon into `ghcr.io` with a token that has `read:packages` before the
first `make apply`.

mini-cloud is private while this repository is public. GitHub does not allow a
public caller to use a private reusable workflow, so `release.yml` currently
mirrors that small build job locally. If the repositories later have compatible
visibility, the `image` job can be replaced with a call to
`elicollinson/mini-cloud/.github/workflows/build-publish.yml@main`.

## Runtime boundary

This deployment intentionally runs the portable part of Solenoid. A Linux
container cannot use macOS PhotoKit/`osxphotos`; direct Photos screenshot flows
are unavailable. iMessage and Contacts also remain unavailable until a separate
host-side, read-only snapshot bridge is added. The API, web UI, scheduled worker,
Prompt Guard, remote model providers, SQLite state, OKF store, Phoenix traces,
and VictoriaLogs shipping run in mini-cloud.

mini-cloud's app runbook contains the SOPS variable inventory, one-time Prompt
Guard model installation, workflow-catalog seed, backup coverage, and the
promotion/apply/rollback commands.
