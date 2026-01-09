// DOM Elements
const captureVisibleBtn = document.getElementById('captureVisible');
const captureFullBtn = document.getElementById('captureFull');
const captureClipboardBtn = document.getElementById('captureClipboard');
const captureSelectionBtn = document.getElementById('captureSelection');
const formatSelect = document.getElementById('format');
const qualitySlider = document.getElementById('quality');
const qualityValue = document.getElementById('qualityValue');
const recentList = document.getElementById('recentList');
const recentSection = document.querySelector('.recent-section');
const notification = document.getElementById('notification');

// Settings
let settings = {
  format: 'png',
  quality: 95
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  console.log('ScreenChat popup loaded');
  loadSettings();
  loadRecentCaptures();
  setupEventListeners();
});

// Event Listeners
function setupEventListeners() {
  captureVisibleBtn.addEventListener('click', () => {
    console.log('Visible capture clicked');
    captureScreenshot('visible');
  });

  captureFullBtn.addEventListener('click', () => {
    console.log('Full page capture clicked');
    captureScreenshot('full');
  });

  captureClipboardBtn.addEventListener('click', () => {
    console.log('Clipboard capture clicked');
    captureToClipboard();
  });

  captureSelectionBtn.addEventListener('click', () => {
    showNotification('Selection mode coming soon!', 'error');
  });

  formatSelect.addEventListener('change', (e) => {
    settings.format = e.target.value;
    saveSettings();
  });

  qualitySlider.addEventListener('input', (e) => {
    settings.quality = parseInt(e.target.value);
    qualityValue.textContent = `${settings.quality}%`;
    saveSettings();
  });
}

// Capture Screenshot
async function captureScreenshot(mode) {
  try {
    console.log(`Starting ${mode} capture`);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      console.error('No active tab found');
      showNotification('No active tab found', 'error');
      return;
    }

    console.log('Active tab:', tab.url);

    if (mode === 'visible') {
      await captureVisibleArea(tab);
    } else if (mode === 'full') {
      await captureFullPage(tab);
    }
  } catch (error) {
    console.error('Capture error:', error);
    showNotification(`Error: ${error.message}`, 'error');
  }
}

// Capture Visible Area
async function captureVisibleArea(tab) {
  try {
    console.log('Capturing visible area...');

    const captureFormat = settings.format === 'png' ? 'png' : 'jpeg';
    const captureOptions = {
      format: captureFormat
    };

    if (captureFormat === 'jpeg') {
      captureOptions.quality = settings.quality;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);

    console.log('Capture successful, downloading...');
    await downloadScreenshot(dataUrl, tab.title, 'visible');
    showNotification('Screenshot captured!');
  } catch (error) {
    console.error('Visible capture error:', error);
    showNotification(`Capture failed: ${error.message}`, 'error');
  }
}

