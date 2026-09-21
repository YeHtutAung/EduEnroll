// Node module-resolution hooks that let an ops script import app code.
//
// App code imports "@/..." (the tsconfig path alias) and extensionless
// relative paths, neither of which plain `node --experimental-strip-types`
// resolves. These hooks map both onto real .ts files under src/, so a script
// can call the same functions the app does instead of re-implementing them.
//
// Registered by register-alias.mjs; see the usage line in each script.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const CANDIDATES = ["", ".ts", ".tsx", `${path.sep}index.ts`];

function toFile(base) {
  for (const suffix of CANDIDATES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let base = null;

  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    const parent = fileURLToPath(context.parentURL);
    // Only rewrite imports made FROM app code; leave node_modules alone.
    if (parent.startsWith(SRC)) base = path.resolve(path.dirname(parent), specifier);
  }

  if (base) {
    const file = toFile(base);
    if (file) return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
