// Copyright 2023 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Holds prerender related page status.
let prerenderStatus = {
  prerendered: document.prerendering,
  url: location.href,
  activated: false,
  hasSpecrules: false,
  hasInjectedSpecrules: false,
  restoredFromBFCache: false,

  // for debug.
  readyStateOnStart: document.readyState,
};
let queried = false;
let settings = chrome.runtime.sendMessage(undefined, { message: 'settings' });
let prerenderedUrls = [];
let candidateUrls = {};

// Make the activated status up to date.
if (document.prerendering) {
  document.addEventListener('prerenderingchange', () => {
    prerenderStatus.prerendered = true;
    prerenderStatus.activated = true;
    chrome.runtime.sendMessage(undefined, { message: 'update', status: prerenderStatus });
  });
}

// Make the restoredFromBFCache status up to date.
window.addEventListener('pageshow', e => {
  if (prerenderStatus.restoredFromBFCache || !e.persisted)
    return;
  prerenderStatus.restoredFromBFCache = true;
  chrome.runtime.sendMessage(undefined, { message: 'update', status: prerenderStatus });
});

// Obtains Extensions settings delivered at the script start time.
async function getRemoteSetting(key) {
  return (await settings)[key];
}

// Check if the link that is potentially relative URL can be prerendered.
function isPrerenderableLink(href) {
  const url = new URL(href, document.baseURI);

  // Already prerendered.
  if (prerenderedUrls.indexOf(url.href) >= 0) {
    return false;
  }

  // Same-origin check.
  if (url.origin !== document.location.origin) {
    return false;
  }
  const baseUrl = document.location.href.substring(
      0, document.location.href.length - document.location.hash.length);
  if (url.href.startsWith(baseUrl)) {
    const urlLen = baseUrl.length;
    // Link to the current page.
    if (url.href.length == urlLen) {
      return false;
    }
    // Link to the segment or the current page with a query.
    if (url.href[urlLen] == '#' || url.href[urlLen] == '?') {
      return false;
    }
  }
  return true;
}

// Calculate CSS selector to query the element.
function calculateSelector(element, childSelector) {
  const suffix = childSelector ? ` ${childSelector}` : '';
  if (element.id) {
    // Now we can have a selector to point the unique element.
    return `#${element.id}${suffix}`;
  }
  let selector = element.tagName;
  if (element.className) {
    selector += '.' + element.className.split(' ').join('.');
  }
  if (!element.parentElement) {
    return `${selector}${suffix}`;
  }
  return calculateSelector(element.parentElement, `${selector}${suffix}`);
}

// Make the hasSpecrules status up to date, and notify the main.js on changes.
function checkSpecrules() {
  if (prerenderStatus.hasSpecrules)
    return;
  prerenderStatus.hasSpecrules = false;
  for (let script of document.getElementsByTagName('script')) {
    if (script.type != 'speculationrules') {
      continue;
    }
    const rules = JSON.parse(script.text);
    if (!rules.prerender) {
      // No rules for prerendering.
      continue;
    }

    prerenderStatus.hasSpecrules = true;
    break;
  }

  // Make sure that prerendering is actually not used before sending the report.
  // Content script may overlook if activation happens before the inejction.
  if (performance.getEntriesByType('navigation')[0].activationStart > 0) {
    prerenderStatus.prerendered = true;
    prerenderStatus.activated = true;
  }
  if (!queried || (prerenderStatus.prerendered && !prerenderStatus.activated))
    return;
  chrome.runtime.sendMessage(undefined, { message: 'update', status: prerenderStatus });
}

// Monitor anchor tags.
async function monitorAnchors() {
  if (!await getRemoteSetting('anchorHoverInjection')) {
    return;
  }
  // TODO: may be better to check the 'src' attribute again as the link may be changed.
  const monitorMarkName = 'prerender-tweaks-monitoring';
  for (let anchor of document.getElementsByTagName('a')) {
    if (anchor.hasAttribute(monitorMarkName)) {
      continue;
    }
    if (!isPrerenderableLink(anchor.href)) {
      anchor.setAttribute(monitorMarkName, 'no');
      continue;
    }
    anchor.setAttribute(monitorMarkName, 'yes');
    anchor.addEventListener('mouseenter', e => {
      if (candidateUrls[e.target.href]) {
        return;
      }
      candidateUrls[e.target.href] = true;
      setTimeout(() => {
        if (candidateUrls[e.target.href]) {
          const url = new URL(e.target.href, document.baseURI);
          injectSpecrules({ urls: [url.href] });
          // TODO: remove it after a certain time period.
        }
      }, 0);
    });
    anchor.addEventListener('mouseleave', e => {
      delete candidateUrls[e.target.href];
    });
    anchor.addEventListener('click', e => {
      const selector = calculateSelector(e.target);
      const sibling = document.querySelectorAll(selector).length;
      chrome.runtime.sendMessage(undefined, {
        message: 'click',
        initiator: document.location.href,
        target: e.target.href,
        selector: selector,
        sibling: sibling
      });
    });
  }
}