// --- Main Coordinator Script (Injected) ---
// This function runs entirely in the page context
async function runFullPageCoordinator(settings) {
  // UI Helper
  const showToast = (msg) => {
    let el = document.getElementById('screenchat-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'screenchat-toast';
      el.style.cssText = `
                position: fixed; bottom: 20px; right: 20px;
                background: #61988E; color: white; padding: 12px 24px;
                border-radius: 8px; font-family: sans-serif; z-index: 2147483647;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2); font-weight: 500; font-size: 14px;
                display: flex; align-items: center; gap: 8px;
            `;
      el.innerHTML = '<span>📷</span> ' + msg;
      document.body.appendChild(el);
    }
    el.childNodes[1].textContent = msg;
  };
  const removeToast = () => {
    const el = document.getElementById('screenchat-toast');
    if (el) el.remove();
  };

  try {
    showToast('Analyzing... Please wait.');

    // 1. Setup & Analysis
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Find Scroll Target
    const findBestScrollTarget = () => {
      const all = document.querySelectorAll('*');
      let best = null;
      let maxScroll = 0;
      // Check window first
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

    // Detect Background Color for filling gaps
    let bgColor = window.getComputedStyle(document.body).backgroundColor;
    if (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') bgColor = '#ffffff';

    // 2. Pre-Capture: Organize Fixed Elements
    // We want Headers at Top, Footers at Bottom.
    const bottomFixed = [];
    const otherFixed = [];

    const classifyFixedElements = () => {
      const all = [];
      const stack = [document];

      // Traverse Light + Shadow DOM for explicit fixed elements
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
        if (el.id === 'screenchat-toast') return;
        // Avoid duplicates
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

      // 1. Find explicit fixed/sticky
      for (const el of all) {
        const s = window.getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
          addToFixed(el);
        }
      }

      // 2. If scrolling a specific element, treat ancestors' siblings as fixed UI (Sidebars/Headers)
      if (target.type === 'element') {
        let current = target.el;
        while (current && current !== document.body && current !== document.documentElement) {
          const parent = current.parentElement;
          if (parent) {
            for (const child of parent.children) {
              if (child !== current && child.nodeName !== 'SCRIPT' && child.nodeName !== 'STYLE') {
                const s = window.getComputedStyle(child);
                if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
                  addToFixed(child);
                }
              }
            }
          }
          current = parent;
        }
      }
    };

    classifyFixedElements();

    // Hide Scrollbars
    const style = document.createElement('style');
    style.id = 'screenchat-css';
    style.textContent = `
            ::-webkit-scrollbar { display: none !important; }
            body { -ms-overflow-style: none !important; scrollbar-width: none !important; }
        `;
    document.head.appendChild(style);

    // 3. Capture Loop
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth * dpr;
    canvas.height = totalHeight * dpr;

    // Fill base
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let currentY = 0;

    for (let i = 0; i < maxScroll; i++) {
      showToast(`Analyzing section ${i + 1} of ${maxScroll}...`);

      // Scroll
      if (target.type === 'window') window.scrollTo(0, currentY);
      else target.el.scrollTop = currentY;

      await sleep(400); // Robust wait for rendering

      // Phase Logic:
      // i=0: otherFixed are VISIBLE (captured at top). bottomFixed are HIDDEN.
      // i=1: Hide otherFixed now (prevent dupes).
      // i=Last: Show bottomFixed now (capture at bottom).

      if (i > 0) {
        // Enforce hiding on every scroll step to fight reactivity
        otherFixed.forEach(item => item.el.style.visibility = 'hidden');
        if (i === 1) await sleep(100);
      }

      if (i === maxScroll - 1 && i > 0) {
        bottomFixed.forEach(item => item.el.style.visibility = item.original);
        await sleep(150);
      }

      // Hide status toast during capture so it doesn't appear in result
      const toastEl = document.getElementById('screenchat-toast');
      if (toastEl) toastEl.style.visibility = 'hidden';

      // Force a layout/paint update
      if (toastEl) void toastEl.offsetHeight;

      // Wait for two animation frames to ensure the hide propagates to screen
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Add a safety buffer to absolutely ensure it's gone from the frame buffer
      await sleep(50);

      // Capture via Background
      const dataUrl = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'capture_tab' }, (response) => {
          resolve(response && response.dataUrl);
        });
      });

      // Restore status toast immediately
      if (toastEl) toastEl.style.visibility = 'visible';

      if (!dataUrl) throw new Error('Capture failed');

      // Draw
      const img = await new Promise((resolve) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.src = dataUrl;
      });

      // Calculate precise offsets to handle scroll clamping and overlap
      const actualY = target.type === 'window' ? window.scrollY : target.el.scrollTop;

      // Determine scale (Retina/HiDPI support)
      const scale = img.naturalWidth / window.innerWidth;

      // Calculate slice parameters
      // We want to draw the content starting at 'currentY' in the global page
      // The screenshot contains content starting at 'actualY'
      // So the offset within the screenshot is 'currentY - actualY'
      const yOffsetCSS = currentY - actualY;
      const srcY = yOffsetCSS * scale;

      // Calculate height to draw
      const remainingHeightCSS = totalHeight - currentY;
      const hToDrawCSS = Math.min(viewportH, remainingHeightCSS);

      const srcH = hToDrawCSS * scale;

      // Destination
      const destX = 0;
      const destY = currentY * scale; // Map CSS to Canvas Pixels (canvas is scaled)
      const destW = canvas.width;
      const destH = srcH; // Maintain 1:1 pixel mapping

      // Safety check for negative offsets (shouldn't happen with correct logic)
      if (srcY >= 0 && srcH > 0 && (srcY + srcH) <= img.naturalHeight + 1) {
        ctx.drawImage(img,
          0, srcY, img.naturalWidth, srcH,
          destX, destY, destW, destH
        );
      }

      currentY += viewportH;
    }

    // 4. Cleanup & Restore
    showToast('Processing...');

    // Restore everything
    bottomFixed.forEach(item => item.el.style.visibility = item.original);
    otherFixed.forEach(item => item.el.style.visibility = item.original);

    if (target.type === 'window') window.scrollTo(0, 0);
    else target.el.scrollTop = 0;
    style.remove();

    // 5. Download
    // 5. Download
    const resultUrl = canvas.toDataURL((settings.format === 'png' ? 'image/png' : 'image/jpeg'), settings.quality / 100);

    // Generate Thumbnail (max 300px width)
    const thumbCanvas = document.createElement('canvas');
    const thumbScale = 300 / canvas.width;
    thumbCanvas.width = 300;
    thumbCanvas.height = canvas.height * thumbScale;
    const thumbCtx = thumbCanvas.getContext('2d');
    thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.6);

    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chrome.runtime.sendMessage({
      action: 'download_blob',
      url: resultUrl,
      thumbnail: thumbUrl,
      filename: `ScreenChat/screenchat-full-${date}.png`
    });

    removeToast();

  } catch (e) {
    console.error(e);
    showToast('Error: ' + e.message);
    setTimeout(removeToast, 3000);
    const style = document.getElementById('screenchat-css');
    if (style) style.remove();
    // Try naive restore if we crashed mid-way
    const all = document.querySelectorAll('*');
    for (const el of all) { if (el.style.visibility === 'hidden') el.style.visibility = ''; }
  }
}

