const state = { scan: null, selected: null, preview: null, arkReady: false };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) { amount /= 1000; index += 1; }
  return `${amount.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function toast(error) {
  const node = $("#toast");
  node.textContent = error?.message || String(error);
  node.classList.remove("hidden");
  setTimeout(() => node.classList.add("hidden"), 6500);
}

function renderHardware(hardware) {
  const gpu = hardware.gpus?.map((item) => item.name).join(", ") || "CPU only";
  $("#hardware-summary").classList.remove("skeleton");
  $("#hardware-summary").innerHTML = [
    ["Operating system", `${hardware.platform} · ${hardware.arch}`],
    ["Processor", `${hardware.cpuModel} · ${hardware.cpuCores} cores`],
    ["Memory", bytes(hardware.ramBytes)],
    ["Accelerator", gpu],
  ].map(([label, value]) => `<div class="hardware-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join("");
}

function renderDisks(disks) {
  const list = $("#disk-list");
  if (!disks.length) {
    list.innerHTML = '<div class="empty-state">No external disks detected. Connect a 4 TB or larger drive and rescan.</div>';
    return;
  }
  list.innerHTML = disks.map((assessment) => {
    const disk = assessment.disk;
    const volume = assessment.mountedWritableVolume || disk.volumes?.find((item) => item.mountPoint) || disk.volumes?.[0];
    const selected = state.selected === disk.id ? " selected" : "";
    const label = assessment.canPrepare ? "READY" : assessment.eligibleSize ? "NEEDS ATTENTION" : "TOO SMALL";
    const tone = assessment.canPrepare ? "good" : assessment.eligibleSize ? "warn" : "bad";
    return `<button class="disk-card${selected}" data-action="select-disk" data-id="${escapeHtml(disk.id)}">
      <div class="disk-top"><div><h3>${escapeHtml(disk.name)}</h3><p>${escapeHtml(disk.devicePath)} · ${escapeHtml(disk.fingerprint)}</p></div><span class="status ${tone}">${label}</span></div>
      <div class="disk-meta"><span class="tag">${bytes(disk.sizeBytes)}</span><span class="tag">${escapeHtml(volume?.filesystem || "unformatted")}</span><span class="tag">${escapeHtml(disk.partitionScheme || "no scheme")}</span><span class="tag">${escapeHtml(disk.bus || "external")}</span></div>
    </button>`;
  }).join("");
}

function renderModels(results) {
  $("#model-list").innerHTML = results.map((result) => {
    const model = result.model;
    const disabled = result.status === "incompatible" || !state.arkReady ? "disabled" : "";
    return `<article class="model-card">
      <div class="model-heading"><div><h3>${escapeHtml(model.name)}</h3><div class="model-family">${escapeHtml(model.parameterCount)} · ${escapeHtml(model.quantization)} · ${escapeHtml(model.format)}</div></div><span class="status ${result.status}">${result.status.toUpperCase()}</span></div>
      <ul class="model-reasons">${result.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      <div class="model-size"><span>${bytes(model.artifact.sizeBytes)}</span><div class="button-row"><button class="button button-secondary" data-action="verify-model" data-id="${escapeHtml(model.id)}" ${disabled}>Verify</button><button class="button button-primary" data-action="download-model" data-id="${escapeHtml(model.id)}" ${disabled}>Add to ark</button></div></div>
    </article>`;
  }).join("");
}

