#!/usr/bin/env bun
// Build and scan the same Linux ARM64 application image the release publishes.
// This is deliberately a local command as well as a CI policy: a developer can
// find a vulnerable image before opening a PR, while release-preflight.yml keeps
// the same gate visible on the PR itself.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const image = process.env.RELEASE_PREFLIGHT_IMAGE ?? "solenoid-assistant:release-preflight";

function fail(message: string): never {
  console.error(`\nrelease preflight failed: ${message}`);
  process.exit(1);
}

function capture(command: string, args: string[], failure?: string): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error?.message.includes("ENOENT")) {
    fail(failure ?? `${command} is not installed or not on PATH.`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    fail(`${failure ?? `${command} ${args.join(" ")} did not succeed.`}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function run(label: string, command: string, args: string[]): void {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error?.message.includes("ENOENT")) {
    fail(`${command} is not installed or not on PATH.`);
  }
  if (result.status !== 0) fail(`${label} exited with status ${result.status ?? "unknown"}.`);
}

capture("docker", ["--version"], "Docker CLI is required. Install Docker Desktop (or Docker Engine) and try again.");
capture(
  "docker",
  ["info", "--format", "{{.ServerVersion}}"],
  "the Docker daemon is unavailable. Start Docker Desktop (or dockerd), then run this command again.",
);
capture(
  "docker",
  ["buildx", "version"],
  "Docker Buildx is required. Install or enable the Buildx plugin and try again.",
);
capture(
  "trivy",
  ["--version"],
  "Trivy is required. Install it (for example, `brew install trivy`) and run this command again.",
);

run("build Linux ARM64 production image", "docker", [
  "buildx",
  "build",
  "--platform",
  "linux/arm64",
  "--pull",
  "--load",
  "--file",
  "deploy/Dockerfile",
  "--build-arg",
  "VERSION=preflight",
  "--tag",
  image,
  ".",
]);

const platform = capture("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]);
if (platform !== "linux/arm64") fail(`built ${platform || "an unknown platform"}; expected linux/arm64.`);

run("scan fixable HIGH/CRITICAL vulnerabilities", "trivy", [
  "image",
  "--platform",
  "linux/arm64",
  "--format",
  "table",
  "--exit-code",
  "1",
  "--ignore-unfixed",
  "--severity",
  "HIGH,CRITICAL",
  "--pkg-types",
  "os,library",
  image,
]);

console.log(`\nrelease preflight passed: ${image} is a clean linux/arm64 production image.`);
