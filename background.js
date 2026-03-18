// Background Service Worker for ScreenChat

const RUNTIME_CONFIG_URL = chrome.runtime.getURL('runtime-config.json');
const HOTKEY_DEBUG_ENABLED = false;
let hotkeyRequestCounter = 0;
let runtimeConfigLoadPromise = null;
let allowedApiOrigins = new Set();

function hotkeyLog(event, details = {}) {
    if (!HOTKEY_DEBUG_ENABLED) return;
    console.log('[ScreenChat][Hotkey][Background]', event, {
        ts: new Date().toISOString(),
        ...details
    });
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

function isLoopbackHostname(hostname = '') {
    const normalized = String(hostname || '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function isAllowedConfiguredApiOrigin(parsed) {
    if (!parsed) return false;
    if (parsed.protocol === 'https:') {
        return !isLocalNetworkHostname(parsed.hostname) || isLoopbackHostname(parsed.hostname);
    }
    return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
}

function normalizeConfiguredApiBaseUrl(rawValue) {
    if (typeof rawValue !== 'string') return null;
    const trimmed = rawValue.trim();
    if (!trimmed) return null;

    try {
        const parsed = new URL(trimmed.replace(/\/+$/, ''));
        if (!isAllowedConfiguredApiOrigin(parsed)) {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

async function ensureRuntimeConfigLoaded() {
    if (allowedApiOrigins.size > 0) return;
    if (!runtimeConfigLoadPromise) {
        runtimeConfigLoadPromise = (async () => {
            const response = await fetch(RUNTIME_CONFIG_URL, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error('Failed to load extension runtime config');
            }

            const payload = await response.json().catch(() => null);
            const configuredCandidates = Array.isArray(payload?.apiBaseCandidates)
                ? payload.apiBaseCandidates
                : (typeof payload?.apiBaseUrl === 'string' ? [payload.apiBaseUrl] : []);
            const normalizedOrigins = configuredCandidates
                .map((candidate) => normalizeConfiguredApiBaseUrl(candidate))
                .filter(Boolean);

            if (!normalizedOrigins.length) {
                throw new Error('No valid backend URL configured for ScreenChat');
            }

            allowedApiOrigins = new Set(normalizedOrigins);
        })().catch((error) => {
            runtimeConfigLoadPromise = null;
            throw error;
        });
    }
    return runtimeConfigLoadPromise;
}

function isAllowedApiRequestUrl(rawUrl = '') {
    try {
        const parsed = new URL(rawUrl);
        return allowedApiOrigins.has(parsed.origin);
    } catch {
        return false;
    }
}

function buildProxyRequestConfig(payload) {
    const requestUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
    if (!requestUrl || !isAllowedApiRequestUrl(requestUrl)) {
        throw new Error('Blocked API request URL');
    }

    const sourceOptions = payload?.options && typeof payload.options === 'object' ? payload.options : {};
    const method = typeof sourceOptions.method === 'string' ? sourceOptions.method : 'GET';
    const headers = sourceOptions.headers && typeof sourceOptions.headers === 'object'
        ? sourceOptions.headers
        : undefined;
    const body = typeof sourceOptions.body === 'string' ? sourceOptions.body : undefined;

    return { requestUrl, method, headers, body };
}

async function proxyApiFetch(message) {
    await ensureRuntimeConfigLoaded();
    const { requestUrl, method, headers, body } = buildProxyRequestConfig(message);

    const response = await fetch(requestUrl, { method, headers, body });
    const bodyText = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });

    return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        bodyText
    };
}

async function proxyApiStream(port, payload, abortController) {
    await ensureRuntimeConfigLoaded();
    const { requestUrl, method, headers, body } = buildProxyRequestConfig(payload);
    const response = await fetch(requestUrl, {
        method,
        headers,
        body,
        signal: abortController.signal
    });

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });

    if (!response.ok) {
        const bodyText = await response.text();
        port.postMessage({
            type: 'http_error',
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            bodyText
        });
        return;
    }

    port.postMessage({
        type: 'response_meta',
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
    });

    if (!response.body || typeof response.body.getReader !== 'function') {
        const bodyText = await response.text();
        if (bodyText) {
            port.postMessage({ type: 'chunk', chunk: bodyText });
        }
        port.postMessage({ type: 'end' });
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) {
            port.postMessage({ type: 'chunk', chunk });
        }
    }

    const tail = decoder.decode();
    if (tail) {
        port.postMessage({ type: 'chunk', chunk: tail });
    }
    port.postMessage({ type: 'end' });
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'proxy_api_stream') return;

    let disconnected = false;
    const abortController = new AbortController();

    const onDisconnect = () => {
        disconnected = true;
        abortController.abort();
    };

    port.onDisconnect.addListener(onDisconnect);

    port.onMessage.addListener((message) => {
        const type = message?.type;
        if (type === 'abort') {
            abortController.abort();
            return;
        }
        if (type !== 'start') return;

        (async () => {
            try {
                await proxyApiStream(port, message, abortController);
            } catch (error) {
                if (disconnected || abortController.signal.aborted) {
                    return;
                }
                port.postMessage({
                    type: 'error',
                    error: error?.message || 'Proxy API stream failed'
                });
            }
        })();
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action;
    const supportedActions = new Set([
        'capture_visible_tab',
        'get_active_tab_url',
        'proxy_api_fetch'
    ]);
    if (!supportedActions.has(action)) return undefined;

    (async () => {
        try {
            if (action === 'capture_visible_tab') {
                const windowId = sender?.tab?.windowId;
                const image = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
                sendResponse({ ok: true, image });
                return;
            }

            if (action === 'proxy_api_fetch') {
                const result = await proxyApiFetch(message);
                sendResponse(result);
                return;
            }

            const senderTabUrl = typeof sender?.tab?.url === 'string' && sender.tab.url.trim()
                ? sender.tab.url.trim()
                : null;
            sendResponse({ ok: true, url: senderTabUrl });
        } catch (error) {
            if (action === 'capture_visible_tab') {
                console.error('Screen capture failed:', error);
                sendResponse({ ok: false, error: 'Unable to capture current screen' });
                return;
            }
            if (action === 'proxy_api_fetch') {
                console.warn('Proxy API fetch failed:', error);
                sendResponse({ ok: false, error: error?.message || 'Proxy API fetch failed' });
                return;
            }

            console.warn('Active tab URL lookup failed:', error);
            sendResponse({
                ok: false,
                url: typeof sender?.tab?.url === 'string' && sender.tab.url.trim()
                    ? sender.tab.url.trim()
                    : null
            });
        }
    })();

    return true;
});

