// sharp's own types, named locally.
//
// The package ships them at `lib/index.d.ts` but its `exports` map does not
// point at them, so under `moduleResolution: bundler` TypeScript resolves the
// runtime entry and finds no declarations. Rather than loosen the whole project
// to reach them, the three calls scripts/make-icons.ts makes are declared here.
//
// Only that script imports sharp. If anything else ever does, delete this and
// give the project a real dependency with real types instead.
declare module "sharp" {
  interface Rendered {
    resize(width: number, height: number, options?: { fit?: "cover" | "contain" | "fill" }): Rendered;
    png(options?: { compressionLevel?: number }): Rendered;
    toFile(path: string): Promise<unknown>;
  }
  function sharp(input: Buffer, options?: { density?: number }): Rendered;
  export default sharp;
}
