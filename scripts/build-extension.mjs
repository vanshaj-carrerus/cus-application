// Builds the CUS Assist browser extension into extension/dist (load it unpacked) and zips it to
// storage/helper/CUS-Assist-Extension.zip, which the portal serves from "Download extension".
//   npm run build:extension
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "extension", "dist");
const zip = path.join(root, "storage", "helper", "CUS-Assist-Extension.zip");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(path.dirname(zip), { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, "extension", "src", "background.ts"),
    content: path.join(root, "extension", "src", "content.ts"),
    popup: path.join(root, "extension", "src", "popup.ts"),
    "main-world": path.join(root, "extension", "src", "main-world.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  tsconfig: path.join(root, "tsconfig.json"),
  logLevel: "warning",
});
copyFileSync(path.join(root, "extension", "manifest.json"), path.join(dist, "manifest.json"));
copyFileSync(path.join(root, "extension", "popup.html"), path.join(dist, "popup.html"));

rmSync(zip, { force: true });
if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${path.join(dist, "*")}' -DestinationPath '${zip}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-r", "-q", zip, "."], { cwd: dist, stdio: "inherit" });
}
console.log(`[extension] built ${path.relative(root, dist)} and ${path.relative(root, zip)}`);
