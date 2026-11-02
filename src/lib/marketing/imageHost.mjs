// Imported by next.config.mjs, so this file can't use TypeScript or path aliases.
const BUCKET_PATH = "/storage/v1/object/public/marketing-assets/**";

/**
 * next/image's allow-list for the marketing bucket. It is fixed at build time, so
 * each build allows only the host it was built with.
 *
 * @param {string | undefined} supabaseUrl
 * @param {boolean} required true for `next build`. `next lint` and `next dev` load
 *   the config too, and CI's lint step has no Supabase env.
 */
export function marketingRemotePatterns(supabaseUrl, required) {
  let url = null;
  try {
    url = supabaseUrl ? new URL(supabaseUrl) : null;
  } catch {
    url = null;
  }

  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    if (required) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL is missing or invalid. next/image needs it to allow marketing images.",
      );
    }
    return [];
  }

  return [
    {
      protocol: url.protocol.replace(":", ""),
      hostname: url.hostname,
      port: url.port,
      pathname: BUCKET_PATH,
    },
  ];
}
