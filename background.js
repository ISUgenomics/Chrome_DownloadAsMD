const MAX_SITE_PAGES = 20;

function sanitizeSegment(value, fallback = "untitled") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function buildFilename(url, title) {
  const parsed = new URL(url);
  const host = sanitizeSegment(parsed.hostname, "site");
  const pathPart = parsed.pathname === "/" ? "index" : parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const filename = sanitizeSegment(pathPart || title || "page", "page");
  return `${host}/${filename}.md`;
}

function toDataUrl(text) {
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
}

async function downloadMarkdown(url, title, markdown) {
  const filename = buildFilename(url, title);
  await chrome.downloads.download({
    url: toDataUrl(markdown),
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

function extractScript() {
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS"]);

  function esc(text) {
    return text.replace(/([\\`*_{}\[\]()#+\-.!>])/g, "\\$1");
  }

  function nodeToMarkdown(node, depth = 0) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent.replace(/\s+/g, " ").trim();
      return content ? esc(content) : "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (skipTags.has(node.tagName)) return "";

    const children = Array.from(node.childNodes)
      .map((child) => nodeToMarkdown(child, depth + 1))
      .filter(Boolean);
    const inner = children.join(node.tagName === "P" ? " " : "");

    switch (node.tagName) {
      case "H1":
        return `# ${inner}\n\n`;
      case "H2":
        return `## ${inner}\n\n`;
      case "H3":
        return `### ${inner}\n\n`;
      case "H4":
        return `#### ${inner}\n\n`;
      case "H5":
        return `##### ${inner}\n\n`;
      case "H6":
        return `###### ${inner}\n\n`;
      case "P":
        return `${inner}\n\n`;
      case "A": {
        const href = node.getAttribute("href") || "";
        return href ? `[${inner || href}](${href})` : inner;
      }
      case "IMG": {
        const alt = node.getAttribute("alt") || "image";
        const src = node.getAttribute("src") || "";
        return src ? `![${esc(alt)}](${src})` : "";
      }
      case "STRONG":
      case "B":
        return `**${inner}**`;
      case "EM":
      case "I":
        return `*${inner}*`;
      case "CODE":
        return `\`${inner}\``;
      case "PRE":
        return `\`\`\`\n${node.textContent.trim()}\n\`\`\`\n\n`;
      case "LI":
        return `${"  ".repeat(Math.max(0, depth - 1))}- ${inner}\n`;
      case "UL":
      case "OL":
        return `${inner}\n`;
      case "BLOCKQUOTE":
        return inner
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n") + "\n\n";
      case "BR":
        return "  \n";
      case "MAIN":
      case "ARTICLE":
      case "SECTION":
      case "DIV":
      case "BODY":
        return `${inner}\n`;
      default:
        return inner;
    }
  }

  const title = document.title || "Untitled";
  const url = window.location.href;
  const markdown = `# ${title}\n\nSource: ${url}\n\n${nodeToMarkdown(document.body)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";

  const sameOriginLinks = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => a.href)
    .filter((href) => {
      try {
        const parsed = new URL(href);
        return parsed.origin === window.location.origin && parsed.protocol.startsWith("http");
      } catch {
        return false;
      }
    });

  return {
    title,
    url,
    markdown,
    links: Array.from(new Set(sameOriginLinks))
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractScript
  });
  return result?.result;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function downloadCurrentPage() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");
  const extracted = await extractFromTab(tab.id);
  await downloadMarkdown(extracted.url, extracted.title, extracted.markdown);
  return "Downloaded current page as Markdown.";
}

async function downloadSite() {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const first = await extractFromTab(tab.id);
  const uniqueLinks = Array.from(new Set([first.url, ...first.links])).slice(0, MAX_SITE_PAGES);
  let downloaded = 0;

  for (const link of uniqueLinks) {
    if (link === first.url) {
      await downloadMarkdown(first.url, first.title, first.markdown);
      downloaded += 1;
      continue;
    }

    const created = await chrome.tabs.create({ url: link, active: false });
    if (!created.id) continue;

    try {
      await waitForTabComplete(created.id);
      const extracted = await extractFromTab(created.id);
      if (extracted?.markdown) {
        await downloadMarkdown(extracted.url, extracted.title, extracted.markdown);
        downloaded += 1;
      }
    } finally {
      await chrome.tabs.remove(created.id).catch(() => {});
    }
  }

  return `Downloaded ${downloaded} page(s) from this site.`;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.action === "download-page") {
      const text = await downloadCurrentPage();
      sendResponse({ ok: true, message: text });
      return;
    }
    if (message?.action === "download-site") {
      const text = await downloadSite();
      sendResponse({ ok: true, message: text });
      return;
    }
    sendResponse({ ok: false, message: "Unknown action." });
  })().catch((error) => {
    sendResponse({ ok: false, message: error?.message || "Failed." });
  });

  return true;
});
