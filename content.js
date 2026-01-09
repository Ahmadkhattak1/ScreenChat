(() => {
    // Prevent multiple injections
    if (window.screenChatInjected) return;
    window.screenChatInjected = true;

    // ScreenChat Content Script

    // State
    let shadowRoot = null;
    let container = null;
    let isCapturing = false;
    let conversationHistory = [];
    let lastCapturedUrl = null;
    let currentScreenshot = null;
    let isExecutingActions = false;

    // Multi-step task state
    let currentTaskState = {
        inProgress: false,
        goal: null,
        stepsCompleted: 0,
        nextStep: null
    };

    // Action history for context continuity
    let actionHistory = [];
    const MAX_ACTION_HISTORY = 10;

    // Loop detection
    let recentActions = []; // Last few action signatures for loop detection
    const LOOP_DETECTION_WINDOW = 5;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    // Adaptive context mode
    let contextMode = 'full'; // 'full', 'viewport', 'dom_only'
    let lastPageState = null; // Track page state changes

    // Session State
    let sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    let sessionUrl = window.location.hostname || 'unknown';

    // Auth State
    let messageCount = 0;
    let authState = 'ANONYMOUS'; // ANONYMOUS, AWAIT_GOOGLE, AUTHENTICATED
    let tempUserData = { email: '', password: '' };
    let userId = 'user_' + Math.floor(Math.random() * 1000000);

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

    // Initialize
    function init() {
        // Cleanup existing
        const existing = document.getElementById('screenchat-host');
        if (existing) existing.remove();

        const host = document.createElement('div');
        host.id = 'screenchat-host';
        document.body.appendChild(host);

        shadowRoot = host.attachShadow({ mode: 'open' });

        // Inject Styles
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('content.css');
        shadowRoot.appendChild(link);

        // Create UI
        createUI();

        // Listen for messages
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'toggle_ui') {
                toggleUI();
            }
        });

        // Restore Session & Conversation History
        chrome.storage.local.get(['screenchat_user', 'conversationHistory', 'messageCount', 'sc_task_active'], (result) => {
            // Domain Check - Reset if new domain
            const currentDomain = window.location.hostname;
            if (result.sessionDomain && result.sessionDomain !== currentDomain) {
                console.log('New domain detected, starting new session.');
                startNewSession(false); // don't clear UI yet, init will do it
            } else if (result.screenchat_user) {
                // Restore existing session
                userId = result.screenchat_user.userId;
                authState = 'AUTHENTICATED';
                // ... (rest of restore logic)
            }

            // Save current domain
            chrome.storage.local.set({ sessionDomain: currentDomain });

            if (result.screenchat_user) {
                userId = result.screenchat_user.userId;
                authState = 'AUTHENTICATED';
            } else {
                if (result.messageCount) messageCount = result.messageCount;
            }

            if (result.conversationHistory && result.conversationHistory.length > 0 && (!result.sessionDomain || result.sessionDomain === currentDomain)) {
                conversationHistory = result.conversationHistory;
                // Re-render chat history
                const messagesArea = shadowRoot.getElementById('sc-messages');
                if (messagesArea) {
                    messagesArea.innerHTML = '';
                    conversationHistory.forEach(msg => {
                        addMessage(msg.content, msg.role === 'user' ? 'user' : 'ai', null, true);
                    });
                }
            }

            // Check for active multi-step task
            if (result.sc_task_active) {
                console.log('Resuming active task...');
                setTimeout(() => {
                    handleAutoContinue();
                }, 2000); // Wait a bit for page load
            }
        });
    }

    // Create UI Structure
    function createUI() {
        container = document.createElement('div');
        container.className = 'sc-container';

        container.innerHTML = `
            <div class="sc-header">
                <div class="sc-header-left">
                    <img src="${chrome.runtime.getURL('icons/icon48.png')}" class="sc-logo" alt="Logo">
                    <span class="sc-title">ScreenChat</span>
                </div>
                <div class="sc-controls">
                    <button class="sc-btn-icon" id="sc-new-chat" title="New Chat">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <a href="https://buymeacoffee.com/AhmadKhattak" target="_blank" class="sc-btn-icon" id="sc-coffee" title="Buy me a coffee">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                             <path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                             <path d="M6 1v3M10 1v3M14 1v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </a>
                    <button class="sc-btn-icon" id="sc-history-btn" title="History">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="sc-btn-icon" id="sc-minimize" title="Minimize">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 12H6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button class="sc-btn-icon" id="sc-position-toggle" title="Move to other side">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M7 16l-4-4m0 0l4-4m-4 4h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="sc-btn-icon" id="sc-close" title="Close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="sc-task-progress" id="sc-task-progress" style="display: none;">
                <div class="sc-task-info">
                    <span class="sc-task-label">Task in progress</span>
                    <span class="sc-task-steps" id="sc-task-steps">Step 1</span>
                </div>
                <div class="sc-task-next" id="sc-task-next"></div>
                <button class="sc-task-cancel" id="sc-task-cancel" title="Cancel task">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    Cancel
                </button>
            </div>

            <div class="sc-messages" id="sc-messages">
                <div class="sc-message ai">
                    <div class="sc-bubble">
                        Hello! I'm ScreenChat. Type a message below and I'll automatically capture this page for you.
                    </div>
                </div>
            </div>

            <div class="sc-history-view" id="sc-history-view">
                <div class="sc-history-header">
                    <h3>Chat History</h3>
                    <button class="sc-btn-icon" id="sc-history-close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="sc-history-list" id="sc-history-list">
                    <!-- History items will be injected here -->
                </div>
            </div>

            <div class="sc-input-area">
                <div class="sc-input-wrapper">
                    <!-- Standard Chat Input -->
                    <textarea class="sc-textarea" id="sc-chat-input" placeholder="Type a message..." rows="1"></textarea>
                    
                    <!-- Password Input (Hidden by default) -->
                    <input type="password" class="sc-password-input" id="sc-password-input" placeholder="Enter your password..." style="display: none;">
                </div>
                
                <!-- Google Button (Hidden by default, shown during auth) -->
                <button class="sc-google-btn" id="sc-google-btn" style="display: none;" title="Sign in with Google">
                    <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                        <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                </button>

                <button class="sc-send-btn" id="sc-send" title="Send (Enter)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
            </div>

            <div class="sc-resize-handle" id="sc-resize-handle"></div>
        `;

        // Load Icon
        container.style.setProperty('--icon-url', `url(${chrome.runtime.getURL('icons/icon48.png')})`);
        shadowRoot.appendChild(container);

        // Restore saved size and position
        chrome.storage.local.get(['sc_ui_width', 'sc_ui_height', 'sc_ui_position'], (result) => {
            if (result.sc_ui_width) container.style.width = result.sc_ui_width + 'px';
            if (result.sc_ui_height) container.style.height = result.sc_ui_height + 'px';
            if (result.sc_ui_position === 'left') {
                document.getElementById('screenchat-host').classList.add('sc-left');
            }
        });

        // Event Listeners
        setupEventListeners();
    }

    function setupEventListeners() {
        const minimizeBtn = shadowRoot.getElementById('sc-minimize');
        const closeBtn = shadowRoot.getElementById('sc-close');
        const newChatBtn = shadowRoot.getElementById('sc-new-chat');
        const sendBtn = shadowRoot.getElementById('sc-send');
        const textarea = shadowRoot.getElementById('sc-chat-input');
        const passwordInput = shadowRoot.getElementById('sc-password-input');
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const googleBtn = shadowRoot.getElementById('sc-google-btn');
        const taskCancelBtn = shadowRoot.getElementById('sc-task-cancel');
        const historyBtn = shadowRoot.getElementById('sc-history-btn');
        const historyView = shadowRoot.getElementById('sc-history-view');
        const closeHistoryBtn = shadowRoot.getElementById('sc-history-close');

        // History Toggle
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                historyView.classList.add('visible');
                loadHistory();
            });
        }

        if (closeHistoryBtn) {
            closeHistoryBtn.addEventListener('click', () => {
                historyView.classList.remove('visible');
            });
        }

        // Load History Logic
        async function loadHistory() {
            const listContainer = shadowRoot.getElementById('sc-history-list');
            listContainer.innerHTML = '<div class="sc-loading">Loading history...</div>';

            try {
                const response = await fetch(`http://localhost:3000/api/history?userId=${userId}`);
                const data = await response.json();

                if (data.sessions && data.sessions.length > 0) {
                    listContainer.innerHTML = '';
                    data.sessions.forEach(session => {
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

                        item.querySelector('.sc-history-open').addEventListener('click', () => restoreSession(session.id, session.url));
                        listContainer.appendChild(item);
                    });
                } else {
                    listContainer.innerHTML = '<div class="sc-empty">No history found.</div>';
                }
            } catch (e) {
                listContainer.innerHTML = '<div class="sc-error">Failed to load history.</div>';
            }
        }

        // Restore Session Logic
        async function restoreSession(sid, url) {
            const listContainer = shadowRoot.getElementById('sc-history-list');
            const originalContent = listContainer.innerHTML;
            listContainer.innerHTML = '<div class="sc-loading">Restoring chat...</div>';

            try {
                const response = await fetch(`http://localhost:3000/api/history/messages?userId=${userId}&sessionId=${sid}`);
                const data = await response.json();

                if (data.history) {
                    // 1. Update Session State
                    sessionId = sid;
                    sessionUrl = url || 'restored_session';
                    conversationHistory = data.history;

                    // 2. Clear & Re-render Messages
                    messagesArea.innerHTML = '';
                    conversationHistory.forEach(msg => {
                        // Messages are already cleaned by backend, but double-check
                        const content = msg.role === 'user' ? cleanUserMessage(msg.content) : cleanAiReply(msg.content);
                        if (content && content.toLowerCase() !== 'continue') {
                            addMessage(content, msg.role === 'user' ? 'user' : 'ai', null, true);
                        }
                    });

                    // 3. Close History View
                    historyView.classList.remove('visible');

                    // 4. Persist
                    chrome.storage.local.set({
                        conversationHistory: conversationHistory,
                        sessionDomain: window.location.hostname // We are effectively hijacking the current domain session
                    });

                }
            } catch (e) {
                console.error("Restore failed", e);
                listContainer.innerHTML = originalContent;
                alert("Failed to restore session.");
            }
        }

        // Position Toggle
        const positionToggleBtn = shadowRoot.getElementById('sc-position-toggle');
        if (positionToggleBtn) {
            positionToggleBtn.addEventListener('click', () => {
                const host = document.getElementById('screenchat-host');
                const isLeft = host.classList.toggle('sc-left');
                chrome.storage.local.set({ sc_ui_position: isLeft ? 'left' : 'right' });
            });
        }

        // Resize Handle
        const resizeHandle = shadowRoot.getElementById('sc-resize-handle');
        if (resizeHandle) {
            let isResizing = false;
            let startX, startY, startWidth, startHeight;

            resizeHandle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                startWidth = container.offsetWidth;
                startHeight = container.offsetHeight;
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const host = document.getElementById('screenchat-host');
                const isLeft = host.classList.contains('sc-left');

                let newWidth, newHeight;
                if (isLeft) {
                    newWidth = startWidth + (e.clientX - startX);
                } else {
                    newWidth = startWidth - (e.clientX - startX);
                }
                newHeight = startHeight - (e.clientY - startY);

                // Apply min/max constraints
                newWidth = Math.max(280, Math.min(600, newWidth));
                newHeight = Math.max(300, Math.min(window.innerHeight * 0.8, newHeight));

                container.style.width = newWidth + 'px';
                container.style.height = newHeight + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    // Save size
                    chrome.storage.local.set({
                        sc_ui_width: container.offsetWidth,
                        sc_ui_height: container.offsetHeight
                    });
                }
            });
        }

        // Cancel task button
        taskCancelBtn.addEventListener('click', cancelCurrentTask);

        // New Chat - Reset Session
        const startNewSession = () => {
            sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
            sessionUrl = window.location.hostname || 'unknown';
            conversationHistory = [];
            lastCapturedUrl = null;
            currentScreenshot = null;

            // Reset task state
            updateTaskProgressUI({ inProgress: false });

            // Clear storage
            chrome.storage.local.remove(['conversationHistory', 'sc_task_active']);

            // Reset UI
            messagesArea.innerHTML = `
                <div class="sc-message ai">
                    <div class="sc-bubble">
                        Hello! I'm ScreenChat. Type a message below and I'll automatically capture this page for you.
                    </div>
                </div>
            `;
        };

        newChatBtn.addEventListener('click', startNewSession);

        // Minimize / Expand
        const toggleMinimize = (e) => {
            if (e) e.stopPropagation();
            container.classList.toggle('minimized');
        };

        minimizeBtn.addEventListener('click', toggleMinimize);
        container.addEventListener('click', (e) => {
            if (container.classList.contains('minimized')) {
                toggleMinimize();
            }
        });

        closeBtn.addEventListener('click', () => { container.style.display = 'none'; });

        // Auto-resize textarea
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
        });

        // Google Poll Logic
        let pollInterval = null;

        const startPolling = () => {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const res = await fetch(`http://localhost:3000/api/auth/status?userId=${userId}`);
                    const data = await res.json();

                    if (data.linked) {
                        clearInterval(pollInterval);
                        authState = 'AUTHENTICATED';
                        // Use email as userId for better data organization
                        userId = data.email.replace(/[^a-zA-Z0-9]/g, '_');

                        addMessage(`Welcome, ${data.email}! 🎉 You're all set.`, 'ai');
                        chrome.storage.local.set({ 'screenchat_user': { userId, email: data.email } });

                        textarea.style.display = 'block';
                        textarea.placeholder = "Type a message...";
                        passwordInput.style.display = 'none';
                        googleBtn.style.display = 'none';
                    }
                } catch (e) {
                    // console.error("Poll", e);
                }
            }, 2000);
        };

        googleBtn.addEventListener('click', () => {
            const w = 500, h = 600;
            const left = (window.screen.width / 2) - (w / 2), top = (window.screen.height / 2) - (h / 2);
            const url = `https://screenchat-aca39.web.app/google-login.html?tempId=${userId}`;
            window.open(url, 'ScreenChat Google Login', `width=${w},height=${h},top=${top},left=${left}`);

            addMessage("I've opened a popup for Google Sign-In. Waiting for you...", 'ai');
            startPolling();
        });

        // Handler
        const handleSend = async () => {
            const text = textarea.value.trim();

            if (!text || isCapturing || isExecutingActions) return;

            textarea.value = '';
            textarea.style.height = 'auto';

            addMessage(text, 'user');

            // --- Auth Check (Google Only) ---
            // BYPASS for localhost testing
            const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            const bypassAuth = true; // Set to false for production

            if (!bypassAuth && authState === 'ANONYMOUS') {
                messageCount++;
                chrome.storage.local.set({ messageCount });
                if (messageCount > 2) {
                    authState = 'AWAIT_GOOGLE';
                    addGoogleSignInMessage();
                    return;
                }
            }

            if (!bypassAuth && authState === 'AWAIT_GOOGLE') {
                addMessage("Please sign in with Google to continue chatting.", 'ai');
                return;
            }
            // ---------------------------

            conversationHistory.push({ role: "user", content: text });
            chrome.storage.local.set({ conversationHistory });

            // Smart Screenshot Logic:
            // 1. First message of session (no screenshot yet)
            // 2. URL changed since last capture
            // 3. User explicitly asks for screenshot/capture/look/see/show
            const currentUrl = window.location.href;
            const needsScreenshot = !currentScreenshot ||
                currentUrl !== lastCapturedUrl ||
                /\b(screenshot|capture|look|see|show|page|screen|view)\b/i.test(text);

            let screenshotDataUrl = null;

            // UI: Disable input
            setInputState(false, 'Working...');

            if (needsScreenshot) {
                // Capture Flow
                isCapturing = true; // Use separate flag for screenshot logic if needed, or unify

                try {
                    container.style.display = 'none';
                    await sleep(100);

                    console.log('Capturing screenshot...');
                    screenshotDataUrl = await captureFullPage();
                    lastCapturedUrl = currentUrl;
                    currentScreenshot = screenshotDataUrl;

                    container.style.display = 'flex';
                } catch (err) {
                    console.error('Screenshot failed:', err);
                    container.style.display = 'flex';
                }
                isCapturing = false;
            } else {
                screenshotDataUrl = currentScreenshot;
            }

            // Show Loading Bubble
            const loadingId = addLoadingMessage();

            // Detect active context (modal, dialog, etc.) and extract fields
            const activeContext = detectActiveContext();
            const formFields = extractFormFields(activeContext);
            const domStructure = extractDOMStructure(activeContext);

            // Build rich context for the AI
            const buildContextString = () => {
                let ctx = `[Current Page: ${currentUrl}]`;

                // Active context (modal/dialog awareness)
                if (activeContext.type !== 'page') {
                    ctx += `\n[ACTIVE CONTEXT: ${activeContext.description}]`;
                    ctx += `\n[IMPORTANT: A ${activeContext.type} is currently open. Target elements INSIDE this ${activeContext.type}, not the background page.]`;
                    if (activeContext.containerSelector) {
                        ctx += `\n[${activeContext.type} selector: ${activeContext.containerSelector}]`;
                    }
                }

                // DOM Structure summary
                if (domStructure.headings.length > 0) {
                    ctx += `\n[Page headings: ${domStructure.headings.map(h => h.text).join(' > ')}]`;
                }

                // Form fields (only those in active context if modal is open)
                if (formFields.length > 0) {
                    const relevantFields = activeContext.type !== 'page'
                        ? formFields.filter(f => f.inActiveContext)
                        : formFields;

                    if (relevantFields.length > 0) {
                        ctx += `\n[Form Fields in ${activeContext.type !== 'page' ? activeContext.type : 'page'}: ${JSON.stringify(relevantFields)}]`;
                    }
                }

                // Key buttons/actions available
                if (domStructure.interactiveElements.length > 0) {
                    const relevantButtons = activeContext.type !== 'page'
                        ? domStructure.interactiveElements.filter(b => b.isInActiveContext)
                        : domStructure.interactiveElements.slice(0, 10);

                    if (relevantButtons.length > 0) {
                        ctx += `\n[Available actions: ${relevantButtons.map(b => `"${b.text}" (${b.selector})`).join(', ')}]`;
                    }
                }

                return ctx;
            };

            // Send to Backend with rich context
            const messagesPayload = conversationHistory.map((m, idx) => {
                if (idx === conversationHistory.length - 1 && m.role === 'user') {
                    return { role: 'user', content: `${buildContextString()}\n\n${m.content}` };
                }
                return m;
            });

            try {
                console.log('[ScreenChat] Sending request to backend...');
                console.log('[ScreenChat] URL:', 'http://localhost:3000/api/chat');
                console.log('[ScreenChat] Payload size:', JSON.stringify({ messages: messagesPayload, userId, sessionId, sessionUrl }).length);

                const response = await fetch('http://localhost:3000/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: messagesPayload,
                        image: screenshotDataUrl,
                        userId: userId,
                        sessionId: sessionId,
                        sessionUrl: sessionUrl,
                        screenshotType: 'full', // Default for initial connection
                        htmlSnapshot: domStructure ? getCleanedHTML(activeContext.container || document.body) : null
                    })
                });

                console.log('[ScreenChat] Response status:', response.status);
                if (!response.ok) throw new Error('Backend failed');
                const data = await response.json();

                // Remove Loading Bubble
                removeMessage(loadingId);

                // Parse structured response
                const parsed = parseStructuredResponse(data.reply);

                // Update task progress UI from backend taskState
                if (data.taskState) {
                    updateTaskProgressUI({
                        inProgress: data.taskState.inProgress,
                        goal: data.taskState.goal,
                        stepsCompleted: data.taskState.stepsCompleted || 0,
                        nextStep: data.taskState.nextStep || parsed.nextStep
                    });
                }

                // Store the raw response for context but show only the message
                conversationHistory.push({ role: "assistant", content: parsed.message });
                chrome.storage.local.set({ conversationHistory });
                addMessage(parsed.message, 'ai');

                if (parsed.status === 'complete') {
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                } else if (parsed.status === 'waiting_for_input') {
                    // AI needs more info from user - pause task but keep UI active
                    setInputState(true, "Type your response...");
                } else if (parsed.actions && parsed.actions.length > 0) {
                    // Task ongoing - set active flag
                    chrome.storage.local.set({ 'sc_task_active': true });
                    // Keep input disabled during actions
                    await executeActions(parsed.actions);

                    // SPA Support: If page doesn't reload, we need to continue manually
                    scheduleAutoContinue();
                } else {
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                }

            } catch (backendErr) {
                console.error('Backend error:', backendErr);
                removeMessage(loadingId);
                setInputState(true);
                updateTaskProgressUI({ inProgress: false });
                addMessage(`Error connecting to AI: ${backendErr.message}`, 'ai');
                conversationHistory.pop();
                chrome.storage.local.set({ conversationHistory });
                chrome.storage.local.remove(['sc_task_active']);
            }
        };

        const handleAutoContinue = async () => {
            // Check for loops BEFORE continuing
            const loopStatus = getLoopStatus();
            if (loopStatus.stuck) {
                console.warn('[ScreenChat] Loop detected:', loopStatus.message);
                addMessage(`I seem to be stuck (${loopStatus.message}). Let me try a different approach or please provide guidance.`, 'ai');
                setInputState(true, "Help me continue...");
                chrome.storage.local.remove(['sc_task_active']);
                updateTaskProgressUI({ inProgress: false });
                // Reset loop detection
                recentActions = [];
                consecutiveFailures = 0;
                return;
            }

            setInputState(false, 'Analyzing results...');

            // Brief stabilization wait (shorter than before - we use viewport now)
            await sleep(800);

            const loadingId = addLoadingMessage("Checking progress...");

            // Use ADAPTIVE context - viewport screenshot by default, much faster
            let context;
            try {
                container.style.display = 'none';
                await sleep(100);

                // Build adaptive context with viewport screenshot (not full page!)
                context = await buildAdaptiveContext({
                    includeScreenshot: true,
                    screenshotMode: 'viewport', // KEY: viewport only, not full page
                    includeDOM: true,
                    includeForms: true,
                    includeScrollable: true,
                    includeActionHistory: true
                });

                container.style.display = 'flex';
            } catch (e) {
                console.error("Context build failed", e);
                container.style.display = 'flex';
                removeMessage(loadingId);
                setInputState(true);
                updateTaskProgressUI({ inProgress: false });
                chrome.storage.local.remove(['sc_task_active']);
                return;
            }

            // Format context for AI message
            const contextMessage = formatContextForAI(context);

            // Construct messages payload
            const messagesPayload = [...conversationHistory];

            // Append continuation with rich context
            messagesPayload.push({
                role: "user",
                content: `${contextMessage}\n\ncontinue`
            });

            try {
                console.log('[ScreenChat] Continuing with viewport context...');
                const response = await fetch('http://localhost:3000/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: messagesPayload,
                        image: context.screenshot,
                        userId: userId,
                        sessionId: sessionId,
                        sessionUrl: sessionUrl,
                        screenshotType: context.screenshotType, // Tell backend what kind of screenshot this is
                        htmlSnapshot: context.htmlSnapshot
                    })
                });

                if (!response.ok) throw new Error('Backend failed');
                const data = await response.json();

                removeMessage(loadingId);

                const parsed = parseStructuredResponse(data.reply);

                // Update task progress UI
                if (data.taskState) {
                    updateTaskProgressUI({
                        inProgress: data.taskState.inProgress,
                        goal: data.taskState.goal,
                        stepsCompleted: data.taskState.stepsCompleted || 0,
                        nextStep: data.taskState.nextStep || parsed.nextStep
                    });
                }

                // Add reply to history
                conversationHistory.push({ role: "assistant", content: parsed.message });
                chrome.storage.local.set({ conversationHistory });
                addMessage(parsed.message, 'ai');

                if (parsed.status === 'complete') {
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                    // Reset tracking
                    actionHistory = [];
                    recentActions = [];
                } else if (parsed.status === 'waiting_for_input') {
                    setInputState(true, "Type your response...");
                } else if (parsed.status === 'stuck' || parsed.status === 'failed') {
                    // AI acknowledged being stuck
                    setInputState(true, "Help me continue...");
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                } else if (parsed.actions && parsed.actions.length > 0) {
                    chrome.storage.local.set({ 'sc_task_active': true });

                    // Execute actions and get results
                    const execResult = await executeActions(parsed.actions);

                    // Check if we're now stuck in a loop
                    if (execResult.loopDetected) {
                        addMessage("I notice I'm repeating the same action. Let me reassess...", 'ai');
                        // Still schedule continue but with longer delay
                        setTimeout(() => scheduleAutoContinue(), 2000);
                    } else if (execResult.anySuccess) {
                        // Continue with shorter delay since we made progress
                        scheduleAutoContinue();
                    } else {
                        // No successful actions - might be stuck
                        consecutiveFailures++;
                        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                            addMessage("Having trouble finding the elements. Could you help guide me?", 'ai');
                            setInputState(true, "Provide guidance...");
                            chrome.storage.local.remove(['sc_task_active']);
                        } else {
                            scheduleAutoContinue();
                        }
                    }
                } else {
                    // No actions and not complete - might need full page view
                    // Request a full screenshot on next iteration
                    contextMode = 'full';
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                }

            } catch (e) {
                console.error("Auto-continue failed", e);
                removeMessage(loadingId);
                setInputState(true);
                updateTaskProgressUI({ inProgress: false });
                chrome.storage.local.remove(['sc_task_active']);
                addMessage("Task paused due to error: " + e.message, 'ai');
            }
        };

        // SPA Continuation Logic
        let continueTimeout = null;
        function scheduleAutoContinue() {
            if (continueTimeout) clearTimeout(continueTimeout);
            continueTimeout = setTimeout(() => {
                // Check if still active (page didn't reload, user didn't cancel)
                chrome.storage.local.get(['sc_task_active'], (res) => {
                    if (res.sc_task_active) {
                        console.log('SPA navigation detected (timeout) - continuing task...');
                        handleAutoContinue();
                    }
                });
            }, 4000); // 4 seconds delay for animations/modals
        }

        sendBtn.addEventListener('click', handleSend);

        const onEnter = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        };

        textarea.addEventListener('keydown', onEnter);
        passwordInput.addEventListener('keydown', onEnter);

        // Function to add inline Google Sign-In button in chat
        function addGoogleSignInMessage() {
            const messagesArea = shadowRoot.getElementById('sc-messages');
            const msgDiv = document.createElement('div');
            msgDiv.className = 'sc-message ai';

            msgDiv.innerHTML = `
                <div class="sc-bubble">
                    <p style="margin: 0 0 12px 0;">To continue our awesome chat, please sign in:</p>
                    <button class="sc-google-signin-btn" style="
                        background: #4285F4;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 6px;
                        font-size: 14px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-family: inherit;
                    ">
                        <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
                            <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                            <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        Sign in with Google
                    </button>
                </div>
            `;

            messagesArea.appendChild(msgDiv);
            messagesArea.scrollTop = messagesArea.scrollHeight;

            // Attach click handler
            const btn = msgDiv.querySelector('.sc-google-signin-btn');
            btn.addEventListener('click', () => {
                const w = 500, h = 600;
                const left = (window.screen.width / 2) - (w / 2), top = (window.screen.height / 2) - (h / 2);
                const url = `https://screenchat-aca39.web.app/google-login.html?tempId=${userId}`;
                window.open(url, 'ScreenChat Google Login', `width=${w},height=${h},top=${top},left=${left}`);

                addMessage("Opened Google Sign-In popup. Waiting for you...", 'ai');
                startPolling();
            });
        }
    }

    function addMessage(text, type, imageUrl = null, skipSave = false) {
        const messagesArea = shadowRoot.getElementById('sc-messages');
        const msgDiv = document.createElement('div');
        msgDiv.className = `sc-message ${type}`;

        let attachmentHtml = '';
        if (imageUrl) {
            attachmentHtml = `<div class="sc-attachment"><img src="${imageUrl}" alt="Screenshot"></div>`;
        }

        // Parse Markdown (Basic)
        let formattedText = escapeHtml(text)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.*?)__/g, '<u>$1</u>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>');

        // basic linkify
        formattedText = formattedText.replace(
            /(https?:\/\/[^\s]+)/g,
            '<a href="$1" target="_blank" style="color: inherit; text-decoration: underline;">$1</a>'
        );

        msgDiv.innerHTML = `
            <div class="sc-bubble">
                ${formattedText}
                ${attachmentHtml}
            </div>
            <div class="sc-timestamp">Just now</div>
        `;

        messagesArea.appendChild(msgDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }

    function toggleUI() {
        if (!container) return;
        if (container.style.display === 'none') {
            container.style.display = 'flex';
            container.classList.remove('minimized');
        } else {
            container.style.display = 'none';
        }
    }

    // --- Screenshot Logic ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function captureFullPage() {
        const showToast = (msg) => {
            let el = document.getElementById('screenchat-loading-toast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'screenchat-loading-toast';
                el.style.cssText = `
                    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                    background: rgba(0,0,0,0.8); color: white; padding: 10px 20px;
                    border-radius: 20px; font-family: sans-serif; z-index: 2147483647;
                    font-size: 14px; pointer-events: none;
                `;
                document.body.appendChild(el);
            }
            el.textContent = msg;
        };
        const removeToast = () => {
            const el = document.getElementById('screenchat-loading-toast');
            if (el) el.remove();
        };

        try {
            showToast('Analyzing full page...');
            const findBestScrollTarget = () => {
                const all = document.querySelectorAll('*');
                let best = null;
                let maxScroll = 0;
                if (document.documentElement.scrollHeight > window.innerHeight) {
                    return { type: 'window', el: window, width: window.innerWidth, height: document.documentElement.scrollHeight };
                }
                for (const el of all) {
                    if (el.scrollHeight > el.clientHeight && el.scrollHeight > maxScroll && el.clientHeight > 0) {
                        const s = window.getComputedStyle(el);
                        if (s.overflowY === 'scroll' || s.overflowY === 'auto') {
                            maxScroll = el.scrollHeight;
                            best = el;
                        }
                    }
                }
                if (best) return { type: 'element', el: best, width: best.clientWidth, height: best.scrollHeight };
                return { type: 'window', el: window, width: window.innerWidth, height: document.documentElement.scrollHeight };
            };

            const target = findBestScrollTarget();
            const viewportH = window.innerHeight;
            const totalHeight = target.height;
            const maxScroll = Math.ceil(totalHeight / viewportH);
            let bgColor = window.getComputedStyle(document.body).backgroundColor;
            if (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') bgColor = '#ffffff';

            const bottomFixed = [], otherFixed = [];
            const classifyFixedElements = () => {
                const all = [];
                const stack = [document];
                while (stack.length > 0) {
                    const root = stack.pop();
                    try {
                        const children = root.querySelectorAll('*');
                        for (const el of children) {
                            all.push(el);
                            if (el.shadowRoot) stack.push(el.shadowRoot);
                        }
                    } catch (e) { }
                }
                const addToFixed = (el) => {
                    if (el.id === 'screenchat-host' || el.id === 'screenchat-loading-toast') return;
                    if ([...bottomFixed, ...otherFixed].some(x => x.el === el)) return;
                    const rect = el.getBoundingClientRect();
                    const windowHeight = window.innerHeight;
                    const isAtBottom = rect.top > windowHeight * 0.7;
                    const isBottomPinned = Math.abs(rect.bottom - windowHeight) < 20 && rect.height < windowHeight * 0.8;
                    if (isAtBottom || isBottomPinned) {
                        bottomFixed.push({ el, original: el.style.visibility });
                        el.style.visibility = 'hidden';
                    } else {
                        otherFixed.push({ el, original: el.style.visibility });
                    }
                };
                for (const el of all) {
                    const s = window.getComputedStyle(el);
                    if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
                        addToFixed(el);
                    }
                }
            };
            classifyFixedElements();

            const style = document.createElement('style');
            style.id = 'screenchat-hide-scroll';
            style.textContent = `::-webkit-scrollbar { display: none !important; } body { -ms-overflow-style: none !important; scrollbar-width: none !important; }`;
            document.head.appendChild(style);

            const dpr = window.devicePixelRatio || 1;
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = window.innerWidth * dpr;
            canvas.height = totalHeight * dpr;
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            let currentY = 0;
            for (let i = 0; i < maxScroll; i++) {
                showToast(`Analyzing section ${i + 1} of ${maxScroll}...`);
                if (target.type === 'window') window.scrollTo(0, currentY); else target.el.scrollTop = currentY;
                await sleep(400);

                if (i > 0) { otherFixed.forEach(item => item.el.style.visibility = 'hidden'); if (i === 1) await sleep(100); }
                if (i === maxScroll - 1 && i > 0) { bottomFixed.forEach(item => item.el.style.visibility = item.original); await sleep(150); }

                const toastEl = document.getElementById('screenchat-loading-toast');
                if (toastEl) toastEl.style.visibility = 'hidden';
                await sleep(100);

                const dataUrl = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ action: 'capture_tab' }, (response) => { resolve(response && response.dataUrl); });
                });
                if (toastEl) toastEl.style.visibility = 'visible';
                if (!dataUrl) throw new Error('Capture failed');

                const img = await new Promise((resolve) => {
                    const i = new Image();
                    i.onload = () => resolve(i);
                    i.src = dataUrl;
                });

                const actualY = target.type === 'window' ? window.scrollY : target.el.scrollTop;
                const scale = img.naturalWidth / window.innerWidth;
                const yOffsetCSS = currentY - actualY;
                const srcY = yOffsetCSS * scale;
                const remainingHeightCSS = totalHeight - currentY;
                const hToDrawCSS = Math.min(viewportH, remainingHeightCSS);
                const srcH = hToDrawCSS * scale;
                const destY = currentY * scale;

                if (srcY >= 0 && srcH > 0 && (srcY + srcH) <= img.naturalHeight + 1) {
                    ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH, 0, destY, canvas.width, srcH);
                }
                currentY += viewportH;
            }
            bottomFixed.forEach(item => item.el.style.visibility = item.original);
            otherFixed.forEach(item => item.el.style.visibility = item.original);
            if (target.type === 'window') window.scrollTo(0, 0); else target.el.scrollTop = 0;
            style.remove();
            removeToast();
            return canvas.toDataURL('image/jpeg', 0.6); // JPEG 60%
        } catch (e) {
            removeToast();
            const style = document.getElementById('screenchat-hide-scroll');
            if (style) style.remove();
            console.error('Capture error:', e);
            throw e;
        }
    }

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

    // --- Viewport-only Screenshot ---
    // Captures just the visible area instead of full page stitching
    async function captureViewport() {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'capture_tab', format: 'jpeg', quality: 60 }, (response) => {
                if (response && response.dataUrl) {
                    resolve(response.dataUrl);
                } else {
                    reject(new Error('Viewport capture failed'));
                }
            });
        });
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

    // --- Action History Management ---
    function recordAction(action, result, pageStateBefore, pageStateAfter) {
        const record = {
            action: {
                type: action.type,
                selector: action.selector,
                value: action.value
            },
            result: result, // 'success', 'failed', 'element_not_found'
            stateChanged: hasPageStateChanged(pageStateBefore, pageStateAfter),
            timestamp: Date.now()
        };

        actionHistory.push(record);
        if (actionHistory.length > MAX_ACTION_HISTORY) {
            actionHistory.shift();
        }

        // Also track for loop detection
        const actionSignature = `${action.type}:${action.selector}`;
        recentActions.push(actionSignature);
        if (recentActions.length > LOOP_DETECTION_WINDOW) {
            recentActions.shift();
        }

        return record;
    }

    // --- Loop Detection ---
    function isStuckInLoop() {
        if (recentActions.length < 3) return false;

        // Check if last 3+ actions are identical
        const lastAction = recentActions[recentActions.length - 1];
        let repeatCount = 0;
        for (let i = recentActions.length - 1; i >= 0; i--) {
            if (recentActions[i] === lastAction) {
                repeatCount++;
            } else {
                break;
            }
        }

        return repeatCount >= 3;
    }

    function getLoopStatus() {
        if (isStuckInLoop()) {
            return {
                stuck: true,
                repeatedAction: recentActions[recentActions.length - 1],
                message: `Repeating same action ${recentActions.filter(a => a === recentActions[recentActions.length - 1]).length} times`
            };
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            return {
                stuck: true,
                message: `${consecutiveFailures} consecutive action failures`
            };
        }

        return { stuck: false };
    }

    // --- Build Action History Context for AI ---
    function getActionHistoryContext() {
        if (actionHistory.length === 0) return '';

        const recent = actionHistory.slice(-3); // Last 3 actions
        const lines = recent.map((record, idx) => {
            const actionDesc = `${record.action.type}${record.action.value ? `("${record.action.value}")` : ''} on ${record.action.selector}`;
            const resultDesc = record.result === 'success'
                ? (record.stateChanged ? 'succeeded, page changed' : 'succeeded, no visible change')
                : `failed: ${record.result}`;
            return `  ${idx + 1}. ${actionDesc} → ${resultDesc}`;
        });

        return `[Recent Actions:\n${lines.join('\n')}]`;
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
            includeScreenshot = true,
            screenshotMode = 'viewport', // 'viewport', 'full', 'element'
            elementSelector = null,
            includeDOM = true,
            includeForms = true,
            includeScrollable = true,
            includeActionHistory = true
        } = options;

        const context = {
            url: window.location.href,
            title: document.title,
            screenshot: null,
            screenshotType: null,
            htmlSnapshot: null,
        };

        // Detect active context first
        const activeContext = detectActiveContext();
        context.activeContext = {
            type: activeContext.type,
            description: activeContext.description,
            selector: activeContext.containerSelector
        };

        // Screenshot based on mode
        if (includeScreenshot) {
            try {
                if (screenshotMode === 'viewport' || activeContext.type !== 'page') {
                    // For modals or viewport mode, just capture visible area
                    context.screenshot = await captureViewport();
                    context.screenshotType = 'viewport';
                } else if (screenshotMode === 'full') {
                    context.screenshot = await captureFullPage();
                    context.screenshotType = 'full';
                } else if (screenshotMode === 'element' && elementSelector) {
                    // For element-specific, still use viewport but note the focus
                    context.screenshot = await captureViewport();
                    context.screenshotType = 'viewport';
                    context.focusElement = elementSelector;
                }
            } catch (e) {
                console.error('[Context] Screenshot failed:', e);
            }
        }

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

        // Action history
        if (includeActionHistory && actionHistory.length > 0) {
            context.actionHistory = getActionHistoryContext();
        }

        // Loop status
        const loopStatus = getLoopStatus();
        if (loopStatus.stuck) {
            context.stuckWarning = loopStatus.message;
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

        if (context.activeContext.type !== 'page') {
            msg += `\n[ACTIVE: ${context.activeContext.description}]`;
            msg += `\n[Target elements INSIDE this ${context.activeContext.type}]`;
        }

        if (context.stuckWarning) {
            msg += `\n[WARNING: ${context.stuckWarning} - try a different approach]`;
        }

        if (context.actionHistory) {
            msg += `\n${context.actionHistory}`;
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

    // --- Parse Structured Response ---
    function parseStructuredResponse(reply) {
        try {
            // Try to parse as JSON first
            const parsed = JSON.parse(reply);
            return {
                message: parsed.message || reply,
                actions: parsed.actions || [],
                status: parsed.status || null,
                nextStep: parsed.nextStep || null,
                verification: parsed.verification || null
            };
        } catch (e) {
            // Try to extract JSON from within the text
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        message: parsed.message || reply,
                        actions: parsed.actions || [],
                        status: parsed.status || null,
                        nextStep: parsed.nextStep || null,
                        verification: parsed.verification || null
                    };
                } catch (e2) {
                    // Fall through
                }
            }
            // Return as plain message
            return { message: reply, actions: [], status: null, nextStep: null, verification: null };
        }
    }

    // --- Execute Actions ---
    async function executeActions(actions) {
        if (isExecutingActions) return { results: [], anySuccess: false };
        isExecutingActions = true;

        const actionResults = [];
        let anySuccess = false;

        // Capture page state BEFORE actions
        const pageStateBefore = getPageStateSignature();

        for (const action of actions) {
            // Capture state before this specific action
            const actionStateBefore = getPageStateSignature();

            try {
                await sleep(300); // Small delay between actions for visual feedback

                let success = false;
                let el = null;

                // Handle actions that don't need an element
                if (action.type === 'scroll_page') {
                    // Scroll the main page
                    const scrollAmount = action.amount || 400;
                    if (action.direction === 'up') {
                        window.scrollBy(0, -scrollAmount);
                    } else {
                        window.scrollBy(0, scrollAmount);
                    }
                    await sleep(300);
                    success = true;
                } else if (action.type === 'scroll_in') {
                    // Scroll within a specific container
                    el = document.querySelector(action.selector);
                    if (el) {
                        const scrollAmount = action.amount || 200;
                        if (action.direction === 'up') {
                            el.scrollTop -= scrollAmount;
                        } else {
                            el.scrollTop += scrollAmount;
                        }
                        await sleep(300);
                        success = true;
                        console.log(`[Action] Scrolled ${action.direction} in ${action.selector}`);
                    } else {
                        console.warn(`[Action] Scroll container not found: ${action.selector}`);
                    }
                } else if (action.type === 'wait') {
                    const duration = action.duration || 1000;
                    await sleep(duration);
                    success = true;
                } else if (action.type === 'observe') {
                    // Just observe - no action needed, triggers context refresh
                    success = true;
                    console.log('[Action] Observe - refreshing context');
                } else {
                    // Actions that need an element
                    el = await findElementWithRetry(action.selector, action.type);

                    if (!el) {
                        console.warn(`[Action] Element not found: ${action.selector}`);
                        const actionStateAfter = getPageStateSignature();
                        recordAction(action, 'element_not_found', actionStateBefore, actionStateAfter);
                        consecutiveFailures++;
                        actionResults.push({ action, success: false, error: 'Element not found' });
                        continue;
                    }

                    console.log(`[Action] ${action.type} on:`, el, 'selector:', action.selector);

                    switch (action.type) {
                        case 'fill':
                            highlightElement(el);
                            el.focus();
                            el.value = '';
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.value = action.value;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                            // For contenteditable divs
                            if (el.getAttribute('contenteditable') === 'true') {
                                el.textContent = action.value;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                            }
                            success = el.value === action.value || el.textContent === action.value;
                            break;

                        case 'click':
                            highlightElement(el);
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            await sleep(150);
                            el.click();
                            success = true;
                            break;

                        case 'select':
                            highlightElement(el);
                            el.value = action.value;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            success = el.value === action.value;
                            break;

                        case 'check':
                            highlightElement(el);
                            el.checked = action.checked !== false;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            success = el.checked === (action.checked !== false);
                            break;

                        case 'scroll':
                            // Legacy scroll action (whole page)
                            const scrollAmt = action.amount || 300;
                            if (action.direction === 'up') {
                                window.scrollBy(0, -scrollAmt);
                            } else {
                                window.scrollBy(0, scrollAmt);
                            }
                            await sleep(300);
                            success = true;
                            break;

                        case 'submit':
                            // Submit a form
                            const form = el.closest('form') || el;
                            if (form.submit) {
                                form.submit();
                            } else {
                                el.click();
                            }
                            success = true;
                            break;

                        case 'press_enter':
                            // Press Enter key on element
                            highlightElement(el);
                            el.focus();
                            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                            success = true;
                            break;

                        default:
                            console.warn(`Unknown action type: ${action.type}`);
                    }
                }

                // Record action with state change detection
                const actionStateAfter = getPageStateSignature();
                const stateChanged = hasPageStateChanged(actionStateBefore, actionStateAfter);

                if (success) {
                    consecutiveFailures = 0;
                    anySuccess = true;
                    recordAction(action, 'success', actionStateBefore, actionStateAfter);
                    console.log(`[Action] Success, state changed: ${stateChanged}`);
                } else {
                    consecutiveFailures++;
                    recordAction(action, 'failed', actionStateBefore, actionStateAfter);
                }

                actionResults.push({ action, success, stateChanged });

            } catch (err) {
                console.error(`[Action] Failed:`, action, err);
                const actionStateAfter = getPageStateSignature();
                recordAction(action, err.message, actionStateBefore, actionStateAfter);
                consecutiveFailures++;
                actionResults.push({ action, success: false, error: err.message });
            }
        }

        // Capture final page state
        const pageStateAfter = getPageStateSignature();
        const overallStateChanged = hasPageStateChanged(pageStateBefore, pageStateAfter);

        // Log summary
        const successCount = actionResults.filter(r => r.success).length;
        console.log(`[Actions] Completed ${successCount}/${actions.length} actions, overall state changed: ${overallStateChanged}`);

        // Store last page state for future comparisons
        lastPageState = pageStateAfter;

        isExecutingActions = false;
        return {
            results: actionResults,
            anySuccess,
            overallStateChanged,
            loopDetected: isStuckInLoop()
        };
    }

    // Find element with retry and context-awareness
    async function findElementWithRetry(selector, actionType, maxRetries = 3) {
        // First, check if we're in a modal context
        const activeContext = detectActiveContext();

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Try the exact selector
            let el = document.querySelector(selector);

            // If found, verify it's visible
            if (el) {
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                    // If modal is open, verify element is in modal
                    if (activeContext.container) {
                        if (activeContext.container.contains(el)) {
                            return el; // Good - element is in the modal
                        } else {
                            console.warn(`[FindElement] Found element but it's NOT in active ${activeContext.type}, searching inside...`);
                            // Try to find similar element inside modal
                            el = findSimilarElementInContext(selector, activeContext.container);
                            if (el) return el;
                        }
                    } else {
                        return el; // No modal, element is fine
                    }
                }
            }

            // Wait a bit and retry (element might be loading)
            if (attempt < maxRetries - 1) {
                await sleep(300);
            }
        }

        return null;
    }

    // Try to find a similar element within a specific container
    function findSimilarElementInContext(selector, container) {
        // Extract key parts from the selector
        const idMatch = selector.match(/#([^\s.[\]]+)/);
        const classMatch = selector.match(/\.([^\s.[\]]+)/g);
        const nameMatch = selector.match(/\[name="([^"]+)"\]/);
        const typeMatch = selector.match(/\[type="([^"]+)"\]/);

        // Try to find by similar attributes within the container
        if (idMatch) {
            const el = container.querySelector(`[id*="${idMatch[1]}"]`);
            if (el) return el;
        }

        if (nameMatch) {
            const el = container.querySelector(`[name="${nameMatch[1]}"]`);
            if (el) return el;
        }

        if (typeMatch && classMatch) {
            const el = container.querySelector(`input[type="${typeMatch[1]}"]${classMatch.join('')}`);
            if (el) return el;
        }

        // Try just by tag type from selector
        const tagMatch = selector.match(/^(\w+)/);
        if (tagMatch) {
            const inputs = container.querySelectorAll(tagMatch[1]);
            if (inputs.length === 1) return inputs[0];
        }

        return null;
    }

    function highlightElement(el) {
        const originalOutline = el.style.outline;
        const originalTransition = el.style.transition;

        el.style.transition = 'outline 0.2s ease';
        el.style.outline = '3px solid #4285F4';

        setTimeout(() => {
            el.style.outline = originalOutline;
            el.style.transition = originalTransition;
        }, 500);
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
        msgDiv.id = id;
        msgDiv.className = 'sc-message ai loading-bubble';
        msgDiv.innerHTML = `<div class="sc-bubble"><i>${text}</i></div>`;
        messagesArea.appendChild(msgDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        return id;
    }

    function removeMessage(id) {
        if (!id) return;
        const el = shadowRoot.getElementById(id);
        if (el) el.remove();
    }

    // Task Progress UI
    function updateTaskProgressUI(taskState) {
        const progressEl = shadowRoot.getElementById('sc-task-progress');
        const stepsEl = shadowRoot.getElementById('sc-task-steps');
        const nextEl = shadowRoot.getElementById('sc-task-next');

        if (!progressEl) return;

        currentTaskState = taskState;

        if (taskState.inProgress) {
            progressEl.style.display = 'flex';
            stepsEl.textContent = `Step ${taskState.stepsCompleted + 1}`;
            if (taskState.nextStep) {
                nextEl.textContent = `Next: ${taskState.nextStep}`;
                nextEl.style.display = 'block';
            } else {
                nextEl.style.display = 'none';
            }
        } else {
            progressEl.style.display = 'none';
        }
    }

    async function cancelCurrentTask() {
        try {
            const response = await fetch('http://localhost:3000/api/task/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId })
            });
            const data = await response.json();
            if (data.success) {
                chrome.storage.local.remove(['sc_task_active']);
                updateTaskProgressUI({ inProgress: false });
                setInputState(true);
                addMessage("Task cancelled.", 'ai');
            }
        } catch (e) {
            console.error('Failed to cancel task:', e);
        }
    }

    init();
})();
