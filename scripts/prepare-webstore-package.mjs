import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const syncScriptPath = path.join(projectRoot, 'scripts', 'sync-runtime-config.mjs');
const manifestPath = path.join(projectRoot, 'manifest.json');
const runtimeConfigPath = path.join(projectRoot, 'runtime-config.json');
const outputGuidePath = path.join(distRoot, 'WEBSTORE_SUBMISSION.md');
const policyUrl = 'https://screenchat.ahmadyaseen.com/privacy';
const dataDeletionUrl = 'https://screenchat.ahmadyaseen.com/data-deletion';

const packageFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'sidepanel.html'
];

const packageDirectories = [
    'icons'
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    ensureDir(dirPath);
}

function removeDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyRecursive(sourcePath, destinationPath) {
    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
        ensureDir(destinationPath);
        for (const entry of fs.readdirSync(sourcePath)) {
            copyRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
        }
        return;
    }

    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
}

function assertExists(relativePath) {
    const absolutePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing required release file: ${relativePath}`);
    }
}

function isLoopbackHostname(hostname = '') {
    const normalized = String(hostname || '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function isPrivateIpv4Address(hostname = '') {
    const parts = hostname.split('.');
    if (parts.length !== 4) return false;
    const octets = parts.map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;

    return false;
}

function isLocalNetworkHostname(hostname = '') {
    const normalized = String(hostname || '').trim().toLowerCase();
    if (!normalized) return false;
    return (
        normalized === 'localhost' ||
        normalized === '0.0.0.0' ||
        normalized === '::1' ||
        normalized === '[::1]' ||
        normalized.endsWith('.local') ||
        isPrivateIpv4Address(normalized)
    );
}

function normalizeProductionApiOrigin(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        throw new Error('runtime-config.json is missing a backend URL.');
    }

    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') {
        throw new Error(`Non-HTTPS backend candidate: ${parsed.origin}`);
    }

    if (isLoopbackHostname(parsed.hostname) || isLocalNetworkHostname(parsed.hostname)) {
        throw new Error(`Local or private backend candidate: ${parsed.origin}`);
    }

    return parsed.origin;
}

function buildProductionRuntimeConfig(runtimeConfig) {
    const configuredCandidates = Array.isArray(runtimeConfig?.apiBaseCandidates) && runtimeConfig.apiBaseCandidates.length > 0
        ? runtimeConfig.apiBaseCandidates
        : [runtimeConfig?.apiBaseUrl];
    const validOrigins = [];
    const skippedCandidates = [];

    for (const candidate of configuredCandidates) {
        try {
            validOrigins.push(normalizeProductionApiOrigin(candidate));
        } catch (error) {
            skippedCandidates.push({
                candidate: String(candidate ?? ''),
                reason: error.message
            });
        }
    }

    const uniqueOrigins = Array.from(new Set(validOrigins));
    if (!uniqueOrigins.length) {
        throw new Error('Refusing to build a Web Store package without at least one public HTTPS backend URL.');
    }

    return {
        apiBaseUrl: uniqueOrigins[0],
        apiBaseCandidates: uniqueOrigins,
        skippedCandidates
    };
}

function runSyncRuntimeConfig() {
    const result = spawnSync(process.execPath, [syncScriptPath], {
        cwd: projectRoot,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error('Failed to regenerate runtime-config.json from .env.');
    }
}

function createZip(sourceDir, zipPath) {
    fs.rmSync(zipPath, { force: true });
    const escapedSource = sourceDir.replace(/'/g, "''");
    const escapedZip = zipPath.replace(/'/g, "''");
    const command = `Compress-Archive -Path '${escapedSource}\\*' -DestinationPath '${escapedZip}' -Force`;
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd: projectRoot,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error('Failed to create the Web Store zip package.');
    }
}

function writeSubmissionGuide(manifest, apiOrigin, zipFileName) {
    const guide = `# ScreenChat Web Store Submission

Generated: ${new Date().toISOString()}

## Upload

- Extension zip: dist/${zipFileName}
- Privacy policy: ${policyUrl}
- Data deletion: ${dataDeletionUrl}
- Support email: ahdfactz@gmail.com
- Backend used by this package: ${apiOrigin}

## Store Listing Copy

- Name: ${manifest.name}
- Short description: Chat with your screen. Ask ScreenChat questions about the current webpage and get AI help in a browser sidebar.
- Single purpose: ScreenChat analyzes the current webpage and answers user questions using the page context, optional screenshots, and saved conversation history.

## Permissions

- activeTab: temporary access to the current tab after the user clicks the extension or uses the hotkey.
- sidePanel: opens ScreenChat in the browser sidebar when the user chooses the sidebar experience.
- scripting: inject the ScreenChat UI into the active tab on demand.
- storage: store sign-in session state, UI preferences, and saved local extension state.
- host permissions (<all_urls>): allows ScreenChat to read page context and capture optional screenshots on whatever site the user explicitly uses it on.

## Privacy Answers

- User data collected: Google sign-in details, page URL, optional screenshots, saved chat history, and profile details supplied by the user.
- User data shared with third parties: Google Firebase for authentication/storage and the configured AI provider for response generation.
- Advertising: ScreenChat does not sell data and does not use data for personalized ads.

## Notes

- The package was built only after validating that runtime-config.json points to a public HTTPS backend.
- If you change ScreenChat/.env, rerun node .\\scripts\\prepare-webstore-package.mjs before uploading a new build.
`;

    fs.writeFileSync(outputGuidePath, guide, 'utf8');
}

function main() {
    runSyncRuntimeConfig();

    assertExists('icons/icon16.png');
    assertExists('icons/icon32.png');
    assertExists('icons/icon48.png');
    assertExists('icons/icon128.png');
    assertExists('icons/icon512.png');
    assertExists('sidepanel.html');

    const manifest = readJson(manifestPath);
    const runtimeConfig = readJson(runtimeConfigPath);
    const productionRuntimeConfig = buildProductionRuntimeConfig(runtimeConfig);
    const apiOrigin = productionRuntimeConfig.apiBaseUrl;
    const zipFileName = `screenchat-chrome-web-store-v${manifest.version}.zip`;
    const zipPath = path.join(distRoot, zipFileName);
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchat-webstore-'));

    resetDir(distRoot);

    try {
        for (const fileName of packageFiles) {
            copyRecursive(path.join(projectRoot, fileName), path.join(stageDir, fileName));
        }

        fs.writeFileSync(
            path.join(stageDir, 'runtime-config.json'),
            `${JSON.stringify({
                apiBaseUrl: productionRuntimeConfig.apiBaseUrl,
                apiBaseCandidates: productionRuntimeConfig.apiBaseCandidates
            }, null, 2)}\n`,
            'utf8'
        );

        for (const directoryName of packageDirectories) {
            copyRecursive(path.join(projectRoot, directoryName), path.join(stageDir, directoryName));
        }

        writeSubmissionGuide(manifest, apiOrigin, zipFileName);
        createZip(stageDir, zipPath);
    } finally {
        removeDir(stageDir);
    }

    if (productionRuntimeConfig.skippedCandidates.length > 0) {
        for (const skippedCandidate of productionRuntimeConfig.skippedCandidates) {
            console.warn(`Skipped backend candidate for packaged build: ${skippedCandidate.candidate} (${skippedCandidate.reason})`);
        }
    }

    console.log(`Created ${path.relative(projectRoot, zipPath)}`);
    console.log(`Wrote ${path.relative(projectRoot, outputGuidePath)}`);
}

main();
