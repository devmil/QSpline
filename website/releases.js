"use strict";

const MAX_MANIFEST_TEXT = 1024 * 1024;
const SUPPORTED = new Map([
  ["linux/x86_64", { label: "Linux x86_64", formats: ["AppImage", "deb", "rpm", "tar.gz"] }],
  ["macos/arm64", { label: "macOS arm64", formats: ["dmg"] }],
  ["windows/x86_64", { label: "Windows x64", formats: ["msi"] }],
]);
const FORMAT_LABELS = {
  AppImage: "AppImage",
  deb: "Debian package",
  rpm: "RPM package",
  "tar.gz": "Portable archive",
  dmg: "Disk image",
  msi: "MSI installer",
};

function requireText(value, name, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release asset is invalid");
  const platform = requireText(value.platform, "asset platform", 32);
  const architecture = requireText(value.architecture, "asset architecture", 32);
  const format = requireText(value.format, "asset format", 32);
  const supported = SUPPORTED.get(`${platform}/${architecture}`);
  if (!supported || !supported.formats.includes(format)) throw new Error("asset target is unsupported");
  const file = requireText(value.file, "asset filename", 255);
  if (file.includes("/") || file.includes("\\") || file === "." || file === "..") throw new Error("asset filename contains a path");
  const url = new URL(requireText(value.url, "asset URL", 2048));
  if (url.protocol !== "https:" || url.username || url.password || decodeURIComponent(url.pathname).split("/").pop() !== file) {
    throw new Error("asset URL is not an unauthenticated HTTPS URL for its filename");
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 95 * 1024 * 1024) throw new Error("asset byte count is invalid");
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error("asset SHA-256 is invalid");
  requireText(value.minimum_system, "asset minimum system", 256);
  return Object.freeze({ ...value, platform, architecture, format, file, url: url.href });
}

function validateRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release record is invalid");
  const version = requireText(value.version, "release version", 128);
  if (!Number.isSafeInteger(value.build) || value.build < 1) throw new Error("release build is invalid");
  const tag = requireText(value.tag, "release tag", 128);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-[1-9][0-9]*$/.test(tag)) throw new Error("release tag is invalid");
  if (value.channel !== "stable" && value.channel !== "beta") throw new Error("release channel is invalid");
  if (!Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 16) throw new Error("release asset count is invalid");
  const assets = value.assets.map(validateAsset);
  const notes = value.notes === undefined ? [] : value.notes;
  if (!Array.isArray(notes) || notes.length > 64) throw new Error("release notes are invalid");
  notes.forEach((note) => requireText(note, "release note"));
  return Object.freeze({ ...value, version, tag, assets, notes: Object.freeze([...notes]) });
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 1 || value.product !== "QSpline") {
    throw new Error("release index schema or product is unsupported");
  }
  if (!Array.isArray(value.releases) || value.releases.length > 256) throw new Error("release history is invalid");
  if (value.releases.length === 0) {
    if (value.latest !== null) throw new Error("empty release history has a latest release");
    return Object.freeze({ schema_version: 1, product: "QSpline", latest: null, releases: Object.freeze([]) });
  }
  if (!value.trust || value.trust.checksum !== "sha256" || value.trust.manifest_signature !== "Ed25519 detached signature over exact JSON bytes" || value.trust.signature_encoding !== "base64") {
    throw new Error("release trust policy is unsupported");
  }
  const releases = value.releases.map(validateRelease);
  const latest = validateRelease(value.latest);
  if (latest.tag !== releases[0].tag) throw new Error("latest release does not match history");
  return Object.freeze({ ...value, latest, releases: Object.freeze(releases) });
}

function platformFromValues(platformValue, userAgent, architectureValue) {
  const platform = `${platformValue || ""} ${userAgent || ""}`.toLowerCase();
  const architecture = `${architectureValue || ""}`.toLowerCase();
  const arm = /arm|aarch/.test(architecture) || /arm64|aarch64/.test(platform);
  if (/win/.test(platform)) return { platform: "windows", architecture: arm ? "arm64" : "x86_64", label: arm ? "Windows ARM64" : "Windows x64" };
  if (/mac|iphone|ipad/.test(platform)) return { platform: "macos", architecture: arm || /iphone|ipad/.test(platform) ? "arm64" : "x86_64", label: arm ? "macOS arm64" : "macOS Intel" };
  if (/linux|x11/.test(platform)) return { platform: "linux", architecture: arm ? "arm64" : "x86_64", label: arm ? "Linux ARM64" : "Linux x86_64" };
  return { platform: "unknown", architecture: "unknown", label: "This platform" };
}

async function detectPlatform(navigatorValue) {
  let architecture = "";
  if (navigatorValue.userAgentData?.getHighEntropyValues) {
    try {
      const values = await navigatorValue.userAgentData.getHighEntropyValues(["architecture"]);
      architecture = values.architecture || "";
    } catch (_) {
      architecture = "";
    }
  }
  return platformFromValues(navigatorValue.userAgentData?.platform || navigatorValue.platform, navigatorValue.userAgent, architecture);
}

