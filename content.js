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

    // Task cancellation state
    let taskCancelled = false;
    let currentAbortController = null;
    let continueTimeoutRef = null;

    // Chat Mode: 'ask' (Q&A) or 'agent' (task execution)
    let chatMode = 'agent';

    // User Profile (personal info for personalization)
    let userProfile = null;

    // Session State
    let sessionId = 'session_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    let sessionUrl = window.location.hostname || 'unknown';

    // Auth State
    let messageCount = 0;
    let authState = 'ANONYMOUS'; // ANONYMOUS, AWAIT_GOOGLE, AUTHENTICATED
    let tempUserData = { email: '', password: '' };
    let userId = 'user_' + Math.floor(Math.random() * 1000000);

    // =============================================================================
    // CORE SYSTEMS - Element Registry, Overlay Stack, Input Simulator, Task Planner
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

    // -----------------------------------------------------------------------------
    // INPUT SIMULATOR - Framework-aware input simulation
    // -----------------------------------------------------------------------------
    const InputSimulator = {
        async fill(elementMeta, text) {
            const { element: el, type } = elementMeta;
            console.log(`[InputSimulator] Filling ${type} with "${text.slice(0, 30)}..."`);

            if (type.startsWith('input:') || type === 'textarea') return await this.fillStandardInput(el, text);
            if (type === 'draftjs') return await this.fillDraftJS(el, text);
            if (type === 'prosemirror') return await this.fillProseMirror(el, text);
            if (type === 'contenteditable' || type === 'quill' || type === 'slate') return await this.fillContentEditable(el, text);
            return await this.fillGeneric(el, text);
        },

        async fillStandardInput(el, text) {
            el.focus();
            await sleep(30);

            // React controlled input handling
            const isReact = Object.keys(el).some(k => k.startsWith('__react'));
            if (isReact) {
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, text);
                else el.value = text;
            } else {
                el.value = text;
            }

            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

            await sleep(50);
            return this.verify(el, text);
        },

        async fillDraftJS(el, text) {
            console.log('[InputSimulator] fillDraftJS starting for:', el);

            // Find the Draft.js editor root and contenteditable
            let editorRoot = el.closest('.DraftEditor-root') || el.closest('[data-contents]')?.parentElement || el;
            let editable = editorRoot.querySelector('[contenteditable="true"]') || editorRoot;

            // Twitter-specific: find the actual tweet input area
            const twitterEditor = el.closest('[data-testid="tweetTextarea_0"]') ||
                document.querySelector('[data-testid="tweetTextarea_0"]');
            if (twitterEditor) {
                editorRoot = twitterEditor;
                editable = twitterEditor.querySelector('[contenteditable="true"]') || twitterEditor;
                console.log('[InputSimulator] Found Twitter editor:', editable);
            }

            // STEP 1: CLICK to activate the editor (not just focus!)
            // Draft.js needs a real click event sequence to enter edit mode
            editable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            await sleep(10);
            editable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            await sleep(10);
            editable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            await sleep(50);

            // STEP 2: Focus the element
            editable.focus();
            await sleep(50);

            // STEP 3: Set cursor position using Selection API
            const selection = window.getSelection();
            const range = document.createRange();

            // Find the text node or create insertion point
            if (editable.firstChild) {
                range.selectNodeContents(editable);
                range.collapse(false); // Collapse to end
            } else {
                range.setStart(editable, 0);
                range.collapse(true);
            }
            selection.removeAllRanges();
            selection.addRange(range);
            await sleep(30);

            // STEP 4: Clear existing content if any
            if (editable.textContent && editable.textContent.trim().length > 0) {
                document.execCommand('selectAll', false, null);
                await sleep(20);
                document.execCommand('delete', false, null);
                await sleep(30);
            }

            // STEP 5: Type character by character with full event simulation
            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                const keyCode = char.charCodeAt(0);

                // Keyboard events
                editable.dispatchEvent(new KeyboardEvent('keydown', {
                    key: char, code: `Key${char.toUpperCase()}`, keyCode, which: keyCode,
                    bubbles: true, cancelable: true
                }));

                // beforeinput (Draft.js listens for this)
                editable.dispatchEvent(new InputEvent('beforeinput', {
                    inputType: 'insertText', data: char, bubbles: true, cancelable: true
                }));

                // Insert via execCommand
                document.execCommand('insertText', false, char);

                // input event
                editable.dispatchEvent(new InputEvent('input', {
                    inputType: 'insertText', data: char, bubbles: true
                }));

                // keyup
                editable.dispatchEvent(new KeyboardEvent('keyup', {
                    key: char, code: `Key${char.toUpperCase()}`, keyCode, which: keyCode,
                    bubbles: true
                }));

                // Small delay every few chars to let Draft.js process
                if (i % 5 === 0) await sleep(10);
            }

            await sleep(150);

            // Verify
            const result = this.verify(editable, text);
            console.log('[InputSimulator] fillDraftJS result:', result);
            return result;
        },

        async fillProseMirror(el, text) {
            const editor = el.closest('.ProseMirror') || el;
            editor.focus();
            await sleep(50);

            document.execCommand('selectAll', false, null);
            await sleep(20);
            document.execCommand('delete', false, null);
            await sleep(20);

            for (let i = 0; i < text.length; i++) {
                const char = text[i];
                editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true }));
                document.execCommand('insertText', false, char);
                editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
                if (i % 10 === 0) await sleep(5);
            }

            await sleep(100);
            return this.verify(editor, text);
        },

        async fillContentEditable(el, text) {
            el.focus();
            await sleep(50);
            document.execCommand('selectAll', false, null);
            await sleep(20);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
            await sleep(50);
            return this.verify(el, text);
        },

        async fillGeneric(el, text) {
            el.focus();
            await sleep(30);
            if ('value' in el) {
                el.value = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.getAttribute('contenteditable')) {
                return await this.fillContentEditable(el, text);
            } else {
                el.textContent = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await sleep(50);
            return this.verify(el, text);
        },

        verify(el, expected) {
            const actual = (el.value || el.textContent || el.innerText || '').trim();
            const success = actual.includes(expected.trim()) || actual.length > 0;
            console.log(`[InputSimulator] Verify: expected "${expected.slice(0, 30)}", got "${actual.slice(0, 30)}", success: ${success}`);
            return { success, expected, actual, element: el };
        },

        async click(elementMeta) {
            const { element: el } = elementMeta;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(100);
            this.highlight(el);
            el.focus();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof el.click === 'function') el.click();
            await sleep(100);
            return { success: true };
        },

        async select(elementMeta, value) {
            const { element: el } = elementMeta;
            el.focus();
            this.highlight(el);
            let option = Array.from(el.options).find(o => o.value === value);
            if (!option) option = Array.from(el.options).find(o => o.text.toLowerCase().includes(value.toLowerCase()));
            if (option) {
                el.value = option.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, selected: option.text };
            }
            return { success: false, error: 'Option not found' };
        },

        async check(elementMeta, checked = true) {
            const { element: el } = elementMeta;
            el.focus();
            this.highlight(el);
            el.checked = checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('click', { bubbles: true }));
            return { success: el.checked === checked };
        },

        highlight(el) {
            const orig = el.style.outline;
            el.style.outline = '3px solid #4285F4';
            el.style.outlineOffset = '2px';
            setTimeout(() => { el.style.outline = orig; el.style.outlineOffset = ''; }, 1000);
        }
    };

    // -----------------------------------------------------------------------------
    // TASK PLANNER - Plan once, execute locally
    // -----------------------------------------------------------------------------
    const TaskPlanner = {
        currentPlan: null,
        currentGoal: null,
        executionState: { stepIndex: 0, completed: [], failed: [] },

        reset() {
            this.currentPlan = null;
            this.currentGoal = null;
            this.executionState = { stepIndex: 0, completed: [], failed: [] };
        },

        setPlan(plan, goal) {
            this.currentPlan = plan;
            this.currentGoal = goal;
            this.executionState = { stepIndex: 0, completed: [], failed: [] };
        },

        hasPlan() {
            return this.currentPlan?.steps?.length > 0;
        },

        getNextStep() {
            if (!this.currentPlan?.steps) return null;
            return this.currentPlan.steps[this.executionState.stepIndex] || null;
        },

        markStepComplete(step, result) {
            this.executionState.completed.push({ step, result });
            this.executionState.stepIndex++;
        },

        markStepFailed(step, reason) {
            this.executionState.failed.push({ step, reason });
        },

        isComplete() {
            if (!this.currentPlan?.steps) return true;
            return this.executionState.stepIndex >= this.currentPlan.steps.length;
        },

        async executeStep(step) {
            console.log(`[TaskPlanner] Executing: ${step.action} on ${step.elementId || step.selector}`);

            let elementMeta = null;
            if (step.elementId) elementMeta = ElementRegistry.get(step.elementId);
            if (!elementMeta && step.selector) {
                const el = ElementRegistry.getBySelector(step.selector);
                if (el) elementMeta = { element: el, type: ElementRegistry.detectInputType(el), label: ElementRegistry.getLabel(el) };
            }

            if (!elementMeta && !['wait', 'scroll_page', 'observe'].includes(step.action)) {
                return { success: false, reason: 'element_not_found', needsReplan: true };
            }

            try {
                switch (step.action) {
                    case 'fill': return await InputSimulator.fill(elementMeta, step.value);
                    case 'click': return await InputSimulator.click(elementMeta);
                    case 'select': return await InputSimulator.select(elementMeta, step.value);
                    case 'check': return await InputSimulator.check(elementMeta, step.checked !== false);
                    case 'wait': await sleep(step.duration || 1000); return { success: true };
                    case 'scroll_page':
                        window.scrollBy(0, step.direction === 'up' ? -(step.amount || 300) : (step.amount || 300));
                        await sleep(200);
                        return { success: true };
                    case 'press_enter':
                        elementMeta.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                        elementMeta.element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                        return { success: true };
                    case 'observe':
                        return { success: true };
                    default:
                        return { success: false, reason: `Unknown action: ${step.action}` };
                }
            } catch (e) {
                console.error('[TaskPlanner] Error:', e);
                return { success: false, reason: e.message };
            }
        },

        getProgress() {
            if (!this.currentPlan?.steps) return { total: 0, completed: 0, current: null };
            return {
                total: this.currentPlan.steps.length,
                completed: this.executionState.stepIndex,
                current: this.getNextStep(),
                goal: this.currentGoal
            };
        }
    };

    // -----------------------------------------------------------------------------
    // CONTEXT BUILDER - Minimal context for LLM
    // -----------------------------------------------------------------------------
    const ContextBuilder = {
        modes: {
            PLAN: { screenshot: 'viewport', elements: 'all', overlay: true },
            EXECUTE: { screenshot: false, elements: 'active', overlay: true },
            DIAGNOSE: { screenshot: 'viewport', elements: 'active', overlay: true },
            CONTINUE: { screenshot: 'viewport', elements: 'active', overlay: true }
        },

        async build(mode = 'PLAN') {
            const config = this.modes[mode] || this.modes.PLAN;
            const context = { url: window.location.href, title: document.title, mode };

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

            if (config.screenshot === 'viewport') {
                try {
                    if (container) container.style.visibility = 'hidden';
                    await sleep(50);
                    context.screenshot = await captureViewport();
                    if (container) container.style.visibility = 'visible';
                } catch (e) {
                    if (container) container.style.visibility = 'visible';
                }
            }

            if (TaskPlanner.hasPlan()) {
                context.taskProgress = TaskPlanner.getProgress();
            }

            return context;
        },

        formatForLLM(context) {
            let msg = `[Page: ${context.url}]`;
            if (context.activeContext?.type !== 'page') {
                msg += `\n[Active: ${context.activeContext.type}${context.activeContext.title ? ` - "${context.activeContext.title}"` : ''}]`;
            }
            if (context.taskProgress) {
                msg += `\n[Progress: ${context.taskProgress.completed + 1}/${context.taskProgress.total}]`;
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <a href="https://buymeacoffee.com/AhmadKhattak" target="_blank" class="sc-btn-icon" id="sc-coffee" title="Support">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                             <path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                             <path d="M6 1v3M10 1v3M14 1v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </a>
                    <div class="sc-settings-wrapper">
                        <button class="sc-btn-icon" id="sc-settings-btn" title="Settings">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
                                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                        <div class="sc-settings-dropdown" id="sc-settings-dropdown">
                            <button class="sc-settings-item" id="sc-profile-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                Personalize
                            </button>
                            <button class="sc-settings-item" id="sc-history-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                                History
                            </button>
                            <button class="sc-settings-item" id="sc-position-toggle">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 16l-4-4m0 0l4-4m-4 4h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                <span id="sc-position-label">Move to left</span>
                            </button>
                        </div>
                    </div>
                    <button class="sc-btn-icon" id="sc-minimize" title="Minimize">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M18 12H6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                    <button class="sc-btn-icon" id="sc-close" title="Close">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
                        Hey! Use <b>Agent</b> to automate tasks or <b>Ask</b> for help with this page.
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

            <div class="sc-profile-view" id="sc-profile-view">
                <div class="sc-profile-header">
                    <h3>Personalize Experience</h3>
                    <button class="sc-btn-icon" id="sc-profile-close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <path d="M6 18L18 6M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </button>
                </div>
                <div class="sc-profile-content">
                    <p class="sc-profile-desc">Optional info to personalize your experience. The AI can use this to auto-fill forms and tailor responses.</p>
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


            <div class="sc-input-area">
                <div class="sc-mode-toggle" id="sc-mode-toggle">
                    <button class="sc-mode-btn active" data-mode="agent" title="Execute tasks on this page">Agent</button>
                    <button class="sc-mode-btn" data-mode="ask" title="Ask questions about this page">Ask</button>
                </div>
                <div class="sc-input-row">
                    <div class="sc-input-wrapper">
                        <textarea class="sc-textarea" id="sc-chat-input" placeholder="Tell me what to do..." rows="1"></textarea>
                        <input type="password" class="sc-password-input" id="sc-password-input" placeholder="Enter your password..." style="display: none;">
                    </div>
                    
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
                // Close settings dropdown first
                const dropdown = shadowRoot.getElementById('sc-settings-dropdown');
                if (dropdown) dropdown.classList.remove('visible');
                historyView.classList.add('visible');
                loadHistory();
            });
        }

        if (closeHistoryBtn) {
            closeHistoryBtn.addEventListener('click', () => {
                historyView.classList.remove('visible');
            });
        }

        // Settings Dropdown Toggle
        const settingsBtn = shadowRoot.getElementById('sc-settings-btn');
        const settingsDropdown = shadowRoot.getElementById('sc-settings-dropdown');
        if (settingsBtn && settingsDropdown) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsDropdown.classList.toggle('visible');
            });
            // Close dropdown when clicking outside
            document.addEventListener('click', () => {
                settingsDropdown.classList.remove('visible');
            });
            shadowRoot.addEventListener('click', (e) => {
                if (!e.target.closest('.sc-settings-wrapper')) {
                    settingsDropdown.classList.remove('visible');
                }
            });
        }

        // Mode Toggle
        const modeToggle = shadowRoot.getElementById('sc-mode-toggle');
        if (modeToggle) {
            const modeButtons = modeToggle.querySelectorAll('.sc-mode-btn');
            modeButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const newMode = btn.dataset.mode;
                    if (newMode !== chatMode) {
                        chatMode = newMode;
                        // Update UI
                        modeButtons.forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        // Update placeholder
                        textarea.placeholder = chatMode === 'agent'
                            ? 'Tell me what to do...'
                            : 'Ask me anything about this page...';
                        // Persist mode preference
                        chrome.storage.local.set({ sc_chat_mode: chatMode });
                    }
                });
            });

            // Restore saved mode
            chrome.storage.local.get(['sc_chat_mode'], (result) => {
                if (result.sc_chat_mode) {
                    chatMode = result.sc_chat_mode;
                    modeButtons.forEach(b => {
                        b.classList.toggle('active', b.dataset.mode === chatMode);
                    });
                    textarea.placeholder = chatMode === 'agent'
                        ? 'Tell me what to do...'
                        : 'Ask me anything about this page...';
                }
            });
        }

        // ============================================================
        // Profile Panel Logic
        // ============================================================
        const profileBtn = shadowRoot.getElementById('sc-profile-btn');
        const profileView = shadowRoot.getElementById('sc-profile-view');
        const profileCloseBtn = shadowRoot.getElementById('sc-profile-close');
        const profileSaveBtn = shadowRoot.getElementById('sc-profile-save');

        // Profile fields
        const profileNameInput = shadowRoot.getElementById('sc-profile-name');
        const profileNicknameInput = shadowRoot.getElementById('sc-profile-nickname');
        const profileEmailInput = shadowRoot.getElementById('sc-profile-email');
        const profilePhoneInput = shadowRoot.getElementById('sc-profile-phone');
        const profileNotesInput = shadowRoot.getElementById('sc-profile-notes');

        // Load profile on init
        async function loadProfile() {
            try {
                const response = await fetch(`http://localhost:3000/api/profile?userId=${userId}`);
                const data = await response.json();
                if (data.profile) {
                    userProfile = data.profile;
                    // Populate fields
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

        // Load profile when we have a userId
        setTimeout(loadProfile, 500);

        // Open profile panel
        if (profileBtn) {
            profileBtn.addEventListener('click', () => {
                settingsDropdown.classList.remove('visible');
                profileView.classList.add('visible');
            });
        }

        // Close profile panel
        if (profileCloseBtn) {
            profileCloseBtn.addEventListener('click', () => {
                profileView.classList.remove('visible');
            });
        }

        // Save profile
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
                    const response = await fetch('http://localhost:3000/api/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId, profile })
                    });
                    const data = await response.json();
                    if (data.success) {
                        userProfile = profile;
                        profileSaveBtn.textContent = 'Saved!';
                        setTimeout(() => {
                            profileSaveBtn.textContent = 'Save Profile';
                            profileSaveBtn.disabled = false;
                            profileView.classList.remove('visible');
                        }, 1000);
                    } else {
                        throw new Error(data.error || 'Failed to save');
                    }
                } catch (e) {
                    console.error('[Profile] Save error:', e);
                    profileSaveBtn.textContent = 'Error!';
                    setTimeout(() => {
                        profileSaveBtn.textContent = 'Save Profile';
                        profileSaveBtn.disabled = false;
                    }, 2000);
                }
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
        const positionLabel = shadowRoot.getElementById('sc-position-label');

        // Helper to update label
        const updatePositionLabel = () => {
            const host = document.getElementById('screenchat-host');
            const isLeft = host?.classList.contains('sc-left');
            if (positionLabel) {
                positionLabel.textContent = isLeft ? 'Move to right' : 'Move to left';
            }
        };

        if (positionToggleBtn) {
            positionToggleBtn.addEventListener('click', () => {
                const host = document.getElementById('screenchat-host');
                const isLeft = host.classList.toggle('sc-left');
                chrome.storage.local.set({ sc_ui_position: isLeft ? 'left' : 'right' });
                updatePositionLabel();
                // Close dropdown
                const dropdown = shadowRoot.getElementById('sc-settings-dropdown');
                if (dropdown) dropdown.classList.remove('visible');
            });
        }

        // Update label on init based on saved position
        setTimeout(updatePositionLabel, 100);

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

            // NEW: Use ContextBuilder for minimal, structured context
            const context = await ContextBuilder.build('PLAN');
            const contextString = ContextBuilder.formatForLLM(context);

            // Send to Backend with minimal context (NO raw HTML!)
            const messagesPayload = conversationHistory.map((m, idx) => {
                if (idx === conversationHistory.length - 1 && m.role === 'user') {
                    return { role: 'user', content: `${contextString}\n\n${m.content}` };
                }
                return m;
            });

            try {
                console.log('[ScreenChat] Sending request with minimal context...');
                console.log('[ScreenChat] Elements:', context.elements?.length || 0);
                console.log('[ScreenChat] Payload size:', JSON.stringify({ messages: messagesPayload, userId, sessionId }).length);

                // Create AbortController for this request
                currentAbortController = new AbortController();

                const response = await fetch('http://localhost:3000/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: messagesPayload,
                        image: screenshotDataUrl || context.screenshot,
                        userId: userId,
                        sessionId: sessionId,
                        sessionUrl: sessionUrl,
                        mode: chatMode,
                        profile: userProfile,
                        screenshotType: context.screenshot ? 'viewport' : 'full',
                        elements: context.elements,
                        activeContext: context.activeContext
                    }),
                    signal: currentAbortController.signal
                });

                console.log('[ScreenChat] Response status:', response.status);
                if (!response.ok) throw new Error('Backend failed');
                const data = await response.json();

                // Remove Loading Bubble
                removeMessage(loadingId);

                // ASK MODE: Just show the response, no action execution
                if (chatMode === 'ask') {
                    // In Ask mode, response is plain text, not JSON
                    const responseText = data.reply;
                    conversationHistory.push({ role: "assistant", content: responseText });
                    chrome.storage.local.set({ conversationHistory });
                    addMessage(responseText, 'ai');
                    setInputState(true);
                    return;
                }

                // AGENT MODE: Parse structured response and execute actions
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

                if (parsed.status === 'complete' || parsed.status === 'cannot_complete') {
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                    TaskPlanner.reset(); // Clean up task state
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
                // Handle abort errors gracefully (user cancelled)
                if (backendErr.name === 'AbortError' || taskCancelled) {
                    console.log('[ScreenChat] Request aborted by user');
                    removeMessage(loadingId);
                    return; // Don't show error message for intentional cancellation
                }
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
            // Check if task was cancelled
            if (taskCancelled) {
                console.log('[AutoContinue] Aborted - task was cancelled');
                return;
            }

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

            // Brief stabilization wait
            await sleep(600);

            const loadingId = addLoadingMessage("Checking progress...");

            // NEW: Use ContextBuilder for minimal continuation context
            let context;
            try {
                context = await ContextBuilder.build('CONTINUE');
            } catch (e) {
                console.error("Context build failed", e);
                removeMessage(loadingId);
                setInputState(true);
                updateTaskProgressUI({ inProgress: false });
                chrome.storage.local.remove(['sc_task_active']);
                return;
            }

            // Format context for AI message
            const contextMessage = ContextBuilder.formatForLLM(context);

            // Construct messages payload
            const messagesPayload = [...conversationHistory];

            // Append continuation with minimal context
            messagesPayload.push({
                role: "user",
                content: `${contextMessage}\n\ncontinue`
            });

            try {
                // Check cancellation before fetch
                if (taskCancelled) {
                    removeMessage(loadingId);
                    return;
                }

                console.log('[ScreenChat] Continuing with minimal context...');
                console.log('[ScreenChat] Elements:', context.elements?.length || 0);

                // Create AbortController for this request
                currentAbortController = new AbortController();

                const response = await fetch('http://localhost:3000/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: messagesPayload,
                        image: context.screenshot,
                        userId: userId,
                        sessionId: sessionId,
                        sessionUrl: sessionUrl,
                        mode: chatMode,
                        profile: userProfile,
                        screenshotType: 'viewport',
                        elements: context.elements,
                        activeContext: context.activeContext
                    }),
                    signal: currentAbortController.signal
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

                if (parsed.status === 'complete' || parsed.status === 'cannot_complete') {
                    chrome.storage.local.remove(['sc_task_active']);
                    updateTaskProgressUI({ inProgress: false });
                    setInputState(true);
                    // Reset tracking
                    actionHistory = [];
                    recentActions = [];
                    TaskPlanner.reset(); // Clean up task state
                } else if (parsed.status === 'waiting_for_input') {
                    setInputState(true, "Type your response...");
                } else if (parsed.status === 'stuck' || parsed.status === 'failed') {
                    // AI acknowledged being stuck
                    setInputState(true, "Help me continue...");
                    chrome.storage.local.remove(['sc_task_active']);
                    TaskPlanner.reset();
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
                // Handle abort errors gracefully (user cancelled)
                if (e.name === 'AbortError' || taskCancelled) {
                    console.log('[AutoContinue] Request aborted by user');
                    removeMessage(loadingId);
                    return; // Don't show error message for intentional cancellation
                }
                console.error("Auto-continue failed", e);
                removeMessage(loadingId);
                setInputState(true);
                updateTaskProgressUI({ inProgress: false });
                chrome.storage.local.remove(['sc_task_active']);
                addMessage("Task paused due to error: " + e.message, 'ai');
            }
        };

        // SPA Continuation Logic
        function scheduleAutoContinue() {
            if (continueTimeoutRef) clearTimeout(continueTimeoutRef);

            // Don't schedule if cancelled
            if (taskCancelled) {
                console.log('[AutoContinue] Skipped - task was cancelled');
                return;
            }

            continueTimeoutRef = setTimeout(() => {
                // Check if cancelled or still active
                if (taskCancelled) {
                    console.log('[AutoContinue] Aborted - task was cancelled');
                    return;
                }

                chrome.storage.local.get(['sc_task_active'], (res) => {
                    if (res.sc_task_active && !taskCancelled) {
                        console.log('[AutoContinue] Continuing task...');
                        handleAutoContinue();
                    }
                });
            }, 4000);
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

    // --- Execute Actions (NEW - Uses InputSimulator & ElementRegistry) ---
    async function executeActions(actions) {
        if (isExecutingActions) return { results: [], anySuccess: false };
        if (taskCancelled) return { results: [], anySuccess: false, cancelled: true };

        isExecutingActions = true;

        const actionResults = [];
        let anySuccess = false;

        // Capture page state BEFORE actions
        const pageStateBefore = getPageStateSignature();

        // Ensure registry is fresh
        ElementRegistry.scan(true);

        for (const action of actions) {
            // Check for cancellation at start of each action
            if (taskCancelled) {
                console.log('[Action] Loop aborted - task cancelled');
                break;
            }

            const actionStateBefore = getPageStateSignature();

            try {
                await sleep(200); // Small delay for visual feedback

                let result = { success: false };

                // Build step for TaskPlanner format
                const step = {
                    action: action.type,
                    elementId: action.elementId,
                    selector: action.selector,
                    value: action.value,
                    direction: action.direction,
                    amount: action.amount,
                    duration: action.duration,
                    checked: action.checked
                };

                // Handle scroll_in separately (not in TaskPlanner)
                if (action.type === 'scroll_in') {
                    const el = ElementRegistry.getBySelector(action.selector);
                    if (el) {
                        const scrollAmount = action.amount || 200;
                        el.scrollTop += action.direction === 'up' ? -scrollAmount : scrollAmount;
                        await sleep(200);
                        result = { success: true };
                    } else {
                        result = { success: false, reason: 'element_not_found' };
                    }
                } else if (action.type === 'submit') {
                    // Handle submit action
                    const el = ElementRegistry.getBySelector(action.selector);
                    if (el) {
                        const form = el.closest('form') || el;
                        if (form.submit) form.submit();
                        else el.click();
                        result = { success: true };
                    } else {
                        result = { success: false, reason: 'element_not_found' };
                    }
                } else if (action.type === 'scroll') {
                    // Legacy scroll action
                    window.scrollBy(0, action.direction === 'up' ? -(action.amount || 300) : (action.amount || 300));
                    await sleep(200);
                    result = { success: true };
                } else {
                    // Use TaskPlanner.executeStep for standard actions
                    result = await TaskPlanner.executeStep(step);
                }

                // Record action with state change detection
                const actionStateAfter = getPageStateSignature();
                const stateChanged = hasPageStateChanged(actionStateBefore, actionStateAfter);

                if (result.success) {
                    consecutiveFailures = 0;
                    anySuccess = true;
                    recordAction(action, 'success', actionStateBefore, actionStateAfter);
                    console.log(`[Action] Success: ${action.type}, state changed: ${stateChanged}`);
                } else {
                    consecutiveFailures++;
                    recordAction(action, result.reason || 'failed', actionStateBefore, actionStateAfter);
                    console.warn(`[Action] Failed: ${action.type} - ${result.reason}`);
                }

                actionResults.push({ action, success: result.success, stateChanged, details: result });

            } catch (err) {
                console.error(`[Action] Error:`, action, err);
                const actionStateAfter = getPageStateSignature();
                recordAction(action, err.message, actionStateBefore, actionStateAfter);
                consecutiveFailures++;
                actionResults.push({ action, success: false, error: err.message });
            }
        }

        // Capture final page state
        const pageStateAfter = getPageStateSignature();
        const overallStateChanged = hasPageStateChanged(pageStateBefore, pageStateAfter);

        const successCount = actionResults.filter(r => r.success).length;
        console.log(`[Actions] Completed ${successCount}/${actions.length}, state changed: ${overallStateChanged}`);

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
        console.log('[Cancel] Cancelling current task...');

        // 1. Set cancel flag to stop loops
        taskCancelled = true;

        // 2. Abort any in-flight fetch requests
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }

        // 3. Clear auto-continue timer
        if (continueTimeoutRef) {
            clearTimeout(continueTimeoutRef);
            continueTimeoutRef = null;
        }

        // 4. Reset execution state
        isExecutingActions = false;
        isCapturing = false;

        // 5. Reset TaskPlanner
        TaskPlanner.reset();

        // 6. Clear action history
        actionHistory = [];
        recentActions = [];
        consecutiveFailures = 0;

        // 7. Update UI immediately
        chrome.storage.local.remove(['sc_task_active']);
        updateTaskProgressUI({ inProgress: false });
        setInputState(true);
        addMessage("Task cancelled.", 'ai');

        // 8. Notify backend (don't await - fire and forget)
        fetch('http://localhost:3000/api/task/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
        }).catch(e => console.error('[Cancel] Backend notify failed:', e));

        // 9. Reset cancel flag after a short delay (for new tasks)
        setTimeout(() => {
            taskCancelled = false;
        }, 500);

        console.log('[Cancel] Task cancelled successfully');
    }

    init();
})();
