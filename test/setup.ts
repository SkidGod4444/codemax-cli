// Preloaded before every test file (bunfig.toml): keep tests out of the user's real ~/.codemax.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CODEMAX_HOME = mkdtempSync(join(tmpdir(), "codemax-test-home-"));
// And out of the developer's real agent setups (MCP servers, skills): an empty home for src/core/share.ts.
process.env.CODEMAX_SHARE_HOME = mkdtempSync(join(tmpdir(), "codemax-test-sharehome-"));
