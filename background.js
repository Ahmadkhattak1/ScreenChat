// Background Service Worker for ScreenChat

chrome.runtime.onInstalled.addListener(() => {
    console.log('ScreenChat extension installed');
});

// Track injected tabs to avoid re-injecting
const injectedTabs = new Set();

chrome.action.onClicked.addListener(async (tab) => {
    // Prevent injection in restricted pages
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;

    if (injectedTabs.has(tab.id)) {
        // Already injected, toggle visibility
        try {
            await chrome.tabs.sendMessage(tab.id, { action: 'toggle_ui' });
        } catch (e) {
            // If sending fails (e.g. page refreshed), re-inject
            injectedTabs.delete(tab.id);
            injectContentScript(tab);
        }
    } else {
        injectContentScript(tab);
    }
});

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
        injectedTabs.add(tab.id);
    } catch (err) {
        console.error('Injection failed:', err);
    }
}

// Clean up closed tabs from the set
chrome.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'capture_tab') {
        // Only capture the visible area of the active tab
        const format = request.format || 'jpeg';
        const quality = request.quality || 60; // Default to 60% quality for tokens

        chrome.tabs.captureVisibleTab(
            sender.tab.windowId,
            { format: format, quality: quality },
            (dataUrl) => {
                if (chrome.runtime.lastError) {
                    console.error(chrome.runtime.lastError);
                    sendResponse({ error: chrome.runtime.lastError.message });
                } else {
                    sendResponse({ dataUrl });
                }
            }
        );
        return true; // Keep channel open for async response
    }

    if (request.action === 'download_blob') {
        chrome.downloads.download({
            url: request.url,
            filename: request.filename
        }, (downloadId) => {
            // Optional: Save to recent captures logic (can be reimplemented or simplified)
        });
    }
});
