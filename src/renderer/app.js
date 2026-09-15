const state = { scan: null, selected: null, preview: null, arkReady: false };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) { amount /= 1000; index += 1; }
  return `${amount.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function platformName(platform) {
  return ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[platform] || platform;
}

function formatName(value) {
  return value ? String(value).toUpperCase() : "без формата";
}

function schemeName(value) {
  if (/guid|gpt/i.test(value || "")) return "GPT";
  return value || "без схемы";
}

function showToast(message, success = false) {
  const node = $("#toast");
  node.textContent = message?.message || String(message);
  node.classList.toggle("success", success);
  node.classList.remove("hidden");
  setTimeout(() => node.classList.add("hidden"), success ? 4500 : 6500);
}

function renderHardware(hardware) {
  const gpu = hardware.gpus?.map((item) => item.name).join(", ") || "только CPU";
  const node = $("#hardware-summary");
  node.classList.remove("skeleton");
  node.textContent = `${platformName(hardware.platform)} · ${hardware.arch} · ${bytes(hardware.ramBytes)} памяти · ${gpu}`;
}

function diskPresentation(assessment) {
  if (assessment.arkPrepared) return { label: "AiArk готов", tone: "good" };
  if (assessment.canPrepare) return { label: "Готов", tone: "good" };
  if (!assessment.eligibleSize) return { label: "Малый объём", tone: "bad" };
  return { label: "Нужно подготовить", tone: "warn" };
}

function renderDisks(disks) {
  const list = $("#disk-list");
  $("#disk-count").textContent = disks.length ? `${disks.length} найден${disks.length === 1 ? "" : "о"}` : "";
  if (!disks.length) {
    list.innerHTML = '<div class="empty-state">Подключите внешний диск объёмом от 4 ТБ и нажмите «Обновить».</div>';
    return;
  }
  list.innerHTML = disks.map((assessment) => {
    const disk = assessment.disk;
    const volume = assessment.mountedWritableVolume || disk.volumes?.find((item) => item.mountPoint) || disk.volumes?.[0];
    const selected = state.selected === disk.id ? " selected" : "";
    const presentation = diskPresentation(assessment);
    const meta = `${bytes(disk.sizeBytes)} · ${formatName(volume?.filesystem)} · ${schemeName(disk.partitionScheme)}`;
    return `<button class="disk-card${selected}" data-action="select-disk" data-id="${escapeHtml(disk.id)}">
      <div class="disk-main">
        <div class="disk-title"><h3>${escapeHtml(disk.name)}</h3><span class="status ${presentation.tone}">${presentation.label}</span></div>
        <p class="disk-meta">${escapeHtml(meta)}</p>
      </div>
      <span class="disk-chevron" aria-hidden="true">›</span>
    </button>`;
  }).join("");
}

function compatibilityPresentation(status) {
  return ({ recommended: ["Рекомендуется", "recommended"], compatible: ["Подходит", "compatible"], limited: ["Медленно", "limited"], incompatible: ["Не подходит", "incompatible"] })[status] || [status, "warn"];
}

function renderModels(results) {
  const compatible = results.filter((result) => result.status !== "incompatible").length;
  $("#model-summary-meta").textContent = `${compatible} из ${results.length} подходят этому компьютеру`;
  $("#model-list").innerHTML = results.map((result) => {
    const model = result.model;
    const [label, tone] = compatibilityPresentation(result.status);
    const disabled = result.status === "incompatible" || !state.arkReady ? "disabled" : "";
    return `<article class="model-row">
      <div><h3>${escapeHtml(model.name)}</h3><div class="model-meta">${escapeHtml(`${model.parameterCount} · ${model.quantization} · ${bytes(model.artifact.sizeBytes)}`)}</div></div>
      <span class="status ${tone}">${escapeHtml(label)}</span>
      <div class="model-actions"><button class="button button-secondary" data-action="verify-model" data-id="${escapeHtml(model.id)}" ${disabled}>Проверить</button><button class="button button-primary" data-action="download-model" data-id="${escapeHtml(model.id)}" ${disabled}>Добавить</button></div>
    </article>`;
  }).join("");
}

function blockerFor(assessment) {
  const disk = assessment.disk;
  const volume = disk.volumes?.find((item) => item.mountPoint) || disk.volumes?.[0];
  if (!assessment.eligibleSize) return "Нужен внешний диск объёмом не менее 4 ТБ.";
  if (!assessment.recommendedScheme) return "Для универсального AiArk нужна схема разделов GUID (GPT).";
  if (!assessment.recommendedFormat) return `Сейчас диск использует ${formatName(volume?.filesystem)}. Для Windows, macOS и Linux нужен ExFAT + GPT.`;
  if (!assessment.mountedWritableVolume) return "Диск доступен только для чтения или не подключён как обычный том.";
  return "Диск пока не соответствует безопасному профилю AiArk.";
}

function detailList(items) {
  return items.filter(Boolean).length ? `<ul>${items.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

function renderPreview(preview) {
  state.preview = preview;
  $("#preview-section").classList.remove("hidden");
  const assessment = state.scan.disks.find((item) => item.disk.id === state.selected);
  state.arkReady = Boolean(assessment?.arkPrepared);

  if (state.arkReady) {
    $("#preview-card").innerHTML = `<div class="decision"><div class="decision-head"><div><h3>AiArk готов к работе</h3><p class="decision-copy">Диск подготовлен. Теперь можно добавлять и проверять модели.</p></div><span class="status good">Готов</span></div><details class="technical-details"><summary>Где находится хранилище</summary>${detailList([assessment.arkRoot])}</details></div>`;
  } else if (preview.canPrepare) {
    $("#preview-card").innerHTML = `<div class="decision"><div class="decision-head"><div><h3>Диск готов</h3><p class="decision-copy">Проверка пройдена. AiArk создаст только свои папки — остальные файлы не изменятся.</p></div><span class="status good">Без форматирования</span></div><div class="confirmation-wrap"><label for="confirmation">Для подтверждения введите <code>${escapeHtml(preview.confirmation)}</code></label><input id="confirmation" class="confirmation" autocomplete="off" spellcheck="false" placeholder="Введите код подтверждения" /></div><div class="button-row"><button data-action="prepare" class="button button-primary">Создать AiArk</button></div><details class="technical-details"><summary>Что будет создано</summary>${detailList(preview.creates)}</details></div>`;
  } else {
    $("#preview-card").innerHTML = `<div class="decision"><div class="decision-head"><div><h3>Диск нужно подготовить</h3><p class="decision-copy">${escapeHtml(blockerFor(assessment))}</p></div><span class="status warn">Требует внимания</span></div><div class="button-row"><button data-action="format-preview" class="button button-primary">Как подготовить диск</button></div><div id="format-result" class="hidden"></div><details class="technical-details"><summary>Технические подробности</summary>${detailList(preview.warnings)}</details></div>`;
  }
  renderModels(state.scan.compatibility);
}

async function selectDisk(id) {
  state.selected = id;
  state.arkReady = false;
  renderDisks(state.scan.disks);
  try { renderPreview(await window.aiark.preview(id)); }
  catch (error) { showToast(error); }
}

async function rescan() {
  const button = $("#scan-button");
  button.disabled = true;
  button.textContent = "Проверяем…";
  try {
    const previous = state.selected;
    state.scan = await window.aiark.scan();
    renderHardware(state.scan.hardware);
    renderModels(state.scan.compatibility);
    const available = state.scan.disks.some((item) => item.disk.id === previous);
    state.selected = available ? previous : state.scan.disks.length === 1 ? state.scan.disks[0].disk.id : null;
    renderDisks(state.scan.disks);
    if (state.selected) await selectDisk(state.selected);
    else {
      state.preview = null;
      state.arkReady = false;
      $("#preview-section").classList.add("hidden");
    }
  } catch (error) { showToast(error); }
  finally { button.disabled = false; button.textContent = "Обновить"; }
}

async function prepare() {
  const input = $("#confirmation");
  if (input.value !== state.preview.confirmation) return showToast("Код подтверждения не совпадает.");
  try {
    const result = await window.aiark.prepare(state.selected, input.value);
    const assessment = state.scan.disks.find((item) => item.disk.id === state.selected);
    assessment.arkPrepared = true;
    assessment.arkRoot = result.root;
    state.arkReady = true;
    renderDisks(state.scan.disks);
    renderPreview(state.preview);
    showToast("AiArk создан. Можно добавлять модели.", true);
  } catch (error) { showToast(error); }
}

async function modelAction(action, id) {
  if (!state.selected || !state.arkReady) return showToast("Сначала подготовьте диск AiArk.");
  try {
    const result = action === "download" ? await window.aiark.downloadModel(id, state.selected) : await window.aiark.verifyModel(id, state.selected);
    const message = action === "download" ? "Модель загружена и проверена." : result.ok ? "Контрольная сумма совпадает." : "Проверка не пройдена.";
    showToast(message, action === "download" || result.ok);
  } catch (error) { showToast(error); }
}

async function runtimeAction(action) {
  const box = $("#runtime-result");
  box.classList.remove("hidden");
  box.textContent = action === "plan" ? "Подбираем версию для этого компьютера…" : "Устанавливаем движок на этот компьютер…";
  try {
    const result = action === "plan" ? await window.aiark.planRuntime("llama.cpp") : await window.aiark.installRuntime("llama.cpp");
    box.textContent = action === "plan" ? `${result.archiveName}\n${result.accelerator} · ${bytes(result.sizeBytes)}\nЛокальная папка: ${result.installDirectory}` : `Готово\n${result.executable || result.installDirectory || "Движок установлен локально"}`;
  } catch (error) { box.textContent = error?.message || String(error); showToast(error); }
}

async function cluster() {
  const box = $("#cluster-result");
  box.classList.remove("hidden");
  box.textContent = "Ищем AiArk в локальной сети…";
  try {
    const peers = await window.aiark.discoverCluster();
    box.textContent = peers.length ? peers.map((peer) => `${peer.hostname} · ${platformName(peer.platform)} · ${peer.address}`).join("\n") : "Другие компьютеры с AiArk не найдены.";
  } catch (error) { box.textContent = error?.message || String(error); showToast(error); }
}

function showFormatGuide(result) {
  const box = $("#format-result");
  box.innerHTML = `<div class="format-guide"><strong>Перед началом сохраните нужные файлы с диска.</strong><ol><li>Откройте системную утилиту для управления дисками.</li><li>Выберите весь физический диск ${escapeHtml(result.target)}.</li><li>Укажите формат ExFAT и схему GUID (GPT).</li><li>После завершения вернитесь в AiArk и нажмите «Обновить».</li></ol><p>AiArk сам форматирование не запускает.</p></div>`;
  box.classList.remove("hidden");
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "select-disk") await selectDisk(target.dataset.id);
  if (action === "prepare") await prepare();
  if (action === "format-preview") {
    try { showFormatGuide(await window.aiark.formatPreview(state.selected)); }
    catch (error) { showToast(error); }
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
