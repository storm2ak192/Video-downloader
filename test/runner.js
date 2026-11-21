const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function collectFiles(directory, extensions, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(fullPath, extensions, output);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) output.push(fullPath);
  }
  return output;
}

test("first-party browser and server JavaScript parses", () => {
  const roots = ["api", "public/js"];
  const files = roots.flatMap((folder) => collectFiles(path.join(ROOT, folder), [".js", ".mjs"]));
  assert.ok(files.length > 10, "expected to inspect the application modules");
  const failures = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: source,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failures.push(path.relative(ROOT, file) + ": " + (result.stderr || result.stdout).trim());
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("all bundled scraper provider hosts are covered by the safe web relay", () => {
  const bundle = fs.readFileSync(path.join(ROOT, "public/js/scrapers/bundle.js"), "utf8");
  const proxy = fs.readFileSync(path.join(ROOT, "api/proxy.js"), "utf8");
  const frontend = fs.readFileSync(path.join(ROOT, "public/js/scrapers/index.js"), "utf8");
  const match = proxy.match(/const ALLOWED_HOSTS = \[([\s\S]*?)\];/);
  const frontMatch = frontend.match(/const RELAY_HOSTS = \[([\s\S]*?)\];/);
  assert.ok(match, "server proxy allowlist must exist");
  assert.ok(frontMatch, "browser relay allowlist must exist");
  const allowed = [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const frontAllowed = [...frontMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const hosts = [...new Set((bundle.match(/https?:\\?\/\\?\/[A-Za-z0-9._-]+/g) || [])
    .map((value) => value.replace(/\\\//g, "/").replace(/^https?:\/\//, "").toLowerCase())
    .filter((host) => host.includes(".") && !["dns.google", "cloudflare-dns.com"].includes(host)))];
  const isCovered = (host, domains) => domains.some((domain) =>
    host === domain || host.endsWith("." + domain)
  );
  const missingServer = hosts.filter((host) => !isCovered(host, allowed));
  const missingBrowser = hosts.filter((host) => !isCovered(host, frontAllowed));
  assert.deepEqual(missingServer, [], "Server proxy is missing: " + missingServer.join(", "));
  assert.deepEqual(missingBrowser, [], "Browser relay is missing: " + missingBrowser.join(", "));
});

test("browser Spleeter releases the actual chunk buffer and not an undefined variable", () => {
  const source = fs.readFileSync(path.join(ROOT, "public/js/modules/tools/spleeterWeb.js"), "utf8");
  assert.match(source, /parts\.length\s*=\s*0/);
  assert.doesNotMatch(source, /chunks\.length\s*=\s*0/);
  assert.match(source, /separateVideoAudioFile/);
  assert.match(source, /recordVideoFromFile/);
});

test("browser scraper requests use the same-origin relay while native requests remain direct", () => {
  const source = fs.readFileSync(path.join(ROOT, "public/js/scrapers/index.js"), "utf8");
  assert.match(source, /installBrowserScraperRelay\(\)/);
  assert.match(source, /window\.Capacitor\?\.isNativePlatform\?\.\(\)/);
  assert.match(source, /\/api\/proxy/);
  assert.match(source, /endsWith\("\." \+ domain\)/);
  assert.match(source, /if \(!init\.headers && !isRequestInput\) return nativeFetch\(input, init\)/);
});

test("Facebook web scraping has a bundled-parser fallback", () => {
  const source = fs.readFileSync(path.join(ROOT, "public/js/scrapers/index.js"), "utf8");
  assert.match(source, /const primary = await scrapeFacebookWeb\(url\)/);
  assert.match(source, /\.scrapeFacebook\(url, \.\.\.args\)/);
});

test("Vercel build configuration and browser WASM outputs are present", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  assert.equal(pkg.scripts["build:web"], "npm test && bash scripts/build-spleeter-wasm.sh");
  assert.equal(pkg.dependencies.axios, undefined, "unused vulnerable Axios must not be installed");
  assert.equal(vercel.outputDirectory, "public");
  assert.equal(vercel.buildCommand, "npm run build:web");
  assert.ok(fs.existsSync(path.join(ROOT, "wasm/spleeter/mori-spleeter-wasm.cc")));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/build-spleeter-wasm.sh")));
});

test("the shell build script is syntactically valid", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts/build-spleeter-wasm.sh"), "utf8");
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
