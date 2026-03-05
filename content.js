(() => {
    // Prevent multiple injections
    if (window.screenChatInjected) return;
    window.screenChatInjected = true;

    // ScreenChat Content Script

    // State
    let shadowRoot = null;
    let container = null;
    let conversationHistory = [];
    let currentAbortController = null;
    let isAwaitingResponse = false;
    let hasLocalConversationMutation = false;
    const chatMode = 'ask';

    // User Profile (personal info for personalization)
    let userProfile = null;

    // Session State
    let sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    let sessionUrl = window.location.href || window.location.hostname || 'unknown';

    // Auth State
    let messageCount = 0;
    let authState = 'ANONYMOUS'; // ANONYMOUS, AWAIT_GOOGLE, AUTHENTICATED
    let tempUserData = { email: '', password: '' };
    let userId = 'user_' + Math.floor(Math.random() * 1000000);
    let attachScreenEnabled = false;
    const API_BASE_CACHE_KEY = 'screenchat_api_base_url';
    const API_BASE_OVERRIDE_KEY = 'screenchat_api_base_override';
    const API_BASE_CANDIDATES = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://screenchat-backend-production.up.railway.app'
    ];
    const API_HEALTH_TIMEOUT_MS = 1400;
    const CHAT_REQUEST_TIMEOUT_MS = 90000;
    let resolvedApiBaseUrl = null;
    let resolvingApiBasePromise = null;

    function normalizeApiBaseUrl(rawValue) {
        if (typeof rawValue !== 'string') return null;
        const trimmed = rawValue.trim();
        if (!trimmed) return null;
        return trimmed.replace(/\/+$/, '');
    }

    function normalizeApiPath(path) {
        if (typeof path !== 'string' || path.length === 0) return '/';
        return path.startsWith('/') ? path : `/${path}`;
    }

    function storageGet(keys) {
        return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }

    function storageSet(data) {
        return new Promise((resolve) => chrome.storage.local.set(data, resolve));
    }

    async function isBackendReachable(baseUrl) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_HEALTH_TIMEOUT_MS);
        try {
            const response = await fetch(`${baseUrl}/health`, {
                method: 'GET',
                signal: controller.signal
            });
            if (!response.ok) return false;
            const payload = await response.json().catch(() => null);
            return Boolean(payload?.ok || response.ok);
        } catch {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function buildApiCandidateList({ overrideBaseUrl, cachedBaseUrl }) {
        const candidateSet = new Set();
        if (overrideBaseUrl) candidateSet.add(overrideBaseUrl);
        if (cachedBaseUrl) candidateSet.add(cachedBaseUrl);
        for (const candidate of API_BASE_CANDIDATES) {
            candidateSet.add(candidate);
        }
        return Array.from(candidateSet);
    }

    async function resolveApiBaseUrl({ forceRefresh = false } = {}) {
        if (!forceRefresh && resolvedApiBaseUrl) return resolvedApiBaseUrl;
        if (!forceRefresh && resolvingApiBasePromise) return resolvingApiBasePromise;

        resolvingApiBasePromise = (async () => {
            let overrideBaseUrl = null;
            let cachedBaseUrl = null;
            try {
                const stored = await storageGet([API_BASE_OVERRIDE_KEY, API_BASE_CACHE_KEY]);
                overrideBaseUrl = normalizeApiBaseUrl(stored[API_BASE_OVERRIDE_KEY]);
                cachedBaseUrl = normalizeApiBaseUrl(stored[API_BASE_CACHE_KEY]);
            } catch (storageError) {
                console.warn('[API] Failed to read stored backend URL:', storageError);
            }

            const candidates = buildApiCandidateList({ overrideBaseUrl, cachedBaseUrl });
            for (const candidate of candidates) {
                const reachable = await isBackendReachable(candidate);
                if (reachable) {
                    resolvedApiBaseUrl = candidate;
                    if (candidate !== cachedBaseUrl) {
                        storageSet({ [API_BASE_CACHE_KEY]: candidate }).catch(() => {
                            // No-op: cache persistence failure should not block requests.
                        });
                    }
                    return candidate;
                }
            }

            resolvedApiBaseUrl = overrideBaseUrl || cachedBaseUrl || API_BASE_CANDIDATES[0];
            return resolvedApiBaseUrl;
        })().finally(() => {
            resolvingApiBasePromise = null;
        });

        return resolvingApiBasePromise;
    }

    async function apiUrl(path) {
        const baseUrl = await resolveApiBaseUrl();
        return `${baseUrl}${normalizeApiPath(path)}`;
    }

    function serializeHeadersForProxy(headers) {
        if (!headers) return undefined;
        if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
        }
        if (Array.isArray(headers)) {
            return Object.fromEntries(headers);
        }
        if (typeof headers === 'object') {
            return { ...headers };
        }
        return undefined;
    }

    function normalizeProxyFetchOptions(options) {
        if (!options || typeof options !== 'object') return {};

        const proxyOptions = {};
        if (typeof options.method === 'string') {
            proxyOptions.method = options.method;
        }

        const serializedHeaders = serializeHeadersForProxy(options.headers);
        if (serializedHeaders) {
            proxyOptions.headers = serializedHeaders;
        }

        if (typeof options.body === 'string') {
            proxyOptions.body = options.body;
        }

        return proxyOptions;
    }

    function responseFromProxyPayload(payload) {
        const status = Number.isInteger(payload?.status) ? payload.status : 500;
        const statusText = typeof payload?.statusText === 'string' ? payload.statusText : '';
        const headers = payload?.headers && typeof payload.headers === 'object' ? payload.headers : {};
        const bodyText = typeof payload?.bodyText === 'string' ? payload.bodyText : '';
        return new Response(bodyText, { status, statusText, headers });
    }

    async function apiFetchViaBackground(requestUrl, options) {
        const response = await chrome.runtime.sendMessage({
            action: 'proxy_api_fetch',
            url: requestUrl,
            options: normalizeProxyFetchOptions(options)
        });

        if (!response?.ok) {
            throw new Error(response?.error || 'Background API proxy failed');
        }

        return responseFromProxyPayload(response);
    }

    async function fetchWithProxyFallback(requestUrl, options) {
        try {
            return await fetch(requestUrl, options);
        } catch (directError) {
            if (directError?.name === 'AbortError') throw directError;
            return apiFetchViaBackground(requestUrl, options);
        }
    }

    async function apiFetch(path, options) {
        const normalizedPath = normalizeApiPath(path);
        const initialUrl = await apiUrl(normalizedPath);
        try {
            return await fetchWithProxyFallback(initialUrl, options);
        } catch (fetchError) {
            const refreshedBaseUrl = await resolveApiBaseUrl({ forceRefresh: true });
            const refreshedUrl = `${refreshedBaseUrl}${normalizedPath}`;
            if (refreshedUrl !== initialUrl) {
                return fetchWithProxyFallback(refreshedUrl, options);
            }
            throw fetchError;
        }
    }

    async function apiFetchDirect(path, options) {
        const normalizedPath = normalizeApiPath(path);
        const initialUrl = await apiUrl(normalizedPath);
        try {
            return await fetch(initialUrl, options);
        } catch (fetchError) {
            if (fetchError?.name === 'AbortError') throw fetchError;
            const refreshedBaseUrl = await resolveApiBaseUrl({ forceRefresh: true });
            const refreshedUrl = `${refreshedBaseUrl}${normalizedPath}`;
            if (refreshedUrl !== initialUrl) {
                return fetch(refreshedUrl, options);
            }
            throw fetchError;
        }
    }

    function getReplyTextFromPayload(payload) {
        return typeof payload?.reply === 'string' ? payload.reply : String(payload?.reply ?? '');
    }

    function createAbortError() {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        return error;
    }

    function extractErrorMessageFromText(rawText, fallbackMessage = 'Backend failed') {
        if (typeof rawText !== 'string') return fallbackMessage;
        const trimmed = rawText.trim();
        if (!trimmed) return fallbackMessage;
        try {
            const payload = JSON.parse(trimmed);
            if (typeof payload?.error === 'string' && payload.error.trim()) {
                return payload.error.trim();
            }
        } catch {
            // Ignore parse failures and return plain text below.
        }
        return trimmed;
    }

    async function getApiErrorMessage(response, fallbackMessage = 'Backend failed') {
        try {
            const contentType = response.headers?.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const payload = await response.json();
                if (typeof payload?.error === 'string' && payload.error.trim()) {
                    return payload.error.trim();
                }
            } else {
                const text = await response.text();
                return extractErrorMessageFromText(text, fallbackMessage);
            }
        } catch {
            // Ignore parse failures and use fallback.
        }
        return fallbackMessage;
    }

    function parseStreamLine(line, onPartialText, state) {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
            event = JSON.parse(trimmed);
        } catch {
            return;
        }

        if (event?.type === 'delta' && typeof event.delta === 'string') {
            state.reply += event.delta;
            if (typeof onPartialText === 'function') {
                onPartialText(state.reply);
            }
            return;
        }

        if (event?.type === 'done' && typeof event.reply === 'string') {
            state.reply = event.reply;
            if (typeof onPartialText === 'function') {
                onPartialText(state.reply);
            }
            return;
        }

        if (event?.type === 'error') {
            throw new Error(
                typeof event.error === 'string' && event.error.trim()
                    ? event.error.trim()
                    : 'Backend stream failed'
            );
        }
    }

    function parseStreamBuffer(state, onPartialText) {
        let newlineIndex = state.buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = state.buffer.slice(0, newlineIndex);
            state.buffer = state.buffer.slice(newlineIndex + 1);
            parseStreamLine(line, onPartialText, state);
            newlineIndex = state.buffer.indexOf('\n');
        }
    }

    function parseRemainingStreamBuffer(state, onPartialText) {
        if (state.buffer.trim()) {
            parseStreamLine(state.buffer, onPartialText, state);
        }
        state.buffer = '';
    }

    async function consumeNdjsonResponse(response, onPartialText, state) {
        if (!response.body || typeof response.body.getReader !== 'function') {
            const bufferedText = await response.text();
            state.buffer += bufferedText;
            parseStreamBuffer(state, onPartialText);
            parseRemainingStreamBuffer(state, onPartialText);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            state.buffer += decoder.decode(value, { stream: true });
            parseStreamBuffer(state, onPartialText);
        }

        state.buffer += decoder.decode();
        parseStreamBuffer(state, onPartialText);
        parseRemainingStreamBuffer(state, onPartialText);
    }

    async function requestChatReplyStreamViaBackground(payload, { signal, onPartialText } = {}) {
        const requestUrl = await apiUrl('/api/chat/stream');
        const streamOptions = normalizeProxyFetchOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        return new Promise((resolve, reject) => {
            const port = chrome.runtime.connect({ name: 'proxy_api_stream' });
            const state = { reply: '', buffer: '' };
            let settled = false;

            const cleanup = () => {
                try {
                    port.onMessage.removeListener(handleMessage);
                    port.onDisconnect.removeListener(handleDisconnect);
                } catch {
                    // No-op.
                }
                if (signal && onAbort) {
                    signal.removeEventListener('abort', onAbort);
                }
                try {
                    port.disconnect();
                } catch {
                    // No-op.
                }
            };

            const settleResolve = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };

            const settleReject = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error || 'Unknown error')));
            };

            const handleMessage = (message) => {
                if (settled) return;
                try {
                    if (message?.type === 'http_error') {
                        const messageText = extractErrorMessageFromText(message.bodyText, message.statusText || 'Backend failed');
                        settleReject(new Error(messageText));
                        return;
                    }

                    if (message?.type === 'error') {
                        settleReject(new Error(message.error || 'Background stream failed'));
                        return;
                    }

                    if (message?.type === 'chunk' && typeof message.chunk === 'string') {
                        state.buffer += message.chunk;
                        parseStreamBuffer(state, onPartialText);
                        return;
                    }

                    if (message?.type === 'end') {
                        parseRemainingStreamBuffer(state, onPartialText);
                        settleResolve(state.reply || 'Sorry, I could not generate a response.');
                    }
                } catch (error) {
                    settleReject(error);
                }
            };

            const handleDisconnect = () => {
                if (settled) return;
                const runtimeError = chrome.runtime.lastError?.message;
                settleReject(new Error(runtimeError || 'Background stream disconnected'));
            };

            const onAbort = () => {
                try {
                    port.postMessage({ type: 'abort' });
                } catch {
                    // No-op.
                }
                settleReject(createAbortError());
            };

            if (signal?.aborted) {
                settleReject(createAbortError());
                return;
            }

            port.onMessage.addListener(handleMessage);
            port.onDisconnect.addListener(handleDisconnect);
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }

            port.postMessage({
                type: 'start',
                url: requestUrl,
                options: streamOptions
            });
        });
    }

    async function requestChatReplyStream(payload, { signal, onPartialText } = {}) {
        return requestChatReplyStreamViaBackground(payload, { signal, onPartialText });
    }

    async function requestChatReply(payload, { signal, onPartialText } = {}) {
        try {
            return await requestChatReplyStream(payload, { signal, onPartialText });
        } catch (streamError) {
            if (streamError?.name === 'AbortError') throw streamError;
            console.warn('[Chat] Streaming failed, falling back to JSON response:', streamError);
        }

        const response = await apiFetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal
        });
        if (!response.ok) {
            const errorMessage = await getApiErrorMessage(response, 'Backend failed');
            throw new Error(errorMessage);
        }

        const data = await response.json();
        const reply = getReplyTextFromPayload(data);
        if (typeof onPartialText === 'function') {
            onPartialText(reply);
        }
        return reply;
    }

    // =============================================================================
    // CORE SYSTEMS - Element Registry, Overlay Stack
    // =============================================================================

    // Interactive element selector
    const INTERACTIVE_SELECTOR = 'input, textarea, select, button, [role="button"], [role="menuitem"], [role="option"], [role="link"], a[href], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';

    // -----------------------------------------------------------------------------
    // ELEMENT REGISTRY - Stable element identification and tracking
    // -----------------------------------------------------------------------------
    const ElementRegistry = {
        elements: new Map(),
        lastScan: 0,
        scanInterval: 500,

        scan(force = false) {
            if (!force && Date.now() - this.lastScan < this.scanInterval) {
                return this.elements;
            }

            this.elements.clear();
            const activeOverlay = OverlayStack.getTopOverlay();
            const searchRoot = activeOverlay?.element || document.body;

            const interactiveEls = searchRoot.querySelectorAll(INTERACTIVE_SELECTOR);

            interactiveEls.forEach((el, index) => {
                if (!this.isVisible(el)) return;
                if (el.closest('#screenchat-host')) return;

                const id = this.generateStableId(el, index);
                const meta = {
                    id,
                    element: el,
                    type: this.detectInputType(el),
                    label: this.getLabel(el),
                    selector: this.generateRobustSelector(el),
                    tagName: el.tagName.toLowerCase(),
                    inputType: el.type || null,
                    enabled: !el.disabled && !el.getAttribute('aria-disabled'),
                    required: el.required || el.getAttribute('aria-required') === 'true',
                    value: this.getCurrentValue(el),
                    rect: el.getBoundingClientRect(),
                    inOverlay: !!activeOverlay
                };

                this.elements.set(id, meta);
            });

            this.lastScan = Date.now();
            return this.elements;
        },

        generateStableId(el, fallbackIndex) {
            // Priority 1: Test IDs (most stable)
            for (const attr of ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-id']) {
                const val = el.getAttribute(attr);
                if (val) return `test:${val}`;
            }

            // Priority 2: ID (if not dynamic)
            if (el.id && !/\d{3,}|[-_]\d+$|^:r/.test(el.id)) {
                return `id:${el.id}`;
            }

            // Priority 3: Name attribute
            if (el.name) {
                return `name:${el.name}`;
            }

            // Priority 4: Aria-label
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.length < 50) {
                return `aria:${ariaLabel.replace(/\s+/g, '_').toLowerCase()}`;
            }

            // Priority 5: Role + text
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            const text = (el.textContent || '').trim().slice(0, 30).replace(/\s+/g, '_').toLowerCase();
            if (text && text.length > 2) {
                return `${role}:${text}`;
            }

            // Priority 6: Placeholder
            if (el.placeholder) {
                return `placeholder:${el.placeholder.slice(0, 30).replace(/\s+/g, '_').toLowerCase()}`;
            }

            // Fallback
            return `${el.tagName.toLowerCase()}:${fallbackIndex}`;
        },

        generateRobustSelector(el) {
            // Priority 1: data-testid
            for (const attr of ['data-testid', 'data-test', 'data-cy']) {
                const val = el.getAttribute(attr);
                if (val) return `[${attr}="${val}"]`;
            }

            // Priority 2: ID
            if (el.id && !/\d{3,}|[-_]\d+$|^:r/.test(el.id)) {
                return `#${CSS.escape(el.id)}`;
            }

            // Priority 3: name
            if (el.name) {
                const sel = `${el.tagName.toLowerCase()}[name="${el.name}"]`;
                if (document.querySelectorAll(sel).length === 1) return sel;
            }

            // Priority 4: aria-label
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) {
                const sel = `[aria-label="${CSS.escape(ariaLabel)}"]`;
                try {
                    if (document.querySelectorAll(sel).length === 1) return sel;
                } catch (e) { }
            }

            // Priority 5: type + placeholder
            if (el.type && el.placeholder) {
                const sel = `${el.tagName.toLowerCase()}[type="${el.type}"][placeholder="${CSS.escape(el.placeholder)}"]`;
                try {
                    if (document.querySelectorAll(sel).length === 1) return sel;
                } catch (e) { }
            }

            // Fallback: path from nearest ID'd ancestor
            let current = el;
            const path = [];
            while (current && current !== document.body) {
                if (current.id && !/\d{3,}/.test(current.id)) {
                    path.unshift(`#${CSS.escape(current.id)}`);
                    break;
                }
                const parent = current.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                    const index = siblings.indexOf(current);
                    path.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index + 1})`);
                }
                current = parent;
            }
            return path.join(' > ') || el.tagName.toLowerCase();
        },

        detectInputType(el) {
            // Rich text editors
            if (el.closest('[data-contents="true"]') || el.closest('.DraftEditor-root')) return 'draftjs';
            if (el.closest('.ProseMirror')) return 'prosemirror';
            if (el.closest('.ql-editor')) return 'quill';
            if (el.closest('.tox-tinymce')) return 'tinymce';
            if (el.closest('[data-slate-editor]')) return 'slate';
            if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';
            if (el.tagName === 'INPUT') return `input:${el.type || 'text'}`;
            if (el.tagName === 'TEXTAREA') return 'textarea';
            if (el.tagName === 'SELECT') return 'select';
            if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return 'button';
            if (el.tagName === 'A') return 'link';
            return 'unknown';
        },

        getLabel(el) {
            if (el.id) {
                const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (label) return label.textContent.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel) {
                const text = parentLabel.textContent.trim();
                const inputText = el.value || el.textContent || '';
                return text.replace(inputText, '').trim() || text;
            }
            if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
                const labelEl = document.getElementById(labelledBy);
                if (labelEl) return labelEl.textContent.trim();
            }
            if (el.placeholder) return el.placeholder;
            if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
                return (el.textContent || '').trim().slice(0, 50);
            }
            if (el.title) return el.title;
            return null;
        },

        getCurrentValue(el) {
            if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
            if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text || el.value;
            if (el.getAttribute('contenteditable') === 'true') return (el.textContent || '').trim().slice(0, 100);
            if (el.value !== undefined) return (el.value || '').slice(0, 100);
            return null;
        },

        isVisible(el) {
            if (!el.offsetParent && el.tagName !== 'BODY' && getComputedStyle(el).position !== 'fixed') return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        },

        get(id) {
            let meta = this.elements.get(id);
            if (!meta || !document.contains(meta.element)) {
                this.scan(true);
                meta = this.elements.get(id);
            }
            return meta;
        },

        getBySelector(selector) {
            try {
                return document.querySelector(selector);
            } catch (e) {
                return null;
            }
        },

        getAll() {
            this.scan();
            return Array.from(this.elements.values());
        },

        getMinimalList() {
            return this.getAll().map(m => ({
                id: m.id,
                type: m.type,
                label: m.label,
                enabled: m.enabled,
                value: m.value
            }));
        }
    };

    // -----------------------------------------------------------------------------
    // OVERLAY STACK - Track modals, dropdowns, popovers
    // -----------------------------------------------------------------------------
    const OverlayStack = {
        overlays: [],

        scan() {
            this.overlays = [];
            const selectors = [
                '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]',
                '[aria-modal="true"]', '[data-state="open"]', '[data-headlessui-state*="open"]',
                '.modal.show', '.modal.open', '.modal:not(.hidden)',
                '.MuiModal-root', '.MuiDialog-root', '.MuiPopover-root', '.MuiMenu-root',
                '.chakra-modal__content', '.ant-modal-wrap:not([style*="display: none"])',
                '[data-radix-dialog-content]', '[data-radix-popover-content]'
            ];

            const seen = new Set();

            for (const selector of selectors) {
                try {
                    document.querySelectorAll(selector).forEach(el => {
                        if (seen.has(el) || el.closest('#screenchat-host')) return;
                        if (!this.isElementVisible(el)) return;
                        seen.add(el);

                        const rect = el.getBoundingClientRect();
                        if (rect.width < 50 || rect.height < 30) return;

                        const contentEl = this.findContentElement(el);
                        this.overlays.push({
                            element: contentEl || el,
                            type: this.classifyOverlay(el),
                            zIndex: parseInt(getComputedStyle(el).zIndex) || 0,
                            blocking: el.getAttribute('aria-modal') === 'true',
                            title: this.getTitle(contentEl || el)
                        });
                    });
                } catch (e) { }
            }

            this.overlays.sort((a, b) => a.zIndex - b.zIndex);
            return this.overlays;
        },

        isElementVisible(el) {
            const style = getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        },

        findContentElement(root) {
            for (const sel of ['[role="dialog"]', '[class*="content"]', '[class*="Content"]', 'form']) {
                const inner = root.querySelector(sel);
                if (inner && inner !== root) {
                    const rect = inner.getBoundingClientRect();
                    if (rect.width > 50 && rect.height > 50 && rect.width < window.innerWidth * 0.95) return inner;
                }
            }
            return null;
        },

        classifyOverlay(el) {
            const role = el.getAttribute('role');
            const cls = (el.className || '').toLowerCase();
            if (role === 'dialog' || role === 'alertdialog') return 'dialog';
            if (role === 'menu') return 'menu';
            if (role === 'listbox') return 'dropdown';
            if (/modal/i.test(cls)) return 'modal';
            if (/drawer/i.test(cls)) return 'drawer';
            if (/dropdown|menu/i.test(cls)) return 'dropdown';
            return 'overlay';
        },

        getTitle(el) {
            const heading = el.querySelector('h1, h2, h3, [class*="title"], [class*="header"]');
            if (heading) return heading.textContent.trim().slice(0, 50);
            return el.getAttribute('aria-label')?.slice(0, 50) || null;
        },

        getTopOverlay() {
            this.scan();
            return this.overlays.length > 0 ? this.overlays[this.overlays.length - 1] : null;
        },

        getActiveContext() {
            const top = this.getTopOverlay();
            if (!top) return { type: 'page', title: document.title, element: document.body, blocking: false };
            return { type: top.type, title: top.title, element: top.element, blocking: top.blocking };
        }
    };

    async function getActiveTabUrl() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'get_active_tab_url' });
            if (response?.ok && typeof response.url === 'string' && response.url.trim()) {
                return response.url.trim();
            }
        } catch (error) {
            console.warn('[Context] Failed to fetch active tab URL from background:', error);
        }
        return window.location.href || null;
    }

    // -----------------------------------------------------------------------------
    // CONTEXT BUILDER - Minimal context for LLM
    // -----------------------------------------------------------------------------
    const ContextBuilder = {
        modes: {
            PLAN: { elements: 'all', overlay: true }
        },

        async build(mode = 'PLAN') {
            const config = this.modes[mode] || this.modes.PLAN;
            const activeTabUrl = await getActiveTabUrl();
            const context = { url: window.location.href, activeTabUrl, title: document.title, mode };

            OverlayStack.scan();
            ElementRegistry.scan(true);

            if (config.overlay) {
                const active = OverlayStack.getActiveContext();
                context.activeContext = { type: active.type, title: active.title, blocking: active.blocking };
            }

            if (config.elements === 'all') {
                context.elements = ElementRegistry.getMinimalList();
            } else if (config.elements === 'active') {
                const top = OverlayStack.getTopOverlay();
                if (top) {
                    context.elements = ElementRegistry.getAll()
                        .filter(m => top.element.contains(m.element))
                        .map(m => ({ id: m.id, type: m.type, label: m.label, enabled: m.enabled, value: m.value }));
                } else {
                    context.elements = ElementRegistry.getMinimalList().slice(0, 30);
                }
            }

            return context;
        },

        formatForLLM(context) {
            let msg = `[Page: ${context.url}]`;
            if (context.activeTabUrl) {
                msg += `\n[Active Tab URL: ${context.activeTabUrl}]`;
            }
            if (context.activeContext?.type !== 'page') {
                msg += `\n[Active: ${context.activeContext.type}${context.activeContext.title ? ` - "${context.activeContext.title}"` : ''}]`;
            }
            if (context.elements?.length > 0) {
                msg += `\n[Elements: ${context.elements.length} available]`;
                const list = context.elements.slice(0, 15).map(e => `  ${e.id}: ${e.type} "${e.label || '-'}"${e.enabled ? '' : ' (disabled)'}`).join('\n');
                msg += `\n${list}`;
            }
            return msg;
        }
    };

    // --- Message Cleaning Helpers ---
    function cleanUserMessage(message) {
        if (!message) return '';
        // Strip system context from user messages
        // Format: [Context...] actual message
        const parts = message.split('\n\n');
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i].trim();
            if (part && !part.startsWith('[') && part.toLowerCase() !== 'continue') {
                return part;
            }
        }
        const lastBracket = message.lastIndexOf(']');
        if (lastBracket !== -1) {
            return message.substring(lastBracket + 1).trim();
        }
        return message.trim();
    }

    function cleanAiReply(reply) {
        if (!reply) return '';
        try {
            const parsed = JSON.parse(reply);
            if (parsed.message) return parsed.message;
        } catch (e) {
            // Not JSON, use as-is
        }
        return reply;
    }

    // UI State
    const UI_STATE_KEY = 'sc_ui_v2';
    const LEGACY_UI_STATE_KEYS = ['sc_ui_width', 'sc_ui_height', 'sc_ui_position'];
    const ATTACH_SCREEN_KEY = 'sc_attach_screen_enabled';
    const ATTACH_GLOW_OVERLAY_ID = 'sc-attach-glow-overlay';
    const DEFAULT_PANEL_WIDTH = 372;
    const DEFAULT_PANEL_HEIGHT = 590;
    const PREVIOUS_DEFAULT_PANEL_WIDTH = 420;
    const PREVIOUS_DEFAULT_PANEL_HEIGHT = 680;
    const INTERMEDIATE_DEFAULT_PANEL_WIDTH = 388;
    const INTERMEDIATE_DEFAULT_PANEL_HEIGHT = 620;
    const MIN_PANEL_WIDTH = 324;
    const MIN_PANEL_HEIGHT = 460;
    const DEFAULT_UI_STATE = {
        mode: 'hidden', // open | hidden
        side: 'right', // right | left
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
        panelPosition: null, // { left, top }
        customPosition: false,
        movable: true,
        resizable: true,
        activePane: 'chat' // chat | history | profile
    };
    let uiState = { ...DEFAULT_UI_STATE };
    let hasTypedWelcome = false;
    let activePanelInteraction = null;
    let lastHotkeyToggleAt = 0;
    let uiStateHydrated = false;
    let pendingUiAction = null;
    let shadowStylesLoaded = false;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function getHostOffset() {
        return window.matchMedia('(max-width: 640px)').matches ? 14 : 24;
    }

    function getViewportPadding() {
        return window.matchMedia('(max-width: 640px)').matches ? 8 : 12;
    }

    function getPanelSizeLimits() {
        const viewportPadding = getViewportPadding();
        const maxWidth = Math.max(220, window.innerWidth - (viewportPadding * 2));
        const maxHeight = Math.max(280, window.innerHeight - (viewportPadding * 2));
        const minWidth = Math.min(MIN_PANEL_WIDTH, maxWidth);
        const minHeight = Math.min(MIN_PANEL_HEIGHT, maxHeight);
        return {
            viewportPadding,
            minWidth,
            minHeight,
            maxWidth,
            maxHeight
        };
    }

    function getDefaultPanelPosition(width = uiState.width, height = uiState.height, side = uiState.side) {
        const { viewportPadding } = getPanelSizeLimits();
        const hostOffset = getHostOffset();
        const preferredLeft = side === 'left'
            ? hostOffset
            : window.innerWidth - width - hostOffset;
        const preferredTop = window.innerHeight - height - hostOffset;
        const maxLeft = Math.max(viewportPadding, window.innerWidth - width - viewportPadding);
        const maxTop = Math.max(viewportPadding, window.innerHeight - height - viewportPadding);
        return {
            left: clamp(preferredLeft, viewportPadding, maxLeft),
            top: clamp(preferredTop, viewportPadding, maxTop)
        };
    }

    function normalizeUiGeometry() {
        const { viewportPadding, minWidth, minHeight, maxWidth, maxHeight } = getPanelSizeLimits();
        const safeWidth = Number.isFinite(uiState.width) ? uiState.width : DEFAULT_PANEL_WIDTH;
        const safeHeight = Number.isFinite(uiState.height) ? uiState.height : DEFAULT_PANEL_HEIGHT;
        uiState.width = Math.round(clamp(safeWidth, minWidth, maxWidth));
        uiState.height = Math.round(clamp(safeHeight, minHeight, maxHeight));

        const hasPosition = uiState.panelPosition
            && Number.isFinite(uiState.panelPosition.left)
            && Number.isFinite(uiState.panelPosition.top);

        if (!hasPosition || !uiState.customPosition) {
            uiState.panelPosition = getDefaultPanelPosition(uiState.width, uiState.height, uiState.side);
            return;
        }

        const maxLeft = Math.max(viewportPadding, window.innerWidth - uiState.width - viewportPadding);
        const maxTop = Math.max(viewportPadding, window.innerHeight - uiState.height - viewportPadding);
        uiState.panelPosition = {
            left: Math.round(clamp(uiState.panelPosition.left, viewportPadding, maxLeft)),
            top: Math.round(clamp(uiState.panelPosition.top, viewportPadding, maxTop))
        };
    }

    function syncSideFromGeometry() {
        if (!uiState.panelPosition) return;
        const centerX = uiState.panelPosition.left + (uiState.width / 2);
        uiState.side = centerX >= (window.innerWidth / 2) ? 'right' : 'left';
    }

    function persistUiState() {
        chrome.storage.local.set({ [UI_STATE_KEY]: uiState });
    }

    function isLikelyLegacyTopRightPosition(state) {
        if (!state?.panelPosition) return false;
        if (state.side !== 'right') return false;
        if (!Number.isFinite(state.panelPosition.left) || !Number.isFinite(state.panelPosition.top)) return false;
        if (!state.customPosition) return false;

        const hostOffset = getHostOffset();
        return state.panelPosition.top <= (hostOffset + 6);
    }

    function migrateAndLoadUiState(onReady) {
        chrome.storage.local.get([UI_STATE_KEY, ...LEGACY_UI_STATE_KEYS], (result) => {
            const loaded = { ...DEFAULT_UI_STATE, ...(result[UI_STATE_KEY] || {}) };
            let migratedLegacy = false;

            if (!result[UI_STATE_KEY]) {
                if (typeof result.sc_ui_width === 'number') {
                    loaded.width = result.sc_ui_width;
                    migratedLegacy = true;
                }
                if (typeof result.sc_ui_height === 'number') {
                    loaded.height = result.sc_ui_height;
                    migratedLegacy = true;
                }
                if (result.sc_ui_position === 'left' || result.sc_ui_position === 'right') {
                    loaded.side = result.sc_ui_position;
                    migratedLegacy = true;
                }
            }

            if (loaded.mode === 'launcher') loaded.mode = 'hidden';
            if (!['open', 'hidden'].includes(loaded.mode)) loaded.mode = 'open';
            if (!['left', 'right'].includes(loaded.side)) loaded.side = 'right';
            if (loaded.activePane === 'settings') loaded.activePane = 'profile';
            if (!['chat', 'history', 'profile'].includes(loaded.activePane)) loaded.activePane = 'chat';
            if (!Number.isFinite(loaded.width)) loaded.width = DEFAULT_PANEL_WIDTH;
            if (!Number.isFinite(loaded.height)) loaded.height = DEFAULT_PANEL_HEIGHT;
            // One-time size migration from old default geometry.
            const isLegacyDefaultSize =
                (loaded.width === PREVIOUS_DEFAULT_PANEL_WIDTH && loaded.height === PREVIOUS_DEFAULT_PANEL_HEIGHT) ||
                (loaded.width === INTERMEDIATE_DEFAULT_PANEL_WIDTH && loaded.height === INTERMEDIATE_DEFAULT_PANEL_HEIGHT);
            if (isLegacyDefaultSize) {
                loaded.width = DEFAULT_PANEL_WIDTH;
                loaded.height = DEFAULT_PANEL_HEIGHT;
                loaded.panelPosition = null;
            }
            if (!loaded.panelPosition || !Number.isFinite(loaded.panelPosition.left) || !Number.isFinite(loaded.panelPosition.top)) {
                loaded.panelPosition = null;
            }
            if (typeof loaded.customPosition !== 'boolean') loaded.customPosition = false;
            if (typeof loaded.movable !== 'boolean') loaded.movable = true;
            if (typeof loaded.resizable !== 'boolean') loaded.resizable = true;
            // Legacy builds persisted top-right as a "custom" position. Reset to the new bottom-right default.
            if (isLikelyLegacyTopRightPosition(loaded)) {
                loaded.customPosition = false;
                loaded.width = DEFAULT_PANEL_WIDTH;
                loaded.height = DEFAULT_PANEL_HEIGHT;
                loaded.panelPosition = null;
            }

            uiState = loaded;
            normalizeUiGeometry();

            const finalize = () => {
                applyUiState();
                if (typeof onReady === 'function') onReady();
            };

            chrome.storage.local.set({ [UI_STATE_KEY]: uiState }, () => {
                if (migratedLegacy) {
                    chrome.storage.local.remove(LEGACY_UI_STATE_KEYS, finalize);
                } else {
                    finalize();
                }
            });
        });
    }

    function applyPanelGeometry() {
        if (!shadowRoot) return;
        normalizeUiGeometry();
        syncSideFromGeometry();

        const host = document.getElementById('screenchat-host');
        if (host) {
            host.classList.toggle('sc-left', uiState.side === 'left');
            const hostOffset = getHostOffset();
            if (uiState.mode === 'open') {
                host.style.left = `${uiState.panelPosition.left}px`;
                host.style.top = `${uiState.panelPosition.top}px`;
                host.style.right = 'auto';
                host.style.bottom = 'auto';
            } else {
                host.style.top = 'auto';
                host.style.bottom = `${hostOffset}px`;
                if (uiState.side === 'left') {
                    host.style.left = `${hostOffset}px`;
                    host.style.right = 'auto';
                } else {
                    host.style.right = `${hostOffset}px`;
                    host.style.left = 'auto';
                }
            }
        }

        const panel = shadowRoot.getElementById('sc-panel');
        if (panel) {
            panel.style.width = `${uiState.width}px`;
            panel.style.height = `${uiState.height}px`;
            panel.classList.toggle('is-movable', !!uiState.movable);
            panel.classList.toggle('is-resizable', !!uiState.resizable);

            // Final guard: never allow any edge of the open panel outside viewport.
            // Skip until the shadow stylesheet is ready to avoid mis-measuring unstyled content.
            if (shadowStylesLoaded && container?.getAttribute('data-mode') === 'open' && host) {
                const { viewportPadding } = getPanelSizeLimits();
                const rect = panel.getBoundingClientRect();
                let dx = 0;
                let dy = 0;

                if (rect.left < viewportPadding) {
                    dx = viewportPadding - rect.left;
                } else if (rect.right > window.innerWidth - viewportPadding) {
                    dx = (window.innerWidth - viewportPadding) - rect.right;
                }

                if (rect.top < viewportPadding) {
                    dy = viewportPadding - rect.top;
                } else if (rect.bottom > window.innerHeight - viewportPadding) {
                    dy = (window.innerHeight - viewportPadding) - rect.bottom;
                }

                if (dx !== 0 || dy !== 0) {
                    const maxLeft = Math.max(viewportPadding, window.innerWidth - uiState.width - viewportPadding);
                    const maxTop = Math.max(viewportPadding, window.innerHeight - uiState.height - viewportPadding);
                    uiState.panelPosition.left = Math.round(clamp(uiState.panelPosition.left + dx, viewportPadding, maxLeft));
                    uiState.panelPosition.top = Math.round(clamp(uiState.panelPosition.top + dy, viewportPadding, maxTop));
                    host.style.left = `${uiState.panelPosition.left}px`;
                    host.style.top = `${uiState.panelPosition.top}px`;
                    syncSideFromGeometry();
                }
            }
        }
    }

    function setActivePane(pane = 'chat', persist = true) {
        if (!shadowRoot) return;
        const panes = {
            chat: 'sc-chat-pane',
            history: 'sc-history-view',
            profile: 'sc-profile-view'
        };
        const targetPane = panes[pane] ? pane : 'chat';

        for (const [key, id] of Object.entries(panes)) {
            const el = shadowRoot.getElementById(id);
            if (el) el.classList.toggle('visible', key === targetPane);
        }

        const chatTab = shadowRoot.getElementById('sc-pane-chat');
        const historyTab = shadowRoot.getElementById('sc-pane-history');
        const profileTab = shadowRoot.getElementById('sc-pane-profile');
        if (chatTab) chatTab.classList.toggle('active', targetPane === 'chat');
        if (historyTab) historyTab.classList.toggle('active', targetPane === 'history');
        if (profileTab) profileTab.classList.toggle('active', targetPane === 'profile');

        uiState.activePane = targetPane;
        if (persist) persistUiState();
    }

    function setUiMode(mode, persist = true) {
        const targetMode = ['open', 'hidden'].includes(mode) ? mode : 'open';
        uiState.mode = targetMode;
        if (container) {
            container.setAttribute('data-mode', targetMode);
        }
        applyPanelGeometry();
        if (targetMode === 'open') {
            setActivePane(uiState.activePane || 'chat', false);
        }
        if (persist) persistUiState();
    }

    function applyUiState() {
        if (!container || !shadowRoot) return;
        applyPanelGeometry();

        setUiMode(uiState.mode, false);
        setActivePane(uiState.activePane, false);
    }

    function focusChatInput(attempts = 8) {
        if (!shadowRoot) return;
        const input = shadowRoot.getElementById('sc-chat-input');
        if (input && !input.disabled) {
            try {
                input.focus({ preventScroll: true });
            } catch (e) {
                input.focus();
            }
            const end = input.value?.length || 0;
            if (typeof input.setSelectionRange === 'function') {
                input.setSelectionRange(end, end);
            }
            if (shadowRoot.activeElement === input || document.activeElement === input) {
                return;
            }
        }
        if (attempts <= 1) return;
        setTimeout(() => {
            requestAnimationFrame(() => focusChatInput(attempts - 1));
        }, 60);
    }

    function setupPanelPointerInteractions() {
        const panel = shadowRoot?.getElementById('sc-panel');
        const headerTop = shadowRoot?.querySelector('.sc-header-top');
        if (!panel || !headerTop) return;

        const startInteraction = (event, interactionType, direction = '') => {
            if (activePanelInteraction) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            if (interactionType === 'move' && !uiState.movable) return;
            if (interactionType === 'resize' && (!uiState.resizable || !direction)) return;

            const nonDragTarget = event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]');
            if (interactionType === 'move' && nonDragTarget) return;

            event.preventDefault();
            event.stopPropagation();

            normalizeUiGeometry();
            const target = event.currentTarget;
            const pointerId = event.pointerId;

            activePanelInteraction = {
                pointerId,
                type: interactionType,
                direction,
                startX: event.clientX,
                startY: event.clientY,
                startLeft: uiState.panelPosition.left,
                startTop: uiState.panelPosition.top,
                startWidth: uiState.width,
                startHeight: uiState.height,
                target
            };
            uiState.customPosition = true;

            panel.classList.add('sc-interacting');
            if (interactionType === 'move') {
                headerTop.classList.add('sc-dragging');
            }

            if (target.setPointerCapture) {
                try {
                    target.setPointerCapture(pointerId);
                } catch (e) { }
            }

            const finishInteraction = () => {
                if (!activePanelInteraction || activePanelInteraction.pointerId !== pointerId) return;

                window.removeEventListener('pointermove', onPointerMove, true);
                window.removeEventListener('pointerup', onPointerUpOrCancel, true);
                window.removeEventListener('pointercancel', onPointerUpOrCancel, true);
                window.removeEventListener('mouseup', onMouseUpFallback, true);
                window.removeEventListener('blur', onWindowBlur);
                target.removeEventListener('lostpointercapture', onLostPointerCapture);

                if (target.releasePointerCapture) {
                    try {
                        target.releasePointerCapture(pointerId);
                    } catch (e) { }
                }

                panel.classList.remove('sc-interacting');
                headerTop.classList.remove('sc-dragging');
                activePanelInteraction = null;
                persistUiState();
            };

            const onPointerMove = (moveEvent) => {
                if (!activePanelInteraction) return;
                // Fallback for pages/browsers that swallow pointerup: stop dragging if primary mouse button is no longer down.
                if (moveEvent.pointerType === 'mouse' && (moveEvent.buttons & 1) === 0) {
                    finishInteraction();
                    return;
                }
                if (moveEvent.pointerId !== pointerId) return;
                moveEvent.preventDefault();

                const dx = moveEvent.clientX - activePanelInteraction.startX;
                const dy = moveEvent.clientY - activePanelInteraction.startY;

                if (activePanelInteraction.type === 'move') {
                    const { viewportPadding } = getPanelSizeLimits();
                    const maxLeft = Math.max(viewportPadding, window.innerWidth - activePanelInteraction.startWidth - viewportPadding);
                    const maxTop = Math.max(viewportPadding, window.innerHeight - activePanelInteraction.startHeight - viewportPadding);
                    uiState.panelPosition.left = Math.round(clamp(activePanelInteraction.startLeft + dx, viewportPadding, maxLeft));
                    uiState.panelPosition.top = Math.round(clamp(activePanelInteraction.startTop + dy, viewportPadding, maxTop));
                } else {
                    const { direction: resizeDirection } = activePanelInteraction;
                    const { viewportPadding, minWidth, minHeight, maxWidth, maxHeight } = getPanelSizeLimits();
                    let nextLeft = activePanelInteraction.startLeft;
                    let nextTop = activePanelInteraction.startTop;
                    let nextWidth = activePanelInteraction.startWidth;
                    let nextHeight = activePanelInteraction.startHeight;

                    if (resizeDirection.includes('e')) {
                        const maxWidthByRightEdge = Math.max(minWidth, window.innerWidth - viewportPadding - nextLeft);
                        nextWidth = clamp(
                            activePanelInteraction.startWidth + dx,
                            minWidth,
                            Math.min(maxWidth, maxWidthByRightEdge)
                        );
                    }

                    if (resizeDirection.includes('s')) {
                        const maxHeightByBottomEdge = Math.max(minHeight, window.innerHeight - viewportPadding - nextTop);
                        nextHeight = clamp(
                            activePanelInteraction.startHeight + dy,
                            minHeight,
                            Math.min(maxHeight, maxHeightByBottomEdge)
                        );
                    }

                    if (resizeDirection.includes('w')) {
                        const maxWidthByLeftEdge = Math.max(minWidth, activePanelInteraction.startLeft + activePanelInteraction.startWidth - viewportPadding);
                        nextWidth = clamp(
                            activePanelInteraction.startWidth - dx,
                            minWidth,
                            Math.min(maxWidth, maxWidthByLeftEdge)
                        );
                        nextLeft = activePanelInteraction.startLeft + (activePanelInteraction.startWidth - nextWidth);
                    }

                    if (resizeDirection.includes('n')) {
                        const maxHeightByTopEdge = Math.max(minHeight, activePanelInteraction.startTop + activePanelInteraction.startHeight - viewportPadding);
                        nextHeight = clamp(
                            activePanelInteraction.startHeight - dy,
                            minHeight,
                            Math.min(maxHeight, maxHeightByTopEdge)
                        );
                        nextTop = activePanelInteraction.startTop + (activePanelInteraction.startHeight - nextHeight);
                    }

                    const maxLeft = Math.max(viewportPadding, window.innerWidth - nextWidth - viewportPadding);
                    const maxTop = Math.max(viewportPadding, window.innerHeight - nextHeight - viewportPadding);

                    uiState.width = Math.round(nextWidth);
                    uiState.height = Math.round(nextHeight);
                    uiState.panelPosition.left = Math.round(clamp(nextLeft, viewportPadding, maxLeft));
                    uiState.panelPosition.top = Math.round(clamp(nextTop, viewportPadding, maxTop));
                }

                syncSideFromGeometry();
                applyPanelGeometry();
            };

            const onPointerUpOrCancel = (upEvent) => {
                if (!activePanelInteraction) return;
                if (upEvent.pointerId !== pointerId && upEvent.type !== 'pointercancel') return;
                finishInteraction();
            };

            const onMouseUpFallback = () => finishInteraction();
            const onLostPointerCapture = (lostEvent) => {
                if (!activePanelInteraction || lostEvent.pointerId !== pointerId) return;
                finishInteraction();
            };
            const onWindowBlur = () => finishInteraction();

            window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
            window.addEventListener('pointerup', onPointerUpOrCancel, true);
            window.addEventListener('pointercancel', onPointerUpOrCancel, true);
            window.addEventListener('mouseup', onMouseUpFallback, true);
            window.addEventListener('blur', onWindowBlur);
            target.addEventListener('lostpointercapture', onLostPointerCapture);
        };

        headerTop.addEventListener('pointerdown', (event) => startInteraction(event, 'move'));

        const resizeHandles = panel.querySelectorAll('.sc-resize-handle');
        resizeHandles.forEach((handle) => {
            const direction = handle.getAttribute('data-direction') || '';
            handle.addEventListener('pointerdown', (event) => startInteraction(event, 'resize', direction));
        });
    }

    // Adapted interaction pattern inspired by 21st.dev Typewriter (MIT).
    function runTypewriter(target, fullText, speed = 18) {
        if (!target) return;
        target.textContent = '';
        let idx = 0;

        const tick = () => {
            target.textContent = fullText.slice(0, idx);
            idx += 1;
            if (idx <= fullText.length) {
                setTimeout(tick, speed);
            } else {
                target.classList.remove('typing');
            }
        };

        target.classList.add('typing');
        tick();
    }

    function isMacDevice() {
        const platform = navigator.userAgentData?.platform || navigator.platform || '';
        return /Mac|iPhone|iPad|iPod/i.test(platform);
    }

    function getHotkeyParts() {
        return isMacDevice() ? ['⌘', '⇧', 'Y'] : ['Ctrl', 'Shift', 'Y'];
    }

    function isTextEditingTarget(target) {
        if (!(target instanceof Element)) return false;
        if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
        return false;
    }

    function isScreenChatEvent(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        return path.some((node) => node && node.id === 'screenchat-host');
    }

    function installHostEventShield(host) {
        if (!host || host.dataset.scShieldInstalled === '1') return;

        const shieldedEvents = [
            'click', 'dblclick', 'auxclick',
            'mousedown', 'mouseup',
            'pointerdown', 'pointerup',
            'touchstart', 'touchend',
            'contextmenu',
            'keydown', 'keyup', 'keypress',
            'input', 'change'
        ];

        const stopFromPage = (event) => {
            event.stopPropagation();
        };

        shieldedEvents.forEach((eventName) => {
            host.addEventListener(eventName, stopFromPage);
        });

        host.dataset.scShieldInstalled = '1';
    }

    function isToggleHotkeyEvent(event) {
        const key = (event.key || '').toLowerCase();
        const yPressed = key === 'y' || event.code === 'KeyY';
        if (!yPressed || !event.shiftKey || event.altKey || event.repeat) return false;

        if (isMacDevice()) {
            return event.metaKey && !event.ctrlKey;
        }
        return event.ctrlKey && !event.metaKey;
    }

    function triggerHotkeyToggle() {
        const now = Date.now();
        if (now - lastHotkeyToggleAt < 160) return;
        lastHotkeyToggleAt = now;
        toggleUIFromHotkey();
    }

    function onGlobalHotkeyKeydown(event) {
        if (!isToggleHotkeyEvent(event)) return;
        if (event.defaultPrevented) return;

        const editing = isTextEditingTarget(event.target);
        const fromScreenChat = isScreenChatEvent(event);
        if (editing && !fromScreenChat) return;

        event.preventDefault();
        event.stopPropagation();
        triggerHotkeyToggle();
    }

    function renderHotkeyHint() {
        const hint = shadowRoot?.getElementById('sc-hotkey-hint');
        if (!hint) return;
        const parts = getHotkeyParts();
        const keycaps = parts
            .map((key) => `<span class="sc-keycap">${escapeHtml(key)}</span>`)
            .join('<span class="sc-keycap-plus" aria-hidden="true">+</span>');
        hint.innerHTML = `<div class="sc-hotkey-hint-keys" role="note" aria-label="ScreenChat hotkey">${keycaps}</div>`;
    }

    function openUiFromActivation() {
        // Open in the default anchored corner on activation.
        uiState.side = 'right';
        uiState.customPosition = false;
        uiState.panelPosition = getDefaultPanelPosition(uiState.width, uiState.height, 'right');
        setUiMode('open');
        setActivePane('chat', false);
    }

    function runUiAction(action) {
        if (action === 'toggle_ui') {
            toggleUI();
        } else if (action === 'open_ui') {
            openUiFromActivation();
        } else if (action === 'hotkey_toggle_ui') {
            triggerHotkeyToggle();
        }
    }

    function handleUiAction(action) {
        if (!uiStateHydrated) {
            pendingUiAction = action;
            return;
        }
        runUiAction(action);
    }

    function syncQuickPromptsVisibility() {
        const prompts = shadowRoot?.getElementById('sc-quick-prompts');
        const messagesArea = shadowRoot?.getElementById('sc-messages');
        const hotkeyHint = shadowRoot?.getElementById('sc-hotkey-hint');
        const hasUserMessageInHistory = conversationHistory.some((msg) => {
            const role = typeof msg?.role === 'string' ? msg.role.trim().toLowerCase() : '';
            return role === 'user' || role === 'human';
        });
        const hasUserMessageInDom = !!messagesArea?.querySelector('.sc-message.user');
        const shouldHidePrompts = hasUserMessageInHistory || hasUserMessageInDom || isAwaitingResponse;
        if (prompts) {
            prompts.classList.toggle('hidden', shouldHidePrompts);
        }
        if (hotkeyHint) {
            hotkeyHint.classList.toggle('hidden', shouldHidePrompts);
        }
        if (messagesArea) {
            messagesArea.classList.toggle('is-empty', !hasUserMessageInHistory && !hasUserMessageInDom && !isAwaitingResponse);
        }
    }

    function renderWelcomeMessage(withTypewriter = false) {
        const messagesArea = shadowRoot?.getElementById('sc-messages');
        if (!messagesArea) return;

        const welcomeText = "Hello! I'm ScreenChat. Ask anything about this page and I will help.";
        if (withTypewriter && !hasTypedWelcome) {
            messagesArea.innerHTML = `
                <div class="sc-message ai">
                    <div class="sc-bubble">
                        <span id="sc-welcome-typewriter" class="sc-typewriter-target"></span>
                    </div>
                    <div class="sc-timestamp">Just now</div>
                </div>
            `;
            const target = messagesArea.querySelector('#sc-welcome-typewriter');
            runTypewriter(target, welcomeText, 20);
            hasTypedWelcome = true;
        } else {
            messagesArea.innerHTML = `
                <div class="sc-message ai">
                    <div class="sc-bubble">${escapeHtml(welcomeText)}</div>
                    <div class="sc-timestamp">Just now</div>
                </div>
            `;
        }
        syncQuickPromptsVisibility();
    }

    function startNewSession(resetUI = true, withTypewriter = false) {
        sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
        sessionUrl = window.location.href || window.location.hostname || 'unknown';
        conversationHistory = [];
        isAwaitingResponse = false;
        hasLocalConversationMutation = false;
        chrome.storage.local.remove(['conversationHistory']);

        if (resetUI) {
            renderWelcomeMessage(withTypewriter);
            setActivePane('chat');
            setUiMode('open');
        }
    }

    function getAttachScreenTooltip(isEnabled) {
        return isEnabled
            ? 'Attached: messages include a screenshot of this page'
            : 'Detached: messages use text/context only';
    }

    function ensureAttachGlowOverlay() {
        let overlay = shadowRoot?.getElementById(ATTACH_GLOW_OVERLAY_ID);
        if (overlay) return overlay;

        if (!shadowRoot) return null;

        overlay = document.createElement('div');
        overlay.id = ATTACH_GLOW_OVERLAY_ID;
        overlay.setAttribute('aria-hidden', 'true');
        shadowRoot.appendChild(overlay);
        return overlay;
    }

    function playAttachGlowAnimation() {
        const overlay = ensureAttachGlowOverlay();
        if (!overlay) return;
        overlay.classList.remove('active');
        // Restart animation when user toggles repeatedly.
        void overlay.offsetWidth;
        overlay.classList.add('active');
        overlay.addEventListener('animationend', () => {
            overlay.classList.remove('active');
        }, { once: true });
    }

    function setAttachScreenEnabled(enabled, persist = true) {
        const wasEnabled = attachScreenEnabled;
        attachScreenEnabled = !!enabled;
        const toggle = shadowRoot?.getElementById('sc-attach-screen-toggle');
        if (toggle) {
            toggle.classList.toggle('active', attachScreenEnabled);
            toggle.setAttribute('aria-pressed', attachScreenEnabled ? 'true' : 'false');
            toggle.setAttribute('aria-label', attachScreenEnabled ? 'Disable attach screen' : 'Enable attach screen');
            toggle.setAttribute('data-tooltip', getAttachScreenTooltip(attachScreenEnabled));
        }

        if (attachScreenEnabled && !wasEnabled && persist) {
            playAttachGlowAnimation();
        }

        if (persist) {
            chrome.storage.local.set({ [ATTACH_SCREEN_KEY]: attachScreenEnabled });
        }
    }

    function captureCurrentScreen() {
        return new Promise((resolve, reject) => {
            const previousVisibility = container?.style.visibility || '';
            if (container) {
                container.style.visibility = 'hidden';
            }

            const finalize = (handler) => (value) => {
                if (container) {
                    container.style.visibility = previousVisibility;
                }
                handler(value);
            };

            try {
                requestAnimationFrame(() => {
                    chrome.runtime.sendMessage({ action: 'capture_visible_tab' }, (response) => {
                        if (chrome.runtime.lastError) {
                            return finalize(reject)(new Error(chrome.runtime.lastError.message || 'Failed to capture screen'));
                        }
                        if (!response?.ok || typeof response.image !== 'string' || !response.image) {
                            return finalize(reject)(new Error(response?.error || 'Failed to capture screen'));
                        }
                        finalize(resolve)(response.image);
                    });
                });
            } catch (error) {
                finalize(reject)(error);
            }
        });
    }

    // Initialize
    function init() {
        const existing = document.getElementById('screenchat-host');
        if (existing) existing.remove();

        const host = document.createElement('div');
        host.id = 'screenchat-host';
        document.body.appendChild(host);
        installHostEventShield(host);

        shadowRoot = host.attachShadow({ mode: 'open' });

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('content.css');
        const onStylesReady = () => {
            if (shadowStylesLoaded) return;
            shadowStylesLoaded = true;
            // Re-apply geometry after CSS loads so first paint uses accurate panel bounds.
            requestAnimationFrame(() => applyPanelGeometry());
        };
        link.addEventListener('load', onStylesReady, { once: true });
        link.addEventListener('error', onStylesReady, { once: true });
        shadowRoot.appendChild(link);

        createUI();
        resolveApiBaseUrl().catch((error) => {
            console.warn('[API] Backend discovery failed:', error);
        });

        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === 'toggle_ui' || request.action === 'open_ui' || request.action === 'hotkey_toggle_ui') {
                handleUiAction(request.action);
            }
        });

        window.addEventListener('keydown', onGlobalHotkeyKeydown, true);

        window.addEventListener('resize', () => {
            if (!container) return;
            applyPanelGeometry();
        });

        migrateAndLoadUiState(() => {
            uiStateHydrated = true;
            if (pendingUiAction) {
                const action = pendingUiAction;
                pendingUiAction = null;
                runUiAction(action);
            }
        });

        chrome.storage.local.get(['screenchat_user', 'conversationHistory', 'messageCount', 'sessionDomain', ATTACH_SCREEN_KEY], (result) => {
            const currentDomain = window.location.hostname;
            if (typeof result[ATTACH_SCREEN_KEY] === 'boolean') {
                setAttachScreenEnabled(result[ATTACH_SCREEN_KEY], false);
            } else {
                setAttachScreenEnabled(attachScreenEnabled, true);
            }

            if (result.sessionDomain && result.sessionDomain !== currentDomain) {
                startNewSession(false, false);
            } else if (result.screenchat_user) {
                userId = result.screenchat_user.userId;
                authState = 'AUTHENTICATED';
            }

            chrome.storage.local.set({ sessionDomain: currentDomain });

            if (result.screenchat_user) {
                userId = result.screenchat_user.userId;
                authState = 'AUTHENTICATED';
            } else if (result.messageCount) {
                messageCount = result.messageCount;
            }

            const messagesArea = shadowRoot.getElementById('sc-messages');
            const uiAlreadyHasMessages = !!messagesArea?.querySelector('.sc-message');
            const canHydrateConversation = !hasLocalConversationMutation && !uiAlreadyHasMessages && conversationHistory.length === 0;

            if (canHydrateConversation) {
                if (result.conversationHistory && result.conversationHistory.length > 0 && (!result.sessionDomain || result.sessionDomain === currentDomain)) {
                    conversationHistory = result.conversationHistory;
                    if (messagesArea) {
                        messagesArea.innerHTML = '';
                        conversationHistory.forEach((msg) => {
                            addMessage(msg.content, msg.role === 'user' ? 'user' : 'ai', null, true);
                        });
                    }
                } else {
                    renderWelcomeMessage(true);
                }
            }
            syncQuickPromptsVisibility();
        });
    }

    // Create UI Structure
    function createUI() {
        container = document.createElement('div');
        container.className = 'sc-shell';

        container.innerHTML = `
            <button class="sc-launcher" id="sc-launcher" title="Open ScreenChat" aria-label="Open ScreenChat">
                <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="sc-launcher-logo" alt="ScreenChat">
            </button>

            <section class="sc-panel" id="sc-panel" role="dialog" aria-label="ScreenChat Assistant">
                <div class="sc-header">
                    <div class="sc-header-top">
                        <div class="sc-header-left">
                            <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="sc-logo" alt="ScreenChat">
                            <div class="sc-brand-copy">
                                <span class="sc-title">ScreenChat</span>
                                <span class="sc-subtitle">Page Assistant</span>
                            </div>
                        </div>
                        <div class="sc-header-actions">
                            <button class="sc-btn-icon" id="sc-history-btn" title="History" aria-label="History">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M3 12a9 9 0 109-9 9.2 9.2 0 00-6.36 2.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                                    <path d="M3 4v4h4M12 7v5l3 2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <button class="sc-btn-icon" id="sc-profile-btn" title="Profile" aria-label="Profile">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.9"/>
                                    <path d="M5.5 19.2c1.55-2.56 3.9-3.84 6.5-3.84s4.95 1.28 6.5 3.84" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                                </svg>
                            </button>
                            <button class="sc-btn-icon sc-btn-new" id="sc-new-chat" title="New Chat" aria-label="Start new chat">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                            </button>
                            <button class="sc-btn-icon" id="sc-close" title="Close" aria-label="Close ScreenChat">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="sc-pane sc-pane-chat visible" id="sc-chat-pane">
                    <div class="sc-messages" id="sc-messages"></div>
                    <div class="sc-quick-prompts" id="sc-quick-prompts">
                        <button class="sc-prompt-btn" data-prompt="Summarize this page in 5 bullets.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">📝</span>
                                <span class="sc-prompt-title">Summarize this page</span>
                            </span>
                            <span class="sc-prompt-chip">/summary</span>
                        </button>
                        <button class="sc-prompt-btn" data-prompt="What are the most important takeaways here?">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">💡</span>
                                <span class="sc-prompt-title">Key takeaways</span>
                            </span>
                            <span class="sc-prompt-chip">/takeaways</span>
                        </button>
                        <button class="sc-prompt-btn" data-prompt="What should I do next based on this page?">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">🧭</span>
                                <span class="sc-prompt-title">What should I do next?</span>
                            </span>
                            <span class="sc-prompt-chip">/next</span>
                        </button>
                    </div>
                    <div class="sc-hotkey-hint" id="sc-hotkey-hint"></div>
                    <div class="sc-input-area">
                        <div class="sc-input-row">
                            <button class="sc-attach-toggle ${attachScreenEnabled ? 'active' : ''}" id="sc-attach-screen-toggle" type="button" aria-label="${attachScreenEnabled ? 'Disable attach screen' : 'Enable attach screen'}" aria-pressed="${attachScreenEnabled ? 'true' : 'false'}" data-tooltip="${getAttachScreenTooltip(attachScreenEnabled)}">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M21.44 11.05L12.95 19.54a5 5 0 01-7.07-7.07l8.49-8.49a3 3 0 114.24 4.24l-8.49 8.49a1 1 0 01-1.41-1.41l7.78-7.78" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <div class="sc-input-wrapper">
                                <textarea class="sc-textarea" id="sc-chat-input" placeholder="Ask me anything about this page..." rows="1"></textarea>
                            </div>
                            <button class="sc-send-btn" id="sc-send" title="Send (Enter)" aria-label="Send message">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="sc-pane" id="sc-history-view">
                    <div class="sc-pane-header">
                        <h3>Chat History</h3>
                        <button class="sc-btn-icon" id="sc-history-close" title="Back" aria-label="Back to chat">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <div class="sc-history-list" id="sc-history-list"></div>
                </div>

                <div class="sc-pane" id="sc-profile-view">
                    <div class="sc-pane-header">
                        <h3>Personalize Experience</h3>
                        <button class="sc-btn-icon" id="sc-profile-close" title="Back" aria-label="Back to chat">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                                <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    <div class="sc-profile-content">
                        <p class="sc-profile-desc">Optional info to personalize your experience and tailor responses.</p>
                        <div class="sc-profile-field">
                            <label for="sc-profile-name">Full Name</label>
                            <input type="text" id="sc-profile-name" placeholder="John Doe">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-nickname">Nickname</label>
                            <input type="text" id="sc-profile-nickname" placeholder="Johnny">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-email">Email</label>
                            <input type="email" id="sc-profile-email" placeholder="john@example.com">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-phone">Phone</label>
                            <input type="tel" id="sc-profile-phone" placeholder="+1 234 567 8900">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-notes">Notes</label>
                            <textarea id="sc-profile-notes" placeholder="e.g., I work at Google, prefer formal responses..."></textarea>
                        </div>
                        <button class="sc-profile-save" id="sc-profile-save">Save Profile</button>
                    </div>
                </div>

                <div class="sc-resize-handle sc-resize-handle-n" data-direction="n" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-e" data-direction="e" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-s" data-direction="s" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-w" data-direction="w" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-ne" data-direction="ne" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-nw" data-direction="nw" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-se" data-direction="se" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-sw" data-direction="sw" aria-hidden="true"></div>
            </section>
        `;

        container.setAttribute('data-mode', uiState.mode);
        shadowRoot.appendChild(container);
        renderHotkeyHint();
        setActivePane('chat', false);
        setupEventListeners();
    }

    function setupEventListeners() {
        const launcherBtn = shadowRoot.getElementById('sc-launcher');
        const closeBtn = shadowRoot.getElementById('sc-close');
        const newChatBtn = shadowRoot.getElementById('sc-new-chat');

        const historyBtn = shadowRoot.getElementById('sc-history-btn');
        const profileBtn = shadowRoot.getElementById('sc-profile-btn');

        const historyCloseBtn = shadowRoot.getElementById('sc-history-close');
        const profileCloseBtn = shadowRoot.getElementById('sc-profile-close');

        const sendBtn = shadowRoot.getElementById('sc-send');
        const textarea = shadowRoot.getElementById('sc-chat-input');
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const attachScreenToggle = shadowRoot.getElementById('sc-attach-screen-toggle');

        const profileSaveBtn = shadowRoot.getElementById('sc-profile-save');
        const profileNameInput = shadowRoot.getElementById('sc-profile-name');
        const profileNicknameInput = shadowRoot.getElementById('sc-profile-nickname');
        const profileEmailInput = shadowRoot.getElementById('sc-profile-email');
        const profilePhoneInput = shadowRoot.getElementById('sc-profile-phone');
        const profileNotesInput = shadowRoot.getElementById('sc-profile-notes');

        const quickPromptButtons = shadowRoot.querySelectorAll('.sc-prompt-btn');
        setupPanelPointerInteractions();

        if (attachScreenToggle) {
            setAttachScreenEnabled(attachScreenEnabled, false);
            attachScreenToggle.addEventListener('click', () => {
                setAttachScreenEnabled(!attachScreenEnabled, true);
            });
        }

        const openPane = (pane) => {
            setUiMode('open');
            setActivePane(pane);
            if (pane === 'history') {
                loadHistory();
            }
        };

        if (launcherBtn) {
            launcherBtn.addEventListener('click', () => {
                setUiMode('open');
                setActivePane(uiState.activePane || 'chat', false);
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setUiMode('hidden');
            });
        }

        if (historyBtn) historyBtn.addEventListener('click', () => openPane('history'));
        if (profileBtn) profileBtn.addEventListener('click', () => openPane('profile'));

        if (historyCloseBtn) historyCloseBtn.addEventListener('click', () => openPane('chat'));
        if (profileCloseBtn) profileCloseBtn.addEventListener('click', () => openPane('chat'));

        async function loadProfile() {
            try {
                const response = await apiFetch(`/api/profile?userId=${encodeURIComponent(userId)}`);
                const data = await response.json();
                if (data.profile) {
                    userProfile = data.profile;
                    if (profileNameInput) profileNameInput.value = data.profile.fullName || '';
                    if (profileNicknameInput) profileNicknameInput.value = data.profile.nickname || '';
                    if (profileEmailInput) profileEmailInput.value = data.profile.email || '';
                    if (profilePhoneInput) profilePhoneInput.value = data.profile.phone || '';
                    if (profileNotesInput) profileNotesInput.value = data.profile.notes || '';
                }
            } catch (e) {
                console.error('[Profile] Load error:', e);
            }
        }

        setTimeout(loadProfile, 500);

        if (profileSaveBtn) {
            profileSaveBtn.addEventListener('click', async () => {
                profileSaveBtn.disabled = true;
                profileSaveBtn.textContent = 'Saving...';

                const profile = {
                    fullName: profileNameInput?.value || '',
                    nickname: profileNicknameInput?.value || '',
                    email: profileEmailInput?.value || '',
                    phone: profilePhoneInput?.value || '',
                    notes: profileNotesInput?.value || ''
                };

                try {
                    const response = await apiFetch('/api/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId, profile })
                    });
                    const data = await response.json();
                    if (data.success) {
                        userProfile = profile;
                        profileSaveBtn.textContent = 'Saved';
                        setTimeout(() => {
                            profileSaveBtn.textContent = 'Save Profile';
                            profileSaveBtn.disabled = false;
                            openPane('chat');
                        }, 900);
                    } else {
                        throw new Error(data.error || 'Failed to save');
                    }
                } catch (e) {
                    console.error('[Profile] Save error:', e);
                    profileSaveBtn.textContent = 'Error';
                    setTimeout(() => {
                        profileSaveBtn.textContent = 'Save Profile';
                        profileSaveBtn.disabled = false;
                    }, 1500);
                }
            });
        }

        async function loadHistory() {
            const listContainer = shadowRoot.getElementById('sc-history-list');
            if (!listContainer) return;
            listContainer.innerHTML = '<div class="sc-loading">Loading history...</div>';

            try {
                const response = await apiFetch(`/api/history?userId=${encodeURIComponent(userId)}`);
                const data = await response.json();

                if (data.sessions && data.sessions.length > 0) {
                    listContainer.innerHTML = '';
                    data.sessions.forEach((session) => {
                        const item = document.createElement('div');
                        item.className = 'sc-history-item';
                        const dateStr = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : 'Unknown date';
                        item.innerHTML = `
                            <div class="sc-history-info">
                                <span class="sc-history-domain">${session.url || 'Unknown URL'}</span>
                                <span class="sc-history-date">${dateStr}</span>
                            </div>
                            <button class="sc-history-open" title="Open Conversation">Open</button>
                        `;
                        const openBtn = item.querySelector('.sc-history-open');
                        openBtn?.addEventListener('click', () => restoreSession(session.id, session.url));
                        listContainer.appendChild(item);
                    });
                } else {
                    listContainer.innerHTML = '<div class="sc-empty">No history found.</div>';
                }
            } catch (e) {
                listContainer.innerHTML = '<div class="sc-error">Failed to load history.</div>';
            }
        }

        async function restoreSession(sid, url) {
            const listContainer = shadowRoot.getElementById('sc-history-list');
            if (!listContainer) return;
            const originalContent = listContainer.innerHTML;
            listContainer.innerHTML = '<div class="sc-loading">Restoring chat...</div>';

            try {
                const response = await apiFetch(`/api/history/messages?userId=${encodeURIComponent(userId)}&sessionId=${encodeURIComponent(sid)}`);
                const data = await response.json();

                if (data.history) {
                    sessionId = sid;
                    sessionUrl = url || 'restored_session';
                    conversationHistory = data.history;

                    messagesArea.innerHTML = '';
                    conversationHistory.forEach((msg) => {
                        const content = msg.role === 'user' ? cleanUserMessage(msg.content) : cleanAiReply(msg.content);
                        if (content && content.toLowerCase() !== 'continue') {
                            addMessage(content, msg.role === 'user' ? 'user' : 'ai', null, true);
                        }
                    });

                    chrome.storage.local.set({
                        conversationHistory,
                        sessionDomain: window.location.hostname
                    });

                    openPane('chat');
                }
            } catch (e) {
                console.error('Restore failed', e);
                listContainer.innerHTML = originalContent;
                addMessage('Failed to restore this session.', 'ai');
            }
        }

        if (newChatBtn) {
            newChatBtn.addEventListener('click', () => {
                startNewSession(true, false);
            });
        }

        quickPromptButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                textarea.value = btn.dataset.prompt || '';
                handleSend();
            });
        });

        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
        });

        const handleSend = async () => {
            const text = textarea.value.trim();
            if (!text) return;

            textarea.value = '';
            textarea.style.height = 'auto';
            hasLocalConversationMutation = true;

            addMessage(text, 'user');

            conversationHistory.push({ role: 'user', content: text });
            chrome.storage.local.set({ conversationHistory });
            syncQuickPromptsVisibility();

            isAwaitingResponse = true;
            setInputState(false, 'Working...');
            syncQuickPromptsVisibility();

            const loadingId = addLoadingMessage();
            let streamedMessageEl = null;
            let latestStreamText = '';
            let streamRenderPending = false;
            let streamCancelled = false;
            let requestTimedOut = false;
            let requestTimeoutId = null;

            const renderStreamMessage = () => {
                if (streamCancelled) return;
                if (!streamedMessageEl) {
                    removeMessage(loadingId);
                    streamedMessageEl = addMessage('', 'ai', null, true);
                }
                updateMessageContent(streamedMessageEl, latestStreamText);
            };

            const onPartialText = (partialReply) => {
                if (streamCancelled) return;
                latestStreamText = typeof partialReply === 'string'
                    ? partialReply
                    : String(partialReply ?? '');
                if (streamRenderPending) return;
                streamRenderPending = true;
                requestAnimationFrame(() => {
                    streamRenderPending = false;
                    renderStreamMessage();
                });
            };

            try {
                const messagesPayload = conversationHistory.map((msg) => {
                    if (msg?.role === 'user') {
                        return { role: 'user', content: cleanUserMessage(msg.content) };
                    }
                    if (msg?.role === 'assistant') {
                        return { role: 'assistant', content: cleanAiReply(msg.content) };
                    }
                    return msg;
                });
                sessionUrl = window.location.href || sessionUrl;

                let attachedImage = null;
                try {
                    attachedImage = await captureCurrentScreen();
                } catch (captureError) {
                    console.warn('[ScreenCapture] Capture failed:', captureError);
                }

                currentAbortController = new AbortController();

                const chatPayload = {
                    messages: messagesPayload,
                    userId,
                    sessionId,
                    sessionUrl,
                    mode: chatMode,
                    profile: userProfile,
                    image: attachedImage
                };

                const responseText = await Promise.race([
                    requestChatReply(chatPayload, {
                        signal: currentAbortController.signal,
                        onPartialText
                    }),
                    new Promise((_, reject) => {
                        requestTimeoutId = setTimeout(() => {
                            requestTimedOut = true;
                            try {
                                currentAbortController?.abort();
                            } catch {
                                // No-op.
                            }
                            const timeoutError = new Error('Request timed out');
                            timeoutError.name = 'TimeoutError';
                            reject(timeoutError);
                        }, CHAT_REQUEST_TIMEOUT_MS);
                    })
                ]);

                if (streamRenderPending) {
                    streamRenderPending = false;
                    renderStreamMessage();
                }
                removeMessage(loadingId);
                if (streamedMessageEl) {
                    updateMessageContent(streamedMessageEl, responseText);
                } else {
                    addMessage(responseText, 'ai');
                }
                if (requestTimeoutId) {
                    clearTimeout(requestTimeoutId);
                    requestTimeoutId = null;
                }

                conversationHistory.push({ role: 'assistant', content: responseText });
                chrome.storage.local.set({ conversationHistory });
                isAwaitingResponse = false;
                setInputState(true);
                syncQuickPromptsVisibility();
            } catch (backendErr) {
                if (requestTimeoutId) {
                    clearTimeout(requestTimeoutId);
                    requestTimeoutId = null;
                }
                streamCancelled = true;
                if (streamedMessageEl?.isConnected) {
                    streamedMessageEl.remove();
                }
                if (backendErr.name === 'AbortError' || backendErr.name === 'TimeoutError') {
                    removeMessage(loadingId);
                    isAwaitingResponse = false;
                    setInputState(true);
                    if (requestTimedOut) {
                        addMessage(`Request timed out after ${Math.floor(CHAT_REQUEST_TIMEOUT_MS / 1000)} seconds. Please try again.`, 'ai');
                        conversationHistory.pop();
                        chrome.storage.local.set({ conversationHistory });
                    }
                    syncQuickPromptsVisibility();
                    return;
                }
                removeMessage(loadingId);
                isAwaitingResponse = false;
                setInputState(true);
                const backendMessage = backendErr?.message || 'Unknown error';
                const userError = backendMessage === 'Failed to fetch'
                    ? 'Unable to reach ScreenChat backend. Confirm the backend is running, then reload the extension.'
                    : `Request failed: ${backendMessage}`;
                addMessage(userError, 'ai');
                conversationHistory.pop();
                chrome.storage.local.set({ conversationHistory });
                syncQuickPromptsVisibility();
            }
        };

        sendBtn.addEventListener('click', handleSend);

        const onEnter = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        };

        const isolateTypingFromPageShortcuts = (e) => {
            e.stopPropagation();
        };

        textarea.addEventListener('keydown', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keyup', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keypress', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keydown', onEnter);
    }

    function formatMessageContent(text) {
        let formattedText = escapeHtml(text)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.*?)__/g, '<u>$1</u>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');

        formattedText = formattedText.replace(
            /(https?:\/\/[^\s]+)/g,
            '<a href="$1" target="_blank" class="sc-inline-link">$1</a>'
        );

        return formattedText;
    }

    function updateMessageContent(messageEl, text, imageUrl = null) {
        if (!messageEl) return;
        const bubble = messageEl.querySelector('.sc-bubble');
        if (!bubble) return;

        const attachmentHtml = imageUrl
            ? `<div class="sc-attachment"><img src="${imageUrl}" alt="Screenshot"></div>`
            : '';
        const formattedText = formatMessageContent(typeof text === 'string' ? text : String(text ?? ''));
        bubble.innerHTML = `${formattedText}${attachmentHtml}`;

        const messagesArea = shadowRoot?.getElementById('sc-messages');
        if (messagesArea) {
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }
    }

    function addMessage(text, type, imageUrl = null, skipSave = false) {
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `sc-message ${type}`;

        msgDiv.innerHTML = `
            <div class="sc-bubble">
            </div>
            <div class="sc-timestamp">Just now</div>
        `;
        updateMessageContent(msgDiv, text, imageUrl);

        messagesArea.appendChild(msgDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        syncQuickPromptsVisibility();
        return msgDiv;
    }

    function toggleUI() {
        if (!container) return;
        if (uiState.mode === 'hidden') {
            setUiMode('open');
            setActivePane('chat');
            return;
        }

        setUiMode('hidden');
    }

    function toggleUIFromHotkey() {
        if (!container) return;
        if (uiState.mode === 'open') {
            setUiMode('hidden');
            return;
        }
        openUiFromActivation();
    }
    // --- Timing helper ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // --- UI Stabilization ---
    // Wait for animations/transitions to complete and UI to stabilize
    async function waitForUIStabilization(maxWait = 2000) {
        const startTime = Date.now();
        let lastHTML = '';
        let stableCount = 0;
        const requiredStableChecks = 3;

        while (Date.now() - startTime < maxWait) {
            await sleep(150);

            // Check if DOM has stabilized
            const currentHTML = document.body.innerHTML.length.toString();
            if (currentHTML === lastHTML) {
                stableCount++;
                if (stableCount >= requiredStableChecks) {
                    console.log('[ScreenChat] UI stabilized after', Date.now() - startTime, 'ms');
                    return true;
                }
            } else {
                stableCount = 0;
                lastHTML = currentHTML;
            }
        }

        console.log('[ScreenChat] UI stabilization timeout, proceeding anyway');
        return false;
    }

    // --- Active Context Detection ---
    // Detects modals, dialogs, overlays, drawers that are currently active
    function detectActiveContext() {
        const context = {
            type: 'page', // 'page', 'modal', 'dialog', 'drawer', 'popup', 'overlay'
            container: null,
            containerSelector: null,
            description: 'Main page'
        };

        // Common modal/dialog selectors and attributes
        const modalSelectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '[aria-modal="true"]',
            '.modal:not([style*="display: none"])',
            '.modal.show',
            '.modal.open',
            '.modal.active',
            '[class*="modal"]:not([style*="display: none"])',
            '.dialog:not([style*="display: none"])',
            '.popup:not([style*="display: none"])',
            '.overlay:not([style*="display: none"])',
            '.drawer.open',
            '.drawer.active',
            '[class*="drawer"].open',
            '.sheet.open',
            '[class*="sheet"].open',
            '.lightbox:not([style*="display: none"])',
            // Framework-specific
            '.MuiModal-root',
            '.MuiDialog-root',
            '.chakra-modal__content',
            '.ant-modal-wrap:not([style*="display: none"])',
            '[data-reach-dialog-content]',
            '[data-radix-dialog-content]',
            '[data-state="open"][role="dialog"]'
        ];

        // Find the topmost modal/overlay
        let topModal = null;
        let highestZIndex = -1;

        for (const selector of modalSelectors) {
            try {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    // Skip our own UI
                    if (el.closest('#screenchat-host')) continue;

                    const style = window.getComputedStyle(el);

                    // Must be visible
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

                    // Check z-index to find topmost
                    const zIndex = parseInt(style.zIndex) || 0;
                    if (zIndex >= highestZIndex) {
                        // Verify it has meaningful content (not just a backdrop)
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 100 && rect.height > 100) {
                            highestZIndex = zIndex;
                            topModal = el;
                        }
                    }
                }
            } catch (e) {
                // Invalid selector, skip
            }
        }

        if (topModal) {
            // Determine context type
            const role = topModal.getAttribute('role');
            const className = topModal.className || '';

            if (role === 'dialog' || role === 'alertdialog') {
                context.type = 'dialog';
            } else if (/modal/i.test(className)) {
                context.type = 'modal';
            } else if (/drawer/i.test(className)) {
                context.type = 'drawer';
            } else if (/popup|popover/i.test(className)) {
                context.type = 'popup';
            } else if (/overlay|sheet/i.test(className)) {
                context.type = 'overlay';
            } else {
                context.type = 'modal';
            }

            // IMPORTANT: Find the actual modal CONTENT, not just the backdrop/overlay
            // Many modals have structure: overlay > backdrop + content panel
            // We want the content panel that has the form fields
            let modalContent = topModal;

            // Look for common modal content patterns inside the found modal
            const contentSelectors = [
                '[role="dialog"]',
                '[role="document"]',
                '[class*="modal-content"]',
                '[class*="modal-body"]',
                '[class*="dialog-content"]',
                '[class*="dialog-panel"]',
                '[class*="DialogContent"]',
                '[class*="ModalContent"]',
                'form',
                '[class*="panel"]',
                // If modal is a full-screen overlay, find the centered content
                '> div > div', // Common pattern: overlay > backdrop-click-catcher > content
            ];

            for (const sel of contentSelectors) {
                try {
                    const inner = topModal.querySelector(sel);
                    if (inner) {
                        const innerRect = inner.getBoundingClientRect();
                        // Must be visible and reasonably sized (not the full screen backdrop)
                        if (innerRect.width > 50 && innerRect.height > 50 &&
                            innerRect.width < window.innerWidth * 0.95) {
                            // Check if it has any form fields
                            const hasInputs = inner.querySelector('input, textarea, select, button');
                            if (hasInputs) {
                                modalContent = inner;
                                console.log('[Context] Found modal content via:', sel);
                                break;
                            }
                        }
                    }
                } catch (e) { }
            }

            // If we didn't find a better content element, try to find the visible centered box
            if (modalContent === topModal) {
                const allChildren = topModal.querySelectorAll('div');
                for (const child of allChildren) {
                    const rect = child.getBoundingClientRect();
                    const style = window.getComputedStyle(child);
                    // Look for a centered, reasonably sized box with content
                    if (rect.width > 200 && rect.height > 100 &&
                        rect.width < window.innerWidth * 0.9 &&
                        style.display !== 'none' &&
                        child.querySelector('input, textarea, button, h1, h2, h3')) {
                        modalContent = child;
                        console.log('[Context] Found modal content by size/content heuristic');
                        break;
                    }
                }
            }

            context.container = modalContent;
            context.containerSelector = generateSelector(modalContent);

            // Try to get a meaningful description
            const title = modalContent.querySelector('h1, h2, h3, [class*="title"], [class*="header"]');
            if (title) {
                context.description = `${context.type}: "${title.textContent.trim().substring(0, 50)}"`;
            } else {
                context.description = `Active ${context.type}`;
            }

            // Log what we found for debugging
            const fieldCount = modalContent.querySelectorAll('input, textarea, select').length;
            console.log(`[Context] Detected ${context.type} with ${fieldCount} form fields`);
        }

        return context;
    }

    // --- Enhanced Form Field Extraction ---
    function extractFormFields(activeContext = null) {
        const fields = [];
        const ctx = activeContext || detectActiveContext();

        // If in a modal/dialog, search within it; otherwise search whole document
        let searchRoot = ctx.container || document;

        // Query for all interactive elements
        let inputs = searchRoot.querySelectorAll('input, textarea, select, button');

        // If we're in a modal but found no inputs, the container detection might have been too narrow
        // Try searching the parent or the original modal overlay
        if (ctx.type !== 'page' && inputs.length === 0) {
            console.log('[FormFields] No inputs in modal container, trying parent...');
            // Try parent element
            if (searchRoot.parentElement) {
                inputs = searchRoot.parentElement.querySelectorAll('input, textarea, select, button');
            }
            // If still nothing, try the full modal overlay we originally found
            if (inputs.length === 0) {
                const modalOverlay = document.querySelector('[class*="modal"], [role="dialog"], [aria-modal="true"]');
                if (modalOverlay) {
                    inputs = modalOverlay.querySelectorAll('input, textarea, select, button');
                    searchRoot = modalOverlay;
                }
            }
        }

        console.log(`[FormFields] Found ${inputs.length} interactive elements in ${ctx.type}`);

        inputs.forEach((el, index) => {
            // Skip hidden or invisible elements
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || el.type === 'hidden') return;

            // Skip elements inside our shadow DOM
            if (el.closest('#screenchat-host')) return;

            // Skip generic buttons without meaningful text (like close X buttons)
            if (el.tagName === 'BUTTON') {
                const text = el.textContent?.trim();
                if (!text || text.length < 2 || text === '×' || text === 'X') return;
            }

            // Determine the element's container context
            const elementContext = getElementContext(el, ctx);

            const field = {
                index,
                tag: el.tagName.toLowerCase(),
                type: el.type || el.tagName.toLowerCase(),
                selector: generateSelector(el),
                id: el.id || null,
                name: el.name || null,
                placeholder: el.placeholder || null,
                label: findLabel(el),
                value: el.value || '',
                required: el.required || false,
                context: elementContext,
                inActiveContext: ctx.container ? ctx.container.contains(el) : true
            };

            // For buttons, include the button text
            if (el.tagName === 'BUTTON' || el.tagName === 'A') {
                field.buttonText = el.textContent?.trim().substring(0, 50) || null;
            }

            // For select, include options
            if (el.tagName === 'SELECT') {
                field.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
            }

            // For checkbox/radio, include checked state
            if (el.type === 'checkbox' || el.type === 'radio') {
                field.checked = el.checked;
            }

            fields.push(field);
        });

        return fields;
    }

    // Determine which container an element belongs to
    function getElementContext(el, activeContext) {
        // Check if element is inside the active modal/dialog
        if (activeContext.container && activeContext.container.contains(el)) {
            return activeContext.description;
        }

        // Check for other common containers
        const form = el.closest('form');
        if (form) {
            const formName = form.getAttribute('name') || form.getAttribute('id') || form.getAttribute('aria-label');
            if (formName) return `form: ${formName}`;
        }

        const section = el.closest('section, article, aside, nav, [role="region"]');
        if (section) {
            const sectionLabel = section.getAttribute('aria-label') ||
                section.querySelector('h1, h2, h3')?.textContent?.trim();
            if (sectionLabel) return `section: ${sectionLabel.substring(0, 30)}`;
        }

        return 'main page';
    }

    // --- Lightweight DOM Structure Extraction ---
    // Provides structural context without full HTML
    function extractDOMStructure(activeContext = null) {
        const ctx = activeContext || detectActiveContext();
        const root = ctx.container || document.body;

        const structure = {
            activeContext: {
                type: ctx.type,
                description: ctx.description,
                selector: ctx.containerSelector
            },
            interactiveElements: [],
            headings: [],
            forms: []
        };

        // Extract headings for context
        const headings = root.querySelectorAll('h1, h2, h3');
        headings.forEach(h => {
            const text = h.textContent.trim();
            if (text && text.length < 100) {
                structure.headings.push({
                    level: h.tagName.toLowerCase(),
                    text: text.substring(0, 60)
                });
            }
        });

        // Extract forms with their purpose
        const forms = root.querySelectorAll('form');
        forms.forEach(form => {
            const formInfo = {
                id: form.id || null,
                name: form.getAttribute('name') || null,
                action: form.action || null,
                fieldCount: form.querySelectorAll('input, textarea, select').length
            };

            // Try to identify form purpose
            const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
            if (submitBtn) {
                formInfo.submitLabel = submitBtn.textContent?.trim() || submitBtn.value || null;
            }

            structure.forms.push(formInfo);
        });

        // Extract key interactive elements (buttons, links with important text)
        const buttons = root.querySelectorAll('button, [role="button"], a[href]');
        buttons.forEach(btn => {
            const style = window.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (btn.closest('#screenchat-host')) return;

            const text = btn.textContent?.trim();
            if (text && text.length > 0 && text.length < 50) {
                structure.interactiveElements.push({
                    type: btn.tagName.toLowerCase(),
                    text: text,
                    selector: generateSelector(btn),
                    isInActiveContext: ctx.container ? ctx.container.contains(btn) : true
                });
            }
        });

        // Limit to avoid token bloat
        structure.interactiveElements = structure.interactiveElements.slice(0, 20);
        structure.headings = structure.headings.slice(0, 10);
        structure.forms = structure.forms.slice(0, 5);

        return structure;
    }

    // --- Page State Signature ---
    // Creates a fingerprint of current page state to detect changes
    function getPageStateSignature() {
        const url = window.location.href;
        const title = document.title;
        const bodyLength = document.body?.innerHTML?.length || 0;

        // Get visible text content hash (simplified)
        const visibleText = document.body?.innerText?.substring(0, 1000) || '';

        // Count key elements
        const inputCount = document.querySelectorAll('input, textarea, select').length;
        const buttonCount = document.querySelectorAll('button, [role="button"]').length;

        // Check for modals/dialogs
        const hasModal = !!document.querySelector('[role="dialog"], [aria-modal="true"], [class*="modal"]');

        return {
            url,
            title,
            bodyLength,
            textPreview: visibleText.substring(0, 200),
            inputCount,
            buttonCount,
            hasModal,
            timestamp: Date.now()
        };
    }

    // --- Detect Page State Change ---
    function hasPageStateChanged(oldState, newState) {
        if (!oldState) return true;

        // URL changed = definitely changed
        if (oldState.url !== newState.url) return true;

        // Modal appeared/disappeared
        if (oldState.hasModal !== newState.hasModal) return true;

        // Significant content change (more than 10% difference in body length)
        const lengthChange = Math.abs(oldState.bodyLength - newState.bodyLength);
        if (lengthChange > oldState.bodyLength * 0.1) return true;

        // Text content changed significantly
        if (oldState.textPreview !== newState.textPreview) return true;

        // Element counts changed significantly
        if (Math.abs(oldState.inputCount - newState.inputCount) > 2) return true;
        if (Math.abs(oldState.buttonCount - newState.buttonCount) > 3) return true;

        return false;
    }

    // --- Scrollable Container Detection ---
    function findScrollableContainers() {
        const containers = [];
        const elements = document.querySelectorAll('*');

        for (const el of elements) {
            if (el.closest('#screenchat-host')) continue;

            const style = window.getComputedStyle(el);
            const isScrollable = (
                (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight
            );

            if (isScrollable && el.clientHeight > 100) {
                const rect = el.getBoundingClientRect();
                // Must be visible
                if (rect.width > 50 && rect.height > 50) {
                    containers.push({
                        selector: generateSelector(el),
                        scrollHeight: el.scrollHeight,
                        clientHeight: el.clientHeight,
                        scrollTop: el.scrollTop,
                        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 10,
                        canScrollUp: el.scrollTop > 10,
                        description: getContainerDescription(el)
                    });
                }
            }
        }

        return containers.slice(0, 5); // Limit to 5 most relevant
    }

    function getContainerDescription(el) {
        // Try to identify what this container holds
        const heading = el.querySelector('h1, h2, h3');
        if (heading) return `"${heading.textContent.trim().substring(0, 30)}" section`;

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;

        const className = el.className;
        if (/result/i.test(className)) return 'results container';
        if (/list/i.test(className)) return 'list container';
        if (/content/i.test(className)) return 'content area';
        if (/sidebar/i.test(className)) return 'sidebar';

        return 'scrollable area';
    }

    // --- Adaptive Context Builder ---
    // Builds context based on what the AI needs, not just dumping everything
    async function buildAdaptiveContext(options = {}) {
        const {
            includeDOM = true,
            includeForms = true,
            includeScrollable = true
        } = options;

        const context = {
            url: window.location.href,
            activeTabUrl: await getActiveTabUrl(),
            title: document.title,
            htmlSnapshot: null
        };

        // Detect active context first
        const activeContext = detectActiveContext();
        context.activeContext = {
            type: activeContext.type,
            description: activeContext.description,
            selector: activeContext.containerSelector
        };

        // DOM structure
        if (includeDOM) {
            context.domStructure = extractDOMStructure(activeContext);
        }

        // Form fields
        if (includeForms) {
            context.formFields = extractFormFields(activeContext);
        }

        // Scrollable containers
        if (includeScrollable) {
            context.scrollableContainers = findScrollableContainers();
        }

        // Page state for change detection
        context.pageState = getPageStateSignature();

        // DOM Snapshot (Cleaned HTML)
        if (includeDOM) {
            context.htmlSnapshot = getCleanedHTML(activeContext.container || document.body);
        }

        return context;
    }

    // --- Cleaned HTML Extraction ---
    function getCleanedHTML(rootNode) {
        if (!rootNode) return '';

        // Clone so we don't modify valid DOM
        const clone = rootNode.cloneNode(true);

        // Remove noise
        const toRemove = clone.querySelectorAll('script, style, noscript, iframe, link, meta');
        toRemove.forEach(el => el.remove());

        // Replace SVGs with placeholder to save tokens
        const svgs = clone.querySelectorAll('svg');
        svgs.forEach(svg => {
            const placeholder = document.createElement('span');
            placeholder.textContent = '[SVG Icon]';
            svg.replaceWith(placeholder);
        });

        // Remove standard comments (optional, but good for tokens)
        const iterator = document.createNodeIterator(clone, NodeFilter.SHOW_COMMENT);
        let currentNode;
        const comments = [];
        while (currentNode = iterator.nextNode()) {
            comments.push(currentNode);
        }
        comments.forEach(node => node.remove());

        // Helper to trim down attributes if needed, but for now we keep most for context
        // We could remove 'style' attributes if they are too long
        const allElements = clone.querySelectorAll('*');
        allElements.forEach(el => {
            if (el.getAttribute('style')) el.removeAttribute('style'); // Remove inline styles to save space
            // Truncate very long classes? Maybe not, tailwind needs them.
            // Truncate very long text content?
            if (el.textContent && el.textContent.length > 500) {
                // Only truncate if it's a single text node, overly complex to handle mostly
            }
        });

        // If we are sending the whole body, it might be too big.
        // Ideally we only send the viewport content, but that's hard to slice HTML-wise.
        // For now, let's send it. If it's too big, backend might choke or we need to truncate.
        // Let's rely on the LLM's large context window for Gemini/GPT-4o.

        return clone.outerHTML;
    }

    // --- Format Context for AI Message ---
    function formatContextForAI(context) {
        let msg = `[Page: ${context.url}]`;
        if (context.activeTabUrl) {
            msg += `\n[Active Tab URL: ${context.activeTabUrl}]`;
        }

        if (context.activeContext.type !== 'page') {
            msg += `\n[ACTIVE: ${context.activeContext.description}]`;
            msg += `\n[Target elements INSIDE this ${context.activeContext.type}]`;
        }

        // Headings for orientation
        if (context.domStructure?.headings?.length > 0) {
            msg += `\n[Visible: ${context.domStructure.headings.map(h => h.text).join(' | ')}]`;
        }

        // Form fields (summarized)
        if (context.formFields?.length > 0) {
            const fieldSummary = context.formFields.slice(0, 10).map(f => {
                const label = f.label || f.placeholder || f.name || f.id || f.type;
                return `${label}(${f.selector})`;
            }).join(', ');
            msg += `\n[Fields: ${fieldSummary}]`;
        }

        // Scrollable containers
        if (context.scrollableContainers?.length > 0) {
            const scrollSummary = context.scrollableContainers.map(c =>
                `${c.description}${c.canScrollDown ? '↓' : ''}${c.canScrollUp ? '↑' : ''}`
            ).join(', ');
            msg += `\n[Scrollable: ${scrollSummary}]`;
        }

        // Key buttons
        if (context.domStructure?.interactiveElements?.length > 0) {
            const buttons = context.domStructure.interactiveElements.slice(0, 8);
            msg += `\n[Buttons: ${buttons.map(b => `"${b.text}"`).join(', ')}]`;
        }

        return msg;
    }

    function generateSelector(el) {
        // Try ID first
        if (el.id) return `#${CSS.escape(el.id)}`;

        // Try name attribute
        if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;

        // Try unique class combination
        if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\s+/).filter(c => c);
            if (classes.length > 0) {
                // IMPORTANT: Escape classes because they may contain special chars (:, [, /) in Tailwind/modern CSS
                const escapedClasses = classes.map(c => CSS.escape(c));
                const selector = `${el.tagName.toLowerCase()}.${escapedClasses.join('.')}`;
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (e) {
                    // Ignore invalid selectors and fall through
                }
            }
        }

        // Try type + placeholder
        if (el.type && el.placeholder) {
            const selector = `${el.tagName.toLowerCase()}[type="${el.type}"][placeholder="${el.placeholder}"]`;
            if (document.querySelectorAll(selector).length === 1) return selector;
        }

        // Fallback to nth-of-type
        const parent = el.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            const index = siblings.indexOf(el) + 1;
            const parentSelector = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase();
            return `${parentSelector} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
        }

        return el.tagName.toLowerCase();
    }

    function findLabel(el) {
        // Check for associated label via 'for' attribute
        if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) return label.textContent.trim();
        }

        // Check for parent label
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim();

        // Check for aria-label
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');

        // Check for preceding sibling or nearby text
        const prev = el.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN')) {
            return prev.textContent.trim();
        }

        return null;
    }

    // UI Helpers
    function setInputState(enabled, placeholder = "Type a message...") {
        const textarea = shadowRoot.getElementById('sc-chat-input');
        const sendBtn = shadowRoot.getElementById('sc-send');
        if (textarea && sendBtn) {
            textarea.disabled = !enabled;
            sendBtn.disabled = !enabled;
            textarea.placeholder = placeholder;
            if (enabled) {
                textarea.focus();
                if (placeholder === "Type a message...") textarea.placeholder = "Type a message...";
            }
        }
    }

    function addLoadingMessage(text = "Thinking...") {
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const msgDiv = document.createElement('div');
        const id = 'loading-' + Date.now();
        const shimmerSpreadPx = Math.max(24, text.length * 3);
        msgDiv.id = id;
        msgDiv.className = 'sc-message ai loading-bubble';
        // Port of 21st.dev ibelick Text Shimmer behavior (MIT) adapted to vanilla CSS/JS.
        msgDiv.innerHTML = `
            <div class="sc-bubble">
                <span
                    class="sc-shimmer-text"
                    style="--sc-shimmer-duration:1s;--sc-shimmer-spread:${shimmerSpreadPx}px;"
                >${escapeHtml(text)}</span>
            </div>
        `;
        messagesArea.appendChild(msgDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        return id;
    }

    function removeMessage(id) {
        if (!id) return;
        const el = shadowRoot.getElementById(id);
        if (el) el.remove();
    }

    init();
})();