function isRestrictedUrl(url = '') {
    return (
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:') ||
        url.startsWith('chrome-extension://')
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openUi(tabId, attempts = 3, payload = {}) {
    return sendUiAction(tabId, 'open_ui', attempts, payload);
}

async function toggleUi(tabId, attempts = 3, payload = {}) {
    return sendUiAction(tabId, 'hotkey_toggle_ui', attempts, payload);
}

async function sendUiAction(tabId, action, attempts = 3, payload = {}) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        const attempt = i + 1;
        try {
            hotkeyLog('send_ui_action_attempt', {
                tabId,
                action,
                attempt,
                attempts,
                hotkeyRequestId: payload.hotkeyRequestId || null
            });
            await chrome.tabs.sendMessage(tabId, { action, ...payload });
            hotkeyLog('send_ui_action_success', {
                tabId,
                action,
                attempt,
                attempts,
                hotkeyRequestId: payload.hotkeyRequestId || null
            });
            return;
        } catch (e) {
            lastError = e;
            hotkeyLog('send_ui_action_error', {
                tabId,
                action,
                attempt,
                attempts,
                hotkeyRequestId: payload.hotkeyRequestId || null,
                error: e?.message || String(e)
            });
            if (i === attempts - 1) break;
            await sleep(80);
        }
    }
    throw lastError || new Error(`Failed to send UI action: ${action}`);
}

