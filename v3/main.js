// Copyright 2023 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { Settings } from "./settings.js"
import { Metrics } from "./metrics.js"
import { getChromiumVersion } from "./utils.js"

let currentStatus = null;
let synchedSettings = null;

const chromiumVersion = getChromiumVersion();
const menuId = 'prerenderLink';
const settings = new Settings(chromiumVersion);
const metrics = new Metrics();

function updateIcon(tabId, title, badgeText, badgeBgColor) {
  chrome.action.setTitle({ tabId: tabId, title: title });
  if (badgeText === undefined)
    badgeText = '';
  chrome.action.setBadgeText({ tabId: tabId, text: badgeText });
  if (badgeBgColor) {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: badgeBgColor });
  }
}

function updateStatus(tabId, status) {
  currentStatus = status;
  if (!status)
    return;
  let text = '|';
  let color = undefined;
  let title = 'Prerender Tweaks';
  if (status.restoredFromBFCache) {
    text += '$|';
    color = '#f0f';
    title += '\nRestored from BFCache';
  } else {
    if (status.prerendered) {
      text += 'P|';
      color = '#00f';
      title += '\nPrerendered';
    }
    if (status.hasInjectedSpecrules) {
      text += 'I|';
      if (!color)
        color = '#ff0';
      title += '\nPage contains tweaked speculationrules';
    } else if (status.hasSpecrules) {
      text += 'S|';
      color = '#0f0';
      title += '\nPage contains speculationrules';
    }
  }
  if (text === '|')
    text = '';
  updateIcon(tabId, title, text, color);
}

function checkPrerenderStatus(options) {
  chrome.tabs.sendMessage(options.tabId, { command: 'queryStatus' }, { frameId: 0 }, status => {
    updateStatus(options.tabId, status);
  });
}

function handleContentSwitch(options) {
  // update context menu rule.
  if (options || !options.url || !options.url.startsWith('http')) {
    chrome.contextMenus.update(menuId, {});
    return;
  }
  const url = new URL(options.url);
  const portString = url.port ? (':' + url.port) : '';
  const sameOriginPattern = url.protocol + '//' + url.host + portString + '/*';
  chrome.contextMenus.update(menuId, { targetUrlPatterns: [sameOriginPattern] });
}

// Hooks
async function registerHooks() {
  synchedSettings = await settings.getSettings();

  // Tab switch.
  chrome.tabs.onActivated.addListener(activeInfo => {
    chrome.tabs.get(activeInfo.tabId, tab => {
      if (tab.url.startsWith('http')) {
        checkPrerenderStatus({ reason: 'onActivated', tabId: activeInfo.tabId, windowId: activeInfo.windowId });
      }
      handleContentSwitch({ reason: 'onActivated', url: tab.url });
    });
  });

  // Page load completion.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' && changeInfo.url) {
      handleContentSwitch({ reason: 'onUpdated.loading', url: changeInfo.url });
    } else if (changeInfo.status === 'complete') {
      if (tab.url && tab.url.startsWith('http')) {
        checkPrerenderStatus({ reason: 'onUpdated.complete', tabId: tabId, windowId: tab.windowId });
      } else {
        updateIcon(tab.id, 'Unsupported page', 'X', '#f77');
      }
    }
  });

  // Request from content script.
  chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.message === 'update') {
      updateStatus(sender.tab.id, message.status);
    } else if (message.message === 'settings') {
      sendResponse(synchedSettings);
    } else if (message.message === 'metrics') {
      if (await settings.get('recordMetrics')) {
        metrics.reportEffectiveLcp(
            message.origin,
            message.prerendered,
            message.effectiveLargestContentfulPaint);
      }
    } else if (message.message == 'clearAllMetrics')  {
      metrics.clearAll();
    } else if (message.message == 'clearOriginMetrics')  {
      chrome.tabs.query({ active: true, lastFocusedWindow: true}, tab => {
        const url = new URL(tab[0].url);
        metrics.clearFor(url.origin);
      });
    } else if (message.message == 'debug')  {
      metrics.dumpToLog();
    }
  });

  // Context menus.
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: menuId,
    contexts: ['link'],
    title: 'Prerender this link'
  });
  chrome.contextMenus.onClicked.addListener(
    (info, tab) => {
      if (info.menuItemId == menuId) {
        chrome.tabs.sendMessage(tab.id, { command: 'insertRule', url: info.linkUrl }, { frameId: 0 });
      }
    });
}

if (chromiumVersion < 110) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true},
    tab => {
      updateIcon(tab[0].id, 'Prerender Tweaks requires Chrome 110+', 'X', '#f00');
    });
} else {
  registerHooks();
}