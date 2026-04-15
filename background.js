// Background Service Worker for ScreenChat

const RUNTIME_CONFIG_URL = chrome.runtime.getURL('runtime-config.json');
const KEEP_ACROSS_TABS_STATE_KEY = 'screenchat_keep_across_tabs_v1';
const DEFAULT_OPEN_STYLE_KEY = 'screenchat_default_open_style_v1';
const HOTKEY_DEBUG_ENABLED = false;
let hotkeyRequestCounter = 0;
let runtimeConfigLoadPromise = null;
let allowedApiOrigins = new Set();
let preferredOpenStyle = 'window';

hydratePreferredOpenStyle().finally(() => {
    queueSidePanelActionBehaviorSync('startup');
});
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.[DEFAULT_OPEN_STYLE_KEY]) return;
    setPreferredOpenStyle(changes[DEFAULT_OPEN_STYLE_KEY].newValue);
    console.info('[OpenStyle][Background] Preferred open style changed', {
        preferredOpenStyle
    });
    queueSidePanelActionBehaviorSync('storage_change');
});

function hotkeyLog(event, details = {}) {
    if (!HOTKEY_DEBUG_ENABLED) return;
    console.log('[ScreenChat][Hotkey][Background]', event, {
        ts: new Date().toISOString(),
        ...details
    });
}

function normalizePreferredOpenStyle(rawValue) {
    const normalizedValue = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
    return normalizedValue === 'sidebar' ? 'sidebar' : 'window';
}

function setPreferredOpenStyle(rawValue) {
    preferredOpenStyle = normalizePreferredOpenStyle(rawValue);
    return preferredOpenStyle;
}

async function syncSidePanelActionBehavior(reason = 'unknown') {
    if (typeof chrome.sidePanel?.setPanelBehavior !== 'function') {
        console.info('[OpenStyle][Background] sidePanel.setPanelBehavior unavailable', {
            reason,
            preferredOpenStyle
        });
        return;
    }

    const openPanelOnActionClick = preferredOpenStyle === 'sidebar';
    console.info('[OpenStyle][Background] Syncing action click behavior', {
        reason,
        preferredOpenStyle,
        openPanelOnActionClick
    });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick });
    console.info('[OpenStyle][Background] Action click behavior synced', {
        reason,
        preferredOpenStyle,
        openPanelOnActionClick
    });
}

function queueSidePanelActionBehaviorSync(reason) {
    syncSidePanelActionBehavior(reason).catch((error) => {
        console.warn('[OpenStyle][Background] Failed to sync action click behavior', {
            reason,
            preferredOpenStyle,
            error: error?.message || String(error)
        });
    });
}

async function hydratePreferredOpenStyle() {
    try {
        const storedValue = await chrome.storage.local.get(DEFAULT_OPEN_STYLE_KEY);
        setPreferredOpenStyle(storedValue?.[DEFAULT_OPEN_STYLE_KEY]);
        console.info('[OpenStyle][Background] Preferred open style hydrated', {
            preferredOpenStyle
        });
    } catch {
        setPreferredOpenStyle('window');
        console.warn('[OpenStyle][Background] Failed to hydrate preferred open style, defaulting to window');
    }
}

function shouldFallbackFromSidebarOpenError(error) {
    const message = String(error?.message || '').trim().toLowerCase();
    if (!message) return true;
    return (
        message.includes('browser sidebar is not available') ||
        message.includes('unable to resolve the current browser window')
    );
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

function getShortcutSettingsUrl(browser = '') {
    return String(browser || '').trim().toLowerCase() === 'edge'
        ? 'edge://extensions/shortcuts'
        : 'chrome://extensions/shortcuts';
}

function normalizeWorkflowEntry(rawWorkflow) {
    if (!rawWorkflow || typeof rawWorkflow !== 'object' || Array.isArray(rawWorkflow)) return null;

    const sessionId = typeof rawWorkflow.sessionId === 'string' ? rawWorkflow.sessionId.trim() : '';
    if (!sessionId) return null;

    return {
        sessionId,
        sessionUrl: typeof rawWorkflow.sessionUrl === 'string' ? rawWorkflow.sessionUrl.trim() : '',
        updatedAt: typeof rawWorkflow.updatedAt === 'string' ? rawWorkflow.updatedAt.trim() : '',
        enabledAt: typeof rawWorkflow.enabledAt === 'string' && rawWorkflow.enabledAt.trim()
            ? rawWorkflow.enabledAt.trim()
            : new Date().toISOString()
    };
}

function normalizeWorkflowStateMap(rawValue) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return {};

    const normalized = {};
    for (const [rawWindowId, rawWorkflow] of Object.entries(rawValue)) {
        const windowId = Number(rawWindowId);
        if (!Number.isInteger(windowId)) continue;
        const normalizedWorkflow = normalizeWorkflowEntry(rawWorkflow);
        if (normalizedWorkflow) {
            normalized[String(windowId)] = normalizedWorkflow;
        }
    }

    return normalized;
}

