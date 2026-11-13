import meta from "../lib/img-meta.json";

const WIDTHS = [480, 960, 1600];
const info = meta as Record<string, { w: number; h: number }>;

/** A photo as AVIF / WebP with a JPEG fallback, responsive (srcset + sizes), with intrinsic width/height so nothing jumps. Lazy unless `eager`. */
export function Pic({ name, sizes = "100vw", className, eager = false, alt = "" }: { name: string; sizes?: string; className?: string; eager?: boolean; alt?: string }) {
  const m = info[name];
  const set = (ext: string) => WIDTHS.map((w) => `/assets/img/${name}-${w}.${ext} ${w}w`).join(", ");
  return (
    <picture>
      <source type="image/avif" srcSet={set("avif")} sizes={sizes} />
      <source type="image/webp" srcSet={set("webp")} sizes={sizes} />
      <img className={className} src={`/assets/${name}.jpg`} width={m?.w} height={m?.h} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" {...(eager ? { fetchPriority: "high" as const } : {})} />
    </picture>
  );
}

/** CSS background for a photo: AVIF, then WebP, then JPEG. */
export const bgImage = (name: string, w = 1600) => `image-set(url(/assets/img/${name}-${w}.avif) type("image/avif"), url(/assets/img/${name}-${w}.webp) type("image/webp"), url(/assets/${name}.jpg) type("image/jpeg"))`;
