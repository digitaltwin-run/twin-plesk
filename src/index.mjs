import fs from "node:fs";
import path from "node:path";

/**
 * Digital Twin Plesk Component
 * Simulates Plesk docroot behavior, detects index.html shadowing, and runs pre-deploy smoke tests.
 */

// Authenticated admin-profile verification (§4.1): Vault-sourced credential ->
// Plesk REST check -> twin update. Secrets never logged; source may be intake,
// API mint, or grant-gated harvest into private Vault.
export { verifyAdminProfile, loadSecretsRoutes, verifyPleskForTicket, assertGrantAllows } from "./plesk-verify.mjs";
export { resolvePleskCredential, revokePleskLease } from "./vault.mjs";

export function detectIndexPageShadowing(docrootPath) {
  const htmlPath = path.join(docrootPath, "index.html");
  const phpPath = path.join(docrootPath, "index.php");

  const hasHtml = fs.existsSync(htmlPath);
  const hasPhp = fs.existsSync(phpPath);

  if (!hasPhp) {
    return { shadowed: false, reason: "no_index_php" };
  }

  if (!hasHtml) {
    return { shadowed: false, reason: "clean_index_php" };
  }

  const htmlContent = fs.readFileSync(htmlPath, "utf8");
  const isPleskDefault = /Domain Default page|default-website-index\.js|Plesk is a <a href="https:\/\/www\.plesk\.com"/i.test(htmlContent);
  const isRedirect = /url=\/index\.php|location\.replace\('\/index\.php'\)/i.test(htmlContent);

  if (isPleskDefault) {
    return { shadowed: true, reason: "plesk_default_page_shadowing", isPleskDefault: true };
  }

  if (isRedirect) {
    return { shadowed: false, reason: "html_redirects_to_php", isRedirect: true };
  }

  return { shadowed: true, reason: "custom_html_shadows_php", isPleskDefault: false };
}

export function validatePleskSourceCompleteness(sourceDir) {
  const findings = [];
  const phpFiles = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".php")) {
        phpFiles.push(full);
      }
    }
  }

  walk(sourceDir);

  for (const file of phpFiles) {
    const content = fs.readFileSync(file, "utf8");
    const requireMatches = content.matchAll(/(?:require|include)(?:_once)?\s*(?:\(?\s*['"]([^'"]+)['"]|dirname\(__DIR__\)\s*\.\s*['"]([^'"]+)['"])/g);
    for (const match of requireMatches) {
      const relPath = match[1] || match[2];
      if (relPath && relPath.startsWith("/lib/")) {
        const expectedLib = path.join(sourceDir, "lib");
        if (!fs.existsSync(expectedLib)) {
          findings.push({
            file: path.relative(sourceDir, file),
            missing: "lib/",
            reason: `Requires ${relPath} but lib/ directory is missing in source_dir`
          });
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    sourceDir,
    phpFilesCount: phpFiles.length,
    findings
  };
}

export function runPreDeploySmokeTest(sourceDir) {
  console.log(`[twin-plesk] Running Digital Twin pre-deploy smoke test on: ${sourceDir}`);
  const completeness = validatePleskSourceCompleteness(sourceDir);
  const shadowing = detectIndexPageShadowing(sourceDir);

  console.log(`[twin-plesk] Source Completeness: ${completeness.ok ? "PASS" : "FAIL"}`);
  console.log(`[twin-plesk] Shadowing Check: ${shadowing.shadowed ? "FAIL (" + shadowing.reason + ")" : "PASS (" + shadowing.reason + ")"}`);

  return {
    ok: completeness.ok && !shadowing.shadowed,
    completeness,
    shadowing
  };
}

if (process.argv.includes("--test") || process.argv.includes("--smoke")) {
  const targetDir = process.argv[3] || process.cwd();
  const res = runPreDeploySmokeTest(targetDir);
  process.exit(res.ok ? 0 : 1);
}
