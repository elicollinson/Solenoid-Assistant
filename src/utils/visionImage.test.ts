// The image a vision model is sent: small enough for LM Link's frame limit,
// still the same picture.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { VISION_MAX_EDGE, visionImage } from "./visionImage";

const decoded = async (data: string) => sharp(Buffer.from(data, "base64")).metadata();

describe("the image sent to a vision model", () => {
  test("a full-size phone screenshot fits the long edge, keeps its shape, and goes as JPEG", async () => {
    // Noise is the worst case for PNG: well past LM Link's limit as it was sent.
    const width = 1290, height = 2796;
    const raw = randomBytes(width * height * 3);
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const sent = await visionImage(png, "image/png");
    expect(sent.mimeType).toBe("image/jpeg");
    const meta = await decoded(sent.data);
    expect(meta.height).toBe(VISION_MAX_EDGE);
    expect(meta.width).toBe(Math.round((width * VISION_MAX_EDGE) / height));
    expect(png.toString("base64").length).toBeGreaterThan(8 * 1024 * 1024);
    expect(sent.data.length).toBeLessThan(8 * 1024 * 1024);
  });

  test("a small image is not enlarged", async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#c00" } }).png().toBuffer();
    const meta = await decoded((await visionImage(png, "image/png")).data);
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  test("bytes sharp cannot read are passed through as they came", async () => {
    const odd = Buffer.from("not an image");
    expect(await visionImage(odd, "image/heic")).toEqual({ data: odd.toString("base64"), mimeType: "image/heic" });
  });
});
