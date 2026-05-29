/* Build the Tether extension: bundle the TS entry points to the JS files manifest.json references
 * (background.js at the root for the service worker; popup/popup.js for the popup). */
import * as esbuild from "esbuild";

const common = { bundle: true, format: "esm", target: "chrome116", logLevel: "info", legalComments: "none" };

await esbuild.build({ ...common, entryPoints: ["src/background.ts"], outfile: "background.js" });
await esbuild.build({ ...common, entryPoints: ["popup/popup.ts"], outfile: "popup/popup.js" });
/* Content scripts can't use ESM `import` at runtime, so bundle as IIFE. */
await esbuild.build({ ...common, format: "iife", entryPoints: ["src/toast.ts"], outfile: "content/toast.js" });

console.log("Tether extension built: background.js, popup/popup.js, content/toast.js");