function selectRecommendation(release, target) {
  if (!release || !SUPPORTED.has(`${target.platform}/${target.architecture}`)) return null;
  const policy = SUPPORTED.get(`${target.platform}/${target.architecture}`);
  for (const format of policy.formats) {
    const asset = release.assets.find((item) => item.platform === target.platform && item.architecture === target.architecture && item.format === format);
    if (asset) return asset;
  }
  return null;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderAsset(asset) {
  const item = element("li", "asset");
  const name = element("div", "asset-name");
  const link = element("a", "", asset.file);
  link.href = asset.url;
  link.rel = "noopener";
  name.append(link, element("small", "", `${FORMAT_LABELS[asset.format]} · ${asset.minimum_system}`));
  const metadata = element("div", "asset-meta", `${asset.platform} ${asset.architecture} · ${formatBytes(asset.bytes)}`);
  const digest = element("code", "digest", `SHA-256 ${asset.sha256}`);
  item.append(name, metadata, digest);
  return item;
}

function renderRelease(release) {
  const card = element("article", "release-card");
  const header = document.createElement("header");
  header.append(element("h3", "", `${release.version} · build ${release.build}`), element("span", "channel", release.channel));
  const tag = element("code", "", release.tag);
  header.append(tag);
  card.append(header);
  if (release.notes.length) {
    const notes = element("ul", "release-notes");
    release.notes.forEach((note) => notes.append(element("li", "", note)));
    card.append(notes);
  }
  const assets = element("ul", "asset-list");
  release.assets.forEach((asset) => assets.append(renderAsset(asset)));
  card.append(assets);
  return card;
}

function renderHistory(manifest) {
  const target = document.querySelector("#releases");
  if (!target) return;
  target.setAttribute("aria-busy", "false");
  if (!manifest.latest) {
    const empty = element("div", "empty-release");
    empty.append(element("strong", "", "No public builds yet"), element("p", "", "The first release remains behind its package, signing, and clean-machine gates."));
    target.replaceChildren(empty);
    return;
  }
  target.replaceChildren(...manifest.releases.map(renderRelease));
}

function renderTrustFiles(manifest) {
  const target = document.querySelector("#trust-files");
  if (!target || !manifest.latest) return;
  const links = [
    ["Signed release index", "_data/releases.json"],
    ["Detached signature", "_data/releases.json.sig"],
    ["Ed25519 public key", "qspline-release-ed25519.pub"],
    ["Tagged source", `https://code.lamers-cloud.de/mlamers/QSpline/src/tag/${encodeURIComponent(manifest.latest.tag)}`],
  ];
  target.replaceChildren(...links.map(([label, href]) => {
    const link = element("a", "button quiet", label);
    link.href = href;
    return link;
  }));
  target.hidden = false;
}

function renderRecommendation(manifest, target) {
  const containers = document.querySelectorAll("[data-release-summary]");
  const unsupported = document.querySelector("[data-unsupported]");
  const supportedTarget = SUPPORTED.has(`${target.platform}/${target.architecture}`);
  if (!supportedTarget && target.platform !== "unknown" && unsupported) {
    const title = unsupported.querySelector("[data-unsupported-title]");
    if (title) title.textContent = `${target.label} is not in v1.`;
    unsupported.hidden = false;
  }
  if (!manifest.latest) return;
  const asset = selectRecommendation(manifest.latest, target);
  containers.forEach((container) => {
    if (!supportedTarget) {
      container.replaceChildren(element("strong", "", `${target.label} is unsupported`), element("span", "", "Choose a supported package below or build QSpline from source."));
      return;
    }
    if (!asset) {
      container.replaceChildren(element("strong", "", `No ${target.label} package in this release`), element("span", "", "The signed index does not contain the expected target."));
      return;
    }
    const label = SUPPORTED.get(`${target.platform}/${target.architecture}`).label;
    const title = element("strong", "", `${manifest.latest.version} for ${label}`);
    const detail = element("span", "", `${FORMAT_LABELS[asset.format]} · ${formatBytes(asset.bytes)} · ${asset.minimum_system}`);
    const link = element("a", "button primary", `Download ${asset.file}`);
    link.href = asset.url;
    container.replaceChildren(title, detail, link);
  });
  const homeLink = document.querySelector("[data-download-link]");
  if (homeLink && asset) {
    homeLink.href = asset.url;
    homeLink.textContent = `Download ${FORMAT_LABELS[asset.format]}`;
  }
}

function applyTheme(preference) {
  const resolved = preference === "light" || preference === "dark" ? preference : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = resolved;
  document.querySelectorAll("[data-theme]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.theme === preference)));
}

function setupTheme() {
  let preference = localStorage.getItem("qs.theme") || "system";
  applyTheme(preference);
  document.querySelectorAll("[data-theme]").forEach((button) => button.addEventListener("click", () => {
    preference = button.dataset.theme;
    localStorage.setItem("qs.theme", preference);
    applyTheme(preference);
  }));
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (preference === "system") applyTheme(preference);
  });
}

async function loadReleases() {
  let manifest;
  try {
    const response = await fetch("_data/releases.json", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_MANIFEST_TEXT) throw new Error("release index exceeds 1 MiB");
    const text = await response.text();
    if (text.length > MAX_MANIFEST_TEXT) throw new Error("release index exceeds 1 MiB");
    manifest = validateManifest(JSON.parse(text));
  } catch (error) {
    const releaseTarget = document.querySelector("#releases");
    if (releaseTarget) {
      releaseTarget.setAttribute("aria-busy", "false");
      const empty = element("div", "empty-release");
      empty.append(element("strong", "", "Release data is unavailable"), element("p", "", error instanceof Error ? error.message : "The release index could not be read."));
      releaseTarget.replaceChildren(empty);
    }
    return;
  }
  renderHistory(manifest);
  renderTrustFiles(manifest);
  renderRecommendation(manifest, await detectPlatform(navigator));
}

if (typeof document !== "undefined") {
  setupTheme();
  loadReleases();
}

if (typeof module !== "undefined") {
  module.exports = { formatBytes, platformFromValues, selectRecommendation, validateManifest };
}
