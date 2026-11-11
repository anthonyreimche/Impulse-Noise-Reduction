// Replaces src/safelight.d.ts with the newest generated API types from
// Safelight's repo. Run it with `npm run update-types`, then `npm run check`.

import { writeFileSync } from "node:fs";

const TYPES_URL = "https://raw.githubusercontent.com/anthonyreimche/SafeLight/main/extension-types/safelight.d.ts";

const response = await fetch(TYPES_URL);
if (!response.ok) {
  console.error(`Couldn't download the types (${response.status} ${response.statusText}): ${TYPES_URL}`);
  process.exit(1);
}
const text = await response.text();
writeFileSync(new URL("../src/safelight.d.ts", import.meta.url), text);
const version = /^\/\/ Safelight (\S+)\./m.exec(text)?.[1] ?? "an unknown version";
console.log(`Updated src/safelight.d.ts to Safelight ${version}'s API.`);