async function activateScreenChat(tab) {
    if (!tab?.id || isRestrictedUrl(tab.url || '')) {
        return;
    }
    await dispatchUiAction(tab, 'open_ui');
}

function defer(task, delayMs = 220) {
    setTimeout(() => {
        Promise.resolve()
            .then(task)
            .catch((error) => console.error('Deferred task failed:', error));
    }, delayMs);
}

chrome.action.onClicked.addListener((tab) => {
    defer(async () => {
        try {
            await activateScreenChat(tab);
        } catch (err) {
            console.error('ScreenChat action click failed:', err);
        }
    });
});

chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-screenchat') return;
    hotkeyLog('command_received', { command });

    defer(async () => {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab) {
                hotkeyLog('command_no_active_tab');
                return;
            }
            hotkeyLog('command_active_tab', {
                tabId: activeTab.id,
                url: activeTab.url || null
            });
            await toggleScreenChatWithHotkey(activeTab);
        } catch (err) {
            console.error('ScreenChat hotkey command failed:', err);
            hotkeyLog('command_failed', { error: err?.message || String(err) });
        }
    });
});

async function toggleScreenChatWithHotkey(tab) {
    if (!tab?.id || isRestrictedUrl(tab.url || '')) {
        hotkeyLog('hotkey_toggle_skipped_restricted', {
            tabId: tab?.id || null,
            url: tab?.url || null
        });
        return;
    }

    const hotkeyRequestId = `hk-${Date.now()}-${++hotkeyRequestCounter}`;
    const hotkeyIssuedAt = Date.now();
    hotkeyLog('hotkey_toggle_dispatch_start', {
        tabId: tab.id,
        url: tab.url || null,
        hotkeyRequestId
    });
    await dispatchUiAction(tab, 'hotkey_toggle_ui', { hotkeyRequestId, hotkeyIssuedAt });
    hotkeyLog('hotkey_toggle_dispatch_done', {
        tabId: tab.id,
        hotkeyRequestId
    });
}

async function dispatchUiAction(tab, action, payload = {}) {
    hotkeyLog('dispatch_ui_action_start', {
        tabId: tab.id,
        action,
        hotkeyRequestId: payload.hotkeyRequestId || null
    });
    // Fast path: content script is already running in the tab.
    try {
        if (action === 'open_ui') {
            await openUi(tab.id, 1, payload);
        } else {
            await toggleUi(tab.id, 1, payload);
        }
        hotkeyLog('dispatch_ui_action_fast_path_ok', {
            tabId: tab.id,
            action,
            hotkeyRequestId: payload.hotkeyRequestId || null
        });
        return;
    } catch (firstError) {
        hotkeyLog('dispatch_ui_action_fast_path_failed', {
            tabId: tab.id,
            action,
            hotkeyRequestId: payload.hotkeyRequestId || null,
            error: firstError?.message || String(firstError)
        });
    }

    await injectContentScript(tab);
    hotkeyLog('dispatch_ui_action_after_inject', {
        tabId: tab.id,
        action,
        hotkeyRequestId: payload.hotkeyRequestId || null
    });
    if (action === 'open_ui') {
        await openUi(tab.id, 3, payload);
    } else {
        await toggleUi(tab.id, 3, payload);
    }
    hotkeyLog('dispatch_ui_action_done', {
        tabId: tab.id,
        action,
        hotkeyRequestId: payload.hotkeyRequestId || null
    });
}

async function injectContentScript(tab) {
    try {
        hotkeyLog('inject_content_script_start', { tabId: tab.id });
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });
        hotkeyLog('inject_content_script_done', { tabId: tab.id });
    } catch (err) {
        console.error('Injection failed:', err);
        hotkeyLog('inject_content_script_failed', {
            tabId: tab.id,
            error: err?.message || String(err)
        });
        throw err;
    }
}
