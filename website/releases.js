async function loadReleases() {
  const target = document.querySelector("#releases");
  try {
    const response = await fetch("_data/releases.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    const releases = manifest.releases || [];
    if (releases.length === 0) {
      target.textContent = "No public builds yet.";
      return;
    }
    target.replaceChildren(...releases.map((release) => {
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = `${release.version} (${release.channel})`;
      section.append(heading);
      for (const artifact of release.assets || []) {
        const link = document.createElement("a");
        link.href = artifact.url;
        link.textContent = `${artifact.platform} ${artifact.architecture} ${artifact.format}`;
        section.append(link, document.createElement("br"));
      }
      return section;
    }));
  } catch (error) {
    target.textContent = `Release data is unavailable: ${error.message}`;
  }
}

loadReleases();
