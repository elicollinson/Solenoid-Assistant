import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getOption } from "./lib/cli";

const MODEL_REPOSITORY = "gravitee-io/Llama-Prompt-Guard-2-86M-onnx";
const MODEL_REVISION = "45a05fbd5337a864edc608f994911f009c37ca57";
const DEFAULT_OUTPUT = "models/prompt-guard-2-86m";

interface ModelFile {
  source: string;
  destination: string;
  sha256: string;
  bytes: number;
}

const MODEL_FILES: readonly ModelFile[] = [
  {
    source: "LICENSE",
    destination: "LICENSE",
    sha256: "90ae4807183070953bd8da5d7be81c4494920fb54c74359383c8a4536bf003c3",
    bytes: 7_553,
  },
  {
    source: "NOTICE",
    destination: "NOTICE",
    sha256: "6d70b1303958ace2c652d10ffcb63cdd8436d49bc0e81c97373df4e329fad0c9",
    bytes: 111,
  },
  {
    source: "config.json",
    destination: "config.json",
    sha256: "a39ae60b9b718b72bbe3f359ad07ddf6909dcb09ccff936c00a488ceb4e983a6",
    bytes: 1_007,
  },
  {
    source: "special_tokens_map.json",
    destination: "special_tokens_map.json",
    sha256: "b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21",
    bytes: 970,
  },
  {
    source: "tokenizer_config.json",
    destination: "tokenizer_config.json",
    sha256: "d5cff0d149f1084504aa8cbdd941289a011ec7f027519feb49e397c58b564398",
    bytes: 19_865,
  },
  {
    source: "tokenizer.json",
    destination: "tokenizer.json",
    sha256: "870798f0e3bb05c636bf62be904b2d8f48ace4785e9c1d71a8a67bd0586c941d",
    bytes: 16_336_105,
  },
  {
    source: "model.onnx",
    destination: "onnx/model.onnx",
    sha256: "fbe0be6a471873b6c52f7d6631c16fbddb88ba8c7ab2ba34ca48e8e77ffd9999",
    bytes: 1_116_138_537,
  },
] as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function downloadFile(file: ModelFile, outputDirectory: string): Promise<void> {
  const destination = resolve(outputDirectory, file.destination);
  const existing = Bun.file(destination);
  if (await existing.exists()) {
    const hash = await sha256File(destination);
    if (hash === file.sha256) {
      console.log(`✓ ${file.destination} (${formatBytes(file.bytes)})`);
      return;
    }
    console.warn(`Existing ${file.destination} failed checksum; replacing it.`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });

  const url =
    `https://huggingface.co/${MODEL_REPOSITORY}/resolve/` +
    `${MODEL_REVISION}/${file.source}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${file.source}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  console.log(`↓ ${file.destination} (${formatBytes(file.bytes)})`);
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(temporary).writer();
  let received = 0;
  let nextProgress = 64_000_000;

  try {
    for await (const chunk of response.body) {
      hasher.update(chunk);
      writer.write(chunk);
      received += chunk.byteLength;
      if (file.bytes >= 64_000_000 && received >= nextProgress) {
        console.log(
          `  ${formatBytes(received)} / ${formatBytes(file.bytes)} ` +
            `(${Math.floor((received / file.bytes) * 100)}%)`,
        );
        nextProgress += 64_000_000;
      }
    }
    await writer.end();
  } catch (error) {
    await Promise.resolve(writer.end()).catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }

  const hash = hasher.digest("hex");
  if (received !== file.bytes || hash !== file.sha256) {
    await rm(temporary, { force: true });
    throw new Error(
      `Verification failed for ${file.source}: received ${received}/${file.bytes} bytes, ` +
        `sha256=${hash}`,
    );
  }

  await rename(temporary, destination);
  console.log(`✓ ${file.destination}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--accept-license")) {
    throw new Error(
      "Llama Prompt Guard 2 is governed by the Llama 4 Community License. " +
        "Review https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M, " +
        "then rerun with --accept-license.",
    );
  }

  const outputDirectory = resolve(
    getOption(args, "output", DEFAULT_OUTPUT),
  );
  await mkdir(outputDirectory, { recursive: true });

  console.log(`Installing Prompt Guard into ${outputDirectory}`);
  console.log(`Pinned source: ${MODEL_REPOSITORY}@${MODEL_REVISION}`);
  for (const file of MODEL_FILES) await downloadFile(file, outputDirectory);

  await Bun.write(
    resolve(outputDirectory, "MODEL_SOURCE.json"),
    `${JSON.stringify({
      repository: MODEL_REPOSITORY,
      revision: MODEL_REVISION,
      installedAt: new Date().toISOString(),
      files: MODEL_FILES,
    }, null, 2)}\n`,
  );
  console.log("Prompt Guard installation complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