async function getStoredWorkflowStateMap() {
    const result = await chrome.storage.local.get(KEEP_ACROSS_TABS_STATE_KEY);
    return normalizeWorkflowStateMap(result?.[KEEP_ACROSS_TABS_STATE_KEY]);
}

async function setStoredWorkflowStateMap(nextMap) {
    await chrome.storage.local.set({
        [KEEP_ACROSS_TABS_STATE_KEY]: normalizeWorkflowStateMap(nextMap)
    });
}

function resolveWindowId(message, sender) {
    if (Number.isInteger(message?.windowId)) {
        return message.windowId;
    }
    if (Number.isInteger(sender?.tab?.windowId)) {
        return sender.tab.windowId;
    }
    return null;
}

async function getWorkflowForWindow(windowId) {
    if (!Number.isInteger(windowId)) return null;
    const workflowStateMap = await getStoredWorkflowStateMap();
    return normalizeWorkflowEntry(workflowStateMap[String(windowId)]);
}

async function setWorkflowForWindow(windowId, workflow) {
    if (!Number.isInteger(windowId)) {
        throw new Error('Missing windowId for keep across tabs');
    }

    const workflowStateMap = await getStoredWorkflowStateMap();
    const workflowKey = String(windowId);
    const normalizedWorkflow = normalizeWorkflowEntry(workflow);

    if (normalizedWorkflow) {
        workflowStateMap[workflowKey] = normalizedWorkflow;
    } else {
        delete workflowStateMap[workflowKey];
    }

    await setStoredWorkflowStateMap(workflowStateMap);
    return normalizedWorkflow;
}

function buildWorkflowStateResponse(windowId, workflow, extra = {}) {
    return {
        ok: true,
        active: !!workflow,
        windowId: Number.isInteger(windowId) ? windowId : null,
        workflow,
        canCloseSidePanel: typeof chrome.sidePanel?.close === 'function',
        ...extra
    };
}

async function getActiveTabForWindow(windowId) {
    if (!Number.isInteger(windowId)) return null;
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    return activeTab || null;
}

async function getLiveCaptureTarget(message, sender) {
    const target = {
        requestedWindowId: Number.isInteger(message?.windowId) ? message.windowId : null,
        senderWindowId: Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null,
        tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
        liveWindowId: null
    };

    if (!Number.isInteger(target.tabId) || typeof chrome.tabs?.get !== 'function') {
        return target;
    }

    try {
        const liveTab = await chrome.tabs.get(target.tabId);
        if (Number.isInteger(liveTab?.windowId)) {
            target.liveWindowId = liveTab.windowId;
        }
    } catch {
        // Fall back to the original sender-derived window id when the tab cannot be refreshed.
    }

    return target;
}

