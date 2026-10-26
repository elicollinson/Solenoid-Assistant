// sharp's own types, named locally.
//
// The package ships them at `lib/index.d.ts` but its `exports` map does not
// point at them, so under `moduleResolution: bundler` TypeScript resolves the
// runtime entry and finds no declarations. Rather than loosen the whole project
// to reach them, the calls this repo makes are declared here: shrinking images
// for vision models (../utils/visionImage.ts) and scripts/make-icons.ts.
declare module "sharp" {
  interface Rendered {
    resize(width: number, height: number, options?: { fit?: "cover" | "contain" | "fill" | "inside"; withoutEnlargement?: boolean }): Rendered;
    rotate(): Rendered;
    png(options?: { compressionLevel?: number }): Rendered;
    jpeg(options?: { quality?: number }): Rendered;
    metadata(): Promise<{ width?: number; height?: number; format?: string }>;
    toBuffer(): Promise<Buffer>;
    toFile(path: string): Promise<unknown>;
  }
  type Input = Buffer | Uint8Array | { create: { width: number; height: number; channels: 3 | 4; background: string } };
  function sharp(
    input: Input,
    options?: { density?: number; raw?: { width: number; height: number; channels: 1 | 2 | 3 | 4 } },
  ): Rendered;
  export default sharp;
}
