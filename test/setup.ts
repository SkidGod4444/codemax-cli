// Preloaded before every test file (bunfig.toml): keep tests out of the user's real ~/.codemax.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-test-home-"));
