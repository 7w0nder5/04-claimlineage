const token = document.querySelector('meta[name="claimlineage-token"]').content;
const state = { workspace: null, snapshots: [], claims: [] };

const element = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "X-ClaimLineage-Token": token, ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Request failed with HTTP ${response.status}`);
  return result;
}

function setStatus(message, error = false) {
  const target = element("status");
  target.textContent = message;
  target.classList.toggle("error", error);
}

function short(value, length = 12) {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function dateText(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function snapshotById(id) {
  return state.snapshots.find((item) => item.id === id);
}

function renderClaims() {
  const list = element("claim-list");
  const query = element("claim-filter").value.trim().toLocaleLowerCase();
  list.replaceChildren();
  const claims = state.claims.filter((claim) => {
    const evidence = claim.evidence[0];
    const snapshot = snapshotById(evidence.snapshotId);
    return [claim.statement, evidence.selector.exact, snapshot?.source.label || ""].join(" ").toLocaleLowerCase().includes(query);
  });
  element("claim-empty").hidden = state.claims.length !== 0;
  for (const claim of claims) {
    const evidence = claim.evidence[0];
    const snapshot = snapshotById(evidence.snapshotId);
    const article = document.createElement("article");
    article.className = "claim-card";
    const main = document.createElement("div");
    main.className = "claim-main";
    const meta = document.createElement("div");
    meta.className = "claim-meta";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Linked";
    const created = document.createElement("span");
    created.textContent = dateText(claim.createdAt);
    const id = document.createElement("span");
    id.className = "mono";
    id.textContent = short(claim.id);
    meta.append(badge, created, id);
    const heading = document.createElement("h3");
    heading.textContent = claim.statement;
    main.append(meta, heading);

    const evidenceBox = document.createElement("div");
    evidenceBox.className = "evidence";
    const inner = document.createElement("div");
    const quote = document.createElement("blockquote");
    quote.textContent = `“${evidence.selector.exact}”`;
    const footer = document.createElement("footer");
    const source = document.createElement("span");
    source.textContent = snapshot?.source.label || "Missing snapshot";
    const digest = document.createElement("span");
    digest.className = "mono";
    digest.textContent = snapshot ? `sha256:${short(snapshot.sha256, 16)}` : "";
    const offsets = document.createElement("span");
    offsets.className = "mono";
    offsets.textContent = `bytes ${evidence.selector.startByte}–${evidence.selector.endByte}`;
    footer.append(source, digest, offsets);
    inner.append(quote, footer);
    evidenceBox.append(inner);
    article.append(main, evidenceBox);
    list.append(article);
  }
}

function renderSources() {
  const list = element("source-list");
  list.replaceChildren();
  element("source-empty").hidden = state.snapshots.length !== 0;
  for (const snapshot of state.snapshots) {
    const article = document.createElement("article");
    article.className = "source-card";
    const type = document.createElement("span");
    type.className = "source-type";
    type.textContent = snapshot.source.type;
    const heading = document.createElement("h3");
    heading.textContent = snapshot.source.label;
    const details = document.createElement("p");
    details.textContent = `${snapshot.mediaType} · ${snapshot.byteLength.toLocaleString()} bytes · ${dateText(snapshot.capturedAt)}`;
    const id = document.createElement("p");
    id.className = "mono";
    id.textContent = snapshot.id;
    const digest = document.createElement("p");
    digest.className = "digest";
    digest.textContent = `sha256:${snapshot.sha256}`;
    article.append(type, heading, details, id, digest);
    if (snapshot.source.finalUrl) {
      const location = document.createElement("p");
      location.textContent = snapshot.source.finalUrl;
      article.append(location);
    }
    list.append(article);
  }
}

function renderSnapshotSelect() {
  const select = element("snapshot-select");
  select.replaceChildren();
  if (!state.snapshots.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Save a snapshot first";
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const snapshot of state.snapshots) {
    const option = document.createElement("option");
    option.value = snapshot.id;
    option.textContent = `${snapshot.source.label} · ${short(snapshot.id, 8)}`;
    select.append(option);
  }
}

function render() {
  element("workspace-name").textContent = state.workspace.name;
  element("workspace-id").textContent = state.workspace.id;
  element("snapshot-count").textContent = state.snapshots.length;
  element("claim-count").textContent = state.claims.length;
  renderClaims();
  renderSources();
  renderSnapshotSelect();
}

async function refresh() {
  Object.assign(state, await api("/api/state"));
  render();
}

function openView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  document.querySelector(`#view-${name} h2`)?.focus?.();
}

async function submitWith(button, action) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Working…";
  setStatus("");
  try {
    await action();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => openView(button.dataset.view)));
document.querySelectorAll("[data-open-view]").forEach((button) => button.addEventListener("click", () => openView(button.dataset.openView)));
element("claim-filter").addEventListener("input", renderClaims);

for (const [active, inactive, form, otherForm] of [
  [element("file-tab"), element("url-tab"), element("file-form"), element("url-form")],
  [element("url-tab"), element("file-tab"), element("url-form"), element("file-form")],
]) {
  active.addEventListener("click", () => {
    active.classList.add("active");
    active.setAttribute("aria-selected", "true");
    inactive.classList.remove("active");
    inactive.setAttribute("aria-selected", "false");
    form.hidden = false;
    otherForm.hidden = true;
  });
}

element("file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = element("file-input").files[0];
  if (!file) return;
  await submitWith(event.submitter, async () => {
    await api("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-ClaimLineage-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    event.target.reset();
    await refresh();
    setStatus(`Saved immutable snapshot of ${file.name}.`);
  });
});

element("url-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = element("url-input").value;
  await submitWith(event.submitter, async () => {
    await api("/api/captures", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    event.target.reset();
    await refresh();
    setStatus("Saved immutable web snapshot.");
  });
});

element("claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitWith(event.submitter, async () => {
    await api("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        statement: element("statement-input").value,
        snapshotId: element("snapshot-select").value,
        quote: element("quote-input").value,
      }),
    });
    event.target.reset();
    await refresh();
    openView("claims");
    setStatus("Claim lineage created and verified against the saved bytes.");
  });
});

element("verify-button").addEventListener("click", async (event) => {
  await submitWith(event.currentTarget, async () => {
    const report = await api("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setStatus(`Workspace intact: ${report.snapshots} snapshot(s), ${report.claims} claim(s), ${report.objects} object(s).`);
  });
});

refresh().catch((error) => setStatus(error.message, true));