function renderPreview(preview) {
  state.preview = preview;
  $("#preview-section").classList.remove("hidden");
  const tree = preview.creates.length
    ? preview.creates.map((item, index) => `${index === 0 ? "●" : "  ├─"} ${escapeHtml(item)}`).join("\n")
    : "No writable target tree can be created yet.";
  const warnings = preview.warnings.length
    ? `<ul class="warning-list">${preview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : '<div class="status good">ALL SAFETY CHECKS PASSED</div>';
  $("#preview-card").innerHTML = `<pre class="preview-tree">${tree}</pre><div class="preview-actions">${warnings}
    <label class="confirmation-label">To create the non-destructive folder structure, type:<br><code>${escapeHtml(preview.confirmation)}</code></label>
    <input id="confirmation" class="confirmation" autocomplete="off" spellcheck="false" placeholder="Type the exact confirmation" ${preview.canPrepare ? "" : "disabled"} />
    <div class="button-row"><button data-action="prepare" class="button button-primary" ${preview.canPrepare ? "" : "disabled"}>Prepare AIARK folders</button><button data-action="format-preview" class="button button-secondary">Why GPT + ExFAT?</button></div>
    <pre id="format-result" class="result-box hidden"></pre></div>`;
  renderModels(state.scan.compatibility);
}

async function rescan() {
  $("#scan-button").disabled = true;
  try {
    state.scan = await window.aiark.scan();
    renderHardware(state.scan.hardware);
    renderDisks(state.scan.disks);
    renderModels(state.scan.compatibility);
    if (state.selected && !state.scan.disks.some((item) => item.disk.id === state.selected)) {
      state.selected = null;
      state.preview = null;
      state.arkReady = false;
      $("#preview-section").classList.add("hidden");
    }
  } catch (error) { toast(error); }
  finally { $("#scan-button").disabled = false; }
}

async function selectDisk(id) {
  state.selected = id;
  state.arkReady = false;
  renderDisks(state.scan.disks);
  try { renderPreview(await window.aiark.preview(id)); }
  catch (error) { toast(error); }
}

async function prepare() {
  const input = $("#confirmation");
  if (input.value !== state.preview.confirmation) return toast(new Error("The confirmation does not match this disk."));
  try {
    const result = await window.aiark.prepare(state.selected, input.value);
    state.arkReady = true;
    input.value = "";
    renderModels(state.scan.compatibility);
    toastSuccess(`Ark prepared at ${result.root}`);
  } catch (error) { toast(error); }
}

function toastSuccess(message) {
  const node = $("#toast");
  node.style.color = "var(--green)";
  node.style.borderColor = "rgba(130,247,165,.3)";
  node.textContent = message;
  node.classList.remove("hidden");
  setTimeout(() => { node.classList.add("hidden"); node.removeAttribute("style"); }, 5000);
}

async function modelAction(action, id) {
  if (!state.selected || !state.arkReady) return toast(new Error("Select and prepare an ark first."));
  try {
    const result = action === "download"
      ? await window.aiark.downloadModel(id, state.selected)
      : await window.aiark.verifyModel(id, state.selected);
    toastSuccess(action === "download" ? `Model ${id} is verified on the ark.` : result.ok ? `Checksum OK for ${id}.` : `Checksum failed for ${id}.`);
  } catch (error) { toast(error); }
}

async function runtimeAction(action) {
  const box = $("#runtime-result");
  box.classList.remove("hidden");
  box.textContent = action === "plan" ? "Resolving a native build…" : "Installing verified runtime locally…";
  try {
    const result = action === "plan" ? await window.aiark.planRuntime("llama.cpp") : await window.aiark.installRuntime("llama.cpp");
    box.textContent = JSON.stringify(result, null, 2);
  } catch (error) { box.textContent = error?.message || String(error); toast(error); }
}

async function cluster() {
  const box = $("#cluster-result");
  box.classList.remove("hidden");
  box.textContent = "Listening on the local network…";
  try {
    const peers = await window.aiark.discoverCluster();
    box.textContent = peers.length ? peers.map((peer) => `${peer.hostname} · ${peer.platform}/${peer.arch} · ${peer.address}`).join("\n") : "No AiArk peers found.";
  } catch (error) { box.textContent = error?.message || String(error); toast(error); }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "select-disk") await selectDisk(target.dataset.id);
  if (action === "prepare") await prepare();
  if (action === "format-preview") {
    try { const result = await window.aiark.formatPreview(state.selected); const box = $("#format-result"); box.textContent = `${result.summary.join("\n")}\n\nRequired destructive token (not accepted by this MVP):\n${result.confirmation}`; box.classList.remove("hidden"); }
    catch (error) { toast(error); }
  }
  if (action === "download-model") await modelAction("download", target.dataset.id);
  if (action === "verify-model") await modelAction("verify", target.dataset.id);
  if (action === "runtime-plan") await runtimeAction("plan");
  if (action === "runtime-install") await runtimeAction("install");
  if (action === "cluster") await cluster();
});

$("#scan-button").addEventListener("click", rescan);
window.aiark.onDownloadProgress((progress) => {
  const wrapper = $("#progress");
  const percent = progress.totalBytes ? Math.min(100, progress.downloadedBytes / progress.totalBytes * 100) : 0;
  wrapper.classList.remove("hidden");
  $("#progress-label").textContent = `${percent.toFixed(1)}%`;
  $("#progress-bar").style.width = `${percent}%`;
  if (percent >= 100) setTimeout(() => wrapper.classList.add("hidden"), 1200);
});

rescan();
