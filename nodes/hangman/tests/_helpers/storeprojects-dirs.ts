/**
 * Shared helper: discover every storeprojects node-directory dynamically.
 *
 * Tests that spin up a BrainService usually need most or all of the
 * built-in node catalog (clock, brain, echo, memory, llm-basic, …).
 * This helper scans `storeprojects/` at runtime and returns every
 * directory that looks like a node-catalog (i.e. `<brAIn-*>/nodes/`).
 * Adding a new area to the workspace? It's picked up automatically.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// __dirname = storeprojects/brAIn-X/nodes/Y/tests/_helpers
// up 5 -> storeprojects/
const STOREPROJECTS_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

export function allStoreprojectNodeDirs(): string[] {
  if (!fs.existsSync(STOREPROJECTS_ROOT)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(STOREPROJECTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^brAIn-/i.test(entry.name)) continue;
    const candidate = path.join(STOREPROJECTS_ROOT, entry.name, "nodes");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      out.push(candidate);
    }
  }
  return out.sort();
}