async function captureVisibleTabWithFallback(target = {}) {
    const captureOptions = { format: 'png' };
    const errors = [];
    const transientRetryDelays = [120, 220, 360, 540, 760, 1020];
    const isTransientCaptureError = (error) => {
        const message = String(error?.message || '').toLowerCase();
        return message.includes('tabs cannot be edited right now')
            || message.includes('user may be dragging a tab');
    };

    const resolveLiveWindowId = async () => {
        if (!Number.isInteger(target?.tabId) || typeof chrome.tabs?.get !== 'function') {
            return Number.isInteger(target?.liveWindowId) ? target.liveWindowId : null;
        }
        try {
            const liveTab = await chrome.tabs.get(target.tabId);
            const liveWindowId = Number.isInteger(liveTab?.windowId) ? liveTab.windowId : null;
            if (Number.isInteger(liveWindowId)) {
                target.liveWindowId = liveWindowId;
            }
            return liveWindowId;
        } catch (error) {
            errors.push(error);
            return Number.isInteger(target?.liveWindowId) ? target.liveWindowId : null;
        }
    };

    const tryCapture = async (label, windowIdResolver) => {
        for (let attempt = 0; attempt <= transientRetryDelays.length; attempt += 1) {
            const targetWindowId = typeof windowIdResolver === 'function'
                ? await windowIdResolver()
                : null;
            try {
                const captureWindowId = Number.isInteger(targetWindowId) ? targetWindowId : undefined;
                const image = await chrome.tabs.captureVisibleTab(captureWindowId, captureOptions);
                return image;
            } catch (error) {
                errors.push(error);
                if (!isTransientCaptureError(error) || attempt === transientRetryDelays.length) {
                    return null;
                }
                await sleep(transientRetryDelays[attempt]);
            }
        }
        return null;
    };

    const directCapture = await tryCapture('direct_or_live_window', async () => {
        const liveWindowId = await resolveLiveWindowId();
        if (Number.isInteger(liveWindowId)) return liveWindowId;
        if (Number.isInteger(target?.requestedWindowId)) return target.requestedWindowId;
        if (Number.isInteger(target?.senderWindowId)) return target.senderWindowId;
        return null;
    });
    if (typeof directCapture === 'string' && directCapture) {
        return directCapture;
    }

    if (Number.isInteger(target?.requestedWindowId)) {
        const requestedWindowCapture = await tryCapture('requested_window', async () => target.requestedWindowId);
        if (typeof requestedWindowCapture === 'string' && requestedWindowCapture) {
            return requestedWindowCapture;
        }
    }

    if (typeof chrome.windows?.getLastFocused === 'function') {
        try {
            const lastFocusedWindow = await chrome.windows.getLastFocused({ populate: false });
            const fallbackWindowId = Number.isInteger(lastFocusedWindow?.id) ? lastFocusedWindow.id : null;
            const fallbackCapture = await tryCapture('last_focused_window', async () => fallbackWindowId);
            if (typeof fallbackCapture === 'string' && fallbackCapture) {
                return fallbackCapture;
            }
        } catch (error) {
            errors.push(error);
        }
    }

    const defaultCapture = await tryCapture('default_window', async () => null);
    if (typeof defaultCapture === 'string' && defaultCapture) {
        return defaultCapture;
    }

    const errorMessage = errors
        .map((error) => error?.message || String(error || 'Unable to capture current screen'))
        .find(Boolean);
    throw new Error(errorMessage || 'Unable to capture current screen');
}

async function openKeepAcrossTabsPanel(windowId) {
    if (!Number.isInteger(windowId)) {
        throw new Error('Unable to resolve the current browser window');
    }
    if (typeof chrome.sidePanel?.open !== 'function') {
        throw new Error('Browser sidebar is not available in this version of Edge.');
    }
    console.info('[OpenStyle][Background] Calling chrome.sidePanel.open', {
        windowId
    });
    await chrome.sidePanel.open({ windowId });
    console.info('[OpenStyle][Background] chrome.sidePanel.open resolved', {
        windowId
    });
    return { ok: true, windowId };
}

async function closeKeepAcrossTabsPanel(windowId) {
    if (!Number.isInteger(windowId)) {
        throw new Error('Unable to resolve the current browser window');
    }

    if (typeof chrome.sidePanel?.close === 'function') {
        await chrome.sidePanel.close({ windowId });
        return { ok: true, windowId, closed: true };
    }

    return { ok: true, windowId, closed: false };
}

