// Background Service Worker for ScreenChat

chrome.runtime.onInstalled.addListener(() => {
    console.log('ScreenChat extension installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== 'capture_visible_tab') return undefined;

    (async () => {
        try {
            const windowId = sender?.tab?.windowId;
            const image = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
            sendResponse({ ok: true, image });
        } catch (error) {
            console.error('Screen capture failed:', error);
            sendResponse({ ok: false, error: 'Unable to capture current screen' });
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
