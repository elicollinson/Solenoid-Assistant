// What a vision model is sent: the image shrunk to a size the model can use.
//
// Full-resolution screenshots are several MiB of PNG, a third more again as
// base64, and LM Link drops any request past about 8 MiB ("LM Link connection
// closed", lmstudio-bug-tracker#1859). The model resizes to its own input
// resolution anyway, so the extra pixels bought nothing but the failure.
// The web project reaches this file through server imports and would not
// otherwise see the local declaration.
/// <reference path="../types/sharp.d.ts" />
import { log } from "../core/logger";

/** Long edge, in pixels. Keeps a phone screenshot's small print legible. */
export const VISION_MAX_EDGE = 2048;
const JPEG_QUALITY = 85;

export interface VisionImage {
  data: string;
  mimeType: string;
}

/**
 * Fit the image inside VISION_MAX_EDGE square, upright, as JPEG. A format sharp
 * cannot decode (HEIC without its codec, say) goes as it came: the caller still
 * gets an answer or the provider's own error, never a new failure from here.
 * sharp is native, so it is loaded here rather than at import: a missing binary
 * costs the resize, not every module that imports vision.
 */
export async function visionImage(bytes: Buffer, mimeType: string): Promise<VisionImage> {
  try {
    const { default: sharp } = await import("sharp");
    const shrunk = await sharp(bytes)
      .rotate()
      .resize(VISION_MAX_EDGE, VISION_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { data: shrunk.toString("base64"), mimeType: "image/jpeg" };
  } catch (error) {
    log.warn("vision: image sent unresized", {
      mimeType,
      bytes: bytes.length,
      error_message: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200),
    });
    return { data: bytes.toString("base64"), mimeType };
  }
}
