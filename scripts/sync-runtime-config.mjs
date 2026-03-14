import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const outputPath = path.join(projectRoot, 'runtime-config.json');

function parseEnvFile(rawText) {
    const values = {};
    for (const line of rawText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;
        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
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

function normalizeCandidate(rawValue) {
    if (typeof rawValue !== 'string') return null;
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
    const parsed = new URL(withoutTrailingSlash);
    const isLoopback = isLoopbackHostname(parsed.hostname);
    const isAllowedHttpsOrigin = parsed.protocol === 'https:' && (!isLocalNetworkHostname(parsed.hostname) || isLoopback);
    const isAllowedHttpLoopbackOrigin = parsed.protocol === 'http:' && isLoopback;
    if (!isAllowedHttpsOrigin && !isAllowedHttpLoopbackOrigin) {
        throw new Error(`Backend URL must use https, except for explicit localhost/127.0.0.1 dev URLs: ${trimmed}`);
    }
    return parsed.origin;
}

const envValues = fs.existsSync(envPath)
    ? parseEnvFile(fs.readFileSync(envPath, 'utf8'))
    : {};
const rawCandidateList = [
    process.env.SCREENCHAT_API_BASE_URLS,
    envValues.SCREENCHAT_API_BASE_URLS,
    process.env.SCREENCHAT_BACKEND_URL,
    envValues.SCREENCHAT_BACKEND_URL
].filter(Boolean);

const candidates = [];
for (const rawEntry of rawCandidateList) {
    const parts = String(rawEntry)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    for (const part of parts) {
        candidates.push(normalizeCandidate(part));
    }
}

const uniqueCandidates = Array.from(new Set(candidates));
if (!uniqueCandidates.length) {
    throw new Error('No backend URL configured. Set SCREENCHAT_BACKEND_URL or SCREENCHAT_API_BASE_URLS in the environment or .env.');
}

const payload = {
    apiBaseUrl: uniqueCandidates[0],
    apiBaseCandidates: uniqueCandidates
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Wrote ${path.relative(projectRoot, outputPath)} with ${uniqueCandidates.length} backend URL(s).`);
