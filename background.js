// Background Service Worker for ScreenChat

chrome.runtime.onInstalled.addListener(() => {
    console.log('ScreenChat extension installed');
});

const ALLOWED_API_ORIGINS = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://screenchat-backend-production.up.railway.app'
]);

function isAllowedApiRequestUrl(rawUrl = '') {
    try {
        const parsed = new URL(rawUrl);
        return ALLOWED_API_ORIGINS.has(parsed.origin);
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
    if (action !== 'capture_visible_tab' && action !== 'get_active_tab_url' && action !== 'proxy_api_fetch') return undefined;

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

            if (typeof sender?.tab?.url === 'string' && sender.tab.url.trim()) {
                sendResponse({ ok: true, url: sender.tab.url });
                return;
            }

            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            sendResponse({ ok: true, url: activeTab?.url || null });
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
            sendResponse({ ok: false, url: sender?.tab?.url || null });
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

const HOTKEY_COMMAND_DEDUPE_MS = 1000;
const lastHotkeyCommandByTab = new Map();

function shouldSuppressDuplicateHotkey(tabId) {
    if (!Number.isInteger(tabId)) return false;
    const now = Date.now();
    const previous = lastHotkeyCommandByTab.get(tabId) || 0;
    lastHotkeyCommandByTab.set(tabId, now);
    return (now - previous) < HOTKEY_COMMAND_DEDUPE_MS;
}

async function openUi(tabId, attempts = 3) {
    return sendUiAction(tabId, 'open_ui', attempts);
}

async function toggleUi(tabId, attempts = 3) {
    return sendUiAction(tabId, 'hotkey_toggle_ui', attempts);
}

async function sendUiAction(tabId, action, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            await chrome.tabs.sendMessage(tabId, { action });
            return;
        } catch (e) {
            lastError = e;
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

    defer(async () => {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab) return;
            await toggleScreenChatWithHotkey(activeTab);
        } catch (err) {
            console.error('ScreenChat hotkey command failed:', err);
        }
    });
});

async function toggleScreenChatWithHotkey(tab) {
    if (!tab?.id || isRestrictedUrl(tab.url || '')) {
        return;
    }
    if (shouldSuppressDuplicateHotkey(tab.id)) {
        return;
    }
    await dispatchUiAction(tab, 'hotkey_toggle_ui');
}

async function dispatchUiAction(tab, action) {
    // Fast path: content script is already running in the tab.
    try {
        if (action === 'open_ui') {
            await openUi(tab.id, 1);
        } else {
            await toggleUi(tab.id, 1);
        }
        return;
    } catch (firstError) {
        // Slow path: inject script and retry action.
    }

    await injectContentScript(tab);
    if (action === 'open_ui') {
        await openUi(tab.id);
    } else {
        await toggleUi(tab.id);
    }
}

async function injectContentScript(tab) {
    try {
        await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        });
    } catch (err) {
        console.error('Injection failed:', err);
        throw err;
    }
}