function scanContent() {
  checkSpecrules();
  monitorAnchors();
}

function reportMetrics() {
  const observer = new PerformanceObserver(list=> {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1];
    const navigationEntry = performance.getEntriesByType('navigation')[0];
    // Follow up the case activation happens before the script injection.
    prerenderStatus.prerendered = navigationEntry.activationStart > 0;
    prerenderStatus.activated = navigationEntry.activationStart > 0;
    const effectiveLargestContentfulPaint = Math.max(
       lastEntry.startTime - navigationEntry.activationStart, 0);

    // send metrics to the background Extension service.
    chrome.runtime.sendMessage(undefined, {
       message: 'metrics',
       prerendered: prerenderStatus.prerendered,
       restoredFromBFCache: prerenderStatus.restoredFromBFCache,
       activationStart: navigationEntry.activationStart,
       largestContentfulPaint: lastEntry.startTime,
       effectiveLargestContentfulPaint: effectiveLargestContentfulPaint,
       url: document.location.href,
       origin: document.location.origin
     });
  });
  observer.observe({ type: 'largest-contentful-paint', buffered: true });
}

// Inject speculationrules for specified URLs.
async function injectSpecrules(options) {
  console.log('injecting speculationrules:');
  let rules = [];
  for (let url of options.urls) {
    // Ignore if the url is already in the prerendered page list.
    if (prerenderedUrls.indexOf(url) >= 0) {
      continue;
    }
    prerenderedUrls.push(url);
    rules.push(`{ "source": "list", "urls": [ "${url}" ] }`);
    console.log(' * ' + url);
    if (options.limit && rules.length >= options.limit) {
      break;
    }
  }
  if (rules.length == 0) {
    return null;
  }
  const rule = document.createElement('script');
  rule.type = 'speculationrules';
  rule.innerText = '{ "prerender": [ ' + rules.join(',') + ' ] }';
  document.head.appendChild(rule);
  prerenderStatus.hasInjectedSpecrules = true;
  return rule;
}

// Content checks on load, and DOM modifications.
let mutationChecking = false;
const mutationObserver = new MutationObserver(o => {
  if (mutationChecking)
    return;
  mutationChecking = true;
  setTimeout(e => {
    mutationChecking = false;
    scanContent();
  }, 100);
});
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', e => {
    scanContent();
    mutationObserver.observe(document, { childList: true, subtree: true });
  });
} else {
  scanContent();
  mutationObserver.observe(document, { childList: true, subtree: true });
}

if (document.readyState === 'complete') {
  reportMetrics();
} else {
  window.addEventListener('load', e => {
    scanContent();
    reportMetrics();
  });
}

function generatePrerenderCandidates(options) {
  if (prerenderStatus.hasSpecrules || prerenderStatus.hasInjectedSpecrules) {
    return { urls: [] };
  }

  const urls = [];
  const maxRules = options.limit || 5;

  if (options.url) {
    urls.push(options.url);
  }
  let anchors = [];
  if (options.selector) {
    anchors = document.querySelectorAll(options.selector);
  }
  if (urls.length == 0 && anchors.length == 0) {
    // Take the first N if there is no prediction hints.
    anchors = document.getElementsByTagName('a');
  }
  for (let a of anchors) {
    if (urls.length >= maxRules) {
      break;
    }
    if (!isPrerenderableLink(a.href)) {
      continue;
    }
    const url = new URL(a.href, document.baseURI);
    urls.push(url.href);
  }

  return { urls: urls, limit: options.limit };
}

// Communication with the main.js running in the background service worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'queryStatus') {
    queried = true;
    sendResponse(prerenderStatus);
  } else if (message.command === 'insertRule') {
    injectSpecrules(generatePrerenderCandidates(message.to));
  }
});