async function openShortcutSettings(message, sender) {
    const createProperties = {
        url: getShortcutSettingsUrl(message?.browser)
    };
    const resolvedWindowId = await resolveWindowId(message, sender);
    if (Number.isInteger(resolvedWindowId)) {
        createProperties.windowId = resolvedWindowId;
    }
    await chrome.tabs.create(createProperties);
    return { ok: true };
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
        'get_keep_across_tabs_state',
        'open_keep_across_tabs_panel',
        'open_side_panel',
        'open_shortcut_settings',
        'proxy_api_fetch',
        'set_keep_across_tabs_state'
    ]);
    if (!supportedActions.has(action)) return undefined;

    (async () => {
        try {
            if (action === 'capture_visible_tab') {
                const captureTarget = await getLiveCaptureTarget(message, sender);
                const image = await captureVisibleTabWithFallback(captureTarget);
                sendResponse({ ok: true, image });
                return;
            }

            if (action === 'proxy_api_fetch') {
                const result = await proxyApiFetch(message);
                sendResponse(result);
                return;
            }

            if (action === 'open_shortcut_settings') {
                const result = await openShortcutSettings(message, sender);
                sendResponse(result);
                return;
            }

            if (action === 'open_keep_across_tabs_panel') {
                const windowId = resolveWindowId(message, sender);
                const workflow = await getWorkflowForWindow(windowId);
                if (!workflow) {
                    sendResponse({ ok: false, error: 'No active keep across tabs workflow' });
                    return;
                }
                await openKeepAcrossTabsPanel(windowId);
                sendResponse(buildWorkflowStateResponse(windowId, workflow));
                return;
            }

            if (action === 'open_side_panel') {
                const windowId = resolveWindowId(message, sender);
                console.info('[OpenStyle][Background] Received open_side_panel request', {
                    senderTabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
                    senderWindowId: Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null,
                    requestedWindowId: Number.isInteger(message?.windowId) ? message.windowId : null,
                    resolvedWindowId: Number.isInteger(windowId) ? windowId : null,
                    preferredOpenStyle
                });
                if (!Number.isInteger(windowId)) {
                    throw new Error('Unable to resolve the current browser window');
                }
                const result = await openKeepAcrossTabsPanel(windowId);
                console.info('[OpenStyle][Background] open_side_panel completed', {
                    resolvedWindowId: windowId,
                    ok: !!result?.ok
                });
                sendResponse(result);
                return;
            }

            if (action === 'get_keep_across_tabs_state') {
                const windowId = resolveWindowId(message, sender);
                const workflow = await getWorkflowForWindow(windowId);
                sendResponse(buildWorkflowStateResponse(windowId, workflow));
                return;
            }

            if (action === 'set_keep_across_tabs_state') {
                const windowId = resolveWindowId(message, sender);
                if (!Number.isInteger(windowId)) {
                    throw new Error('Unable to resolve the current browser window');
                }

                const enabled = !!message?.enabled;
                if (enabled) {
                    const workflow = {
                        sessionId: message?.sessionId,
                        sessionUrl: message?.sessionUrl,
                        updatedAt: message?.updatedAt,
                        enabledAt: new Date().toISOString()
                    };
                    try {
                        await openKeepAcrossTabsPanel(windowId);
                        await setWorkflowForWindow(windowId, workflow);
                    } catch (error) {
                        await setWorkflowForWindow(windowId, null).catch(() => {});
                        throw error;
                    }
                    sendResponse(buildWorkflowStateResponse(windowId, workflow));
                    return;
                }

                await setWorkflowForWindow(windowId, null);
                const closeResult = await closeKeepAcrossTabsPanel(windowId);
                await restoreInlineUiForWindow(windowId).catch(() => false);
                sendResponse(buildWorkflowStateResponse(windowId, null, {
                    closed: !!closeResult?.closed
                }));
                return;
            }

            const windowId = resolveWindowId(message, sender);
            const activeTab = await getActiveTabForWindow(windowId);
            const activeTabUrl = typeof activeTab?.url === 'string' && activeTab.url.trim()
                ? activeTab.url.trim()
                : (typeof sender?.tab?.url === 'string' && sender.tab.url.trim() ? sender.tab.url.trim() : null);
            sendResponse({ ok: true, url: activeTabUrl });
        } catch (error) {
            if (action === 'capture_visible_tab') {
                sendResponse({ ok: false, error: error?.message || 'Unable to capture current screen' });
                return;
            }
            if (action === 'proxy_api_fetch') {
                console.warn('Proxy API fetch failed:', error);
                sendResponse({ ok: false, error: error?.message || 'Proxy API fetch failed' });
                return;
            }

            if (action === 'open_shortcut_settings') {
                console.warn('Shortcut settings open failed:', error);
                sendResponse({ ok: false, error: error?.message || 'Unable to open shortcut settings' });
                return;
            }

            if (action === 'get_keep_across_tabs_state' || action === 'open_keep_across_tabs_panel' || action === 'open_side_panel' || action === 'set_keep_across_tabs_state') {
                console.warn('Keep across tabs state failed:', error);
                sendResponse({ ok: false, error: error?.message || 'Unable to update keep across tabs' });
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

async function restoreInlineUi(tabId, attempts = 3, payload = {}) {
    return sendUiAction(tabId, 'restore_inline_ui', attempts, payload);
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
    console.info('[OpenStyle][Background] activateScreenChat start', {
        tabId: Number.isInteger(tab?.id) ? tab.id : null,
        windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
        url: tab?.url || null,
        preferredOpenStyle
    });
    if (preferredOpenStyle === 'sidebar' && Number.isInteger(tab?.windowId)) {
        try {
            await openKeepAcrossTabsPanel(tab.windowId);
            if (tab?.id && !isRestrictedUrl(tab.url || '')) {
                await chrome.tabs.sendMessage(tab.id, { action: 'hide_ui' }).catch(() => {});
            }
            console.info('[OpenStyle][Background] activateScreenChat opened preferred sidebar');
            return;
        } catch (error) {
            console.warn('Preferred sidebar open failed from action click:', error);
            if (!shouldFallbackFromSidebarOpenError(error)) {
                console.warn('[OpenStyle][Background] activateScreenChat returning after non-fallback sidebar error');
                return;
            }
        }
    }

    const activeWorkflow = await getWorkflowForWindow(tab?.windowId);
    if (activeWorkflow && Number.isInteger(tab?.windowId)) {
        try {
            await openKeepAcrossTabsPanel(tab.windowId);
            return;
        } catch (error) {
            console.warn('Keep across tabs reopen failed from action click:', error);
            await setWorkflowForWindow(tab.windowId, null).catch(() => {});
        }
    }

    if (!tab?.id || isRestrictedUrl(tab.url || '')) {
        return;
    }
    await dispatchUiAction(tab, 'open_ui');
}

chrome.action.onClicked.addListener(async (tab) => {
    try {
        if (preferredOpenStyle === 'sidebar') {
            console.info('[OpenStyle][Background] Action click received while sidebar is preferred', {
                tabId: Number.isInteger(tab?.id) ? tab.id : null,
                windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null
            });
        }

        await activateScreenChat(tab);
    } catch (err) {
        console.error('ScreenChat action click failed:', err);
    }
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-screenchat') return;
    hotkeyLog('command_received', { command });

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

async function toggleScreenChatWithHotkey(tab) {
    console.info('[OpenStyle][Background] toggleScreenChatWithHotkey start', {
        tabId: Number.isInteger(tab?.id) ? tab.id : null,
        windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
        url: tab?.url || null,
        preferredOpenStyle
    });
    if (preferredOpenStyle === 'sidebar' && Number.isInteger(tab?.windowId)) {
        try {
            await openKeepAcrossTabsPanel(tab.windowId);
            if (tab?.id && !isRestrictedUrl(tab.url || '')) {
                await chrome.tabs.sendMessage(tab.id, { action: 'hide_ui' }).catch(() => {});
            }
            console.info('[OpenStyle][Background] toggleScreenChatWithHotkey opened preferred sidebar');
            return;
        } catch (error) {
            console.warn('Preferred sidebar open failed from hotkey:', error);
            if (!shouldFallbackFromSidebarOpenError(error)) {
                console.warn('[OpenStyle][Background] toggleScreenChatWithHotkey returning after non-fallback sidebar error');
                return;
            }
        }
    }

    const activeWorkflow = await getWorkflowForWindow(tab?.windowId);
    if (activeWorkflow && Number.isInteger(tab?.windowId)) {
        try {
            await openKeepAcrossTabsPanel(tab.windowId);
            return;
        } catch (error) {
            console.warn('Keep across tabs reopen failed from hotkey:', error);
            await setWorkflowForWindow(tab.windowId, null).catch(() => {});
        }
    }

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
        } else if (action === 'restore_inline_ui') {
            await restoreInlineUi(tab.id, 1, payload);
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
    } else if (action === 'restore_inline_ui') {
        await restoreInlineUi(tab.id, 3, payload);
    } else {
        await toggleUi(tab.id, 3, payload);
    }
    hotkeyLog('dispatch_ui_action_done', {
        tabId: tab.id,
        action,
        hotkeyRequestId: payload.hotkeyRequestId || null
    });
}

async function restoreInlineUiForWindow(windowId) {
    if (!Number.isInteger(windowId)) return false;
    const activeTab = await getActiveTabForWindow(windowId);
    if (!activeTab?.id || isRestrictedUrl(activeTab.url || '')) {
        return false;
    }
    await dispatchUiAction(activeTab, 'restore_inline_ui');
    return true;
}

if (chrome.sidePanel?.onClosed?.addListener) {
    chrome.sidePanel.onClosed.addListener(async (info) => {
        const closedPath = typeof info?.path === 'string' ? info.path.trim() : '';
        if (!closedPath || !closedPath.endsWith('sidepanel.html')) return;

        const windowId = Number.isInteger(info?.windowId) ? info.windowId : null;
        if (!Number.isInteger(windowId)) return;

        const activeWorkflow = await getWorkflowForWindow(windowId);
        if (!activeWorkflow) return;

        try {
            await setWorkflowForWindow(windowId, null);
            await restoreInlineUiForWindow(windowId);
        } catch (error) {
            console.warn('Side panel close restore failed:', error);
        }
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