// Capture Full Page Handler
async function captureFullPage(tab) {
  try {
    console.log('Starting full page capture injection...');

    // Check blacklist
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      showNotification('Cannot capture browser pages', 'error');
      return;
    }

    // Inject and Run
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runFullPageCoordinator,
      args: [{
        format: settings.format,
        quality: settings.quality
      }]
    });

    // Close popup immediately to get out of the way
    window.close();

  } catch (error) {
    console.error('Injection failed:', error);
    showNotification('Failed to start capture', 'error');
  }
}

// Download Screenshot
async function downloadScreenshot(dataUrl, pageTitle, mode) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const sanitizedTitle = pageTitle.replace(/[^a-z0-9]/gi, '_').slice(0, 30);
    const filename = `ScreenChat/screenshot_${sanitizedTitle}_${mode}_${timestamp}.${settings.format}`;

    console.log('Downloading:', filename);

    // Generate Thumbnail
    const thumbUrl = await createThumbnail(dataUrl);

    // Save to downloads
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    console.log('Download started, ID:', downloadId);

    // Save to recent captures
    await saveRecentCapture({
      dataUrl: thumbUrl || dataUrl,
      downloadId: downloadId,
      filename: filename,
      timestamp: Date.now(),
      mode: mode
    });

    loadRecentCaptures();
  } catch (error) {
    console.error('Download error:', error);
    showNotification(`Download failed: ${error.message}`, 'error');
  }
}

