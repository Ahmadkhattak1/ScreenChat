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

    // Session State
    let sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    let sessionUrl = window.location.hostname || 'unknown';

    // Auth State
    let messageCount = 0;
    let authState = 'ANONYMOUS'; // ANONYMOUS, AWAIT_GOOGLE, AUTHENTICATED
    let tempUserData = { email: '', password: '' };
    let userId = 'user_' + Math.floor(Math.random() * 1000000);

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
        chrome.storage.local.get(['screenchat_user', 'conversationHistory', 'messageCount'], (result) => {
            if (result.screenchat_user) {
                userId = result.screenchat_user.userId;
                authState = 'AUTHENTICATED';
                console.log('Restored session for:', userId);
            } else {
                if (result.messageCount) messageCount = result.messageCount;
            }

            if (result.conversationHistory && result.conversationHistory.length > 0) {
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
                    <button class="sc-btn-icon" id="sc-minimize" title="Minimize">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 12H6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button class="sc-btn-icon" id="sc-close" title="Close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="sc-messages" id="sc-messages">
                <div class="sc-message ai">
                    <div class="sc-bubble">
                        Hello! I'm ScreenChat. Type a message below and I'll automatically capture this page for you.
                    </div>
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
        `;

        // Load Icon
        container.style.setProperty('--icon-url', `url(${chrome.runtime.getURL('icons/icon48.png')})`);
        shadowRoot.appendChild(container);

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

        // New Chat - Reset Session
        const startNewSession = () => {
            sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
            sessionUrl = window.location.hostname || 'unknown';
            conversationHistory = [];
            lastCapturedUrl = null;
            currentScreenshot = null;

            // Clear storage
            chrome.storage.local.remove(['conversationHistory']);

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
                    const res = await fetch(`https://screenchat-backend-production.up.railway.app/api/auth/status?userId=${userId}`);
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

            if (!text || isCapturing) return;

            textarea.value = '';
            textarea.style.height = 'auto';

            addMessage(text, 'user');

            // --- Auth Check (Google Only) ---
            if (authState === 'ANONYMOUS') {
                messageCount++;
                chrome.storage.local.set({ messageCount });
                if (messageCount > 2) {
                    authState = 'AWAIT_GOOGLE';
                    addGoogleSignInMessage();
                    return;
                }
            }

            if (authState === 'AWAIT_GOOGLE') {
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

            if (needsScreenshot) {
                // Capture Flow
                isCapturing = true;
                sendBtn.disabled = true;

                try {
                    container.style.display = 'none';
                    await sleep(100);

                    console.log('Capturing screenshot (URL changed or first/explicit)');
                    screenshotDataUrl = await captureFullPage();
                    lastCapturedUrl = currentUrl;
                    currentScreenshot = screenshotDataUrl;

                    container.style.display = 'flex';
                    addMessage("Analyzing...", 'ai', screenshotDataUrl);
                } catch (err) {
                    console.error('Screenshot failed:', err);
                    container.style.display = 'flex';
                    addMessage("Thinking...", 'ai');
                } finally {
                    isCapturing = false;
                    sendBtn.disabled = false;
                }
            } else {
                // Reuse cached screenshot, no UI disruption
                addMessage("Thinking...", 'ai');
                screenshotDataUrl = currentScreenshot;
            }

            // Send to Backend with URL context
            const messagesPayload = conversationHistory.map((m, idx) => {
                if (idx === conversationHistory.length - 1 && m.role === 'user') {
                    return { role: 'user', content: `[Current Page: ${currentUrl}]\n\n${m.content}` };
                }
                return m;
            });

            try {
                const response = await fetch('https://screenchat-backend-production.up.railway.app/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: messagesPayload,
                        image: screenshotDataUrl,
                        userId: userId,
                        sessionId: sessionId,
                        sessionUrl: sessionUrl
                    })
                });

                if (!response.ok) throw new Error('Backend failed');
                const data = await response.json();

                conversationHistory.push({ role: "assistant", content: data.reply });
                chrome.storage.local.set({ conversationHistory });
                addMessage(data.reply, 'ai');

            } catch (backendErr) {
                console.error('Backend error:', backendErr);
                addMessage(`Error connecting to AI: ${backendErr.message}`, 'ai');
                conversationHistory.pop();
                chrome.storage.local.set({ conversationHistory });
            }
        };

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
            return canvas.toDataURL('image/png');
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

    init();
})();
