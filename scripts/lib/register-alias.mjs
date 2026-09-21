// Registers alias-hooks.mjs. Pass with --import; see alias-hooks.mjs for why.
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