// Helper: Create Thumbnail
function createThumbnail(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      const scale = 300 / img.naturalWidth;
      cvs.width = 300;
      cvs.height = img.naturalHeight * scale;
      cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
      resolve(cvs.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Save Recent Capture
async function saveRecentCapture(capture) {
  try {
    const { recentCaptures = [] } = await chrome.storage.local.get('recentCaptures');

    // Keep only last 5 captures
    const updated = [capture, ...recentCaptures].slice(0, 5);

    await chrome.storage.local.set({ recentCaptures: updated });
  } catch (error) {
    console.error('Save recent error:', error);
  }
}

// Load Recent Captures
async function loadRecentCaptures() {
  try {
    const { recentCaptures = [] } = await chrome.storage.local.get('recentCaptures');

    if (recentCaptures.length === 0) {
      // Hide the entire recent section when empty
      if (recentSection) {
        recentSection.style.display = 'none';
      }
      return;
    }

    // Show the recent section if it was hidden
    if (recentSection) {
      recentSection.style.display = 'block';
    }

    recentList.innerHTML = recentCaptures.map((capture, index) => {
      const timeAgo = getTimeAgo(capture.timestamp);
      return `
    <div class="recent-item">
    <img src="${capture.dataUrl}" alt="${capture.filename}" data-url="${capture.dataUrl}">
      <div class="recent-item-info">
        <div class="recent-item-name">${capture.filename}</div>
        <div class="recent-item-time">${timeAgo}</div>
      </div>
      <button class="delete-btn" data-index="${index}" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
      `;
    }).join('');

    // Add click handlers for images
    document.querySelectorAll('.recent-item img').forEach(img => {
      img.addEventListener('click', () => {
        const dataUrl = img.dataset.url;
        chrome.tabs.create({ url: dataUrl });
      });
    });

    // Add delete handlers
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        await deleteRecentCapture(index);
      });
    });
  } catch (error) {
    console.error('Load recent error:', error);
  }
}

// Get Time Ago
function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Settings Management
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings) {
      settings = stored.settings;
      formatSelect.value = settings.format;
      qualitySlider.value = settings.quality;
      qualityValue.textContent = `${settings.quality} % `;
    }
  } catch (error) {
    console.error('Load settings error:', error);
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ settings });
  } catch (error) {
    console.error('Save settings error:', error);
  }
}

// Show Notification
function showNotification(message, type = 'success') {
  console.log(`Notification(${type}): `, message);
  notification.textContent = message;
  notification.className = `notification ${type} show`;

  setTimeout(() => {
    notification.classList.remove('show');
  }, 3000);
}

// Delete Recent Capture

// Delete Recent Capture
async function deleteRecentCapture(index) {
  try {
    const { recentCaptures = [] } = await chrome.storage.local.get('recentCaptures');
    const item = recentCaptures[index];

    if (item && item.downloadId) {
      // Delete actual file from disk
      try {
        chrome.downloads.removeFile(item.downloadId, () => {
          if (chrome.runtime.lastError) console.log('File deletion warning:', chrome.runtime.lastError.message);
        });
      } catch (e) { console.error('Delete file error:', e); }

      // Erase from download history
      chrome.downloads.erase({ id: item.downloadId }, () => { });
    }

    recentCaptures.splice(index, 1);
    await chrome.storage.local.set({ recentCaptures });
    loadRecentCaptures();
    showNotification('Screenshot deleted');
  } catch (error) {
    console.error('Delete error:', error);
    showNotification('Failed to delete', 'error');
  }
}

// Capture to Clipboard
async function captureToClipboard() {
  try {
    console.log('Capturing to clipboard...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      console.error('No active tab found');
      showNotification('No active tab found', 'error');
      return;
    }

    console.log('Active tab:', tab.url);

    // Capture visible area
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });

    // Convert data URL to blob
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    // Copy to clipboard
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob
      })
    ]);

    console.log('Copied to clipboard');
    showNotification('Copied to clipboard!');
  } catch (error) {
    console.error('Clipboard capture error:', error);
    showNotification(`Clipboard failed: ${error.message}`, 'error');
  }
}
