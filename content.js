(() => {
    // Prevent multiple injections
    if (window.screenChatInjected) return;
    window.screenChatInjected = true;

    // ScreenChat Content Script
    const APP_SURFACE = (() => {
        const explicitSurface = typeof window.__SCREENCHAT_SURFACE === 'string'
            ? window.__SCREENCHAT_SURFACE.trim().toLowerCase()
            : '';
        if (explicitSurface === 'sidepanel') return 'sidepanel';
        return /\/sidepanel\.html(?:$|\?)/i.test(window.location?.pathname || '')
            ? 'sidepanel'
            : 'content';
    })();
    const IS_SIDEPANEL_SURFACE = APP_SURFACE === 'sidepanel';

    // State
    let shadowRoot = null;
    let container = null;
    let conversationHistory = [];
    let currentAbortController = null;
    let isAwaitingResponse = false;
    let activeResponseRequestId = 0;
    let activeResponseStopRequested = false;
    let responseRequestCounter = 0;
    let hasLocalConversationMutation = false;
    let currentSurfaceWindowId = null;
    let keepAcrossTabsRequestInFlight = false;
    let keepAcrossTabsState = {
        active: false,
        windowId: null,
        workflow: null,
        canCloseSidePanel: false
    };
    // User Profile (personal info for personalization)
    let userProfile = null;
    const DEFAULT_WELCOME_MESSAGE = 'How can I help with this page? What would you like to ask about it?';

    // Session State
    let sessionId = createSessionId();
    let sessionUrl = window.location.href || window.location.hostname || 'unknown';
    let sessionUpdatedAt = null;

    // Auth State
    const AUTH_SESSION_KEY = 'screenchat_auth_session';
    const CONVERSATION_HISTORY_KEY = 'conversationHistory';
    const SESSION_STATE_KEY = 'screenchat_session_state';
    const KEEP_ACROSS_TABS_STATE_KEY = 'screenchat_keep_across_tabs_v1';
    const DEFAULT_OPEN_STYLE_KEY = 'screenchat_default_open_style_v1';
    const LEGACY_SESSION_DOMAIN_KEY = 'sessionDomain';
    const PROFILE_CACHE_KEY = 'screenchat_profile_identity';
    const PROFILE_LOCAL_STORAGE_KEY = 'screenchat_profile_identity';
    let authState = 'ANONYMOUS'; // ANONYMOUS | AUTHENTICATED
    let authSession = null;
    let isAuthSessionVerified = false;
    let isAuthRestoreInFlight = false;
    let attachScreenEnabled = true;
    let preferredOpenStyle = 'window';
    let attachGlowResetTimeout = 0;
    const API_BASE_CACHE_KEY = 'screenchat_api_base_url';
    const API_BASE_OVERRIDE_KEY = 'screenchat_api_base_override';
    const RUNTIME_CONFIG_URL = chrome.runtime.getURL('runtime-config.json');
    const API_HEALTH_TIMEOUT_MS = 1400;
    const CHAT_REQUEST_TIMEOUT_MS = 90000;
    const TIMESTAMP_REFRESH_INTERVAL_MS = 60000;
    const WEB_SIGN_IN_POLL_INTERVAL_MS = 900;
    const WEB_SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
    const HOSTED_SIGN_IN_MESSAGE_TYPE = 'screenchat_google_auth_linked';
    const HOSTED_SIGN_IN_CLOSED_MESSAGE_TYPE = 'screenchat_google_auth_closed';
    const EXTENSION_CONTEXT_RECOVERY_MESSAGE = 'ScreenChat was updated in the background. Reload this tab and try signing in again.';
    const RELATIVE_TIME_FORMATTER = typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
        : null;
    let resolvedApiBaseUrl = null;
    let resolvingApiBasePromise = null;
    let authRefreshPromise = null;
    let hostedAuthBackendCheckPromise = null;
    let runtimeConfigLoadPromise = null;
    let apiBaseCandidates = [];
    let allowedApiBaseOrigins = new Set();

    function parseTimestampMs(rawTimestamp) {
        if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === '') return null;

        if (rawTimestamp instanceof Date) {
            const dateMs = rawTimestamp.getTime();
            return Number.isFinite(dateMs) ? dateMs : null;
        }

        if (typeof rawTimestamp === 'number') {
            if (!Number.isFinite(rawTimestamp)) return null;
            // Support both Unix seconds and milliseconds.
            return rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp;
        }

        if (typeof rawTimestamp === 'string') {
            const trimmed = rawTimestamp.trim();
            if (!trimmed) return null;
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric)) {
                return numeric < 1000000000000 ? numeric * 1000 : numeric;
            }

            const parsedMs = Date.parse(trimmed);
            return Number.isFinite(parsedMs) ? parsedMs : null;
        }

        return null;
    }

    function toIsoTimestamp(rawTimestamp) {
        const timestampMs = parseTimestampMs(rawTimestamp);
        return timestampMs === null ? null : new Date(timestampMs).toISOString();
    }

    function createSessionId() {
        return `session_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
    }

    const LUCIDE_ICON_PATHS = {
        'history': [
            '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />',
            '<path d="M3 3v5h5" />',
            '<path d="M12 7v5l4 2" />'
        ],
        'circle-fading-plus': [
            '<path d="M12 2a10 10 0 0 1 7.38 16.75" />',
            '<path d="M12 8v8" />',
            '<path d="M16 12H8" />',
            '<path d="M2.5 8.875a10 10 0 0 0-.5 3" />',
            '<path d="M2.83 16a10 10 0 0 0 2.43 3.4" />',
            '<path d="M4.636 5.235a10 10 0 0 1 .891-.857" />',
            '<path d="M8.644 21.42a10 10 0 0 0 7.631-.38" />'
        ],
        'user': [
            '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />',
            '<circle cx="12" cy="7" r="4" />'
        ],
        'circle-x': [
            '<circle cx="12" cy="12" r="10" />',
            '<path d="m15 9-6 6" />',
            '<path d="m9 9 6 6" />'
        ],
        'pin': [
            '<path d="M12 17v5" />',
            '<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />'
        ],
        'plus': [
            '<path d="M5 12h14" />',
            '<path d="M12 5v14" />'
        ],
        'minus': [
            '<path d="M5 12h14" />'
        ],
        'square': [
            '<rect width="14" height="14" x="5" y="5" rx="2" ry="2" />'
        ],
        'log-out': [
            '<path d="m16 17 5-5-5-5" />',
            '<path d="M21 12H9" />',
            '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />'
        ],
        'send': [
            '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />',
            '<path d="m21.854 2.147-10.94 10.939" />'
        ],
        'arrow-left': [
            '<path d="m12 19-7-7 7-7" />',
            '<path d="M19 12H5" />'
        ],
        'search': [
            '<path d="m21 21-4.34-4.34" />',
            '<circle cx="11" cy="11" r="8" />'
        ],
        'trash': [
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />',
            '<path d="M3 6h18" />',
            '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />'
        ],
        'chevron-right': [
            '<path d="m9 18 6-6-6-6" />'
        ],
        'loader': [
            '<path d="M12 2v4" />',
            '<path d="m16.2 7.8 2.9-2.9" />',
            '<path d="M18 12h4" />',
            '<path d="m16.2 16.2 2.9 2.9" />',
            '<path d="M12 18v4" />',
            '<path d="m4.9 19.1 2.9-2.9" />',
            '<path d="M2 12h4" />',
            '<path d="m4.9 4.9 2.9 2.9" />'
        ],
        'circle-slash': [
            '<circle cx="12" cy="12" r="10" />',
            '<line x1="9" x2="15" y1="15" y2="9" />'
        ]
    };
    const LUCIDE_FILE_OVERRIDES = {
        'arrow-left.svg': { icon: 'arrow-left', stroke: '#223B36' },
        'clock.svg': { icon: 'history', stroke: '#223B36' },
        'comment-dots.svg': { icon: 'circle-fading-plus', stroke: '#223B36' },
        'user.svg': { icon: 'user', stroke: '#223B36' },
        'times-square.svg': { icon: 'circle-x', stroke: '#223B36' },
        'pin.svg': { icon: 'pin', stroke: '#223B36' },
        'plus-square-Filled.svg': { icon: 'plus', stroke: '#43A996' },
        'minus-square-muted.svg': { icon: 'minus', stroke: '#74818C' },
        'minus-square-Filled.svg': { icon: 'minus', stroke: '#74818C' },
        'Log out.svg': { icon: 'log-out', stroke: '#3E544F' },
        'send.svg': { icon: 'send', stroke: '#FFFFFF' },
        'Icon Button.svg': { icon: 'trash', stroke: '#223B36' },
        'trash.svg': { icon: 'trash', stroke: '#223B36' },
        'chevron-right.svg': { icon: 'chevron-right', stroke: '#223B36' },
        'search.svg': { icon: 'search', stroke: '#223B36' },
        'loader.svg': { icon: 'loader', stroke: '#758481' },
        'circle-slash.svg': { icon: 'circle-slash', stroke: '#758481' }
    };
    const lucideDataUriCache = new Map();

    function buildLucideIconDataUri(iconName, strokeColor) {
        const paths = LUCIDE_ICON_PATHS[iconName];
        if (!Array.isArray(paths) || !paths.length) return '';
        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg"',
            ' width="24"',
            ' height="24"',
            ' viewBox="0 0 24 24"',
            ' fill="none"',
            ` stroke="${strokeColor}"`,
            ' stroke-width="1.5"',
            ' stroke-linecap="round"',
            ' stroke-linejoin="round">',
            ...paths,
            '</svg>'
        ].join('');
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function normalizeConversationRole(rawRole) {
        const normalized = String(rawRole || '').trim().toLowerCase();
        if (normalized === 'user') return 'user';
        if (normalized === 'assistant' || normalized === 'ai') return 'assistant';
        return '';
    }

    function normalizeConversationEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const role = normalizeConversationRole(entry.role);
        if (!role) return null;
        const content = typeof entry.content === 'string'
            ? entry.content
            : String(entry.content ?? '');
        if (!content.trim()) return null;

        return {
            role,
            content,
            timestamp: toIsoTimestamp(entry.timestamp)
        };
    }

    function normalizeConversationHistory(entries) {
        if (!Array.isArray(entries)) return [];
        return entries
            .map((entry) => normalizeConversationEntry(entry))
            .filter(Boolean);
    }

    function getLatestConversationTimestamp(history = conversationHistory) {
        if (!Array.isArray(history)) return null;
        for (let i = history.length - 1; i >= 0; i -= 1) {
            const entryTimestamp = toIsoTimestamp(history[i]?.timestamp);
            if (entryTimestamp) return entryTimestamp;
        }
        return null;
    }

    function formatRelativeUnit(value, unit) {
        if (RELATIVE_TIME_FORMATTER) {
            return RELATIVE_TIME_FORMATTER.format(value, unit);
        }
        const abs = Math.abs(value);
        const suffix = value < 0 ? 'ago' : 'from now';
        const label = abs === 1 ? unit : `${unit}s`;
        return `${abs} ${label} ${suffix}`;
    }

    function formatRelativeTimestamp(rawTimestamp, nowMs = Date.now()) {
        const timestampMs = parseTimestampMs(rawTimestamp);
        if (timestampMs === null) return 'Earlier';

        const diffMs = timestampMs - nowMs;
        const absMs = Math.abs(diffMs);
        const minuteMs = 60 * 1000;
        const hourMs = 60 * minuteMs;
        const dayMs = 24 * hourMs;
        const weekMs = 7 * dayMs;
        const monthMs = 30 * dayMs;
        const yearMs = 365 * dayMs;

        if (absMs < 45 * 1000) return 'Just now';
        if (absMs < hourMs) return formatRelativeUnit(Math.round(diffMs / minuteMs), 'minute');
        if (absMs < dayMs) return formatRelativeUnit(Math.round(diffMs / hourMs), 'hour');
        if (absMs < weekMs) return formatRelativeUnit(Math.round(diffMs / dayMs), 'day');
        if (absMs < monthMs) return formatRelativeUnit(Math.round(diffMs / weekMs), 'week');
        if (absMs < yearMs) return formatRelativeUnit(Math.round(diffMs / monthMs), 'month');
        return formatRelativeUnit(Math.round(diffMs / yearMs), 'year');
    }

    function setMessageTimestamp(messageEl, rawTimestamp = Date.now()) {
        if (!messageEl) return null;
        const timestampEl = messageEl.querySelector('.sc-timestamp');
        if (!timestampEl) return null;

        const timestampMs = parseTimestampMs(rawTimestamp);
        if (timestampMs === null) {
            timestampEl.removeAttribute('data-timestamp');
            timestampEl.textContent = formatRelativeTimestamp(null);
            return null;
        }

        timestampEl.dataset.timestamp = String(timestampMs);
        timestampEl.textContent = formatRelativeTimestamp(timestampMs);
        return timestampMs;
    }

    function refreshVisibleTimestamps() {
        if (!shadowRoot) return;
        const nowMs = Date.now();
        const timestampEls = shadowRoot.querySelectorAll('.sc-timestamp[data-timestamp]');
        timestampEls.forEach((timestampEl) => {
            const timestampMs = Number(timestampEl.dataset.timestamp);
            if (!Number.isFinite(timestampMs)) return;
            timestampEl.textContent = formatRelativeTimestamp(timestampMs, nowMs);
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
        if (apiBaseCandidates.length > 0) return;
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
                const normalizedCandidates = configuredCandidates
                    .map((candidate) => normalizeConfiguredApiBaseUrl(candidate))
                    .filter(Boolean);

                if (!normalizedCandidates.length) {
                    throw new Error('No valid backend URL configured for ScreenChat');
                }

                apiBaseCandidates = Array.from(new Set(normalizedCandidates));
                allowedApiBaseOrigins = new Set(
                    apiBaseCandidates.map((candidate) => new URL(candidate).origin)
                );
            })().catch((error) => {
                runtimeConfigLoadPromise = null;
                throw error;
            });
        }
        return runtimeConfigLoadPromise;
    }

    function isAllowedApiBaseUrl(baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            // Prevent local/private network probes, which trigger noisy browser permission prompts per-site.
            if (!isAllowedConfiguredApiOrigin(parsed)) {
                return false;
            }
            return allowedApiBaseOrigins.has(parsed.origin);
        } catch {
            return false;
        }
    }

    function normalizeApiBaseUrl(rawValue) {
        if (typeof rawValue !== 'string') return null;
        const trimmed = rawValue.trim();
        if (!trimmed) return null;
        const normalized = trimmed.replace(/\/+$/, '');
        return isAllowedApiBaseUrl(normalized) ? normalized : null;
    }

    function normalizeApiPath(path) {
        if (typeof path !== 'string' || path.length === 0) return '/';
        return path.startsWith('/') ? path : `/${path}`;
    }

    function isLoopbackApiBaseUrl(baseUrl) {
        if (!isNonEmptyString(baseUrl)) return false;
        try {
            return isLoopbackHostname(new URL(baseUrl).hostname);
        } catch {
            return false;
        }
    }

    function getUnreachableBackendMessage() {
        const activeBaseUrl = normalizeApiBaseUrl(resolvedApiBaseUrl)
            || normalizeApiBaseUrl(apiBaseCandidates[0])
            || '';
        if (isLoopbackApiBaseUrl(activeBaseUrl)) {
            return 'Unable to reach ScreenChat backend. The extension is currently targeting localhost. If your backend is hosted on Railway, update ScreenChat/.env, rerun node .\\scripts\\sync-runtime-config.mjs, then reload the extension.';
        }
        return 'Unable to reach ScreenChat backend. Confirm the backend is running, then reload the extension.';
    }

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function getErrorMessage(error) {
        if (isNonEmptyString(error?.message)) return error.message.trim();
        if (isNonEmptyString(error)) return error.trim();
        return '';
    }

    function isExtensionContextInvalidatedError(error) {
        const normalized = getErrorMessage(error).toLowerCase();
        return normalized.includes('extension context invalidated') || normalized.includes('context invalidated');
    }

    function getUserDisplayName(user) {
        if (isNonEmptyString(user?.fullName)) return user.fullName.trim();
        if (isNonEmptyString(user?.email)) return user.email.trim().split('@')[0];
        return 'Google user';
    }

    function getAccountFullName() {
        if (!isAuthenticated()) return '';
        return isNonEmptyString(authSession?.user?.fullName)
            ? authSession.user.fullName.trim()
            : '';
    }

    function getAccountEmail() {
        if (!isAuthenticated()) return '';
        return isNonEmptyString(authSession?.user?.email)
            ? authSession.user.email.trim()
            : '';
    }

    function normalizeProfileIdentity(rawIdentity) {
        if (!rawIdentity || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) return null;

        const fullName = isNonEmptyString(rawIdentity.fullName)
            ? rawIdentity.fullName.trim()
            : '';
        const email = isNonEmptyString(rawIdentity.email)
            ? rawIdentity.email.trim()
            : '';

        if (!fullName && !email) return null;

        return { fullName, email };
    }

    function readProfileIdentityFromLocalStorage() {
        try {
            const storage = window.localStorage;
            if (!storage) return null;
            const rawValue = storage.getItem(PROFILE_LOCAL_STORAGE_KEY);
            if (!isNonEmptyString(rawValue)) return null;
            return normalizeProfileIdentity(JSON.parse(rawValue));
        } catch {
            return null;
        }
    }

    function persistProfileIdentity(profileLike) {
        const identity = normalizeProfileIdentity(profileLike);

        try {
            const storage = window.localStorage;
            if (storage) {
                if (identity) {
                    storage.setItem(PROFILE_LOCAL_STORAGE_KEY, JSON.stringify(identity));
                } else {
                    storage.removeItem(PROFILE_LOCAL_STORAGE_KEY);
                }
            }
        } catch {
            // Ignore localStorage failures on restricted pages.
        }

        if (identity) {
            storageSetSafe({ [PROFILE_CACHE_KEY]: identity });
        } else {
            storageRemoveSafe([PROFILE_CACHE_KEY]);
        }

        return identity;
    }

    function applyProfileFormValues(profileInputs, profile) {
        const hasStoredProfile = profile && typeof profile === 'object' && !Array.isArray(profile);
        const source = hasStoredProfile ? profile : {};
        const cachedIdentity = readProfileIdentityFromLocalStorage();
        const accountFullName = getAccountFullName();
        const accountEmail = getAccountEmail();
        const resolvedFullName = hasStoredProfile
            ? (isNonEmptyString(source.fullName) ? source.fullName.trim() : '')
            : (cachedIdentity?.fullName || accountFullName);
        const resolvedEmail = hasStoredProfile
            ? (isNonEmptyString(source.email) ? source.email.trim() : '')
            : (cachedIdentity?.email || accountEmail);

        if (profileInputs.profileNameInput) profileInputs.profileNameInput.value = resolvedFullName;
        if (profileInputs.profileNicknameInput) profileInputs.profileNicknameInput.value = source.nickname || '';
        if (profileInputs.profileEmailInput) profileInputs.profileEmailInput.value = resolvedEmail;
        if (profileInputs.profilePhoneInput) profileInputs.profilePhoneInput.value = source.phone || '';
        if (profileInputs.profileNotesInput) profileInputs.profileNotesInput.value = source.notes || '';

        return {
            fullName: resolvedFullName,
            nickname: source.nickname || '',
            email: resolvedEmail,
            phone: source.phone || '',
            notes: source.notes || ''
        };
    }

    function getUserAvatarInitial(user) {
        const displayName = getUserDisplayName(user);
        const firstVisibleCharacter = Array.from(displayName).find((char) => /\S/.test(char));
        return firstVisibleCharacter ? firstVisibleCharacter.toUpperCase() : 'G';
    }

    function normalizeStoredAuthSession(rawSession) {
        if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
            return null;
        }

        const authToken = isNonEmptyString(rawSession.authToken)
            ? rawSession.authToken.trim()
            : (isNonEmptyString(rawSession.idToken) ? rawSession.idToken.trim() : '');
        const refreshToken = isNonEmptyString(rawSession.refreshToken)
            ? rawSession.refreshToken.trim()
            : '';
        const userSource = rawSession.user && typeof rawSession.user === 'object' ? rawSession.user : {};
        const normalizedUser = {
            id: isNonEmptyString(userSource.id) ? userSource.id.trim() : '',
            email: isNonEmptyString(userSource.email) ? userSource.email.trim() : '',
            fullName: isNonEmptyString(userSource.fullName) ? userSource.fullName.trim() : '',
            picture: isNonEmptyString(userSource.picture) ? userSource.picture.trim() : '',
            emailVerified: Boolean(userSource.emailVerified)
        };

        const resolvedUserId = normalizedUser.id;
        if (!authToken || !resolvedUserId) return null;

        return {
            authToken,
            refreshToken,
            user: normalizedUser
        };
    }

    function isAuthenticated() {
        return authState === 'AUTHENTICATED' && isAuthSessionVerified && !!normalizeStoredAuthSession(authSession);
    }

    function getAuthToken() {
        return normalizeStoredAuthSession(authSession)?.authToken || '';
    }

    function getRefreshToken() {
        return normalizeStoredAuthSession(authSession)?.refreshToken || '';
    }

    function setAuthSession(session, { persist = true, verified = true } = {}) {
        const normalized = normalizeStoredAuthSession(session);
        authSession = normalized;
        isAuthSessionVerified = !!normalized && !!verified;
        authState = isAuthSessionVerified ? 'AUTHENTICATED' : 'ANONYMOUS';

        if (persist) {
            if (normalized) {
                storageSetSafe({ [AUTH_SESSION_KEY]: normalized });
            } else {
                storageRemoveSafe([AUTH_SESSION_KEY]);
            }
        }
    }

    function clearAuthSession({ persist = true } = {}) {
        setAuthSession(null, { persist });
    }

    function withAuthHeaders(options, { includeAuth = true } = {}) {
        const nextOptions = options && typeof options === 'object' ? { ...options } : {};
        const headers = new Headers(nextOptions.headers || {});
        if (includeAuth) {
            const token = getAuthToken();
            if (token) {
                headers.set('Authorization', `Bearer ${token}`);
            }
        }
        nextOptions.headers = headers;
        return nextOptions;
    }

    function isUnauthorizedResponse(response) {
        return Number(response?.status) === 401;
    }

    function isAuthErrorMessage(rawMessage) {
        if (!isNonEmptyString(rawMessage)) return false;
        const normalized = rawMessage.toLowerCase();
        return normalized.includes('authentication') ||
            normalized.includes('unauthorized') ||
            normalized.includes('invalid or expired google token') ||
            normalized.includes('sign in');
    }

    function storageGetSafe(keys, onDone = () => {}) {
        try {
            chrome.storage.local.get(keys, (result) => {
                const runtimeError = chrome.runtime?.lastError;
                if (runtimeError) {
                    console.warn('[Storage] get failed:', runtimeError.message || runtimeError);
                    onDone({});
                    return;
                }
                onDone(result && typeof result === 'object' ? result : {});
            });
        } catch (error) {
            console.warn('[Storage] get failed:', error);
            onDone({});
        }
    }

    function storageSetSafe(data, onDone = () => {}) {
        try {
            chrome.storage.local.set(data, () => {
                const runtimeError = chrome.runtime?.lastError;
                if (runtimeError) {
                    console.warn('[Storage] set failed:', runtimeError.message || runtimeError);
                }
                onDone();
            });
        } catch (error) {
            console.warn('[Storage] set failed:', error);
            onDone();
        }
    }

    function storageRemoveSafe(keys, onDone = () => {}) {
        try {
            chrome.storage.local.remove(keys, () => {
                const runtimeError = chrome.runtime?.lastError;
                if (runtimeError) {
                    console.warn('[Storage] remove failed:', runtimeError.message || runtimeError);
                }
                onDone();
            });
        } catch (error) {
            console.warn('[Storage] remove failed:', error);
            onDone();
        }
    }

    function storageGet(keys) {
        return new Promise((resolve) => storageGetSafe(keys, resolve));
    }

    function storageSet(data) {
        return new Promise((resolve) => storageSetSafe(data, resolve));
    }

    function normalizePreferredOpenStyle(rawValue) {
        const normalizedValue = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
        return normalizedValue === 'sidebar' ? 'sidebar' : 'window';
    }

    function isSidebarPreferredOpenStyle() {
        return normalizePreferredOpenStyle(preferredOpenStyle) === 'sidebar';
    }

    function syncPreferredOpenStyleUi() {
        if (!shadowRoot) return;
        const optionInputs = shadowRoot.querySelectorAll('input[name="sc-default-open-style"]');
        optionInputs.forEach((input) => {
            const isChecked = normalizePreferredOpenStyle(input.value) === preferredOpenStyle;
            input.checked = isChecked;
            const optionCard = input.closest('.sc-open-style-option');
            if (optionCard) {
                optionCard.classList.toggle('selected', isChecked);
            }
        });
    }

    function setPreferredOpenStyle(nextStyle, { persist = true } = {}) {
        preferredOpenStyle = normalizePreferredOpenStyle(nextStyle);
        syncPreferredOpenStyleUi();
        if (persist) {
            storageSetSafe({ [DEFAULT_OPEN_STYLE_KEY]: preferredOpenStyle });
        }
        return preferredOpenStyle;
    }

    async function loadPreferredOpenStyle() {
        const storedValues = await storageGet([DEFAULT_OPEN_STYLE_KEY]);
        return setPreferredOpenStyle(storedValues?.[DEFAULT_OPEN_STYLE_KEY], { persist: false });
    }

    function normalizeKeepAcrossTabsState(rawState) {
        const workflowSource = rawState?.workflow && typeof rawState.workflow === 'object' && !Array.isArray(rawState.workflow)
            ? rawState.workflow
            : null;
        const sessionId = isNonEmptyString(workflowSource?.sessionId) ? workflowSource.sessionId.trim() : '';
        const workflow = sessionId
            ? {
                sessionId,
                sessionUrl: isNonEmptyString(workflowSource?.sessionUrl) ? workflowSource.sessionUrl.trim() : '',
                updatedAt: toIsoTimestamp(workflowSource?.updatedAt) || '',
                enabledAt: toIsoTimestamp(workflowSource?.enabledAt) || ''
            }
            : null;

        return {
            active: !!rawState?.active && !!workflow,
            windowId: Number.isInteger(rawState?.windowId) ? rawState.windowId : null,
            workflow,
            canCloseSidePanel: !!rawState?.canCloseSidePanel
        };
    }

    function getPersistedConversationSnapshot(storageResult = {}) {
        const persistedHistory = normalizeConversationHistory(storageResult?.[CONVERSATION_HISTORY_KEY]);
        const rawSessionState = storageResult?.[SESSION_STATE_KEY];
        const sessionState = rawSessionState && typeof rawSessionState === 'object' && !Array.isArray(rawSessionState)
            ? rawSessionState
            : null;
        const persistedSessionId = isNonEmptyString(sessionState?.sessionId)
            ? sessionState.sessionId.trim()
            : '';
        if (!persistedSessionId && !persistedHistory.length) {
            return null;
        }

        return {
            sessionId: persistedSessionId || createSessionId(),
            sessionUrl: isNonEmptyString(sessionState?.sessionUrl)
                ? sessionState.sessionUrl.trim()
                : (isNonEmptyString(sessionState?.sessionDomain) ? sessionState.sessionDomain.trim() : ''),
            updatedAt: toIsoTimestamp(sessionState?.updatedAt) || getLatestConversationTimestamp(persistedHistory),
            history: persistedHistory
        };
    }

    async function restoreKeepAcrossTabsConversation({ force = false } = {}) {
        if (!IS_SIDEPANEL_SURFACE || !keepAcrossTabsState.active) return false;

        const persistedConversation = getPersistedConversationSnapshot(
            await storageGet([CONVERSATION_HISTORY_KEY, SESSION_STATE_KEY])
        );
        if (!persistedConversation) return false;

        const workflowSessionId = isNonEmptyString(keepAcrossTabsState.workflow?.sessionId)
            ? keepAcrossTabsState.workflow.sessionId.trim()
            : '';
        if (workflowSessionId && persistedConversation.sessionId !== workflowSessionId) {
            return false;
        }

        const persistedUpdatedAt = persistedConversation.updatedAt || '';
        const currentUpdatedAt = sessionUpdatedAt || getLatestConversationTimestamp(conversationHistory);
        const shouldApply = force
            || persistedConversation.sessionId !== sessionId
            || persistedConversation.history.length !== conversationHistory.length
            || persistedUpdatedAt !== currentUpdatedAt;
        if (!shouldApply) return false;

        applyConversationState({
            sessionId: persistedConversation.sessionId,
            sessionUrl: persistedConversation.sessionUrl || sessionUrl,
            history: persistedConversation.history,
            updatedAt: persistedConversation.updatedAt,
            persist: false,
            withTypewriter: false
        });
        return true;
    }

    async function getSurfaceWindowId() {
        if (!IS_SIDEPANEL_SURFACE) return null;
        if (Number.isInteger(currentSurfaceWindowId)) return currentSurfaceWindowId;
        if (typeof chrome?.windows?.getCurrent !== 'function') return null;

        try {
            const currentWindow = await chrome.windows.getCurrent();
            currentSurfaceWindowId = Number.isInteger(currentWindow?.id) ? currentWindow.id : null;
        } catch (error) {
            console.warn('[KeepAcrossTabs] Failed to resolve current window:', error);
            currentSurfaceWindowId = null;
        }

        return currentSurfaceWindowId;
    }

    function sendSurfaceRuntimeMessage(payload) {
        const nextPayload = payload && typeof payload === 'object' ? { ...payload } : {};
        if (!IS_SIDEPANEL_SURFACE) {
            if (nextPayload.action === 'open_side_panel') {
                console.info('[OpenStyle] Sending sidebar open request from content surface', {
                    surface: APP_SURFACE,
                    preferredOpenStyle,
                    windowId: null
                });
            }
            return chrome.runtime.sendMessage(nextPayload);
        }
        return getSurfaceWindowId().then((surfaceWindowId) => {
            if (Number.isInteger(surfaceWindowId)) {
                nextPayload.windowId = surfaceWindowId;
            }
            if (nextPayload.action === 'open_side_panel') {
                console.info('[OpenStyle] Sending sidebar open request from sidepanel surface', {
                    surface: APP_SURFACE,
                    preferredOpenStyle,
                    windowId: Number.isInteger(surfaceWindowId) ? surfaceWindowId : null
                });
            }
            return chrome.runtime.sendMessage(nextPayload);
        });
    }

    async function fetchKeepAcrossTabsState() {
        const response = await sendSurfaceRuntimeMessage({ action: 'get_keep_across_tabs_state' });
        if (!response?.ok) {
            throw new Error(response?.error || 'Unable to load keep across tabs state');
        }
        return normalizeKeepAcrossTabsState(response);
    }

    async function openKeepAcrossTabsPanel() {
        const response = await sendSurfaceRuntimeMessage({ action: 'open_keep_across_tabs_panel' });
        if (!response?.ok || !response?.active) {
            throw new Error(response?.error || 'Unable to open keep across tabs');
        }
        return response;
    }

    async function openDefaultSidePanel() {
        console.info('[OpenStyle] Requesting default sidebar open', {
            surface: APP_SURFACE,
            preferredOpenStyle
        });
        const response = await sendSurfaceRuntimeMessage({ action: 'open_side_panel' });
        console.info('[OpenStyle] Sidebar open response received', {
            surface: APP_SURFACE,
            preferredOpenStyle,
            ok: !!response?.ok,
            windowId: Number.isInteger(response?.windowId) ? response.windowId : null,
            error: response?.error || null
        });
        if (!response?.ok) {
            throw new Error(response?.error || 'Unable to open sidebar');
        }
        return response;
    }

    function syncKeepAcrossTabsUi() {
        const keepAcrossTabsBtn = shadowRoot?.getElementById('sc-keep-across-tabs');
        const isActive = !!keepAcrossTabsState.active;
        if (keepAcrossTabsBtn) {
            keepAcrossTabsBtn.classList.toggle('active', isActive);
            keepAcrossTabsBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            keepAcrossTabsBtn.setAttribute('title', 'Keep across tabs');
            keepAcrossTabsBtn.setAttribute('aria-label', 'Keep across tabs');
            keepAcrossTabsBtn.disabled = !!keepAcrossTabsRequestInFlight;
        }

        const panel = shadowRoot?.getElementById('sc-panel');
        if (panel) {
            panel.toggleAttribute('data-keep-across-tabs-active', isActive);
        }
    }

    async function refreshKeepAcrossTabsState({ hideInlineUiOnActive = true } = {}) {
        const wasKeepAcrossTabsActive = !!keepAcrossTabsState.active;
        try {
            keepAcrossTabsState = await fetchKeepAcrossTabsState();
        } catch (error) {
            console.warn('[KeepAcrossTabs] State refresh failed:', error);
            keepAcrossTabsState = normalizeKeepAcrossTabsState(null);
        }

        syncKeepAcrossTabsUi();

        if (!IS_SIDEPANEL_SURFACE && keepAcrossTabsState.active && hideInlineUiOnActive) {
            setUiMode('hidden');
        } else if (!IS_SIDEPANEL_SURFACE && wasKeepAcrossTabsActive && !keepAcrossTabsState.active && uiState.mode === 'hidden') {
            setActivePane('chat', false);
            setUiMode('open');
        }

        return keepAcrossTabsState;
    }

    async function setKeepAcrossTabsEnabled(enabled) {
        const response = await sendSurfaceRuntimeMessage({
            action: 'set_keep_across_tabs_state',
            enabled: !!enabled,
            sessionId,
            sessionUrl,
            updatedAt: sessionUpdatedAt || getLatestConversationTimestamp(conversationHistory)
        });
        if (!response?.ok) {
            throw new Error(response?.error || 'Unable to update keep across tabs');
        }
        keepAcrossTabsState = normalizeKeepAcrossTabsState(response);
        syncKeepAcrossTabsUi();
        return keepAcrossTabsState;
    }

    async function toggleKeepAcrossTabs() {
        if (keepAcrossTabsRequestInFlight) return;
        keepAcrossTabsRequestInFlight = true;
        syncKeepAcrossTabsUi();

        try {
            const nextEnabled = !keepAcrossTabsState.active;
            if (nextEnabled) {
                persistConversationState({ updatedAt: sessionUpdatedAt || getLatestConversationTimestamp(conversationHistory) });
            }

            const nextState = await setKeepAcrossTabsEnabled(nextEnabled);
            if (!IS_SIDEPANEL_SURFACE && nextState.active) {
                setUiMode('hidden');
            }
        } catch (error) {
            console.warn('[KeepAcrossTabs] Toggle failed:', error);
            await refreshKeepAcrossTabsState({ hideInlineUiOnActive: false });
        } finally {
            keepAcrossTabsRequestInFlight = false;
            syncKeepAcrossTabsUi();
        }
    }

    function getSessionDomainForUrl(urlValue = sessionUrl) {
        if (!isNonEmptyString(urlValue)) {
            return window.location.hostname;
        }
        try {
            return new URL(urlValue).hostname || window.location.hostname;
        } catch {
            return window.location.hostname;
        }
    }

    function persistConversationState({ updatedAt = sessionUpdatedAt } = {}) {
        const resolvedUpdatedAt = toIsoTimestamp(updatedAt) || getLatestConversationTimestamp(conversationHistory);
        sessionUpdatedAt = resolvedUpdatedAt;
        const sessionState = {
            sessionId,
            sessionUrl,
            updatedAt: sessionUpdatedAt,
            sessionDomain: getSessionDomainForUrl(sessionUrl)
        };

        storageSetSafe({
            [CONVERSATION_HISTORY_KEY]: conversationHistory,
            [SESSION_STATE_KEY]: sessionState,
            [LEGACY_SESSION_DOMAIN_KEY]: sessionState.sessionDomain
        });
    }

    function clearPersistedConversationState() {
        sessionUpdatedAt = null;
        storageRemoveSafe([CONVERSATION_HISTORY_KEY, SESSION_STATE_KEY, LEGACY_SESSION_DOMAIN_KEY]);
    }

    function renderConversationHistory(historyEntries, { fallbackTimestamp = null, withTypewriter = false } = {}) {
        const messagesArea = shadowRoot?.getElementById('sc-messages');
        if (!messagesArea) return;

        messagesArea.innerHTML = '';
        const normalizedHistory = normalizeConversationHistory(historyEntries);
        if (!normalizedHistory.length) {
            renderWelcomeMessage(withTypewriter);
            return;
        }

        normalizedHistory.forEach((entry) => {
            const role = normalizeConversationRole(entry.role);
            const content = role === 'user' ? cleanUserMessage(entry.content) : cleanAiReply(entry.content);
            const timestamp = entry.timestamp || fallbackTimestamp;
            if (!content || content.toLowerCase() === 'continue') return;
            addMessage(content, role === 'user' ? 'user' : 'ai', null, true, timestamp);
        });
        scrollMessagesToBottom({ force: true });
    }

    function applyConversationState({ sessionId: nextSessionId, sessionUrl: nextSessionUrl, history, updatedAt, persist = true, withTypewriter = false } = {}) {
        if (isNonEmptyString(nextSessionId)) {
            sessionId = nextSessionId.trim();
        } else if (!isNonEmptyString(sessionId)) {
            sessionId = createSessionId();
        }

        if (isNonEmptyString(nextSessionUrl)) {
            sessionUrl = nextSessionUrl.trim();
        }

        conversationHistory = normalizeConversationHistory(history);
        sessionUpdatedAt = toIsoTimestamp(updatedAt) || getLatestConversationTimestamp(conversationHistory);
        hasLocalConversationMutation = false;
        renderConversationHistory(conversationHistory, { fallbackTimestamp: sessionUpdatedAt, withTypewriter });
        if (persist) {
            persistConversationState({ updatedAt: sessionUpdatedAt });
        }
        syncQuickPromptsVisibility();
    }

    function buildClientContext(pageUrl = sessionUrl) {
        const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
        const platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
        const normalizedUserAgent = userAgent.toLowerCase();
        const normalizedPlatform = platform.toLowerCase();
        const resolvedPageUrl = isNonEmptyString(pageUrl) ? pageUrl.trim() : '';
        let pageHostname = '';
        if (resolvedPageUrl) {
            try {
                pageHostname = new URL(resolvedPageUrl).hostname || '';
            } catch {
                pageHostname = '';
            }
        }

        let browser = '';
        if (normalizedUserAgent.includes('edg/')) browser = 'Edge';
        else if (normalizedUserAgent.includes('opr/') || normalizedUserAgent.includes('opera')) browser = 'Opera';
        else if (normalizedUserAgent.includes('firefox/')) browser = 'Firefox';
        else if (normalizedUserAgent.includes('chrome/') && !normalizedUserAgent.includes('edg/') && !normalizedUserAgent.includes('opr/')) browser = 'Chrome';
        else if (normalizedUserAgent.includes('safari/') && !normalizedUserAgent.includes('chrome/')) browser = 'Safari';

        let os = '';
        if (normalizedUserAgent.includes('windows') || normalizedPlatform.includes('win')) os = 'Windows';
        else if (normalizedUserAgent.includes('mac os') || normalizedUserAgent.includes('macintosh') || normalizedPlatform.includes('mac')) os = 'macOS';
        else if (normalizedUserAgent.includes('android')) os = 'Android';
        else if (normalizedUserAgent.includes('iphone') || normalizedUserAgent.includes('ipad') || normalizedUserAgent.includes('ios')) os = 'iOS';
        else if (normalizedUserAgent.includes('linux') || normalizedPlatform.includes('linux')) os = 'Linux';
        else if (normalizedUserAgent.includes('cros')) os = 'ChromeOS';

        let deviceType = 'desktop';
        if (normalizedUserAgent.includes('ipad') || normalizedUserAgent.includes('tablet')) deviceType = 'tablet';
        else if (normalizedUserAgent.includes('mobile') || normalizedUserAgent.includes('iphone') || normalizedUserAgent.includes('android')) deviceType = 'mobile';

        return {
            userAgent,
            platform,
            browser,
            os,
            deviceType,
            pageHostname,
            extensionVersion: chrome.runtime.getManifest()?.version || ''
        };
    }

    function formatHistoryLocation(rawUrl) {
        if (!isNonEmptyString(rawUrl)) return 'Unknown page';
        try {
            const parsed = new URL(rawUrl);
            const hostname = parsed.hostname || rawUrl;
            const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
            return `${hostname}${path}`;
        } catch {
            return rawUrl;
        }
    }

    function formatHistoryPreview(session = {}) {
        if (isNonEmptyString(session.lastMessagePreview)) return session.lastMessagePreview.trim();
        if (isNonEmptyString(session.lastUserMessage)) return session.lastUserMessage.trim();
        if (isNonEmptyString(session.lastAssistantMessage)) return session.lastAssistantMessage.trim();
        return 'Conversation saved in your ScreenChat history.';
    }

    function formatHistoryDate(timestamp) {
        if (!isNonEmptyString(timestamp)) return 'Unknown date';
        const parsed = new Date(timestamp);
        if (Number.isNaN(parsed.getTime())) return 'Unknown date';
        const day = String(parsed.getDate()).padStart(2, '0');
        const month = parsed.toLocaleString(undefined, { month: 'long' });
        const year = parsed.getFullYear();
        const time = parsed.toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        return `${day} ${month} ${year} | ${time}`;
    }

    async function isBackendReachable(baseUrl) {
        try {
            const response = await Promise.race([
                apiFetchViaBackground(`${baseUrl}/health`, { method: 'GET' }),
                new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Backend health check timed out')), API_HEALTH_TIMEOUT_MS);
                })
            ]);
            if (!response.ok) return false;
            const payload = await response.json().catch(() => null);
            return Boolean(payload?.ok || response.ok);
        } catch {
            return false;
        }
    }

    function buildApiCandidateList({ overrideBaseUrl, cachedBaseUrl }) {
        const candidateSet = new Set();
        if (overrideBaseUrl) candidateSet.add(overrideBaseUrl);
        if (cachedBaseUrl) candidateSet.add(cachedBaseUrl);
        for (const candidate of apiBaseCandidates) {
            const normalizedCandidate = normalizeApiBaseUrl(candidate);
            if (normalizedCandidate) {
                candidateSet.add(normalizedCandidate);
            }
        }
        return Array.from(candidateSet);
    }

    async function resolveApiBaseUrl({ forceRefresh = false } = {}) {
        await ensureRuntimeConfigLoaded();
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

            resolvedApiBaseUrl = overrideBaseUrl || cachedBaseUrl || apiBaseCandidates[0];
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
            return await apiFetchViaBackground(requestUrl, options);
        } catch (proxyError) {
            try {
                return await fetch(requestUrl, options);
            } catch (directError) {
                if (directError?.name === 'AbortError') throw directError;
                throw proxyError;
            }
        }
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function createSignalWaiter() {
        let hasPendingSignal = false;
        let activeWaiter = null;

        return {
            notify() {
                if (activeWaiter) {
                    const resolveWaiter = activeWaiter;
                    activeWaiter = null;
                    resolveWaiter('signal');
                    return;
                }

                hasPendingSignal = true;
            },
            wait(timeoutMs) {
                if (hasPendingSignal) {
                    hasPendingSignal = false;
                    return Promise.resolve('signal');
                }

                return new Promise((resolve) => {
                    const timeoutId = setTimeout(() => {
                        if (activeWaiter === finishWait) {
                            activeWaiter = null;
                        }
                        resolve('timeout');
                    }, timeoutMs);

                    const finishWait = (reason = 'signal') => {
                        clearTimeout(timeoutId);
                        if (activeWaiter === finishWait) {
                            activeWaiter = null;
                        }
                        hasPendingSignal = false;
                        resolve(reason);
                    };

                    activeWaiter = finishWait;
                });
            }
        };
    }

    async function createHostedGoogleSignInAttempt() {
        const response = await apiFetch(
            '/api/auth/start',
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            { includeAuth: false }
        );

        if (!response.ok) {
            throw new Error(await getApiErrorMessage(response, 'Failed to start Google sign-in'));
        }

        const payload = await response.json().catch(() => null);
        const tempId = isNonEmptyString(payload?.tempId) ? payload.tempId.trim() : '';
        if (!tempId) {
            throw new Error('Google sign-in backend did not return a session ID');
        }

        return tempId;
    }

    async function loadHostedGoogleSignInStatus(tempId, { consume = false } = {}) {
        if (!isNonEmptyString(tempId)) return null;

        const searchParams = new URLSearchParams({ tempId: tempId.trim() });
        if (consume) {
            searchParams.set('consume', '1');
        }
        const statusResponse = await apiFetch(
            `/api/auth/status?${searchParams.toString()}`,
            { method: 'GET' },
            { includeAuth: false }
        );

        if (!statusResponse.ok) {
            return null;
        }

        const statusPayload = await statusResponse.json().catch(() => null);
        const session = normalizeStoredAuthSession({
            authToken: statusPayload?.authToken,
            refreshToken: statusPayload?.refreshToken,
            user: statusPayload?.user
        });

        return {
            status: isNonEmptyString(statusPayload?.status) ? statusPayload.status.trim().toLowerCase() : '',
            session: statusPayload?.linked && session ? session : null,
            error: isNonEmptyString(statusPayload?.error) ? statusPayload.error.trim() : ''
        };
    }

    async function cancelHostedGoogleSignInAttempt(tempId) {
        if (!isNonEmptyString(tempId)) return;

        await apiFetch(
            '/api/auth/cancel',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tempId: tempId.trim() })
            },
            { includeAuth: false }
        ).catch(() => null);
    }

    function getHostedGoogleSignInSessionFromMessage(payload, expectedTempId) {
        if (!payload || typeof payload !== 'object') return null;
        if (payload.type !== HOSTED_SIGN_IN_MESSAGE_TYPE) return null;
        if (!isNonEmptyString(payload.tempId) || payload.tempId.trim() !== expectedTempId) return null;

        return normalizeStoredAuthSession({
            authToken: payload.authToken,
            refreshToken: payload.refreshToken,
            user: payload.user
        });
    }

    function isHostedGoogleSignInClosedMessage(payload, expectedTempId) {
        if (!payload || typeof payload !== 'object') return false;
        if (payload.type !== HOSTED_SIGN_IN_CLOSED_MESSAGE_TYPE) return false;
        return isNonEmptyString(payload.tempId) && payload.tempId.trim() === expectedTempId;
    }

    async function waitForHostedGoogleSignInResult(tempId, popup) {
        const signalWaiter = createSignalWaiter();
        let directSession = null;
        let popupWasClosed = false;
        let popupCloseWasCancelled = false;
        const onHostedSignInMessage = (event) => {
            if (!allowedApiBaseOrigins.has(event?.origin)) return;
            const payload = event?.data && typeof event.data === 'object' ? event.data : null;
            const nextSession = getHostedGoogleSignInSessionFromMessage(payload, tempId);
            if (!nextSession && !isHostedGoogleSignInClosedMessage(payload, tempId)) return;
            if (nextSession) {
                directSession = nextSession;
            } else {
                popupWasClosed = true;
            }
            signalWaiter.notify();
        };

        window.addEventListener('message', onHostedSignInMessage);

        try {
            const startedAt = Date.now();
            const deadline = Date.now() + WEB_SIGN_IN_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (directSession) {
                    await loadHostedGoogleSignInStatus(tempId, { consume: true }).catch(() => null);
                    return directSession;
                }

                const statusSnapshot = await loadHostedGoogleSignInStatus(tempId, { consume: true });
                if (statusSnapshot?.session) {
                    return statusSnapshot.session;
                }

                if (popupWasClosed) {
                    if (!popupCloseWasCancelled) {
                        popupCloseWasCancelled = true;
                        await cancelHostedGoogleSignInAttempt(tempId);
                    }
                    throw new Error('Google sign-in window was closed before completion.');
                }

                if (statusSnapshot?.status === 'cancelled') {
                    throw new Error('Google sign-in window was closed before completion.');
                }

                if (statusSnapshot?.status === 'expired') {
                    throw new Error('Google sign-in expired. Please try again.');
                }

                if (statusSnapshot?.status === 'missing' && (Date.now() - startedAt) > 8000) {
                    throw new Error('Google sign-in session was lost. Please try again.');
                }

                if (statusSnapshot?.status === 'error' && statusSnapshot.error) {
                    throw new Error(statusSnapshot.error);
                }

                await signalWaiter.wait(WEB_SIGN_IN_POLL_INTERVAL_MS);
            }
        } finally {
            window.removeEventListener('message', onHostedSignInMessage);
        }

        throw new Error('Google sign-in timed out. Please try again.');
    }

    async function requestRefreshedAuthSession(refreshToken = getRefreshToken()) {
        const normalizedRefreshToken = isNonEmptyString(refreshToken) ? refreshToken.trim() : '';
        if (!normalizedRefreshToken) return null;

        const requestUrl = await apiUrl('/api/auth/refresh');
        const response = await fetchWithProxyFallback(requestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: normalizedRefreshToken })
        });

        if (!response.ok) {
            return null;
        }

        const payload = await response.json().catch(() => null);
        return normalizeStoredAuthSession({
            authToken: isNonEmptyString(payload?.authToken) ? payload.authToken.trim() : '',
            refreshToken: isNonEmptyString(payload?.refreshToken)
                ? payload.refreshToken.trim()
                : normalizedRefreshToken,
            user: payload?.user
        });
    }

    async function refreshAuthSession() {
        const currentSession = normalizeStoredAuthSession(authSession);
        if (!currentSession?.refreshToken) return null;
        if (authRefreshPromise) return authRefreshPromise;

        authRefreshPromise = (async () => {
            const nextSession = await requestRefreshedAuthSession(currentSession.refreshToken);
            if (!nextSession) {
                clearAuthSession();
                return null;
            }

            setAuthSession(nextSession);
            return nextSession;
        })().finally(() => {
            authRefreshPromise = null;
        });

        return authRefreshPromise;
    }

    async function beginHostedGoogleSignIn() {
        await ensureHostedGoogleAuthBackendReady();
        const baseUrl = await resolveApiBaseUrl();
        const tempId = await createHostedGoogleSignInAttempt();
        const loginUrl = `${baseUrl}/google-login.html?tempId=${encodeURIComponent(tempId)}`;
        const popup = window.open(loginUrl, 'screenchat-google-signin', 'popup=yes,width=520,height=720');

        if (!popup) {
            throw new Error('Sign-in popup was blocked. Allow popups and try again.');
        }

        try {
            popup.focus();
        } catch {
            // No-op.
        }

        const nextSession = await waitForHostedGoogleSignInResult(tempId, popup);

        try {
            popup.close();
        } catch {
            // No-op.
        }

        return nextSession;
    }

    async function apiFetch(path, options, { includeAuth = true } = {}) {
        const normalizedPath = normalizeApiPath(path);
        const initialUrl = await apiUrl(normalizedPath);
        const makeRequest = (requestUrl) => fetchWithProxyFallback(
            requestUrl,
            withAuthHeaders(options, { includeAuth })
        );
        try {
            let response = await makeRequest(initialUrl);
            if (response.status === 401 && includeAuth && getRefreshToken()) {
                const refreshedSession = await refreshAuthSession();
                if (refreshedSession?.authToken) {
                    response = await makeRequest(initialUrl);
                }
            }
            return response;
        } catch (fetchError) {
            const refreshedBaseUrl = await resolveApiBaseUrl({ forceRefresh: true });
            const refreshedUrl = `${refreshedBaseUrl}${normalizedPath}`;
            if (refreshedUrl !== initialUrl) {
                return makeRequest(refreshedUrl);
            }
            throw fetchError;
        }
    }

    async function apiFetchDirect(path, options, { includeAuth = true } = {}) {
        const normalizedPath = normalizeApiPath(path);
        const requestOptions = withAuthHeaders(options, { includeAuth });
        const initialUrl = await apiUrl(normalizedPath);
        try {
            return await fetch(initialUrl, requestOptions);
        } catch (fetchError) {
            if (fetchError?.name === 'AbortError') throw fetchError;
            const refreshedBaseUrl = await resolveApiBaseUrl({ forceRefresh: true });
            const refreshedUrl = `${refreshedBaseUrl}${normalizedPath}`;
            if (refreshedUrl !== initialUrl) {
                return fetch(refreshedUrl, requestOptions);
            }
            throw fetchError;
        }
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

    function getMissingFirebaseConfigKeys(config) {
        const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
        return requiredKeys.filter((key) => !isNonEmptyString(config?.[key]));
    }

    async function ensureHostedGoogleAuthBackendReady() {
        if (hostedAuthBackendCheckPromise) return hostedAuthBackendCheckPromise;

        hostedAuthBackendCheckPromise = (async () => {
            const authConfigResponse = await apiFetch(
                '/api/auth/config',
                { method: 'GET' },
                { includeAuth: false }
            );
            if (authConfigResponse.status === 404) {
                throw new Error('ScreenChat backend is missing /api/auth/config. Deploy the latest backend to Railway, then reload the extension.');
            }
            if (!authConfigResponse.ok) {
                throw new Error(await getApiErrorMessage(authConfigResponse, 'Unable to load ScreenChat auth config.'));
            }

            const authConfig = await authConfigResponse.json().catch(() => null);
            if (isNonEmptyString(authConfig?.googleOauthClientId)) {
                throw new Error('ScreenChat is still pointing at the old OAuth backend. Reload the extension with the correct runtime config, or deploy the latest backend.');
            }
            if (isNonEmptyString(authConfig?.authMode) && authConfig.authMode !== 'firebase-web') {
                throw new Error(`Unsupported auth mode from backend: ${authConfig.authMode}`);
            }

            const firebaseConfigResponse = await apiFetch(
                '/api/firebase-config',
                { method: 'GET' },
                { includeAuth: false }
            );
            if (firebaseConfigResponse.status === 404) {
                throw new Error('ScreenChat backend is missing /api/firebase-config. Deploy the latest backend to Railway, then reload the extension.');
            }
            if (!firebaseConfigResponse.ok) {
                throw new Error(await getApiErrorMessage(firebaseConfigResponse, 'Unable to load Firebase config from ScreenChat backend.'));
            }

            const firebaseConfig = await firebaseConfigResponse.json().catch(() => null);
            const missingKeys = getMissingFirebaseConfigKeys(firebaseConfig);
            if (missingKeys.length > 0) {
                throw new Error(`ScreenChat backend Firebase config is incomplete: ${missingKeys.join(', ')}`);
            }

            return { authConfig, firebaseConfig };
        })().catch((error) => {
            hostedAuthBackendCheckPromise = null;
            throw error;
        });

        return hostedAuthBackendCheckPromise;
    }

    function parseStreamLine(line, onPartialText, state) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return;
        const payload = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : trimmed;
        if (!payload || payload === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(payload);
        } catch {
            return;
        }

        if (event?.type === 'delta' && typeof event.delta === 'string') {
            state.reply += event.delta;
            if (typeof onPartialText === 'function') {
                onPartialText(cleanAiReply(state.reply, { allowPartial: true }));
            }
            return;
        }

        if (event?.type === 'done') {
            const finalReply = typeof event.reply === 'string'
                ? event.reply
                : extractStructuredReplyText(event);
            if (!isNonEmptyString(finalReply)) return;
            state.reply = finalReply;
            if (typeof onPartialText === 'function') {
                onPartialText(cleanAiReply(state.reply));
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
        const requestHeaders = withAuthHeaders({
            headers: { 'Content-Type': 'application/json' }
        });
        const streamOptions = normalizeProxyFetchOptions({
            method: 'POST',
            headers: requestHeaders.headers,
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
                        settleResolve(cleanAiReply(state.reply) || 'Sorry, I could not generate a response.');
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

    async function requestChatReplyStreamDirect(payload, { signal, onPartialText } = {}) {
        const state = { reply: '', buffer: '' };
        const requestOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal
        };

        let response = await apiFetchDirect('/api/chat/stream', requestOptions);
        if (isUnauthorizedResponse(response) && getRefreshToken()) {
            const refreshedSession = await refreshAuthSession();
            if (refreshedSession?.authToken) {
                response = await apiFetchDirect('/api/chat/stream', requestOptions);
            }
        }

        if (!response.ok) {
            const errorMessage = await getApiErrorMessage(response, 'Backend failed');
            throw new Error(errorMessage);
        }

        await consumeNdjsonResponse(response, onPartialText, state);
        return cleanAiReply(state.reply) || 'Sorry, I could not generate a response.';
    }

    async function requestChatReplyStream(payload, { signal, onPartialText } = {}) {
        try {
            return await requestChatReplyStreamDirect(payload, { signal, onPartialText });
        } catch (directStreamError) {
            if (directStreamError?.name === 'AbortError') throw directStreamError;
            console.warn('[Chat] Direct stream failed, falling back to background stream:', directStreamError);
        }

        return requestChatReplyStreamViaBackground(payload, { signal, onPartialText });
    }

    async function requestChatReply(payload, { signal, onPartialText } = {}) {
        return requestChatReplyStream(payload, { signal, onPartialText });
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
            const response = await sendSurfaceRuntimeMessage({ action: 'get_active_tab_url' });
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

    function buildCurrentPageUrlContext(currentUrl) {
        if (!isNonEmptyString(currentUrl)) return '';
        return `[Current URL: ${currentUrl.trim()}]`;
    }

    function attachCurrentPageUrlContext(messages, currentUrl) {
        const normalizedMessages = Array.isArray(messages)
            ? messages.map((message) => (message && typeof message === 'object' ? { ...message } : message))
            : [];
        const pageContext = buildCurrentPageUrlContext(currentUrl);
        if (!pageContext) return normalizedMessages;

        for (let i = normalizedMessages.length - 1; i >= 0; i -= 1) {
            const message = normalizedMessages[i];
            if (message?.role !== 'user' || !isNonEmptyString(message?.content)) continue;

            normalizedMessages[i] = {
                ...message,
                content: `${pageContext}\n\n${cleanUserMessage(message.content)}`
            };
            break;
        }

        return normalizedMessages;
    }

    function stripMarkdownCodeFence(rawText) {
        if (!isNonEmptyString(rawText)) return '';
        const trimmed = rawText.trim();
        const match = trimmed.match(/^```(?:json|javascript|js|text|markdown)?\s*([\s\S]*?)\s*```$/i);
        return match ? match[1].trim() : trimmed;
    }

    function extractStructuredReplyText(value) {
        if (isNonEmptyString(value)) {
            return value.trim();
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const extracted = extractStructuredReplyText(item);
                if (isNonEmptyString(extracted)) {
                    return extracted.trim();
                }
            }
            return '';
        }

        if (!value || typeof value !== 'object') {
            return '';
        }

        const directKeys = ['message', 'reply', 'content', 'text', 'output_text', 'outputText', 'answer', 'value', 'nextStep'];
        for (const key of directKeys) {
            if (!(key in value)) continue;
            const extracted = extractStructuredReplyText(value[key]);
            if (isNonEmptyString(extracted)) {
                return extracted.trim();
            }
        }

        const nestedKeys = ['output', 'choices', 'data', 'response', 'result'];
        for (const key of nestedKeys) {
            if (!(key in value)) continue;
            const extracted = extractStructuredReplyText(value[key]);
            if (isNonEmptyString(extracted)) {
                return extracted.trim();
            }
        }

        return '';
    }

    function extractPartialJsonMessage(rawReply) {
        if (!isNonEmptyString(rawReply)) return '';
        const normalized = stripMarkdownCodeFence(rawReply);
        if (!normalized || !/^[{\[]/.test(normalized)) return '';

        const match = normalized.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/s);
        if (!match) return '';

        try {
            return JSON.parse(`"${match[1]}"`);
        } catch {
            return match[1]
                .replace(/\\"/g, '"')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t');
        }
    }

    function cleanAiReply(reply, { allowPartial = false } = {}) {
        if (reply === null || reply === undefined) return '';

        const rawText = typeof reply === 'string' ? reply : JSON.stringify(reply);
        const trimmed = rawText.trim();
        if (!trimmed) return '';

        const candidates = [trimmed];
        const unfenced = stripMarkdownCodeFence(trimmed);
        if (unfenced && unfenced !== trimmed) {
            candidates.unshift(unfenced);
        }

        for (const candidate of candidates) {
            if (!candidate) continue;
            const firstChar = candidate[0];
            if (!['{', '[', '"'].includes(firstChar)) continue;

            try {
                const parsed = JSON.parse(candidate);
                const extracted = extractStructuredReplyText(parsed);
                if (isNonEmptyString(extracted)) {
                    return extracted.trim();
                }
            } catch {
                // Ignore parse failures and fall back below.
            }
        }

        if (allowPartial) {
            const partialMessage = extractPartialJsonMessage(trimmed);
            if (isNonEmptyString(partialMessage)) {
                return partialMessage;
            }

            if (/^(?:```(?:json|javascript|js)?\s*)?[\[{]/i.test(trimmed)) {
                return '';
            }
        }

        return rawText;
    }

    // UI State
    const UI_STATE_KEY = 'sc_ui_v2';
    const LEGACY_UI_STATE_KEYS = ['sc_ui_width', 'sc_ui_height', 'sc_ui_position'];
    const PROFILE_NUDGE_OPT_OUT_KEY = 'sc_profile_nudge_opt_out';
    const ATTACH_GLOW_OVERLAY_ID = 'sc-attach-glow-overlay';
    const ATTACH_GLOW_ANIMATION_MS = 920;
    const DEFAULT_PANEL_WIDTH = 382;
    const DEFAULT_PANEL_HEIGHT = 684;
    const PREVIOUS_DEFAULT_PANEL_WIDTH = 462;
    const PREVIOUS_DEFAULT_PANEL_HEIGHT = 833;
    const INTERMEDIATE_DEFAULT_PANEL_WIDTH = 420;
    const INTERMEDIATE_DEFAULT_PANEL_HEIGHT = 680;
    const LEGACY_PANEL_WIDTH = 388;
    const LEGACY_PANEL_HEIGHT = 620;
    const MIN_PANEL_WIDTH = 340;
    const MIN_PANEL_HEIGHT = 560;
    const MAX_PANEL_WIDTH = 420;
    const MAX_PANEL_HEIGHT = 720;
    const DEFAULT_UI_STATE = {
        mode: 'hidden', // open | hidden
        side: 'right', // right | left
        width: DEFAULT_PANEL_WIDTH,
        height: DEFAULT_PANEL_HEIGHT,
        panelPosition: null, // { left, top }
        customPosition: false,
        movable: true,
        resizable: true,
        activePane: 'chat' // auth | chat | history | profile
    };
    let uiState = { ...DEFAULT_UI_STATE };
    let hasTypedWelcome = false;
    let activePanelInteraction = null;
    const HOTKEY_DEBUG_ENABLED = false;
    const HOTKEY_REPEAT_GUARD_MS = 220;
    const HOTKEY_CROSS_SOURCE_GUARD_MS = 700;
    const CHAT_AUTO_SCROLL_THRESHOLD_PX = 48;
    const ROUTED_WHEEL_SCROLL_EASING = 0.24;
    const ROUTED_WHEEL_SCROLL_SETTLE_PX = 0.5;
    const HEADER_REVEAL_CLASS = 'sc-header-entering';
    const HEADER_REVEAL_DURATION_MS = 640;
    let lastHotkeyToggleAt = 0;
    let lastHotkeyToggleSource = '';
    let uiStateHydrated = false;
    let pendingUiAction = null;
    let shadowStylesLoaded = false;
    let profileNudgeOptOut = false;
    let profileNudgeSkippedThisSession = false;
    let profileLoadAttempted = false;
    let headerRevealTimerId = null;

    function hotkeyLog(event, details = {}) {
        if (!HOTKEY_DEBUG_ENABLED) return;
        console.log('[ScreenChat][Hotkey][Content]', event, {
            ts: new Date().toISOString(),
            href: window.location.href,
            mode: uiState?.mode || 'unknown',
            hydrated: uiStateHydrated,
            ...details
        });
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function isElementNearScrollBottom(element, threshold = CHAT_AUTO_SCROLL_THRESHOLD_PX) {
        if (!(element instanceof HTMLElement)) return false;
        const remainingScroll = element.scrollHeight - element.clientHeight - element.scrollTop;
        return remainingScroll <= threshold;
    }

    function scrollMessagesToBottom({ force = false } = {}) {
        const messagesArea = shadowRoot?.getElementById('sc-messages');
        if (!(messagesArea instanceof HTMLElement)) return false;
        if (!force && !isElementNearScrollBottom(messagesArea)) return false;
        messagesArea.scrollTop = messagesArea.scrollHeight;
        return true;
    }

    function prefersReducedMotion() {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function clearHeaderRevealAnimation() {
        if (headerRevealTimerId) {
            clearTimeout(headerRevealTimerId);
            headerRevealTimerId = null;
        }
        const panel = shadowRoot?.getElementById('sc-panel');
        if (panel) {
            panel.classList.remove(HEADER_REVEAL_CLASS);
        }
    }

    function playHeaderRevealAnimation() {
        const panel = shadowRoot?.getElementById('sc-panel');
        clearHeaderRevealAnimation();
        if (!(panel instanceof HTMLElement) || prefersReducedMotion()) return;
        void panel.offsetWidth;
        panel.classList.add(HEADER_REVEAL_CLASS);
        headerRevealTimerId = setTimeout(() => {
            panel.classList.remove(HEADER_REVEAL_CLASS);
            headerRevealTimerId = null;
        }, HEADER_REVEAL_DURATION_MS);
    }

    function getHostOffset() {
        return window.matchMedia('(max-width: 640px)').matches ? 14 : 24;
    }

    function getViewportPadding() {
        return window.matchMedia('(max-width: 640px)').matches ? 8 : 12;
    }

    function getPanelSizeLimits() {
        const viewportPadding = getViewportPadding();
        const maxWidth = Math.min(MAX_PANEL_WIDTH, Math.max(220, window.innerWidth - (viewportPadding * 2)));
        const maxHeight = Math.min(MAX_PANEL_HEIGHT, Math.max(280, window.innerHeight - (viewportPadding * 2)));
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
        if (IS_SIDEPANEL_SURFACE) return;
        storageSetSafe({ [UI_STATE_KEY]: uiState });
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
        if (IS_SIDEPANEL_SURFACE) {
            uiState = {
                ...DEFAULT_UI_STATE,
                mode: 'open',
                movable: false,
                resizable: false,
                customPosition: false,
                panelPosition: null
            };
            applyUiState();
            if (typeof onReady === 'function') onReady();
            return;
        }

        storageGetSafe([UI_STATE_KEY, ...LEGACY_UI_STATE_KEYS], (result) => {
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
            if (!['auth', 'chat', 'history', 'profile'].includes(loaded.activePane)) loaded.activePane = 'chat';
            if (!Number.isFinite(loaded.width)) loaded.width = DEFAULT_PANEL_WIDTH;
            if (!Number.isFinite(loaded.height)) loaded.height = DEFAULT_PANEL_HEIGHT;
            // One-time size migration from old default geometry.
            const isLegacyDefaultSize =
                (loaded.width === PREVIOUS_DEFAULT_PANEL_WIDTH && loaded.height === PREVIOUS_DEFAULT_PANEL_HEIGHT) ||
                (loaded.width === INTERMEDIATE_DEFAULT_PANEL_WIDTH && loaded.height === INTERMEDIATE_DEFAULT_PANEL_HEIGHT) ||
                (loaded.width === LEGACY_PANEL_WIDTH && loaded.height === LEGACY_PANEL_HEIGHT);
            if (isLegacyDefaultSize) {
                loaded.width = DEFAULT_PANEL_WIDTH;
                loaded.height = DEFAULT_PANEL_HEIGHT;
                loaded.panelPosition = null;
            }
            if (!loaded.panelPosition || !Number.isFinite(loaded.panelPosition.left) || !Number.isFinite(loaded.panelPosition.top)) {
                loaded.panelPosition = null;
            }
            if (typeof loaded.customPosition !== 'boolean') loaded.customPosition = false;
            loaded.movable = true;
            loaded.resizable = true;
            if (!loaded.customPosition) {
                loaded.panelPosition = null;
            }
            // The content script is injected on demand, so restoring an "open" mode here
            // causes a first-paint flash before the requested action runs.
            loaded.mode = 'hidden';
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

            storageSetSafe({ [UI_STATE_KEY]: uiState }, () => {
                if (migratedLegacy) {
                    storageRemoveSafe(LEGACY_UI_STATE_KEYS, finalize);
                } else {
                    finalize();
                }
            });
        });
    }

    function applyPanelGeometry() {
        if (!shadowRoot) return;
        if (IS_SIDEPANEL_SURFACE) {
            const host = document.getElementById('screenchat-host');
            if (host) {
                host.classList.remove('sc-left');
            }

            const panel = shadowRoot.getElementById('sc-panel');
            if (panel) {
                panel.style.width = '';
                panel.style.height = '';
                panel.classList.remove('is-movable');
                panel.classList.remove('is-resizable');
            }

            positionProfileNudge();
            return;
        }

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

        const profileNudge = shadowRoot.getElementById('sc-profile-nudge');
        if (profileNudge?.classList.contains('visible')) {
            positionProfileNudge();
        }
    }

    function setActivePane(pane = 'chat', persist = true) {
        if (!shadowRoot) return;
        const panes = {
            auth: 'sc-auth-view',
            chat: 'sc-chat-pane',
            history: 'sc-history-view',
            profile: 'sc-profile-view'
        };
        const requestedPane = panes[pane] ? pane : 'chat';
        const canAccessRequestedPane = isAuthenticated() || (isAuthRestoreInFlight && requestedPane === 'chat');
        const targetPane = canAccessRequestedPane ? requestedPane : 'auth';

        for (const [key, id] of Object.entries(panes)) {
            const el = shadowRoot.getElementById(id);
            if (el) el.classList.toggle('visible', key === targetPane);
        }

        const panel = shadowRoot.getElementById('sc-panel');
        if (panel) {
            panel.setAttribute('data-active-pane', targetPane);
        }

        const chatTabs = [shadowRoot.getElementById('sc-pane-chat'), shadowRoot.getElementById('sc-chat-nav')].filter(Boolean);
        const historyTabs = [shadowRoot.getElementById('sc-pane-history'), shadowRoot.getElementById('sc-history-btn')].filter(Boolean);
        const profileTabs = [shadowRoot.getElementById('sc-pane-profile'), shadowRoot.getElementById('sc-profile-btn')].filter(Boolean);
        chatTabs.forEach((tab) => tab.classList.toggle('active', targetPane === 'chat'));
        historyTabs.forEach((tab) => tab.classList.toggle('active', targetPane === 'history'));
        profileTabs.forEach((tab) => tab.classList.toggle('active', targetPane === 'profile'));

        uiState.activePane = targetPane;
        refreshProfileNudgeVisibility();
        if (persist) persistUiState();
    }

    function setUiMode(mode, persist = true) {
        const previousMode = uiState.mode;
        const targetMode = IS_SIDEPANEL_SURFACE
            ? 'open'
            : (['open', 'hidden'].includes(mode) ? mode : 'open');
        const shouldAnimateHeader = targetMode === 'open' && previousMode !== 'open';
        uiState.mode = targetMode;
        if (previousMode !== targetMode) {
            hotkeyLog('ui_mode_changed', { from: previousMode, to: targetMode, persist });
        }
        if (container) {
            container.setAttribute('data-mode', targetMode);
        }
        applyPanelGeometry();
        if (targetMode === 'open') {
            setActivePane(uiState.activePane || 'chat', false);
            if (shouldAnimateHeader) {
                requestAnimationFrame(() => playHeaderRevealAnimation());
            }
        } else {
            clearHeaderRevealAnimation();
        }
        refreshProfileNudgeVisibility();
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
        const header = shadowRoot?.querySelector('.sc-header');
        const headerTop = shadowRoot?.querySelector('.sc-header-top');
        const grabZone = shadowRoot?.getElementById('sc-grab-zone');
        if (!panel || !header || !headerTop || !grabZone) return;

        const moveTargets = [grabZone, header];
        const dragStateTargets = [grabZone, header, headerTop];
        const getInteractionCursor = (interactionType, direction = '') => {
            if (interactionType === 'move') return 'grabbing';
            if (!direction) return '';
            return `${direction}-resize`;
        };
        const setDocumentCursor = (cursor = '') => {
            document.documentElement.style.cursor = cursor;
            if (document.body) {
                document.body.style.cursor = cursor;
            }
        };

        const startInteraction = (event, interactionType, direction = '') => {
            if (activePanelInteraction) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            if (interactionType === 'move' && !uiState.movable) return;
            if (interactionType === 'resize' && (!uiState.resizable || !direction)) return;

            const nonDragTarget = event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"], .sc-profile-nudge');
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
                target,
                rootCursor: document.documentElement.style.cursor,
                bodyCursor: document.body?.style.cursor || ''
            };
            uiState.customPosition = true;

            panel.classList.add('sc-interacting');
            if (interactionType === 'move') {
                dragStateTargets.forEach((targetNode) => targetNode.classList.add('sc-dragging'));
            }
            setDocumentCursor(getInteractionCursor(interactionType, direction));

            if (target.setPointerCapture) {
                try {
                    target.setPointerCapture(pointerId);
                } catch (e) { }
            }

            const finishInteraction = () => {
                if (!activePanelInteraction || activePanelInteraction.pointerId !== pointerId) return;

                target.removeEventListener('pointermove', onPointerMove);
                target.removeEventListener('pointerup', onPointerUpOrCancel);
                target.removeEventListener('pointercancel', onPointerUpOrCancel);
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
                dragStateTargets.forEach((targetNode) => targetNode.classList.remove('sc-dragging'));
                setDocumentCursor(activePanelInteraction.rootCursor || '');
                if (document.body) {
                    document.body.style.cursor = activePanelInteraction.bodyCursor || '';
                }
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

            target.addEventListener('pointermove', onPointerMove, { passive: false });
            target.addEventListener('pointerup', onPointerUpOrCancel);
            target.addEventListener('pointercancel', onPointerUpOrCancel);
            window.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
            window.addEventListener('pointerup', onPointerUpOrCancel, true);
            window.addEventListener('pointercancel', onPointerUpOrCancel, true);
            window.addEventListener('mouseup', onMouseUpFallback, true);
            window.addEventListener('blur', onWindowBlur);
            target.addEventListener('lostpointercapture', onLostPointerCapture);
        };

        moveTargets.forEach((targetNode) => {
            targetNode.addEventListener('pointerdown', (event) => startInteraction(event, 'move'));
        });

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
            }
        };

        tick();
    }

    function isMacDevice() {
        const platform = navigator.userAgentData?.platform || navigator.platform || '';
        return /Mac|iPhone|iPad|iPod/i.test(platform);
    }

    function getHotkeyParts() {
        return isMacDevice() ? ['⌘', '⇧', 'Y'] : ['Ctrl', 'Shift', 'Y'];
    }

    function isEdgeBrowser() {
        const brands = Array.isArray(navigator.userAgentData?.brands) ? navigator.userAgentData.brands : [];
        if (brands.some((brand) => /microsoft edge/i.test(brand?.brand || ''))) {
            return true;
        }
        return /\bEdg\//i.test(navigator.userAgent || '');
    }

    function getShortcutSettingsInfo() {
        return isEdgeBrowser()
            ? { browser: 'edge', browserName: 'Edge', url: 'edge://extensions/shortcuts' }
            : { browser: 'chrome', browserName: 'Chrome', url: 'chrome://extensions/shortcuts' };
    }

    async function openShortcutSettings() {
        const shortcutSettings = getShortcutSettingsInfo();
        const response = await sendSurfaceRuntimeMessage({
            action: 'open_shortcut_settings',
            browser: shortcutSettings.browser
        });
        if (!response?.ok) {
            throw new Error(response?.error || 'Unable to open shortcut settings');
        }
    }

    function installHostEventShield(host) {
        if (!host || host.dataset.scShieldInstalled === '1') return;

        const shieldedEvents = [
            'click', 'dblclick', 'auxclick',
            'mousedown', 'mouseup',
            'pointerdown', 'pointerup',
            'touchstart', 'touchend', 'touchmove',
            'wheel',
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

    function triggerHotkeyToggle(source = 'runtime_message') {
        const now = Date.now();
        const elapsed = now - lastHotkeyToggleAt;
        const sameSource = source === lastHotkeyToggleSource;
        if (sameSource && elapsed < HOTKEY_REPEAT_GUARD_MS) {
            hotkeyLog('trigger_blocked_repeat', {
                source,
                elapsed,
                threshold: HOTKEY_REPEAT_GUARD_MS
            });
            return;
        }
        if (!sameSource && elapsed < HOTKEY_CROSS_SOURCE_GUARD_MS) {
            hotkeyLog('trigger_blocked_cross_source', {
                source,
                previousSource: lastHotkeyToggleSource,
                elapsed,
                threshold: HOTKEY_CROSS_SOURCE_GUARD_MS
            });
            return;
        }

        lastHotkeyToggleAt = now;
        lastHotkeyToggleSource = source;
        hotkeyLog('trigger_accepted', { source, elapsed, sameSource });
        toggleUIFromHotkey();
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
        console.info('[OpenStyle] Activation requested', {
            surface: APP_SURFACE,
            preferredOpenStyle,
            keepAcrossTabsActive: !!keepAcrossTabsState.active,
            uiMode: uiState.mode
        });
        if (!IS_SIDEPANEL_SURFACE && keepAcrossTabsState.active) {
            openKeepAcrossTabsPanel()
                .then(() => {
                    console.info('[OpenStyle] Reopened existing keep-across-tabs sidebar');
                    setUiMode('hidden');
                })
                .catch((error) => {
                    const errorMessage = String(error?.message || '');
                    if (errorMessage.includes('No active keep across tabs workflow')) {
                        refreshKeepAcrossTabsState({ hideInlineUiOnActive: false }).catch(() => {});
                    } else {
                        console.warn('[KeepAcrossTabs] Failed to reopen side panel:', error);
                    }
                    setActivePane('chat', false);
                    setUiMode('open');
                });
            return;
        }

        if (!IS_SIDEPANEL_SURFACE && isSidebarPreferredOpenStyle()) {
            openDefaultSidePanel()
                .then(() => {
                    console.info('[OpenStyle] Preferred sidebar opened successfully');
                    setUiMode('hidden');
                })
                .catch((error) => {
                    console.warn('[OpenStyle] Failed to open preferred sidebar:', error);
                    console.info('[OpenStyle] Falling back to inline window after sidebar open failure');
                    openInlineUiFromActivation();
                });
            return;
        }

        console.info('[OpenStyle] Opening inline window');
        openInlineUiFromActivation();
    }

    function restoreInlineUiFromSidePanel() {
        if (IS_SIDEPANEL_SURFACE) return;
        setActivePane('chat', false);
        setUiMode('open');
        focusChatInput();
    }

    function runUiAction(action, source = 'runtime_message') {
        hotkeyLog('run_ui_action', { action, source });
        if (action === 'toggle_ui') {
            toggleUI();
        } else if (action === 'open_ui') {
            openUiFromActivation();
        } else if (action === 'hide_ui') {
            setUiMode('hidden');
        } else if (action === 'restore_inline_ui') {
            restoreInlineUiFromSidePanel();
        } else if (action === 'hotkey_toggle_ui') {
            triggerHotkeyToggle(source);
        }
    }

    function handleUiAction(action, source = 'runtime_message') {
        if (!uiStateHydrated) {
            pendingUiAction = { action, source };
            hotkeyLog('action_queued_until_hydrated', { action, source });
            return;
        }

        hotkeyLog('action_run', { action, source });
        runUiAction(action, source);
    }

    function setAuthStatus(message = '', isError = false) {
        const statusEl = shadowRoot?.getElementById('sc-auth-status');
        if (!statusEl) return;
        const statusMessage = isExtensionContextInvalidatedError(message)
            ? EXTENSION_CONTEXT_RECOVERY_MESSAGE
            : message;
        statusEl.textContent = statusMessage;
        statusEl.classList.toggle('error', !!isError);
    }

    function syncAuthUi() {
        if (!shadowRoot) return;
        const authenticated = isAuthenticated();
        const authUserEl = shadowRoot.getElementById('sc-auth-user');
        const historyBtn = shadowRoot.getElementById('sc-history-btn');
        const profileBtn = shadowRoot.getElementById('sc-profile-btn');
        const historyNavBtn = shadowRoot.getElementById('sc-pane-history');
        const profileNavBtn = shadowRoot.getElementById('sc-pane-profile');
        const newChatBtn = shadowRoot.getElementById('sc-new-chat');
        const attachToggle = shadowRoot.getElementById('sc-attach-screen-toggle');
        const accountSummaryEl = shadowRoot.getElementById('sc-account-summary');
        const accountAvatarEl = shadowRoot.getElementById('sc-account-avatar');
        const accountAvatarFallbackEl = shadowRoot.getElementById('sc-account-avatar-fallback');
        const accountNameEl = shadowRoot.getElementById('sc-account-name');
        const accountEmailEl = shadowRoot.getElementById('sc-account-email');
        const signedInUser = authenticated ? authSession?.user : null;

        if (authUserEl) {
            authUserEl.textContent = authenticated && signedInUser?.email
                ? `Signed in as ${signedInUser.email}`
                : '';
        }

        if (accountSummaryEl) {
            accountSummaryEl.hidden = !authenticated;
        }
        if (authenticated && signedInUser) {
            const resolvedAccountName = isNonEmptyString(userProfile?.fullName)
                ? userProfile.fullName.trim()
                : getUserDisplayName(signedInUser);
            const resolvedAccountEmail = isNonEmptyString(userProfile?.email)
                ? userProfile.email.trim()
                : (signedInUser.email || '');
            if (accountNameEl) {
                accountNameEl.textContent = resolvedAccountName;
            }
            if (accountEmailEl) {
                accountEmailEl.textContent = resolvedAccountEmail;
            }
            if (accountAvatarFallbackEl) {
                accountAvatarFallbackEl.textContent = getUserAvatarInitial(signedInUser);
            }
            if (accountAvatarEl) {
                const avatarUrl = isNonEmptyString(signedInUser.picture) ? signedInUser.picture.trim() : '';
                if (avatarUrl) {
                    accountAvatarEl.src = avatarUrl;
                    accountAvatarEl.hidden = false;
                } else {
                    accountAvatarEl.removeAttribute('src');
                    accountAvatarEl.hidden = true;
                }
            }
        }

        if (authenticated) {
            setAuthStatus('');
        }

        if (historyBtn) historyBtn.disabled = !authenticated;
        if (profileBtn) profileBtn.disabled = !authenticated;
        if (historyNavBtn) historyNavBtn.disabled = !authenticated;
        if (profileNavBtn) profileNavBtn.disabled = !authenticated;
        if (newChatBtn) newChatBtn.disabled = !authenticated;
        if (attachToggle) attachToggle.disabled = !authenticated;

        if (!authenticated) {
            if (isAuthRestoreInFlight) {
                setInputState(false, 'Restoring your session...');
                if (uiState.activePane !== 'chat') {
                    setActivePane('chat', false);
                }
            } else {
                setInputState(false, 'Sign in with Google to continue...');
                if (uiState.activePane !== 'auth') {
                    setActivePane('auth', false);
                }
            }
        } else if (!isAwaitingResponse) {
            setInputState(true, 'Ask me anything...');
            if (uiState.activePane === 'auth') {
                setActivePane('chat', false);
            }
        }
    }

    function requireAuthenticationUi(message = 'Please sign in with Google to continue.') {
        isAuthRestoreInFlight = false;
        clearAuthSession();
        userProfile = null;
        profileLoadAttempted = false;
        setAuthStatus(message, true);
        syncAuthUi();
        setActivePane('auth');
    }

    let latestHistorySyncPromise = null;

    async function syncLatestHistoryIntoChat({ force = false } = {}) {
        if (!isAuthenticated()) return false;
        if (latestHistorySyncPromise) return latestHistorySyncPromise;

        latestHistorySyncPromise = (async () => {
            const hasConversation = conversationHistory.length > 0;
            if (!force && hasLocalConversationMutation) {
                return false;
            }

            const response = await apiFetch('/api/history/latest');
            if (!response.ok) {
                if (isUnauthorizedResponse(response)) {
                    requireAuthenticationUi('Please sign in again to sync your history.');
                    return false;
                }
                throw new Error(await getApiErrorMessage(response, 'Failed to sync history'));
            }

            const payload = await response.json();
            const remoteSession = payload?.session && typeof payload.session === 'object' ? payload.session : null;
            const remoteHistory = normalizeConversationHistory(payload?.history);
            if (!remoteSession?.id || !remoteHistory.length) {
                return false;
            }

            const remoteUpdatedAt = toIsoTimestamp(remoteSession.updatedAt);
            const localUpdatedAt = toIsoTimestamp(sessionUpdatedAt) || getLatestConversationTimestamp(conversationHistory);
            const shouldHydrate = force || !hasConversation || !localUpdatedAt || (
                remoteUpdatedAt && parseTimestampMs(remoteUpdatedAt) > (parseTimestampMs(localUpdatedAt) || 0)
            );

            if (!shouldHydrate) {
                return false;
            }

            applyConversationState({
                sessionId: remoteSession.id,
                sessionUrl: remoteSession.url,
                history: remoteHistory,
                updatedAt: remoteUpdatedAt,
                persist: true,
                withTypewriter: false
            });
            return true;
        })().catch((error) => {
            console.warn('[History] Latest session sync failed:', error);
            return false;
        }).finally(() => {
            latestHistorySyncPromise = null;
        });

        return latestHistorySyncPromise;
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
        const shouldHidePrompts = !isAuthenticated() || hasUserMessageInHistory || hasUserMessageInDom || isAwaitingResponse;
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
        messagesArea.innerHTML = '';
        const welcomeMessageEl = addMessage('', 'ai', null, true, Date.now(), true);
        const bubble = welcomeMessageEl?.querySelector('.sc-bubble');
        if (bubble && withTypewriter) {
            runTypewriter(bubble, DEFAULT_WELCOME_MESSAGE);
        } else {
            updateMessageContent(welcomeMessageEl, DEFAULT_WELCOME_MESSAGE, null, { forceScroll: true });
        }
        hasTypedWelcome = !!withTypewriter;
        syncQuickPromptsVisibility();
    }

    function resetConversationState() {
        if (currentAbortController) {
            try {
                currentAbortController.abort();
            } catch {
                // No-op.
            }
        }
        currentAbortController = null;
        activeResponseRequestId = 0;
        activeResponseStopRequested = false;
        sessionId = createSessionId();
        sessionUrl = window.location.href || window.location.hostname || 'unknown';
        sessionUpdatedAt = null;
        conversationHistory = [];
        isAwaitingResponse = false;
        hasLocalConversationMutation = false;
        setAttachScreenEnabled(true);
        clearPersistedConversationState();
    }

    function startNewSession(resetUI = true, withTypewriter = false) {
        resetConversationState();

        if (resetUI) {
            renderWelcomeMessage(withTypewriter);
            setActivePane('chat');
            setUiMode('open');
        }
    }

    function openInlineUiFromActivation() {
        uiState.side = 'right';
        uiState.customPosition = false;
        uiState.panelPosition = getDefaultPanelPosition(uiState.width, uiState.height, 'right');
        setAttachScreenEnabled(true);
        resetConversationState();
        renderWelcomeMessage(false);
        setActivePane('chat', false);
        setUiMode('open');
    }

    function getUiSvgUrl(filename) {
        const normalizedFilename = typeof filename === 'string' ? filename.trim() : '';
        const override = LUCIDE_FILE_OVERRIDES[normalizedFilename];
        if (override) {
            const cacheKey = `${normalizedFilename}:${override.icon}:${override.stroke}`;
            if (!lucideDataUriCache.has(cacheKey)) {
                lucideDataUriCache.set(cacheKey, buildLucideIconDataUri(override.icon, override.stroke));
            }
            return lucideDataUriCache.get(cacheKey);
        }
        return chrome.runtime.getURL(`icons/svgs/${filename}`);
    }

    function getAttachScreenControlLabel(isEnabled) {
        return isEnabled ? 'Remove the attached screen' : 'Attach the screen';
    }

    function getAttachScreenTooltip(isEnabled) {
        return getAttachScreenControlLabel(isEnabled);
    }

    function getAttachScreenIconUrl(isEnabled) {
        return getUiSvgUrl(isEnabled ? 'minus-square-muted.svg' : 'plus-square-Filled.svg');
    }

    function getPrimaryActionControlLabel() {
        return isAwaitingResponse ? 'Stop response' : 'Send message';
    }

    function getPrimaryActionTooltip() {
        return isAwaitingResponse ? 'Stop response' : 'Send (Enter)';
    }

    function getPrimaryActionIconUrl() {
        return isAwaitingResponse
            ? buildLucideIconDataUri('square', '#FFFFFF')
            : getUiSvgUrl('send.svg');
    }

    function getChatInputPlaceholder(fallback = 'Ask me anything...') {
        return isAwaitingResponse
            ? 'Type to interrupt...'
            : fallback;
    }

    function hasAnyProfileValue(profile) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
        const values = [profile.fullName, profile.nickname, profile.email, profile.phone, profile.notes];
        return values.some((value) => typeof value === 'string' && value.trim().length > 0);
    }

    function setProfileNudgeOptOut(enabled) {
        profileNudgeOptOut = !!enabled;
        storageSetSafe({ [PROFILE_NUDGE_OPT_OUT_KEY]: profileNudgeOptOut });
        refreshProfileNudgeVisibility();
    }

    function positionProfileNudge() {
        const nudge = shadowRoot?.getElementById('sc-profile-nudge');
        const profileBtn = shadowRoot?.getElementById('sc-profile-btn') || shadowRoot?.getElementById('sc-pane-profile');
        if (!nudge || !profileBtn) return;

        const buttonRect = profileBtn.getBoundingClientRect();
        const nudgeWidth = nudge.offsetWidth || 244;
        const viewportPadding = 10;
        const arrowEdgePadding = 16;
        const top = buttonRect.top - 10;
        let left = buttonRect.left + (buttonRect.width / 2) - (nudgeWidth / 2);
        left = clamp(left, viewportPadding, window.innerWidth - nudgeWidth - viewportPadding);

        const arrowLeft = clamp(
            buttonRect.left + (buttonRect.width / 2) - left,
            arrowEdgePadding,
            nudgeWidth - arrowEdgePadding
        );

        nudge.style.left = `${Math.round(left)}px`;
        nudge.style.top = `${Math.round(top)}px`;
        nudge.style.setProperty('--sc-profile-nudge-arrow-left', `${Math.round(arrowLeft)}px`);
    }

    function setProfileNudgeVisible(visible) {
        const nudge = shadowRoot?.getElementById('sc-profile-nudge');
        const profileBtn = shadowRoot?.getElementById('sc-profile-btn') || shadowRoot?.getElementById('sc-pane-profile');
        if (!nudge) return;
        const shouldShow = !!visible;
        nudge.classList.toggle('visible', shouldShow);
        nudge.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
        if (profileBtn) {
            profileBtn.classList.toggle('sc-btn-icon-nudged', shouldShow);
        }
        if (shouldShow) {
            positionProfileNudge();
            requestAnimationFrame(positionProfileNudge);
        }
    }

    function shouldShowProfileNudge() {
        if (!isAuthenticated()) return false;
        if (!profileLoadAttempted) return false;
        if (profileNudgeOptOut || profileNudgeSkippedThisSession) return false;
        if (uiState.mode !== 'open' || uiState.activePane !== 'chat') return false;
        return !hasAnyProfileValue(userProfile);
    }

    function refreshProfileNudgeVisibility() {
        setProfileNudgeVisible(shouldShowProfileNudge());
    }

    function ensureAttachGlowOverlay() {
        let overlay = shadowRoot?.getElementById(ATTACH_GLOW_OVERLAY_ID);
        overlay?.querySelector('.sc-attach-glow-badge')?.remove();
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

        if (attachGlowResetTimeout) {
            window.clearTimeout(attachGlowResetTimeout);
            attachGlowResetTimeout = 0;
        }

        overlay.classList.remove('active');
        // Restart animation when user toggles repeatedly.
        void overlay.offsetWidth;
        overlay.classList.add('active');

        let settled = false;
        const onAnimationEnd = (event) => {
            if (event.target !== overlay) return;
            settle();
        };
        const settle = () => {
            if (settled) return;
            settled = true;
            overlay.classList.remove('active');
            overlay.removeEventListener('animationend', onAnimationEnd);
            if (attachGlowResetTimeout) {
                window.clearTimeout(attachGlowResetTimeout);
                attachGlowResetTimeout = 0;
            }
        };

        overlay.addEventListener('animationend', onAnimationEnd);
        attachGlowResetTimeout = window.setTimeout(settle, ATTACH_GLOW_ANIMATION_MS + 200);
    }

    function setAttachScreenEnabled(enabled) {
        const wasEnabled = attachScreenEnabled;
        attachScreenEnabled = !!enabled;
        const attachToggle = shadowRoot?.getElementById('sc-attach-screen-toggle');
        const toggleIcon = attachToggle?.querySelector('.sc-attach-icon');
        const controlLabel = getAttachScreenControlLabel(attachScreenEnabled);
        if (attachToggle) {
            attachToggle.classList.toggle('active', attachScreenEnabled);
            attachToggle.setAttribute('aria-pressed', attachScreenEnabled ? 'true' : 'false');
            attachToggle.setAttribute('aria-label', controlLabel);
            attachToggle.setAttribute('data-tooltip', getAttachScreenTooltip(attachScreenEnabled));
            attachToggle.removeAttribute('title');
        }
        if (toggleIcon) {
            toggleIcon.src = getAttachScreenIconUrl(attachScreenEnabled);
        }

        if (attachScreenEnabled && !wasEnabled) {
            playAttachGlowAnimation();
        }
    }

    function isVisibleForCapture(el) {
        if (!(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function hasVisibleScreenChatUiForCapture() {
        const panel = shadowRoot?.getElementById('sc-panel');
        const launcher = shadowRoot?.getElementById('sc-launcher');
        return (panel && isVisibleForCapture(panel)) || (launcher && isVisibleForCapture(launcher));
    }

    function waitForPaint(frames = 1) {
        const frameCount = Math.max(1, Number(frames) || 1);
        return new Promise((resolve) => {
            let remaining = frameCount;
            const tick = () => {
                remaining -= 1;
                if (remaining <= 0) {
                    resolve();
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    }

    async function waitForCaptureSettle({ frames = 2, delayMs = 120 } = {}) {
        await waitForPaint(frames);
        const nextDelayMs = Math.max(0, Number(delayMs) || 0);
        if (nextDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
        }
    }

    function captureVisibleTabImage() {
        return new Promise((resolve, reject) => {
            getSurfaceWindowId()
                .then((surfaceWindowId) => {
                    const payload = { action: 'capture_visible_tab' };
                    if (Number.isInteger(surfaceWindowId)) {
                        payload.windowId = surfaceWindowId;
                    }

                    chrome.runtime.sendMessage(payload, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message || 'Failed to capture screen'));
                            return;
                        }
                        if (!response?.ok || typeof response.image !== 'string' || !response.image) {
                            reject(new Error(response?.error || 'Failed to capture screen'));
                            return;
                        }
                        resolve(response.image);
                    });
                })
                .catch((error) => {
                    reject(error instanceof Error ? error : new Error(String(error || 'Failed to capture screen')));
                });
        });
    }

    async function captureCurrentScreen() {
        if (IS_SIDEPANEL_SURFACE) {
            await waitForCaptureSettle({ frames: 3, delayMs: 180 });
            return captureVisibleTabImage();
        }

        const host = document.getElementById('screenchat-host');
        const shouldMoveHostOffscreen = !!host && hasVisibleScreenChatUiForCapture();

        if (!shouldMoveHostOffscreen) {
            await waitForCaptureSettle({ frames: 2, delayMs: 120 });
            return captureVisibleTabImage();
        }

        host.setAttribute('data-sc-capture-hidden', '1');
        try {
            // Wait for the hide state to paint before capture so the screenshot keeps underlying content.
            await waitForCaptureSettle({ frames: 2, delayMs: 120 });
            return await captureVisibleTabImage();
        } finally {
            host.removeAttribute('data-sc-capture-hidden');
            await waitForPaint(1);
        }
    }

    // Initialize
    function init() {
        const existing = document.getElementById('screenchat-host');
        if (existing) existing.remove();

        const host = document.createElement('div');
        host.id = 'screenchat-host';
        host.setAttribute('data-sc-surface', APP_SURFACE);
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
        loadPreferredOpenStyle().catch((error) => {
            console.warn('[OpenStyle] Failed to load preferred opening style:', error);
        });
        resolveApiBaseUrl().catch((error) => {
            console.warn('[API] Backend discovery failed:', error);
        });

        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === 'toggle_ui' || request.action === 'open_ui' || request.action === 'restore_inline_ui' || request.action === 'hotkey_toggle_ui' || request.action === 'hide_ui') {
                hotkeyLog('runtime_message_received', {
                    action: request.action,
                    hotkeyRequestId: request.hotkeyRequestId || null,
                    hotkeyIssuedAt: request.hotkeyIssuedAt || null
                });
                handleUiAction(request.action, 'runtime_message');
            }
        });

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local') return;
            if (changes?.[DEFAULT_OPEN_STYLE_KEY]) {
                setPreferredOpenStyle(changes[DEFAULT_OPEN_STYLE_KEY].newValue, { persist: false });
            }
            if (changes?.[KEEP_ACROSS_TABS_STATE_KEY]) {
                refreshKeepAcrossTabsState({
                    hideInlineUiOnActive: !keepAcrossTabsRequestInFlight
                }).then(() => {
                    if (!IS_SIDEPANEL_SURFACE || !keepAcrossTabsState.active) return null;
                    return restoreKeepAcrossTabsConversation();
                }).catch((error) => {
                    console.warn('[KeepAcrossTabs] Storage sync failed:', error);
                });
            }
        });

        window.addEventListener('resize', () => {
            if (!container) return;
            applyPanelGeometry();
        });
        setInterval(refreshVisibleTimestamps, TIMESTAMP_REFRESH_INTERVAL_MS);

        migrateAndLoadUiState(() => {
            uiStateHydrated = true;
            hotkeyLog('ui_state_hydrated', {
                pendingUiAction: pendingUiAction
                    ? (typeof pendingUiAction === 'string'
                        ? pendingUiAction
                        : `${pendingUiAction.action}:${pendingUiAction.source}`)
                    : null
            });
            if (pendingUiAction) {
                const pendingAction = pendingUiAction;
                pendingUiAction = null;
                if (typeof pendingAction === 'string') {
                    hotkeyLog('replaying_pending_action', {
                        action: pendingAction,
                        source: 'runtime_message'
                    });
                    runUiAction(pendingAction, 'runtime_message');
                } else {
                    hotkeyLog('replaying_pending_action', {
                        action: pendingAction.action,
                        source: pendingAction.source || 'runtime_message'
                    });
                    runUiAction(pendingAction.action, pendingAction.source || 'runtime_message');
                }
            }
        });

        storageGetSafe([
            AUTH_SESSION_KEY,
            'screenchat_user',
            'messageCount',
            PROFILE_NUDGE_OPT_OUT_KEY,
            PROFILE_CACHE_KEY,
            CONVERSATION_HISTORY_KEY,
            SESSION_STATE_KEY
        ], (result) => {
            (async () => {
                profileNudgeOptOut = !!result[PROFILE_NUDGE_OPT_OUT_KEY];
                setAttachScreenEnabled(true);

                const cachedProfileIdentity = normalizeProfileIdentity(result[PROFILE_CACHE_KEY]) || readProfileIdentityFromLocalStorage();
                if (cachedProfileIdentity) {
                    persistProfileIdentity(cachedProfileIdentity);
                    const initialProfileInputs = {
                        profileNameInput: shadowRoot?.getElementById('sc-profile-name'),
                        profileNicknameInput: shadowRoot?.getElementById('sc-profile-nickname'),
                        profileEmailInput: shadowRoot?.getElementById('sc-profile-email'),
                        profilePhoneInput: shadowRoot?.getElementById('sc-profile-phone'),
                        profileNotesInput: shadowRoot?.getElementById('sc-profile-notes')
                    };
                    userProfile = applyProfileFormValues({
                        profileNameInput: initialProfileInputs.profileNameInput,
                        profileNicknameInput: initialProfileInputs.profileNicknameInput,
                        profileEmailInput: initialProfileInputs.profileEmailInput,
                        profilePhoneInput: initialProfileInputs.profilePhoneInput,
                        profileNotesInput: initialProfileInputs.profileNotesInput
                    }, {
                        fullName: cachedProfileIdentity.fullName || '',
                        nickname: '',
                        email: cachedProfileIdentity.email || '',
                        phone: '',
                        notes: ''
                    });
                }

                await refreshKeepAcrossTabsState({ hideInlineUiOnActive: false });

                const persistedConversation = IS_SIDEPANEL_SURFACE && keepAcrossTabsState.active
                    ? getPersistedConversationSnapshot(result)
                    : null;
                if (persistedConversation) {
                    applyConversationState({
                        sessionId: persistedConversation.sessionId,
                        sessionUrl: persistedConversation.sessionUrl || sessionUrl,
                        history: persistedConversation.history,
                        updatedAt: persistedConversation.updatedAt,
                        persist: false,
                        withTypewriter: false
                    });
                } else {
                    // Always start from a fresh local chat session when the content-surface extension loads.
                    resetConversationState();
                }

                const storedAuthSession = normalizeStoredAuthSession(result[AUTH_SESSION_KEY]);
                const hasStoredAuthSession = !!storedAuthSession;
                // Do not block the UI on startup auth restoration; API requests already refresh tokens on demand.
                setAuthSession(storedAuthSession, { persist: false, verified: hasStoredAuthSession });
                isAuthRestoreInFlight = false;

                if (result.screenchat_user || result.messageCount) {
                    storageRemoveSafe(['screenchat_user', 'messageCount']);
                }

                const messagesArea = shadowRoot.getElementById('sc-messages');
                if (messagesArea && !messagesArea.querySelector('.sc-message')) {
                    renderWelcomeMessage(false);
                }

                syncAuthUi();
                syncQuickPromptsVisibility();
                refreshProfileNudgeVisibility();
                syncKeepAcrossTabsUi();
            })().catch((error) => {
                console.warn('[Init] ScreenChat bootstrap failed:', error);
                resetConversationState();
                syncAuthUi();
                syncQuickPromptsVisibility();
                refreshProfileNudgeVisibility();
                syncKeepAcrossTabsUi();
            });
        });
    }

    // Create UI Structure
    function createUI() {
        container = document.createElement('div');
        container.className = 'sc-shell';
        container.dataset.scSurface = APP_SURFACE;
        const logoUrl = chrome.runtime.getURL('icons/icon48.png');
        const sidebarOpenStyleIllustrationUrl = chrome.runtime.getURL('icons/svgs/open-style-sidebar.svg');
        const windowOpenStyleIllustrationUrl = chrome.runtime.getURL('icons/svgs/open-style-window.svg');
        const keepAcrossTabsIconUrl = getUiSvgUrl('pin.svg');
        const historyIconUrl = getUiSvgUrl('clock.svg');
        const chatIconUrl = getUiSvgUrl('comment-dots.svg');
        const profileIconUrl = getUiSvgUrl('user.svg');
        const closeIconUrl = getUiSvgUrl('times-square.svg');
        const backIconUrl = getUiSvgUrl('arrow-left.svg');
        const attachIconUrl = getAttachScreenIconUrl(attachScreenEnabled);
        const sendIconUrl = getPrimaryActionIconUrl();
        const searchIconUrl = getUiSvgUrl('search.svg');
        const toolbarTrashIconUrl = getUiSvgUrl('Icon Button.svg');
        const logoutIconUrl = getUiSvgUrl('Log out.svg');

        container.innerHTML = `
            <button class="sc-launcher" id="sc-launcher" title="Open ScreenChat" aria-label="Open ScreenChat">
                <img src="${logoUrl}" class="sc-launcher-logo" alt="ScreenChat">
            </button>

            <section class="sc-panel" id="sc-panel" role="dialog" aria-label="ScreenChat Assistant">
                <div class="sc-grab-zone" id="sc-grab-zone" aria-hidden="true">
                    <span class="sc-grab-pill"></span>
                </div>
                <div class="sc-header">
                    <div class="sc-header-top">
                        <button class="sc-btn-icon sc-header-back" id="sc-header-back" title="Back" aria-label="Back to chat">
                            <img src="${backIconUrl}" class="sc-icon-img sc-icon-img-back" alt="" aria-hidden="true">
                        </button>
                        <div class="sc-header-left">
                            <img src="${logoUrl}" class="sc-logo" alt="ScreenChat">
                            <div class="sc-brand-copy">
                                <span class="sc-title">ScreenChat</span>
                                <span class="sc-subtitle">Context for what is on screen</span>
                            </div>
                        </div>
                        <div class="sc-header-actions">
                            <div class="sc-header-actions-extra">
                                <button class="sc-btn-icon" id="sc-keep-across-tabs" title="Keep across tabs" aria-label="Keep across tabs" aria-pressed="false">
                                    <img src="${keepAcrossTabsIconUrl}" class="sc-icon-img" alt="" aria-hidden="true">
                                </button>
                                <button class="sc-btn-icon" id="sc-history-btn" title="History" aria-label="History">
                                    <img src="${historyIconUrl}" class="sc-icon-img" alt="" aria-hidden="true">
                                </button>
                                <button class="sc-btn-icon sc-btn-new" id="sc-new-chat" title="Chat" aria-label="Open chat">
                                    <img src="${chatIconUrl}" class="sc-icon-img" alt="" aria-hidden="true">
                                </button>
                                <button class="sc-btn-icon" id="sc-profile-btn" title="Profile" aria-label="Profile">
                                    <img src="${profileIconUrl}" class="sc-icon-img" alt="" aria-hidden="true">
                                </button>
                            </div>
                            <button class="sc-btn-icon" id="sc-close" title="Close" aria-label="Close ScreenChat">
                                <img src="${closeIconUrl}" class="sc-icon-img sc-icon-img-close" alt="" aria-hidden="true">
                            </button>
                        </div>
                    </div>
                </div>

                <div class="sc-pane sc-pane-auth" id="sc-auth-view">
                    <div class="sc-auth-card">
                        <h3>Continue to ScreenChat</h3>
                        <p class="sc-auth-copy">Save your sessions, reopen past chats, and ask about anything visible on the page.</p>
                        <button class="sc-google-signin-btn" id="sc-google-signin-btn" type="button">
                            <span class="sc-google-mark" aria-hidden="true">G</span>
                            <span>Sign in with Google</span>
                        </button>
                        <p class="sc-auth-user" id="sc-auth-user"></p>
                        <p class="sc-auth-status" id="sc-auth-status"></p>
                    </div>
                </div>

                <div class="sc-pane sc-pane-chat visible" id="sc-chat-pane">
                    <div class="sc-messages" id="sc-messages"></div>
                    <div class="sc-quick-prompts" id="sc-quick-prompts">
                        <button class="sc-prompt-btn" type="button" data-prompt="What are the key takeaways from this page?">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">📝</span>
                                <span class="sc-prompt-title">Key takeaways</span>
                            </span>
                            <span class="sc-prompt-chip">/summary</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="Give me a summary of the page.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">💡</span>
                                <span class="sc-prompt-title">Summary of the page</span>
                            </span>
                            <span class="sc-prompt-chip">/explain</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="Draft the next reply or action I should take from this page.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-emoji" aria-hidden="true">🧭</span>
                                <span class="sc-prompt-title">Draft my next step</span>
                            </span>
                            <span class="sc-prompt-chip">/reply</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="Explain this page in simple language and define any jargon I should know.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-title">Explain it simply</span>
                            </span>
                            <span class="sc-prompt-chip">/simplify</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="List the concrete action items, tasks, or next steps suggested by this page.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-title">Action items</span>
                            </span>
                            <span class="sc-prompt-chip">/actions</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="Extract the most important facts, numbers, names, and claims from this page.">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-title">Important facts</span>
                            </span>
                            <span class="sc-prompt-chip">/facts</span>
                        </button>
                        <button class="sc-prompt-btn" type="button" data-prompt="What follow-up questions should I ask based on this page?">
                            <span class="sc-prompt-main">
                                <span class="sc-prompt-title">Questions to ask</span>
                            </span>
                            <span class="sc-prompt-chip">/questions</span>
                        </button>
                    </div>
                    <div class="sc-hotkey-hint" id="sc-hotkey-hint"></div>
                    <div class="sc-input-area">
                        <div class="sc-input-row">
                            <div class="sc-input-wrapper">
                                <textarea class="sc-textarea" id="sc-chat-input" placeholder="Ask me anything..." rows="1"></textarea>
                                <button class="sc-attach-toggle ${attachScreenEnabled ? 'active' : ''}" id="sc-attach-screen-toggle" type="button" aria-label="${getAttachScreenControlLabel(attachScreenEnabled)}" aria-pressed="${attachScreenEnabled ? 'true' : 'false'}" data-tooltip="${getAttachScreenTooltip(attachScreenEnabled)}">
                                    <img src="${attachIconUrl}" class="sc-attach-icon" alt="" aria-hidden="true">
                                </button>
                            </div>
                            <button class="sc-send-btn" id="sc-send" title="Send (Enter)" aria-label="Send message">
                                <img src="${sendIconUrl}" class="sc-send-icon" alt="" aria-hidden="true">
                            </button>
                        </div>
                    </div>
                </div>

                <div class="sc-pane" id="sc-history-view">
                    <div class="sc-pane-header">
                        <button class="sc-btn-icon sc-back-btn" id="sc-history-close" aria-label="Back to chat">
                            <img src="${backIconUrl}" class="sc-icon-img sc-icon-img-back" alt="" aria-hidden="true">
                        </button>
                        <div class="sc-pane-heading">
                            <h3>History</h3>
                            <p>Reopen saved sessions from any page.</p>
                        </div>
                    </div>
                    <div class="sc-history-tools">
                        <button class="sc-btn-icon sc-tool-btn" id="sc-history-search-toggle" type="button" title="Search history" aria-label="Search history" aria-expanded="false" aria-controls="sc-history-search-wrap">
                            <img src="${searchIconUrl}" class="sc-icon-img sc-tool-icon" alt="" aria-hidden="true">
                        </button>
                        <button class="sc-btn-icon sc-tool-btn" id="sc-history-clear" type="button" title="Clear all conversations" aria-label="Clear all conversations">
                            <img src="${toolbarTrashIconUrl}" class="sc-icon-img sc-tool-icon" alt="" aria-hidden="true">
                        </button>
                    </div>
                    <div class="sc-history-search" id="sc-history-search-wrap" hidden>
                        <input class="sc-history-search-input" id="sc-history-search-input" type="search" placeholder="Search messages and pages" autocomplete="off" spellcheck="false">
                    </div>
                    <div class="sc-history-list" id="sc-history-list"></div>
                </div>

                <div class="sc-pane" id="sc-profile-view">
                    <div class="sc-pane-header">
                        <button class="sc-btn-icon sc-back-btn" id="sc-profile-close" aria-label="Back to chat">
                            <img src="${backIconUrl}" class="sc-icon-img sc-icon-img-back" alt="" aria-hidden="true">
                        </button>
                        <div class="sc-pane-heading">
                            <h3>Profile</h3>
                            <p>Personalize how ScreenChat helps you.</p>
                        </div>
                    </div>
                    <div class="sc-profile-content" id="sc-profile-content">
                        <div class="sc-account-summary" id="sc-account-summary" hidden>
                            <div class="sc-account-avatar-wrap" aria-hidden="true">
                                <img class="sc-account-avatar" id="sc-account-avatar" alt="" hidden>
                                <span class="sc-account-avatar-fallback" id="sc-account-avatar-fallback">G</span>
                            </div>
                            <div class="sc-account-meta">
                                <p class="sc-account-name" id="sc-account-name"></p>
                                <p class="sc-account-email" id="sc-account-email"></p>
                            </div>
                        </div>
                        <p class="sc-profile-desc">Your full name and email are imported from your Google account and saved to your ScreenChat profile. You can edit them here for how ScreenChat uses your information in responses. This does not change your main Google account information.</p>
                        <div class="sc-profile-field">
                            <label for="sc-profile-name">Full Name</label>
                            <input type="text" id="sc-profile-name" placeholder="John Doe">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-nickname">Nickname</label>
                            <input type="text" id="sc-profile-nickname" placeholder="Nickname">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-email">Email</label>
                            <input type="email" id="sc-profile-email" placeholder="Email">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-phone">Phone</label>
                            <input type="tel" id="sc-profile-phone" placeholder="Phone">
                        </div>
                        <div class="sc-profile-field">
                            <label for="sc-profile-notes">Notes</label>
                            <textarea id="sc-profile-notes" placeholder="I work at google, prefer formal responses"></textarea>
                        </div>
                        <section class="sc-profile-settings-group" aria-labelledby="sc-default-open-style-label">
                            <div class="sc-profile-settings-copy">
                                <p class="sc-profile-settings-label" id="sc-default-open-style-label">Default Opening Style</p>
                            </div>
                            <div class="sc-open-style-grid" role="radiogroup" aria-labelledby="sc-default-open-style-label">
                                <label class="sc-open-style-option ${preferredOpenStyle === 'window' ? 'selected' : ''}">
                                    <input class="sc-open-style-input" type="radio" name="sc-default-open-style" value="window"${preferredOpenStyle === 'window' ? ' checked' : ''}>
                                    <img src="${windowOpenStyleIllustrationUrl}" class="sc-open-style-illustration" alt="" aria-hidden="true">
                                    <span class="sc-open-style-name">Chat Window</span>
                                </label>
                                <label class="sc-open-style-option ${preferredOpenStyle === 'sidebar' ? 'selected' : ''}">
                                    <input class="sc-open-style-input" type="radio" name="sc-default-open-style" value="sidebar"${preferredOpenStyle === 'sidebar' ? ' checked' : ''}>
                                    <img src="${sidebarOpenStyleIllustrationUrl}" class="sc-open-style-illustration" alt="" aria-hidden="true">
                                    <span class="sc-open-style-name">Sidebar</span>
                                </label>
                            </div>
                        </section>
                        <div class="sc-profile-shortcut-row">
                            <span class="sc-profile-shortcut-label">Shortcut</span>
                            <a class="sc-profile-shortcut-link" id="sc-profile-shortcut-link" href="chrome://extensions/shortcuts" target="_blank" rel="noreferrer">Open settings</a>
                        </div>
                        <button class="sc-profile-save" id="sc-profile-save" type="button">Save</button>
                        <div class="sc-profile-footer">
                        <button class="sc-profile-signout" id="sc-profile-signout" type="button" title="Sign out" aria-label="Sign out">
                            <img src="${logoutIconUrl}" class="sc-profile-signout-icon" alt="" aria-hidden="true">
                            <span class="sc-visually-hidden">Sign out</span>
                        </button>
                        </div>
                    </div>
                </div>

                <nav class="sc-bottom-nav" aria-label="ScreenChat sections">
                    <button class="sc-nav-btn" id="sc-pane-chat" type="button" aria-label="Chat">
                        <span class="sc-nav-icon" aria-hidden="true">
                            <img src="${chatIconUrl}" class="sc-icon-img sc-nav-icon-img" alt="" aria-hidden="true">
                        </span>
                        <span class="sc-nav-label">Chat</span>
                    </button>
                    <button class="sc-nav-btn" id="sc-pane-history" type="button" aria-label="History">
                        <span class="sc-nav-icon" aria-hidden="true">
                            <img src="${historyIconUrl}" class="sc-icon-img sc-nav-icon-img" alt="" aria-hidden="true">
                        </span>
                        <span class="sc-nav-label">History</span>
                    </button>
                    <button class="sc-nav-btn" id="sc-pane-profile" type="button" aria-label="Profile">
                        <span class="sc-nav-icon" aria-hidden="true">
                            <img src="${profileIconUrl}" class="sc-icon-img sc-nav-icon-img" alt="" aria-hidden="true">
                        </span>
                        <span class="sc-nav-label">Profile</span>
                    </button>
                </nav>

                <div class="sc-resize-handle sc-resize-handle-n" data-direction="n" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-e" data-direction="e" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-s" data-direction="s" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-w" data-direction="w" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-ne" data-direction="ne" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-nw" data-direction="nw" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-se" data-direction="se" aria-hidden="true"></div>
                <div class="sc-resize-handle sc-resize-handle-sw" data-direction="sw" aria-hidden="true"></div>
            </section>
            <div class="sc-profile-nudge" id="sc-profile-nudge" role="note" aria-hidden="true">
                <p class="sc-profile-nudge-title">Personalize ScreenChat</p>
                <p class="sc-profile-nudge-copy">Add a few details so I can help you.</p>
                <div class="sc-profile-nudge-actions">
                    <button class="sc-profile-nudge-btn" id="sc-profile-nudge-skip" type="button">Skip for now</button>
                    <button class="sc-profile-nudge-btn" id="sc-profile-nudge-stop" type="button">Don&apos;t ask again</button>
                </div>
            </div>
        `;

        container.setAttribute('data-mode', uiState.mode);
        shadowRoot.appendChild(container);
        renderHotkeyHint();
        setActivePane(isAuthenticated() ? 'chat' : 'auth', false);
        setupEventListeners();
        syncAuthUi();
        syncKeepAcrossTabsUi();
    }

    function setupEventListeners() {
        const launcherBtn = shadowRoot.getElementById('sc-launcher');
        const panel = shadowRoot.getElementById('sc-panel');
        const closeBtn = shadowRoot.getElementById('sc-close');
        const headerBackBtn = shadowRoot.getElementById('sc-header-back');
        const newChatBtn = shadowRoot.getElementById('sc-new-chat');
        const chatPaneBtn = shadowRoot.getElementById('sc-pane-chat');
        const historyPaneBtn = shadowRoot.getElementById('sc-pane-history');
        const profilePaneBtn = shadowRoot.getElementById('sc-pane-profile');

        const keepAcrossTabsBtn = shadowRoot.getElementById('sc-keep-across-tabs');
        const historyBtn = shadowRoot.getElementById('sc-history-btn');
        const profileBtn = shadowRoot.getElementById('sc-profile-btn');

        const historyCloseBtn = shadowRoot.getElementById('sc-history-close');
        const profileCloseBtn = shadowRoot.getElementById('sc-profile-close');

        const sendBtn = shadowRoot.getElementById('sc-send');
        const textarea = shadowRoot.getElementById('sc-chat-input');
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const historyList = shadowRoot.getElementById('sc-history-list');
        const historySearchToggleBtn = shadowRoot.getElementById('sc-history-search-toggle');
        const historySearchWrap = shadowRoot.getElementById('sc-history-search-wrap');
        const historySearchInput = shadowRoot.getElementById('sc-history-search-input');
        const historyClearBtn = shadowRoot.getElementById('sc-history-clear');
        const profileContent = shadowRoot.getElementById('sc-profile-content');
        const attachScreenToggle = shadowRoot.getElementById('sc-attach-screen-toggle');
        const googleSignInBtn = shadowRoot.getElementById('sc-google-signin-btn');

        const profileSaveBtn = shadowRoot.getElementById('sc-profile-save');
        const profileShortcutLink = shadowRoot.getElementById('sc-profile-shortcut-link');
        const profileSignOutBtn = shadowRoot.getElementById('sc-profile-signout');
        const profileNameInput = shadowRoot.getElementById('sc-profile-name');
        const profileNicknameInput = shadowRoot.getElementById('sc-profile-nickname');
        const profileEmailInput = shadowRoot.getElementById('sc-profile-email');
        const profilePhoneInput = shadowRoot.getElementById('sc-profile-phone');
        const profileNotesInput = shadowRoot.getElementById('sc-profile-notes');
        const defaultOpenStyleInputs = Array.from(shadowRoot.querySelectorAll('input[name="sc-default-open-style"]'));
        const profileNudgeSkipBtn = shadowRoot.getElementById('sc-profile-nudge-skip');
        const profileNudgeStopBtn = shadowRoot.getElementById('sc-profile-nudge-stop');

        const quickPrompts = shadowRoot.getElementById('sc-quick-prompts');
        const quickPromptButtons = shadowRoot.querySelectorAll('.sc-prompt-btn');
        const HISTORY_FETCH_LIMIT = 250;
        let historySessions = [];
        let historySearchQuery = '';
        let historySearchOpen = false;
        let historyLoading = false;
        let historyErrorMessage = '';
        let historyRestoringSessionId = '';
        let historyDeletingSessionId = '';
        let historyClearingAll = false;
        let historyOpenMenuSessionId = '';
        setupPanelPointerInteractions();
        [
            closeBtn,
            headerBackBtn,
            newChatBtn,
            chatPaneBtn,
            historyPaneBtn,
            profilePaneBtn,
            keepAcrossTabsBtn,
            historyBtn,
            profileBtn,
            historyCloseBtn,
            profileCloseBtn,
            sendBtn,
            attachScreenToggle,
            googleSignInBtn,
            profileSaveBtn,
            profileShortcutLink,
            profileSignOutBtn
        ].forEach(bindPressScale);

        if (keepAcrossTabsBtn) {
            keepAcrossTabsBtn.addEventListener('click', () => {
                toggleKeepAcrossTabs();
            });
        }

        if (profileShortcutLink instanceof HTMLAnchorElement) {
            const shortcutSettings = getShortcutSettingsInfo();
            profileShortcutLink.href = shortcutSettings.url;
            profileShortcutLink.title = `Open ${shortcutSettings.browserName} shortcut settings`;
            profileShortcutLink.setAttribute('aria-label', `Open ${shortcutSettings.browserName} shortcut settings`);
            profileShortcutLink.addEventListener('click', async (event) => {
                event.preventDefault();
                try {
                    await openShortcutSettings();
                } catch (error) {
                    console.warn('[Shortcuts] Open settings failed:', error);
                }
            });
        }

        defaultOpenStyleInputs.forEach((input) => {
            input.addEventListener('change', () => {
                if (!input.checked) return;
                setPreferredOpenStyle(input.value);
            });
        });
        syncPreferredOpenStyleUi();

        function syncProfileState(profile) {
            const storedProfile = profile && typeof profile === 'object' && !Array.isArray(profile)
                ? profile
                : null;

            userProfile = applyProfileFormValues({
                profileNameInput,
                profileNicknameInput,
                profileEmailInput,
                profilePhoneInput,
                profileNotesInput
            }, storedProfile);

            persistProfileIdentity(userProfile);
            syncAuthUi();

            if (storedProfile && hasAnyProfileValue(userProfile)) {
                setProfileNudgeOptOut(true);
            }

            return userProfile;
        }

        function setGoogleSignInState(loading) {
            if (!googleSignInBtn) return;
            googleSignInBtn.disabled = !!loading;
            googleSignInBtn.innerHTML = loading
                ? '<span class="sc-google-mark" aria-hidden="true">G</span><span>Signing in...</span>'
                : '<span class="sc-google-mark" aria-hidden="true">G</span><span>Sign in with Google</span>';
        }

        function setProfileSignOutState(state = 'idle') {
            if (!profileSignOutBtn) return;
            const loadingIconUrl = getUiSvgUrl('loader.svg');
            const errorIconUrl = getUiSvgUrl('circle-slash.svg');
            const idleIconUrl = getUiSvgUrl('Log out.svg');
            if (state === 'loading') {
                profileSignOutBtn.innerHTML = `
                    <img src="${loadingIconUrl}" class="sc-profile-signout-icon sc-icon-spin" alt="" aria-hidden="true">
                    <span class="sc-visually-hidden">Signing out</span>
                `;
                profileSignOutBtn.setAttribute('title', 'Signing out...');
                profileSignOutBtn.setAttribute('aria-label', 'Signing out');
                return;
            }
            if (state === 'error') {
                profileSignOutBtn.innerHTML = `
                    <img src="${errorIconUrl}" class="sc-profile-signout-icon" alt="" aria-hidden="true">
                    <span class="sc-visually-hidden">Sign out failed</span>
                `;
                profileSignOutBtn.setAttribute('title', 'Sign out failed. Try again.');
                profileSignOutBtn.setAttribute('aria-label', 'Sign out failed');
                return;
            }
            profileSignOutBtn.innerHTML = `
                <img src="${idleIconUrl}" class="sc-profile-signout-icon" alt="" aria-hidden="true">
                <span class="sc-visually-hidden">Sign out</span>
            `;
            profileSignOutBtn.setAttribute('title', 'Sign out');
            profileSignOutBtn.setAttribute('aria-label', 'Sign out');
        }

        function bindPressScale(button) {
            if (!(button instanceof HTMLElement) || button.dataset.scPressScaleBound === '1') return;
            button.dataset.scPressScaleBound = '1';
            const clearPressed = () => button.classList.remove('sc-pressing');
            button.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                button.classList.add('sc-pressing');
                try {
                    button.setPointerCapture(event.pointerId);
                } catch {
                    // Pointer capture is optional here; the visual state still works without it.
                }
            });
            button.addEventListener('pointerup', clearPressed);
            button.addEventListener('pointercancel', clearPressed);
            button.addEventListener('lostpointercapture', clearPressed);
            button.addEventListener('blur', clearPressed);
        }

        function bindHorizontalPromptScroller(container) {
            if (!(container instanceof HTMLElement)) return;

            let activePointerId = null;
            let dragStartX = 0;
            let dragStartScrollLeft = 0;
            let isDragging = false;
            let suppressNextClick = false;

            const hasHorizontalOverflow = () => (container.scrollWidth - container.clientWidth) > 1;

            const stopDragging = () => {
                if (activePointerId !== null) {
                    try {
                        container.releasePointerCapture(activePointerId);
                    } catch {
                        // Pointer capture is optional for drag scrolling.
                    }
                }
                activePointerId = null;
                isDragging = false;
                container.classList.remove('sc-drag-scrolling');
            };

            container.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || !hasHorizontalOverflow()) return;
                cancelSmoothWheelRouting(container);
                activePointerId = event.pointerId;
                dragStartX = event.clientX;
                dragStartScrollLeft = container.scrollLeft;
                isDragging = false;
                suppressNextClick = false;
            });

            container.addEventListener('pointermove', (event) => {
                if (activePointerId !== event.pointerId) return;

                const deltaX = event.clientX - dragStartX;
                if (!isDragging && Math.abs(deltaX) > 6) {
                    isDragging = true;
                    suppressNextClick = true;
                    container.classList.add('sc-drag-scrolling');
                    try {
                        container.setPointerCapture(event.pointerId);
                    } catch {
                        // Pointer capture is optional for drag scrolling.
                    }
                }

                if (!isDragging) return;
                event.preventDefault();
                container.scrollLeft = dragStartScrollLeft - deltaX;
            });

            container.addEventListener('pointerup', stopDragging);
            container.addEventListener('pointercancel', stopDragging);
            container.addEventListener('lostpointercapture', stopDragging);

            container.addEventListener('click', (event) => {
                if (!suppressNextClick) return;
                event.preventDefault();
                event.stopPropagation();
                suppressNextClick = false;
            }, true);

            container.addEventListener('wheel', (event) => {
                const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
                if (maxScrollLeft <= 1) return;

                const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                const deltaX = normalizeWheelDelta(primaryDelta, event.deltaMode, container, 'x');
                if (!deltaX) return;

                const didScroll = queueSmoothWheelScroll(container, deltaX, 0, {
                    smooth: event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
                });
                if (!didScroll) return;

                event.preventDefault();
                event.stopPropagation();
            }, { passive: false });
        }

        function bindAutoHidingScrollbar(container) {
            if (!container) return;

            let hideTimerId = null;
            let syncFrameId = 0;

            const clearHideTimer = () => {
                if (!hideTimerId) return;
                clearTimeout(hideTimerId);
                hideTimerId = null;
            };

            const syncScrollState = () => {
                syncFrameId = 0;
                const hasOverflow = (container.scrollHeight - container.clientHeight) > 1;
                container.classList.toggle('sc-has-scroll', hasOverflow);
                if (!hasOverflow) {
                    clearHideTimer();
                    container.classList.remove('sc-scroll-active');
                }
            };

            const requestSyncScrollState = () => {
                if (syncFrameId) return;
                syncFrameId = requestAnimationFrame(syncScrollState);
            };

            const scheduleHideScrollbar = () => {
                const hasOverflow = (container.scrollHeight - container.clientHeight) > 1;
                container.classList.toggle('sc-has-scroll', hasOverflow);
                clearHideTimer();
                if (!hasOverflow) {
                    container.classList.remove('sc-scroll-active');
                    return;
                }
                hideTimerId = setTimeout(() => {
                    hideTimerId = null;
                    container.classList.remove('sc-scroll-active');
                }, 1400);
            };

            const revealScrollbar = () => {
                requestSyncScrollState();
                container.classList.add('sc-scroll-active');
                scheduleHideScrollbar();
            };

            container.addEventListener('pointerdown', () => cancelSmoothWheelRouting(container));
            container.addEventListener('scroll', revealScrollbar, { passive: true });
            container.addEventListener('wheel', revealScrollbar, { passive: true });
            container.addEventListener('touchstart', revealScrollbar, { passive: true });
            container.addEventListener('pointerenter', revealScrollbar);
            container.addEventListener('pointerleave', scheduleHideScrollbar);
            container.addEventListener('focusin', revealScrollbar);
            container.addEventListener('focusout', scheduleHideScrollbar);
            window.addEventListener('resize', requestSyncScrollState);

            if (typeof ResizeObserver === 'function') {
                const resizeObserver = new ResizeObserver(requestSyncScrollState);
                resizeObserver.observe(container);
                container._scResizeObserver = resizeObserver;
            }

            if (typeof MutationObserver === 'function') {
                const mutationObserver = new MutationObserver(requestSyncScrollState);
                mutationObserver.observe(container, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
                container._scMutationObserver = mutationObserver;
            }

            requestSyncScrollState();
        }

        function getActivePaneScrollContainer() {
            if (uiState.activePane === 'history') return historyList;
            if (uiState.activePane === 'profile') return profileContent;
            if (uiState.activePane === 'chat') return messagesArea;
            return null;
        }

        function isScrollableOverflow(overflowValue = '') {
            return overflowValue === 'auto' || overflowValue === 'scroll' || overflowValue === 'overlay';
        }

        function canElementScroll(element) {
            if (!(element instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(element);
            const canScrollY = isScrollableOverflow(style.overflowY) && (element.scrollHeight - element.clientHeight) > 1;
            const canScrollX = isScrollableOverflow(style.overflowX) && (element.scrollWidth - element.clientWidth) > 1;
            return canScrollX || canScrollY;
        }

        function normalizeWheelDelta(delta, deltaMode, container, axis = 'y') {
            if (!delta) return 0;
            if (!(container instanceof HTMLElement)) return delta;

            if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
                const computed = window.getComputedStyle(container);
                const lineHeight = Number.parseFloat(computed.lineHeight) || 16;
                return delta * lineHeight;
            }

            if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
                const viewportSize = axis === 'x' ? container.clientWidth : container.clientHeight;
                return delta * (viewportSize || 1);
            }

            return delta;
        }

        function cancelSmoothWheelRouting(container) {
            if (!(container instanceof HTMLElement)) return;
            const state = container._scSmoothWheelRouting;
            if (!state) return;
            if (state.frameId) {
                cancelAnimationFrame(state.frameId);
                state.frameId = 0;
            }
            state.targetLeft = container.scrollLeft;
            state.targetTop = container.scrollTop;
        }

        function queueSmoothWheelScroll(container, deltaX = 0, deltaY = 0, { smooth = true } = {}) {
            if (!(container instanceof HTMLElement)) return false;

            const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

            let state = container._scSmoothWheelRouting;
            if (!state) {
                state = {
                    frameId: 0,
                    targetLeft: container.scrollLeft,
                    targetTop: container.scrollTop
                };
                container._scSmoothWheelRouting = state;
            }

            if (!state.frameId) {
                state.targetLeft = container.scrollLeft;
                state.targetTop = container.scrollTop;
            }

            const nextScrollLeft = clamp(state.targetLeft + deltaX, 0, maxScrollLeft);
            const nextScrollTop = clamp(state.targetTop + deltaY, 0, maxScrollTop);
            const hasPendingMovement = Math.abs(nextScrollLeft - container.scrollLeft) > ROUTED_WHEEL_SCROLL_SETTLE_PX
                || Math.abs(nextScrollTop - container.scrollTop) > ROUTED_WHEEL_SCROLL_SETTLE_PX
                || nextScrollLeft !== state.targetLeft
                || nextScrollTop !== state.targetTop;

            if (!hasPendingMovement) return false;

            state.targetLeft = nextScrollLeft;
            state.targetTop = nextScrollTop;

            if (!smooth || prefersReducedMotion()) {
                cancelSmoothWheelRouting(container);
                container.scrollTo({
                    left: nextScrollLeft,
                    top: nextScrollTop,
                    behavior: 'auto'
                });
                state.targetLeft = container.scrollLeft;
                state.targetTop = container.scrollTop;
                return true;
            }

            if (state.frameId) return true;

            const step = () => {
                const currentMaxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
                const currentMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
                state.targetLeft = clamp(state.targetLeft, 0, currentMaxScrollLeft);
                state.targetTop = clamp(state.targetTop, 0, currentMaxScrollTop);

                const remainingLeft = state.targetLeft - container.scrollLeft;
                const remainingTop = state.targetTop - container.scrollTop;
                const settledLeft = Math.abs(remainingLeft) <= ROUTED_WHEEL_SCROLL_SETTLE_PX;
                const settledTop = Math.abs(remainingTop) <= ROUTED_WHEEL_SCROLL_SETTLE_PX;

                const nextLeft = settledLeft
                    ? state.targetLeft
                    : container.scrollLeft + (remainingLeft * ROUTED_WHEEL_SCROLL_EASING);
                const nextTop = settledTop
                    ? state.targetTop
                    : container.scrollTop + (remainingTop * ROUTED_WHEEL_SCROLL_EASING);

                container.scrollTo({
                    left: nextLeft,
                    top: nextTop,
                    behavior: 'auto'
                });

                if (settledLeft && settledTop) {
                    state.frameId = 0;
                    container.scrollTo({
                        left: state.targetLeft,
                        top: state.targetTop,
                        behavior: 'auto'
                    });
                    return;
                }

                state.frameId = requestAnimationFrame(step);
            };

            state.frameId = requestAnimationFrame(step);
            return true;
        }

        function findWheelScrollContainer(event) {
            const path = typeof event.composedPath === 'function' ? event.composedPath() : [];

            for (const node of path) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.id === 'screenchat-host') break;
                if (canElementScroll(node)) return node;
            }

            return null;
        }

        function routeExtensionWheel(event) {
            if (uiState.mode !== 'open') return;
            if (activePanelInteraction) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const nativeScrollContainer = findWheelScrollContainer(event);
            if (nativeScrollContainer) return;

            const scrollContainer = getActivePaneScrollContainer();
            if (!(scrollContainer instanceof HTMLElement)) return;

            const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, scrollContainer, 'x');
            const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, scrollContainer, 'y');
            const didScroll = queueSmoothWheelScroll(scrollContainer, deltaX, deltaY, {
                smooth: event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
            });
            if (!didScroll) return;

            event.preventDefault();
            event.stopPropagation();
        }

        bindAutoHidingScrollbar(messagesArea);
        bindAutoHidingScrollbar(historyList);
        bindAutoHidingScrollbar(profileContent);
        bindHorizontalPromptScroller(quickPrompts);
        panel.addEventListener('wheel', routeExtensionWheel, { passive: false });

        async function validateAuthSessionWithBackend() {
            if (!isAuthenticated()) return false;
            try {
                const response = await apiFetch('/api/auth/me');
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to continue.');
                        return false;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to validate session'));
                }

                const payload = await response.json();
                const user = payload?.user && typeof payload.user === 'object' ? payload.user : null;
                if (!user?.id) {
                    requireAuthenticationUi('Please sign in again to continue.');
                    return false;
                }

                setAuthSession({
                    authToken: getAuthToken(),
                    refreshToken: getRefreshToken(),
                    user: {
                        id: user.id,
                        email: user.email || '',
                        fullName: user.fullName || '',
                        picture: user.picture || '',
                        emailVerified: !!user.emailVerified
                    }
                });
                syncProfileState(payload?.profile);
                profileLoadAttempted = true;
                refreshProfileNudgeVisibility();
                if (!conversationHistory.length) {
                    renderWelcomeMessage(true);
                }
                syncAuthUi();
                setAuthStatus('');
                return true;
            } catch (error) {
                console.warn('[Auth] Session validation failed:', error);
                requireAuthenticationUi('Please sign in with Google to continue.');
                return false;
            }
        }

        async function handleGoogleSignIn() {
            if (isAwaitingResponse) return;
            setGoogleSignInState(true);
            setAuthStatus('Complete Google sign-in in the Google window...', false);

            try {
                let nextSession = await beginHostedGoogleSignIn();
                setAuthStatus('Finalizing sign-in...', false);
                setAuthSession(nextSession);

                if (nextSession?.refreshToken) {
                    const refreshedSession = await requestRefreshedAuthSession(nextSession.refreshToken).catch((error) => {
                        console.warn('[Auth] Immediate session refresh failed:', error);
                        return null;
                    });
                    if (refreshedSession) {
                        nextSession = refreshedSession;
                        setAuthSession(nextSession);
                    } else {
                        setAuthSession(nextSession);
                    }
                }

                setAuthStatus('');
                syncAuthUi();

                startNewSession(true, true);
                await loadProfile();
                setActivePane('chat');
                setUiMode('open');
            } catch (error) {
                const authErrorMessage = isExtensionContextInvalidatedError(error)
                    ? EXTENSION_CONTEXT_RECOVERY_MESSAGE
                    : (getErrorMessage(error) || 'Google sign-in failed');
                setAuthStatus(authErrorMessage, true);
            } finally {
                setGoogleSignInState(false);
            }
        }

        if (googleSignInBtn) {
            googleSignInBtn.addEventListener('click', () => {
                handleGoogleSignIn();
            });
        }

        if (attachScreenToggle) {
            setAttachScreenEnabled(attachScreenEnabled);
            bindPressScale(attachScreenToggle);
            attachScreenToggle.addEventListener('click', () => {
                setAttachScreenEnabled(!attachScreenEnabled);
            });
        }

        const openPane = (pane) => {
            if (!isAuthenticated()) {
                setActivePane('auth');
                setAuthStatus('Please sign in with Google to continue.', false);
                return;
            }
            setUiMode('open');
            setActivePane(pane);
            if (pane === 'history') {
                loadHistory();
            }
        };

        if (launcherBtn) {
            launcherBtn.addEventListener('click', () => {
                openUiFromActivation();
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setUiMode('hidden');
            });
        }

        if (headerBackBtn) {
            headerBackBtn.addEventListener('click', () => {
                if (!isAuthenticated()) {
                    setActivePane('auth');
                    return;
                }
                setActivePane('chat');
            });
        }

        if (chatPaneBtn) chatPaneBtn.addEventListener('click', () => openPane('chat'));
        if (historyPaneBtn) historyPaneBtn.addEventListener('click', () => openPane('history'));
        if (profilePaneBtn) {
            profilePaneBtn.addEventListener('click', () => {
                if (!isAuthenticated()) {
                    setActivePane('auth');
                    setAuthStatus('Please sign in with Google to continue.', false);
                    return;
                }
                profileNudgeSkippedThisSession = true;
                refreshProfileNudgeVisibility();
                loadProfile();
                openPane('profile');
            });
        }
        if (historyBtn) historyBtn.addEventListener('click', () => openPane('history'));
        if (profileBtn) {
            profileBtn.addEventListener('click', () => {
                if (!isAuthenticated()) {
                    setActivePane('auth');
                    setAuthStatus('Please sign in with Google to continue.', false);
                    return;
                }
                profileNudgeSkippedThisSession = true;
                refreshProfileNudgeVisibility();
                loadProfile();
                openPane('profile');
            });
        }

        if (historySearchToggleBtn) {
            bindPressScale(historySearchToggleBtn);
            historySearchToggleBtn.addEventListener('click', () => {
                const shouldOpen = !historySearchOpen;
                historySearchOpen = shouldOpen;
                historyOpenMenuSessionId = '';
                if (!shouldOpen) {
                    historySearchQuery = '';
                    if (historySearchInput) {
                        historySearchInput.value = '';
                    }
                }
                renderHistoryList();
                if (shouldOpen) {
                    syncHistoryControls({ focusSearch: true });
                }
            });
        }

        if (historySearchInput) {
            historySearchInput.addEventListener('input', () => {
                historySearchQuery = historySearchInput.value || '';
                historyOpenMenuSessionId = '';
                renderHistoryList();
            });

            historySearchInput.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                if (historySearchQuery) {
                    historySearchQuery = '';
                    historySearchInput.value = '';
                    renderHistoryList();
                    return;
                }
                historySearchOpen = false;
                historyOpenMenuSessionId = '';
                renderHistoryList();
                historySearchToggleBtn?.focus();
            });
        }

        if (historyClearBtn) {
            bindPressScale(historyClearBtn);
            historyClearBtn.addEventListener('click', () => {
                clearAllHistory();
            });
        }

        if (historyCloseBtn) historyCloseBtn.addEventListener('click', () => openPane('chat'));
        if (profileCloseBtn) profileCloseBtn.addEventListener('click', () => openPane('chat'));
        syncHistoryControls();

        if (profileNudgeSkipBtn) {
            profileNudgeSkipBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                profileNudgeSkippedThisSession = true;
                refreshProfileNudgeVisibility();
            });
        }

        if (profileNudgeStopBtn) {
            profileNudgeStopBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                setProfileNudgeOptOut(true);
            });
        }

        async function loadProfile() {
            if (!isAuthenticated()) {
                userProfile = null;
                profileLoadAttempted = true;
                refreshProfileNudgeVisibility();
                return;
            }

            try {
                const response = await apiFetch('/api/profile');
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to access your profile.');
                        return;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to load profile'));
                }

                const data = await response.json();
                syncProfileState(data?.profile);
            } catch (e) {
                console.error('[Profile] Load error:', e);
            } finally {
                profileLoadAttempted = true;
                refreshProfileNudgeVisibility();
            }
        }

        setTimeout(() => {
            if (isAuthenticated() && !profileLoadAttempted) {
                loadProfile();
            }
        }, 500);

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
                    if (!isAuthenticated()) {
                        requireAuthenticationUi('Please sign in with Google to save your profile.');
                        throw new Error('Authentication required');
                    }

                    const response = await apiFetch('/api/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ profile })
                    });
                    if (!response.ok) {
                        if (isUnauthorizedResponse(response)) {
                            requireAuthenticationUi('Please sign in again to save your profile.');
                            throw new Error('Authentication required');
                        }
                        throw new Error(await getApiErrorMessage(response, 'Failed to save profile'));
                    }

                    const data = await response.json();
                    if (data.success) {
                        syncProfileState(data?.profile || profile);
                        profileLoadAttempted = true;
                        refreshProfileNudgeVisibility();
                        profileSaveBtn.textContent = 'Saved';
                        setTimeout(() => {
                            profileSaveBtn.textContent = 'Save';
                            profileSaveBtn.disabled = false;
                            openPane('chat');
                        }, 900);
                    } else {
                        throw new Error(data.error || 'Failed to save');
                    }
                } catch (e) {
                    if (e?.message === 'Authentication required') {
                        profileSaveBtn.textContent = 'Save';
                        profileSaveBtn.disabled = false;
                        return;
                    }
                    console.error('[Profile] Save error:', e);
                    profileSaveBtn.textContent = 'Error';
                    setTimeout(() => {
                        profileSaveBtn.textContent = 'Save';
                        profileSaveBtn.disabled = false;
                    }, 1500);
                }
            });
        }

        if (profileSignOutBtn) {
            setProfileSignOutState('idle');
            profileSignOutBtn.addEventListener('click', async () => {
                if (!isAuthenticated()) {
                    requireAuthenticationUi('Please sign in with Google to continue.');
                    return;
                }

                profileSignOutBtn.disabled = true;
                setProfileSignOutState('loading');
                if (profileSaveBtn) profileSaveBtn.disabled = true;

                try {
                    clearAuthSession();
                    persistProfileIdentity(null);
                    userProfile = null;
                    profileLoadAttempted = false;
                    hasLocalConversationMutation = false;
                    conversationHistory = [];
                    historySessions = [];
                    historySearchQuery = '';
                    historySearchOpen = false;
                    historyLoading = false;
                    historyErrorMessage = '';
                    historyRestoringSessionId = '';
                    historyDeletingSessionId = '';
                    historyClearingAll = false;
                    historyOpenMenuSessionId = '';
                    clearPersistedConversationState();

                    if (profileNameInput) profileNameInput.value = '';
                    if (profileNicknameInput) profileNicknameInput.value = '';
                    if (profileEmailInput) profileEmailInput.value = '';
                    if (profilePhoneInput) profilePhoneInput.value = '';
                    if (profileNotesInput) profileNotesInput.value = '';

                    setAuthStatus('Signed out.', false);
                    setProfileSignOutState('idle');
                    syncAuthUi();
                    setActivePane('auth');
                    setUiMode('open');
                } catch (error) {
                    console.warn('[Auth] Sign-out failed:', error);
                    setAuthStatus(error?.message || 'Google sign-out failed', true);
                    setProfileSignOutState('error');
                    setTimeout(() => {
                        setProfileSignOutState('idle');
                    }, 1200);
                } finally {
                    profileSignOutBtn.disabled = false;
                    if (profileSaveBtn) {
                        profileSaveBtn.disabled = false;
                    }
                }
            });
        }

        function getHistorySearchText(session = {}) {
            const parts = [
                formatHistoryPreview(session),
                session.lastMessagePreview,
                session.lastUserMessage,
                session.lastAssistantMessage,
                formatHistoryLocation(session.url),
                session.url
            ];

            return Array.from(new Set(parts.filter((value) => isNonEmptyString(value))))
                .join('\n')
                .toLowerCase();
        }

        function syncHistoryControls({ focusSearch = false } = {}) {
            if (historySearchWrap) {
                historySearchWrap.hidden = !historySearchOpen;
            }

            if (historySearchToggleBtn) {
                historySearchToggleBtn.classList.toggle('active', historySearchOpen || !!historySearchQuery.trim());
                historySearchToggleBtn.setAttribute('aria-expanded', historySearchOpen ? 'true' : 'false');
                historySearchToggleBtn.disabled = historyClearingAll;
                historySearchToggleBtn.setAttribute('title', historySearchOpen ? 'Hide search' : 'Search history');
                historySearchToggleBtn.setAttribute('aria-label', historySearchOpen ? 'Hide search' : 'Search history');
            }

            if (historySearchInput) {
                if (historySearchInput.value !== historySearchQuery) {
                    historySearchInput.value = historySearchQuery;
                }
                historySearchInput.disabled = historyLoading || historyClearingAll;
                if (focusSearch && historySearchOpen) {
                    requestAnimationFrame(() => {
                        historySearchInput.focus();
                        historySearchInput.select();
                    });
                }
            }

            if (historyClearBtn) {
                historyClearBtn.disabled = historyLoading || historyClearingAll || !historySessions.length;
                historyClearBtn.setAttribute('title', historyClearingAll ? 'Clearing history...' : 'Clear all conversations');
            }
        }

        function getFilteredHistorySessions() {
            const normalizedQuery = historySearchQuery.trim().toLowerCase();
            if (!normalizedQuery) {
                return historySessions;
            }

            return historySessions.filter((session) => getHistorySearchText(session).includes(normalizedQuery));
        }

        function renderHistoryState(message, className = 'sc-empty') {
            if (!historyList) return;
            historyList.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
        }

        function renderHistoryList() {
            syncHistoryControls();
            if (!historyList) return;

            if (!isAuthenticated()) {
                renderHistoryState('Sign in with Google to view history.');
                return;
            }

            if (historyClearingAll) {
                renderHistoryState('Clearing history...', 'sc-loading');
                return;
            }

            if (historyLoading) {
                renderHistoryState('Loading history...', 'sc-loading');
                return;
            }

            if (!historySessions.length) {
                renderHistoryState(historyErrorMessage || 'No history found.', historyErrorMessage ? 'sc-error' : 'sc-empty');
                return;
            }

            const filteredSessions = getFilteredHistorySessions();
            if (!filteredSessions.length) {
                renderHistoryState(historyErrorMessage || 'No conversations match your search.', historyErrorMessage ? 'sc-error' : 'sc-empty');
                return;
            }

            const historyChevronIconUrl = getUiSvgUrl('chevron-right.svg');
            historyList.innerHTML = '';

            if (historyErrorMessage) {
                const errorState = document.createElement('div');
                errorState.className = 'sc-error';
                errorState.textContent = historyErrorMessage;
                historyList.appendChild(errorState);
            }

            filteredSessions.forEach((session) => {
                const item = document.createElement('div');
                const isRestoreBusy = historyRestoringSessionId === session.id;
                const isDeleteBusy = historyDeletingSessionId === session.id;
                const isMenuOpen = historyOpenMenuSessionId === session.id || isDeleteBusy;
                const isBusy = historyClearingAll || isRestoreBusy || isDeleteBusy;
                const locationLabel = formatHistoryLocation(session.url);
                const titleLabel = locationLabel || 'Unknown page';
                const statusLabel = isDeleteBusy
                    ? 'Deleting conversation...'
                    : (isRestoreBusy ? 'Opening conversation...' : formatHistoryDate(session.updatedAt));

                item.className = `sc-history-item${isMenuOpen ? ' is-menu-open' : ''}`;

                const mainBtn = document.createElement('button');
                mainBtn.className = 'sc-history-main';
                mainBtn.type = 'button';
                mainBtn.disabled = isBusy;
                mainBtn.setAttribute('aria-label', 'Open conversation');

                const info = document.createElement('div');
                info.className = 'sc-history-info';

                const title = document.createElement('span');
                title.className = 'sc-history-domain';
                title.textContent = titleLabel;
                info.appendChild(title);

                const date = document.createElement('span');
                date.className = 'sc-history-date';
                date.textContent = statusLabel;
                info.appendChild(date);

                mainBtn.appendChild(info);
                mainBtn.addEventListener('click', () => {
                    restoreSession(session.id, session.url, session.updatedAt);
                });
                item.appendChild(mainBtn);

                const actions = document.createElement('div');
                actions.className = 'sc-history-actions';

                const menuBtn = document.createElement('button');
                menuBtn.className = `sc-history-open${isMenuOpen ? ' active' : ''}`;
                menuBtn.type = 'button';
                menuBtn.disabled = isBusy;
                menuBtn.setAttribute('aria-label', isMenuOpen ? 'Hide delete option' : 'Show delete option');
                menuBtn.setAttribute('aria-expanded', isMenuOpen ? 'true' : 'false');
                menuBtn.innerHTML = `
                    <img src="${historyChevronIconUrl}" class="sc-history-open-icon" alt="" aria-hidden="true">
                `;
                bindPressScale(menuBtn);
                menuBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    historyOpenMenuSessionId = isMenuOpen ? '' : session.id;
                    renderHistoryList();
                });
                actions.appendChild(menuBtn);

                if (isMenuOpen) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'sc-history-delete';
                    deleteBtn.type = 'button';
                    deleteBtn.disabled = isBusy;
                    deleteBtn.textContent = isDeleteBusy ? 'Deleting...' : 'Delete';
                    deleteBtn.setAttribute('aria-label', 'Delete this conversation');
                    bindPressScale(deleteBtn);
                    deleteBtn.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteHistorySession(session);
                    });
                    actions.appendChild(deleteBtn);
                }

                item.appendChild(actions);
                historyList.appendChild(item);
            });
        }

        async function loadHistory() {
            if (!historyList) return;

            if (!isAuthenticated()) {
                historySessions = [];
                historyErrorMessage = '';
                renderHistoryList();
                setActivePane('auth');
                return;
            }

            historyLoading = true;
            historyErrorMessage = '';
            historyOpenMenuSessionId = '';
            renderHistoryList();

            try {
                const response = await apiFetch(`/api/history?limit=${HISTORY_FETCH_LIMIT}`);
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to load history.');
                        historySessions = [];
                        historyErrorMessage = '';
                        renderHistoryList();
                        return;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to load history'));
                }

                const data = await response.json();
                historySessions = Array.isArray(data?.sessions) ? data.sessions : [];
            } catch (e) {
                console.error('[History] Load error:', e);
                historyErrorMessage = e?.message || 'Failed to load history.';
            } finally {
                historyLoading = false;
                renderHistoryList();
            }
        }

        async function restoreSession(sid, url, fallbackTimestamp = null) {
            if (!historyList || !sid || historyDeletingSessionId || historyClearingAll) return;
            if (!isAuthenticated()) {
                setActivePane('auth');
                return;
            }

            historyRestoringSessionId = sid;
            historyErrorMessage = '';
            historyOpenMenuSessionId = '';
            renderHistoryList();

            try {
                const response = await apiFetch(`/api/history/messages?sessionId=${encodeURIComponent(sid)}`);
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to restore this chat.');
                        return;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to restore session'));
                }
                const data = await response.json();

                if (!Array.isArray(data?.history)) {
                    throw new Error('History payload was invalid');
                }

                applyConversationState({
                    sessionId: data?.session?.id || sid,
                    sessionUrl: data?.session?.url || url || 'restored_session',
                    history: data.history,
                    updatedAt: data?.session?.updatedAt || fallbackTimestamp,
                    persist: true,
                    withTypewriter: false
                });
                openPane('chat');
            } catch (e) {
                console.error('[History] Restore failed:', e);
                historyErrorMessage = e?.message || 'Failed to restore this session.';
                renderHistoryList();
                addMessage('Failed to restore this session.', 'ai');
            } finally {
                historyRestoringSessionId = '';
                renderHistoryList();
            }
        }

        async function deleteHistorySession(session) {
            if (!session?.id || historyDeletingSessionId || historyRestoringSessionId || historyClearingAll) return;
            if (!isAuthenticated()) {
                setActivePane('auth');
                return;
            }

            const sessionLabel = formatHistoryLocation(session.url);
            const confirmationLabel = sessionLabel.length > 140
                ? `${sessionLabel.slice(0, 137)}...`
                : sessionLabel;
            if (!window.confirm(`Delete this conversation?\n\n${confirmationLabel}`)) {
                return;
            }

            historyDeletingSessionId = session.id;
            historyErrorMessage = '';
            renderHistoryList();

            try {
                const response = await apiFetch(`/api/history/session?sessionId=${encodeURIComponent(session.id)}`, {
                    method: 'DELETE'
                });
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to delete this conversation.');
                        return;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to delete conversation'));
                }

                historySessions = historySessions.filter((historySession) => historySession.id !== session.id);
                if (historyOpenMenuSessionId === session.id) {
                    historyOpenMenuSessionId = '';
                }
                if (sessionId === session.id) {
                    startNewSession(true, false);
                }
            } catch (e) {
                console.error('[History] Delete failed:', e);
                historyErrorMessage = e?.message || 'Failed to delete this conversation.';
            } finally {
                historyDeletingSessionId = '';
                renderHistoryList();
            }
        }

        async function clearAllHistory() {
            if (!historySessions.length || historyLoading || historyRestoringSessionId || historyDeletingSessionId || historyClearingAll) return;
            if (!isAuthenticated()) {
                setActivePane('auth');
                return;
            }

            if (!window.confirm('Delete all saved conversations?')) {
                return;
            }

            historyClearingAll = true;
            historyErrorMessage = '';
            historyOpenMenuSessionId = '';
            renderHistoryList();

            try {
                const response = await apiFetch('/api/history', { method: 'DELETE' });
                if (!response.ok) {
                    if (isUnauthorizedResponse(response)) {
                        requireAuthenticationUi('Please sign in again to clear your history.');
                        return;
                    }
                    throw new Error(await getApiErrorMessage(response, 'Failed to clear history'));
                }

                historySessions = [];
                historySearchQuery = '';
                historySearchOpen = false;
                if (historySearchInput) {
                    historySearchInput.value = '';
                }
                startNewSession(true, false);
            } catch (e) {
                console.error('[History] Clear failed:', e);
                historyErrorMessage = e?.message || 'Failed to clear history.';
            } finally {
                historyClearingAll = false;
                renderHistoryList();
            }
        }

        if (newChatBtn) {
            newChatBtn.addEventListener('click', () => {
                if (!isAuthenticated()) {
                    setActivePane('auth');
                    setAuthStatus('Please sign in with Google to continue.', false);
                    return;
                }
                if (uiState.activePane !== 'chat') {
                    setActivePane('chat');
                    return;
                }
                startNewSession(true, false);
            });
        }

        function resizeChatTextarea() {
            if (!textarea) return;
            const minHeight = 28;
            const maxHeight = 140;
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
        }

        textarea.addEventListener('input', () => {
            resizeChatTextarea();
        });

        resizeChatTextarea();

        function canContinueResponseRequest(requestId) {
            return activeResponseRequestId === requestId && !activeResponseStopRequested;
        }

        function assertResponseRequestCanContinue(requestId) {
            if (!canContinueResponseRequest(requestId)) {
                throw createAbortError();
            }
        }

        function finalizeResponseRequest(requestId, requestAbortController = null) {
            if (requestAbortController && currentAbortController === requestAbortController) {
                currentAbortController = null;
            }
            if (activeResponseRequestId !== requestId) {
                return false;
            }
            activeResponseRequestId = 0;
            activeResponseStopRequested = false;
            isAwaitingResponse = false;
            setInputState(true);
            syncQuickPromptsVisibility();
            return true;
        }

        function stopCurrentResponse(source = 'user') {
            if (!isAwaitingResponse || !activeResponseRequestId) return false;
            activeResponseStopRequested = true;
            const abortController = currentAbortController;
            currentAbortController = null;
            console.info('[Chat] Stop requested', {
                source,
                activeResponseRequestId,
                hadAbortController: !!abortController
            });
            if (abortController) {
                try {
                    abortController.abort();
                } catch (error) {
                    console.warn('[Chat] Stop request failed:', error);
                }
            }
            return true;
        }

        const handleSend = async ({ replaceActiveResponse = false, source = 'button' } = {}) => {
            if (!isAuthenticated()) {
                setActivePane('auth');
                setAuthStatus('Please sign in with Google to continue.', false);
                return;
            }

            const text = textarea.value.trim();
            if (isAwaitingResponse) {
                if (!text || !replaceActiveResponse) {
                    stopCurrentResponse(source);
                    return;
                }
                stopCurrentResponse(`${source}_replace`);
            }
            if (!text) return;

            textarea.value = '';
            resizeChatTextarea();
            hasLocalConversationMutation = true;

            const userMessageTimestamp = new Date().toISOString();
            const userMessageEl = addMessage(text, 'user', null, false, userMessageTimestamp, true);

            conversationHistory.push({ role: 'user', content: text, timestamp: userMessageTimestamp });
            sessionUpdatedAt = userMessageTimestamp;
            persistConversationState({ updatedAt: userMessageTimestamp });
            syncQuickPromptsVisibility();

            const requestId = ++responseRequestCounter;
            activeResponseRequestId = requestId;
            activeResponseStopRequested = false;
            isAwaitingResponse = true;
            setInputState(false, 'Working...');
            syncQuickPromptsVisibility();

            const loadingId = addLoadingMessage("Thinking...", true);
            let streamedMessageEl = null;
            let latestStreamText = '';
            let streamRenderPending = false;
            let streamCancelled = false;
            let requestTimedOut = false;
            let requestTimeoutId = null;
            let requestAbortController = null;

            const renderStreamMessage = () => {
                if (streamCancelled) return;
                if (!latestStreamText && !streamedMessageEl) return;
                if (!streamedMessageEl) {
                    removeMessage(loadingId);
                    streamedMessageEl = addMessage('', 'ai', null, true);
                }
                updateMessageContent(streamedMessageEl, latestStreamText, null, { allowPartial: true });
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

            const preservePartialResponse = () => {
                const partialResponseText = cleanAiReply(latestStreamText);
                if (!partialResponseText) {
                    removeMessage(loadingId);
                    return false;
                }

                removeMessage(loadingId);
                if (!streamedMessageEl) {
                    streamedMessageEl = addMessage('', 'ai', null, true);
                }
                updateMessageContent(streamedMessageEl, partialResponseText);
                const assistantMessageTimestamp = new Date().toISOString();
                setMessageTimestamp(streamedMessageEl, assistantMessageTimestamp);

                const partialAssistantEntry = {
                    role: 'assistant',
                    content: partialResponseText,
                    timestamp: assistantMessageTimestamp
                };
                const relatedUserMessageIndex = conversationHistory.findIndex((entry) => (
                    entry?.role === 'user' && entry?.timestamp === userMessageTimestamp
                ));
                if (relatedUserMessageIndex >= 0) {
                    conversationHistory.splice(relatedUserMessageIndex + 1, 0, partialAssistantEntry);
                } else {
                    conversationHistory.push(partialAssistantEntry);
                }
                sessionUpdatedAt = assistantMessageTimestamp;
                persistConversationState({ updatedAt: assistantMessageTimestamp });
                return true;
            };

            try {
                const messagesPayload = conversationHistory.map((msg) => {
                    const normalizedRole = normalizeConversationRole(msg?.role);
                    if (normalizedRole === 'user') {
                        return {
                            role: 'user',
                            content: cleanUserMessage(msg.content),
                            timestamp: msg.timestamp
                        };
                    }
                    if (normalizedRole === 'assistant') {
                        return {
                            role: 'assistant',
                            content: cleanAiReply(msg.content),
                            timestamp: msg.timestamp
                        };
                    }
                    return msg;
                });
                const activeTabUrl = await getActiveTabUrl();
                assertResponseRequestCanContinue(requestId);
                sessionUrl = activeTabUrl || window.location.href || sessionUrl;
                const messagesWithPageContext = attachCurrentPageUrlContext(messagesPayload, sessionUrl);

                let attachedImage = null;
                if (attachScreenEnabled) {
                    try {
                        attachedImage = await captureCurrentScreen();
                        assertResponseRequestCanContinue(requestId);
                        if (attachedImage && userMessageEl?.isConnected) {
                            updateMessageContent(userMessageEl, text, attachedImage, { forceScroll: true });
                        }
                    } catch {
                        // Keep the request going even if screenshot capture fails.
                    }
                }

                assertResponseRequestCanContinue(requestId);
                requestAbortController = new AbortController();
                currentAbortController = requestAbortController;
                assertResponseRequestCanContinue(requestId);

                const chatPayload = {
                    messages: messagesWithPageContext,
                    sessionId,
                    sessionUrl,
                    activeTabUrl,
                    profile: userProfile,
                    image: attachedImage,
                    clientContext: buildClientContext(sessionUrl)
                };

                const responseText = await Promise.race([
                    requestChatReply(chatPayload, {
                        signal: requestAbortController.signal,
                        onPartialText
                    }),
                    new Promise((_, reject) => {
                        requestTimeoutId = setTimeout(() => {
                            requestTimedOut = true;
                            try {
                                requestAbortController?.abort();
                            } catch {
                                // No-op.
                            }
                            const timeoutError = new Error('Request timed out');
                            timeoutError.name = 'TimeoutError';
                            reject(timeoutError);
                        }, CHAT_REQUEST_TIMEOUT_MS);
                    })
                ]);
                assertResponseRequestCanContinue(requestId);

                if (streamRenderPending) {
                    streamRenderPending = false;
                    renderStreamMessage();
                }
                removeMessage(loadingId);
                const assistantMessageTimestamp = new Date().toISOString();
                if (streamedMessageEl) {
                    updateMessageContent(streamedMessageEl, responseText);
                    setMessageTimestamp(streamedMessageEl, assistantMessageTimestamp);
                } else {
                    addMessage(responseText, 'ai', null, false, assistantMessageTimestamp);
                }
                if (requestTimeoutId) {
                    clearTimeout(requestTimeoutId);
                    requestTimeoutId = null;
                }

                conversationHistory.push({
                    role: 'assistant',
                    content: responseText,
                    timestamp: assistantMessageTimestamp
                });
                sessionUpdatedAt = assistantMessageTimestamp;
                persistConversationState({ updatedAt: assistantMessageTimestamp });
                finalizeResponseRequest(requestId, requestAbortController);
            } catch (backendErr) {
                if (requestTimeoutId) {
                    clearTimeout(requestTimeoutId);
                    requestTimeoutId = null;
                }
                streamCancelled = true;
                if (backendErr.name === 'AbortError' || backendErr.name === 'TimeoutError') {
                    const preservedPartialResponse = preservePartialResponse();
                    if (requestTimedOut && !preservedPartialResponse) {
                        addMessage(`Request timed out after ${Math.floor(CHAT_REQUEST_TIMEOUT_MS / 1000)} seconds. Please try again.`, 'ai');
                        conversationHistory.pop();
                        persistConversationState({ updatedAt: getLatestConversationTimestamp(conversationHistory) });
                    }
                    finalizeResponseRequest(requestId, requestAbortController);
                    return;
                }
                removeMessage(loadingId);
                finalizeResponseRequest(requestId, requestAbortController);
                const backendMessage = backendErr?.message || 'Unknown error';
                if (isAuthErrorMessage(backendMessage)) {
                    requireAuthenticationUi('Session expired. Please sign in again.');
                    addMessage('Your session expired. Sign in with Google to continue.', 'ai');
                    conversationHistory.pop();
                    persistConversationState({ updatedAt: getLatestConversationTimestamp(conversationHistory) });
                    syncQuickPromptsVisibility();
                    return;
                }
                const userError = backendMessage === 'Failed to fetch'
                    ? getUnreachableBackendMessage()
                    : `Request failed: ${backendMessage}`;
                addMessage(userError, 'ai');
                conversationHistory.pop();
                persistConversationState({ updatedAt: getLatestConversationTimestamp(conversationHistory) });
                syncQuickPromptsVisibility();
            }
        };

        quickPromptButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                textarea.value = btn.dataset.prompt || '';
                handleSend({ source: 'quick_prompt', replaceActiveResponse: true });
            });
        });

        sendBtn.addEventListener('click', () => {
            handleSend({ source: 'button', replaceActiveResponse: false });
        });

        const onEnter = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend({ source: 'enter', replaceActiveResponse: true });
            }
        };

        const isolateTypingFromPageShortcuts = (e) => {
            e.stopPropagation();
        };

        textarea.addEventListener('keydown', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keyup', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keypress', isolateTypingFromPageShortcuts);
        textarea.addEventListener('keydown', onEnter);

        if (isAuthenticated()) {
            validateAuthSessionWithBackend();
        } else {
            syncAuthUi();
        }
    }

    function sanitizeMarkdownUrl(rawUrl) {
        if (typeof rawUrl !== 'string') return null;
        const decodedUrl = decodeHtmlEntities(rawUrl).trim();
        if (!decodedUrl) return null;

        try {
            const parsed = new URL(decodedUrl, window.location.href);
            if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
            return escapeHtml(parsed.href);
        } catch {
            return null;
        }
    }

    function decodeHtmlEntities(text) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = text;
        return textarea.value;
    }

    function autoLinkTextOutsideTags(html) {
        if (!html) return '';
        return html
            .split(/(<[^>]+>)/g)
            .map((chunk) => {
                if (chunk.startsWith('<')) return chunk;
                return chunk.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,!?;:)]/g, (matchedUrl) => {
                    const safeHref = sanitizeMarkdownUrl(matchedUrl);
                    if (!safeHref) return matchedUrl;
                    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="sc-inline-link">${matchedUrl}</a>`;
                });
            })
            .join('');
    }

    function parseInlineMarkdown(rawText) {
        if (typeof rawText !== 'string' || !rawText) return '';

        const codeTokens = [];
        const tokenized = rawText.replace(/`([^`\n]+)`/g, (_, codeContent) => {
            const token = `%%SC_CODE_${codeTokens.length}%%`;
            codeTokens.push(`<code>${escapeHtml(codeContent)}</code>`);
            return token;
        });

        let html = escapeHtml(tokenized);

        html = html
            .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__([\s\S]+?)__/g, '<strong>$1</strong>')
            .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

        html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, rawHref) => {
            const safeHref = sanitizeMarkdownUrl(rawHref);
            if (!safeHref) return label;
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="sc-inline-link">${label}</a>`;
        });

        html = autoLinkTextOutsideTags(html);

        for (let idx = 0; idx < codeTokens.length; idx += 1) {
            const token = `%%SC_CODE_${idx}%%`;
            html = html.split(token).join(codeTokens[idx]);
        }

        return html;
    }

    function isMarkdownBlockBoundary(line) {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return /^#{1,6}\s+/.test(trimmed) ||
            /^```/.test(trimmed) ||
            /^>\s?/.test(trimmed) ||
            /^[-*+]\s+/.test(trimmed) ||
            /^\d+\.\s+/.test(trimmed) ||
            /^([-*_])\1{2,}$/.test(trimmed);
    }

    function parseMarkdownList(lines, startIndex, ordered = false) {
        const itemRegex = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        let idx = startIndex;

        while (idx < lines.length) {
            const line = lines[idx];
            const itemMatch = line.match(itemRegex);
            if (itemMatch) {
                items.push(itemMatch[1]);
                idx += 1;
                continue;
            }

            if (items.length && /^\s{2,}\S/.test(line)) {
                items[items.length - 1] += `\n${line.trim()}`;
                idx += 1;
                continue;
            }

            break;
        }

        const tag = ordered ? 'ol' : 'ul';
        const listHtml = items
            .map((itemText) => `<li>${parseInlineMarkdown(itemText).replace(/\n/g, '<br>')}</li>`)
            .join('');

        return {
            html: `<${tag}>${listHtml}</${tag}>`,
            nextIndex: idx
        };
    }

    function renderMarkdown(markdownText) {
        const source = typeof markdownText === 'string' ? markdownText : String(markdownText ?? '');
        const lines = source.replace(/\r\n?/g, '\n').split('\n');
        const blocks = [];
        let idx = 0;

        while (idx < lines.length) {
            const line = lines[idx];
            const trimmed = line.trim();

            if (!trimmed) {
                idx += 1;
                continue;
            }

            const fenceMatch = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
            if (fenceMatch) {
                const language = fenceMatch[1] ? fenceMatch[1].toLowerCase() : '';
                idx += 1;
                const codeLines = [];
                while (idx < lines.length && !lines[idx].trim().startsWith('```')) {
                    codeLines.push(lines[idx]);
                    idx += 1;
                }
                if (idx < lines.length) idx += 1;
                const className = language ? ` class="language-${escapeHtml(language)}"` : '';
                blocks.push(`<pre><code${className}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
                continue;
            }

            const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                blocks.push(`<h${level}>${parseInlineMarkdown(headingMatch[2])}</h${level}>`);
                idx += 1;
                continue;
            }

            if (/^>\s?/.test(trimmed)) {
                const quoteLines = [];
                while (idx < lines.length && /^>\s?/.test(lines[idx].trim())) {
                    quoteLines.push(lines[idx].replace(/^\s*>\s?/, ''));
                    idx += 1;
                }
                blocks.push(`<blockquote>${renderMarkdown(quoteLines.join('\n'))}</blockquote>`);
                continue;
            }

            if (/^[-*+]\s+/.test(trimmed)) {
                const list = parseMarkdownList(lines, idx, false);
                blocks.push(list.html);
                idx = list.nextIndex;
                continue;
            }

            if (/^\d+\.\s+/.test(trimmed)) {
                const list = parseMarkdownList(lines, idx, true);
                blocks.push(list.html);
                idx = list.nextIndex;
                continue;
            }

            if (/^([-*_])\1{2,}$/.test(trimmed)) {
                blocks.push('<hr>');
                idx += 1;
                continue;
            }

            const paragraphLines = [line.trimEnd()];
            idx += 1;
            while (idx < lines.length) {
                const paragraphCandidate = lines[idx];
                if (!paragraphCandidate.trim()) break;
                if (isMarkdownBlockBoundary(paragraphCandidate)) break;
                paragraphLines.push(paragraphCandidate.trimEnd());
                idx += 1;
            }

            const paragraphHtml = parseInlineMarkdown(paragraphLines.join('\n')).replace(/\n/g, '<br>');
            blocks.push(`<p>${paragraphHtml}</p>`);
        }

        return blocks.join('');
    }

    function renderPlainText(text) {
        const source = typeof text === 'string' ? text : String(text ?? '');
        const normalized = escapeHtml(source).replace(/\r\n?/g, '\n');
        return autoLinkTextOutsideTags(normalized).replace(/\n/g, '<br>');
    }

    function formatMessageContent(text, { enableMarkdown = true } = {}) {
        return enableMarkdown ? renderMarkdown(text) : renderPlainText(text);
    }

    function updateMessageContent(messageEl, text, imageUrl = null, { forceScroll = false, allowPartial = false } = {}) {
        if (!messageEl) return;
        const bubble = messageEl.querySelector('.sc-bubble');
        if (!bubble) return;
        const messagesArea = shadowRoot?.getElementById('sc-messages');
        const shouldAutoScroll = forceScroll || (
            messageEl.isConnected &&
            isElementNearScrollBottom(messagesArea)
        );

        const isAiMessage = messageEl.classList.contains('ai');
        const normalizedText = isAiMessage
            ? cleanAiReply(text, { allowPartial })
            : (typeof text === 'string' ? text : String(text ?? ''));
        const formattedText = formatMessageContent(normalizedText, { enableMarkdown: isAiMessage });
        bubble.innerHTML = formattedText;

        if (shouldAutoScroll) {
            scrollMessagesToBottom({ force: true });
        }
    }

    function addMessage(text, type, imageUrl = null, skipSave = false, timestamp = Date.now(), forceScroll = false) {
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const shouldAutoScroll = forceScroll || isElementNearScrollBottom(messagesArea);
        const msgDiv = document.createElement('div');
        msgDiv.className = `sc-message ${type}`;

        msgDiv.innerHTML = `
            <div class="sc-bubble">
            </div>
            <div class="sc-timestamp"></div>
        `;
        setMessageTimestamp(msgDiv, timestamp);
        updateMessageContent(msgDiv, text, imageUrl);

        messagesArea.appendChild(msgDiv);
        if (shouldAutoScroll) {
            scrollMessagesToBottom({ force: true });
        }
        syncQuickPromptsVisibility();
        return msgDiv;
    }

    function toggleUI() {
        if (!container) return;
        if (uiState.mode === 'hidden') {
            openUiFromActivation();
            return;
        }

        setUiMode('hidden');
    }

    function toggleUIFromHotkey() {
        if (!container) return;
        if (uiState.mode === 'open') {
            hotkeyLog('toggle_hotkey_close');
            setUiMode('hidden');
            return;
        }
        hotkeyLog('toggle_hotkey_open');
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
                    return true;
                }
            } else {
                stableCount = 0;
                lastHTML = currentHTML;
            }
        }

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

            const fieldCount = modalContent.querySelectorAll('input, textarea, select').length;
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
            includeForms = true,
            includeScrollable = true
        } = options;

        const context = {
            url: window.location.href,
            activeTabUrl: await getActiveTabUrl(),
            title: document.title
        };

        // Detect active context first
        const activeContext = detectActiveContext();
        context.activeContext = {
            type: activeContext.type,
            description: activeContext.description,
            selector: activeContext.containerSelector
        };

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
    function setInputState(enabled, placeholder = "Ask me anything...") {
        const textarea = shadowRoot.getElementById('sc-chat-input');
        const sendBtn = shadowRoot.getElementById('sc-send');
        const sendIcon = sendBtn?.querySelector('.sc-send-icon');
        if (textarea && sendBtn) {
            const isComposerInteractive = !!enabled || isAwaitingResponse;
            textarea.disabled = !isComposerInteractive;
            sendBtn.disabled = !isComposerInteractive;
            textarea.placeholder = getChatInputPlaceholder(placeholder);
            textarea.setAttribute('aria-busy', isAwaitingResponse ? 'true' : 'false');
            sendBtn.classList.toggle('is-stop', isAwaitingResponse);
            sendBtn.setAttribute('aria-label', getPrimaryActionControlLabel());
            sendBtn.setAttribute('title', getPrimaryActionTooltip());
            if (sendIcon) {
                sendIcon.src = getPrimaryActionIconUrl();
            }
            if (isComposerInteractive) {
                textarea.focus();
            }
        }
    }

    function addLoadingMessage(text = "Thinking...", forceScroll = false) {
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const shouldAutoScroll = forceScroll || isElementNearScrollBottom(messagesArea);
        const msgDiv = document.createElement('div');
        const id = 'loading-' + Date.now();
        msgDiv.id = id;
        msgDiv.className = 'sc-message ai loading-bubble';
        msgDiv.innerHTML = `
            <div class="sc-bubble" aria-label="${escapeHtml(text)}" role="status">
                <span class="sc-sr-only">${escapeHtml(text)}</span>
                <span class="sc-typing-indicator" aria-hidden="true">
                    <span class="sc-typing-dot"></span>
                    <span class="sc-typing-dot"></span>
                    <span class="sc-typing-dot"></span>
                </span>
            </div>
        `;
        messagesArea.appendChild(msgDiv);
        if (shouldAutoScroll) {
            scrollMessagesToBottom({ force: true });
        }
        return id;
    }

    function removeMessage(id) {
        if (!id) return;
        const el = shadowRoot.getElementById(id);
        if (el) el.remove();
    }

    init();
})();
