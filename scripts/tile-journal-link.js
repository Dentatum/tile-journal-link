const MODULE_ID = "tile-journal-link";
const FLAG = "config";
const i18n = (key) => game.i18n.localize(`TJL.${key}`);
const DEFAULTS = {
  enabled: false,
  journalUuid: "",
  titleEnabled: false,
  title: "",
  titlePosition: "top",
  titleFontSize: 18,
  titleFontFamily: "Signika",
  titleColor: "#FFFFFF",
  glowEnabled: false,
  glowColor: "#FFAA00",
  glowWidth: 7,
  glowStrength: 3
};

function configFor(tile) {
  return { ...DEFAULTS, ...(tile.document.getFlag(MODULE_ID, FLAG) ?? {}) };
}

function colorNumber(value) {
  const parsed = Number.parseInt(String(value ?? "#FFAA00").replace("#", ""), 16);
  return Number.isFinite(parsed) ? parsed : 0xFFAA00;
}

const interceptedTileConfigRegistries = new WeakSet();

function registerTileConfigTab(TileConfigClass = foundry.applications.sheets.TileConfig) {
  if (typeof TileConfigClass !== "function") return false;

  let changed = false;

  // Merge, rather than replace, the TABS declared by Foundry, Monk's Active Tiles,
  // and any other module which extends TileConfig. Our tab is always appended last.
  const currentTabs = TileConfigClass.TABS ?? {};
  const tabs = foundry.utils.deepClone(currentTabs);
  tabs.sheet ??= {
    initial: "position",
    labelPrefix: "TILE.TABS",
    tabs: []
  };
  tabs.sheet.tabs ??= [];

  const mergedTabs = tabs.sheet.tabs
    .filter(tab => tab.id !== "tile-journal-link");
  mergedTabs.push({
    id: "tile-journal-link",
    icon: "fas fa-book-open",
    label: "TJL.Tab"
  });

  if (JSON.stringify(mergedTabs) !== JSON.stringify(currentTabs.sheet?.tabs ?? [])) {
    tabs.sheet.tabs = mergedTabs;
    TileConfigClass.TABS = tabs;
    changed = true;
  }

  // Preserve all module PARTS. The custom panel belongs immediately before
  // the native footer, after the parts contributed by other modules.
  const currentParts = TileConfigClass.PARTS ?? {};
  const parts = foundry.utils.deepClone(currentParts);
  const entries = Object.entries(parts)
    .filter(([key]) => key !== "tile-journal-link");

  const customPart = {
    template: `modules/${MODULE_ID}/templates/tile-journal-link.hbs`,
    scrollable: []
  };

  const footerIndex = entries.findIndex(([key]) => key === "footer");
  if (footerIndex >= 0) entries.splice(footerIndex, 0, ["tile-journal-link", customPart]);
  else entries.push(["tile-journal-link", customPart]);

  const nextParts = Object.fromEntries(entries);
  const oldKeys = Object.keys(currentParts);
  const newKeys = Object.keys(nextParts);
  const partChanged = JSON.stringify(oldKeys) !== JSON.stringify(newKeys)
    || currentParts["tile-journal-link"]?.template !== customPart.template;

  if (partChanged) {
    TileConfigClass.PARTS = nextParts;
    changed = true;
  }

  // A derived TileConfig may override these methods without calling super.
  // Patch the actual class used for the document sheet as well as core TileConfig.
  patchTileConfigContext(TileConfigClass);
  patchTileConfigRenderLifecycle(TileConfigClass);

  return changed;
}

function installTileConfigClassInterceptor() {
  const registry = CONFIG.Tile?.sheetClasses?.base?.["core.TileConfig"];
  if (!registry || interceptedTileConfigRegistries.has(registry)) return;

  const descriptor = Object.getOwnPropertyDescriptor(registry, "cls");
  if (descriptor?.configurable === false) {
    registerTileConfigTab(registry.cls);
    return;
  }

  let currentClass = descriptor?.get
    ? descriptor.get.call(registry)
    : (descriptor?.value ?? registry.cls);

  // Do not replace an existing accessor unless it has a setter which can be chained.
  if (descriptor?.get && !descriptor.set) {
    registerTileConfigTab(currentClass);
    return;
  }

  Object.defineProperty(registry, "cls", {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      return descriptor?.get ? descriptor.get.call(this) : currentClass;
    },
    set(nextClass) {
      if (descriptor?.set) descriptor.set.call(this, nextClass);
      else currentClass = nextClass;

      const activeClass = descriptor?.get ? descriptor.get.call(this) : currentClass;
      registerTileConfigTab(activeClass);
    }
  });

  interceptedTileConfigRegistries.add(registry);
  registerTileConfigTab(currentClass);
}

function registerActiveTileConfigClass() {
  const sheetClass = CONFIG.Tile?.sheetClasses?.base?.["core.TileConfig"]?.cls;
  if (sheetClass) registerTileConfigTab(sheetClass);
}

function ensureTileJournalTabOnRenderedSheet(app) {
  if (!app || app.document?.documentName !== "Tile") return;

  const changed = registerTileConfigTab(app.constructor);
  if (!changed || app._tjlTabRefreshPending) return;

  // If another module replaced TileConfig after our ready hook, the first render
  // may have been prepared without our part. Re-render once using the merged class.
  app._tjlTabRefreshPending = true;
  Promise.resolve().then(() => {
    app._tjlTabRefreshPending = false;
    if (app.rendered && !app._tjlTabRefreshDone) {
      app._tjlTabRefreshDone = true;
      app.render({ force: true });
    }
  });
}

function patchTileConfigContext(TileConfig = foundry.applications.sheets.TileConfig) {
  if (!TileConfig?.prototype || Object.hasOwn(TileConfig.prototype, "_tjlContextPatched")) return;

  const original = TileConfig.prototype._preparePartContext;
  if (typeof original !== "function") return;

  TileConfig.prototype._preparePartContext = async function(partId, context, options) {
    const partContext = await original.call(this, partId, context, options);
    if (partId !== "tile-journal-link") return partContext;

    const stored = this.document.getFlag(MODULE_ID, FLAG) ?? {};
    const fontConfig = foundry.applications?.settings?.menus?.FontConfig;
    let fontChoices = {};
    try {
      fontChoices = fontConfig?.getAvailableFontChoices?.() ?? {};
    } catch (error) {
      console.warn(`${MODULE_ID} | No se pudieron obtener las fuentes disponibles`, error);
    }
    if (!Object.keys(fontChoices).length) {
      fontChoices = Object.fromEntries(Object.keys(CONFIG.fontDefinitions ?? {}).map(name => [name, name]));
    }
    const titleFontFamily = stored.titleFontFamily ?? DEFAULTS.titleFontFamily;
    if (titleFontFamily && !Object.hasOwn(fontChoices, titleFontFamily)) {
      fontChoices[titleFontFamily] = titleFontFamily;
    }

    partContext.tjl = {
      ...DEFAULTS,
      ...stored,
      fontChoices: Object.entries(fontChoices)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([value, label]) => ({ value, label }))
    };
    return partContext;
  };
  Object.defineProperty(TileConfig.prototype, "_tjlContextPatched", { value: true });
}

function getDragPayloads(event) {
  const payloads = [];
  const editor = globalThis.TextEditor
    ?? foundry.applications?.ux?.TextEditor?.implementation
    ?? foundry.applications?.ux?.TextEditor;

  try {
    const parsed = editor?.getDragEventData?.(event);
    if (parsed) payloads.push(parsed);
  } catch (error) {
    console.debug(`${MODULE_ID} | TextEditor no ha podido leer el arrastre`, error);
  }

  const transfer = event.dataTransfer;
  if (!transfer) return payloads;

  const types = Array.from(transfer.types ?? []);
  for (const type of new Set(["application/x-tile-journal-link", ...types, "application/json", "text/plain", "text/html", "text/uri-list"])) {
    let raw = "";
    try { raw = transfer.getData(type); } catch { /* Tipo MIME no disponible */ }
    if (!raw) continue;

    if (type === "text/html") {
      try {
        const parsed = new DOMParser().parseFromString(raw, "text/html");
        for (const node of parsed.querySelectorAll("[data-uuid], [data-document-uuid], [data-id], a[href]")) {
          payloads.push({
            uuid: node.getAttribute("data-uuid") || node.getAttribute("data-document-uuid"),
            id: node.getAttribute("data-id"),
            type: node.getAttribute("data-type"),
            href: node.getAttribute("href")
          });
        }
      } catch (error) {
        console.debug(`${MODULE_ID} | HTML de arrastre no reconocido`, error);
      }
      payloads.push(raw);
      continue;
    }

    try {
      payloads.push(JSON.parse(raw));
    } catch {
      payloads.push(raw);
    }
  }
  return payloads;
}

function normalizeJournalUuid(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const patterns = [
    /@UUID\[([^\]]+)\]/i,
    /(?:^|[^\w])((?:JournalEntry|Compendium\.[\w.-]+\.JournalEntry)\.[\w-]+(?:\.JournalEntryPage\.[\w-]+)?)(?:$|[^\w])/i
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1].trim();
  }
  if (/^(?:JournalEntry\.[\w-]+(?:\.JournalEntryPage\.[\w-]+)?|Compendium\.[\w.-]+\.JournalEntry\.[\w-]+(?:\.JournalEntryPage\.[\w-]+)?)$/.test(input)) {
    return input;
  }
  return null;
}

function journalUuidFromPayload(payload, depth = 0) {
  if (payload === null || payload === undefined || depth > 6) return null;

  if (typeof payload === "string") return normalizeJournalUuid(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const uuid = journalUuidFromPayload(item, depth + 1);
      if (uuid) return uuid;
    }
    return null;
  }
  if (typeof payload !== "object") return null;

  for (const key of ["uuid", "documentUuid", "documentUUID", "uuidString", "href", "text"]) {
    const uuid = normalizeJournalUuid(payload[key]);
    if (uuid) return uuid;
  }

  for (const key of ["data", "document", "entry", "payload", "documentData", "source", "dragData"]) {
    const uuid = journalUuidFromPayload(payload[key], depth + 1);
    if (uuid) return uuid;
  }

  const type = payload.type ?? payload.documentName ?? payload.documentType ?? payload.data?.type;
  const id = payload.id ?? payload._id ?? payload.documentId ?? payload.data?.id ?? payload.data?._id;
  const pack = payload.pack ?? payload.collection ?? payload.compendium;

  if (type === "JournalEntry" && id) {
    if (pack) return `Compendium.${pack}.JournalEntry.${id}`;
    const entry = game.journal?.get?.(id);
    return entry?.uuid ?? `JournalEntry.${id}`;
  }

  if (type === "JournalEntryPage" && id) {
    const parentUuid = payload.parentUuid ?? payload.journalUuid ?? payload.parent?.uuid;
    if (parentUuid) return `${parentUuid}.JournalEntryPage.${id}`;
    const parentId = typeof payload.parent === "string" ? payload.parent
      : payload.parentId ?? payload.parent?._id ?? payload.parent?.id ?? payload.journalId;
    if (parentId) {
      if (pack) return `Compendium.${pack}.JournalEntry.${parentId}.JournalEntryPage.${id}`;
      const journal = game.journal?.get?.(parentId);
      const page = journal?.pages?.get?.(id);
      return page?.uuid ?? (journal ? `${journal.uuid}.JournalEntryPage.${id}` : null);
    }

    // Some directory drag formats provide only the page ID. Search world journals.
    for (const journal of game.journal ?? []) {
      const page = journal.pages?.get?.(id);
      if (page) return page.uuid;
    }
  }
  return null;
}

function getJournalUuidFromDrop(event) {
  for (const payload of getDragPayloads(event)) {
    const uuid = journalUuidFromPayload(payload);
    if (uuid) return uuid;
  }
  return null;
}


function patchJournalDragSources() {
  const JournalDirectory = foundry.applications?.sidebar?.tabs?.JournalDirectory;
  const directoryPrototype = JournalDirectory?.prototype;
  if (directoryPrototype && !directoryPrototype._tjlDragPatched) {
    const original = directoryPrototype._getEntryDragData;
    if (typeof original === "function") {
      directoryPrototype._getEntryDragData = function(entryId, ...args) {
        const data = original.call(this, entryId, ...args);
        const attachUuid = payload => {
          if (!payload || typeof payload !== "object") return payload;
          const entry = game.journal?.get?.(entryId);
          return entry ? { ...payload, uuid: entry.uuid, documentName: "JournalEntry" } : payload;
        };
        return data && typeof data.then === "function" ? data.then(attachUuid) : attachUuid(data);
      };
    }
    Object.defineProperty(directoryPrototype, "_tjlDragPatched", { value: true });
  }

  const JournalEntrySheet = foundry.applications?.sheets?.journal?.JournalEntrySheet;
  const sheetPrototype = JournalEntrySheet?.prototype;
  if (sheetPrototype && !sheetPrototype._tjlPageDragPatched) {
    const original = sheetPrototype._onDragStart;
    if (typeof original === "function") {
      sheetPrototype._onDragStart = function(event) {
        const result = original.call(this, event);
        try {
          const target = event.target instanceof Element ? event.target.closest(
            "[data-uuid], [data-document-uuid], [data-page-id], [data-document-id], [data-id]"
          ) : null;
          const directUuid = target?.dataset?.uuid || target?.dataset?.documentUuid;
          let uuid = normalizeJournalUuid(directUuid);
          if (!uuid && target) {
            const pageId = target.dataset.pageId
              || (target.dataset.type === "JournalEntryPage" ? target.dataset.id : null);
            const page = pageId ? this.document?.pages?.get?.(pageId) : null;
            uuid = page?.uuid ?? null;
          }
          if (!uuid && target) {
            const id = target.dataset.documentId || target.dataset.entryId
              || (target.dataset.type === "JournalEntry" ? target.dataset.id : null);
            const entry = id ? game.journal?.get?.(id) : null;
            uuid = entry?.uuid ?? null;
          }
          if (uuid && event.dataTransfer) event.dataTransfer.setData("application/x-tile-journal-link", uuid);
        } catch (error) {
          console.debug(`${MODULE_ID} | No se pudo añadir UUID al arrastre de página`, error);
        }
        return result;
      };
    }
    Object.defineProperty(sheetPrototype, "_tjlPageDragPatched", { value: true });
  }

  if (document.documentElement.dataset.tjlDragStartBound !== "true") {
    document.documentElement.dataset.tjlDragStartBound = "true";
    document.addEventListener("dragstart", event => {
      const target = event.target instanceof Element ? event.target.closest(
        "[data-uuid], [data-document-uuid], [data-document-id], [data-entry-id]"
      ) : null;
      if (!target || !event.dataTransfer) return;
      let uuid = normalizeJournalUuid(target.dataset.uuid || target.dataset.documentUuid);
      if (!uuid) {
        const id = target.dataset.documentId || target.dataset.entryId;
        uuid = game.journal?.get?.(id)?.uuid ?? null;
      }
      if (uuid) {
        try { event.dataTransfer.setData("application/x-tile-journal-link", uuid); }
        catch (error) { console.debug(`${MODULE_ID} | No se pudo añadir MIME UUID`, error); }
      }
    }, true);
  }
}

function resolveDropTarget(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  const direct = target.closest("#tjl-journal-uuid");
  if (direct) return direct;
  const zone = target.closest(".tjl-uuid-drop-zone");
  return zone?.querySelector("#tjl-journal-uuid") ?? null;
}

function handleJournalDrop(event) {
  const input = resolveDropTarget(event);
  if (!input) return;
  event.preventDefault();
  event.stopPropagation();

  const uuid = getJournalUuidFromDrop(event);
  if (!uuid) {
    console.warn(`${MODULE_ID} | Datos de arrastre de Journal no reconocidos`, {
      types: Array.from(event.dataTransfer?.types ?? []),
      payloads: getDragPayloads(event)
    });
    ui.notifications.warn(i18n("DropUnsupported"));
    return;
  }

  input.value = uuid;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  ui.notifications.info(i18n("DropSuccess"));
}


function bindTileConfigControls(app) {
  const tab = app.element?.querySelector?.('[data-tab="tile-journal-link"]');
  if (!tab || tab.dataset.tjlBound === "true") return;
  tab.dataset.tjlBound = "true";

  const dropField = tab.querySelector("#tjl-journal-uuid");
  if (dropField) {
    dropField.addEventListener("dragenter", event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  dropField.addEventListener("dragover", event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
    dropField.addEventListener("drop", handleJournalDrop);
  }

}


function installFontSizeSynchronization() {
  if (document.documentElement.dataset.tjlFontSizeSync === "true") return;
  document.documentElement.dataset.tjlFontSizeSync = "true";

  const clampFontSize = value => {
    const number = Number.parseInt(String(value), 10);
    if (!Number.isFinite(number)) return null;
    return Math.min(96, Math.max(6, number));
  };

  const synchronize = event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    const isSlider = target.id === "tjl-title-font-size-slider";
    const isNumber = target.id === "tjl-title-font-size";
    if (!isSlider && !isNumber) return;

    const tab = target.closest('[data-tab="tile-journal-link"]');
    if (!tab) return;

    const slider = tab.querySelector("#tjl-title-font-size-slider");
    const number = tab.querySelector("#tjl-title-font-size");
    if (!slider || !number) return;

    if (isSlider) {
      // The range control is already constrained by min/max/step.
      number.value = slider.value;
      return;
    }

    const value = clampFontSize(number.value);
    if (value === null) return;

    // While typing, don't overwrite an empty or partially-entered value.
    // Synchronize only valid numeric values.
    slider.value = String(value);

    if (event.type === "change") {
      number.value = String(value);
      slider.value = String(value);
    }
  };

  // Capture phase runs before Foundry's form handlers. No synthetic events are
  // dispatched, avoiding loops and keeping one named input as the saved value.
  document.addEventListener("input", synchronize, true);
  document.addEventListener("change", synchronize, true);

  // Initialize both controls when a TileConfig part is first rendered.
  Hooks.on("renderTileConfig", app => {
    const tab = app.element?.querySelector?.('[data-tab="tile-journal-link"]');
    const slider = tab?.querySelector?.("#tjl-title-font-size-slider");
    const number = tab?.querySelector?.("#tjl-title-font-size");
    if (!slider || !number) return;
    const initial = clampFontSize(number.value) ?? 18;
    number.value = String(initial);
    slider.value = String(initial);
  });
}

function patchTileConfigRenderLifecycle(TileConfig = foundry.applications.sheets.TileConfig) {
  if (!TileConfig?.prototype || Object.hasOwn(TileConfig.prototype, "_tjlRenderPatched")) return;

  const originalOnRender = TileConfig.prototype._onRender;
  if (typeof originalOnRender !== "function") return;

  TileConfig.prototype._onRender = async function(context, options) {
    await originalOnRender.call(this, context, options);
    bindTileConfigControls(this);
  };

  Object.defineProperty(TileConfig.prototype, "_tjlRenderPatched", { value: true });
}

let lastJournalOpen = { tileId: null, timestamp: 0 };

/**
 * Check whether the current user may observe the linked Journal document.
 * This is intentionally called only from openLinkedJournal (double-click),
 * never from the hover/title/glow code.
 *
 * JournalEntryPage.testUserPermission evaluates the page's effective ownership,
 * including inherited parent ownership and page-specific overrides.
 */
function canCurrentUserOpenJournal(targetDocument) {
  const user = game.user;

  // A GM always has access, regardless of explicit ownership values.
  if (user?.isGM) return true;
  if (!user || !targetDocument) return false;

  const observerPermission = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER;
  if (observerPermission === undefined) {
    console.error(`${MODULE_ID} | CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER no está disponible.`);
    return false;
  }

  if (typeof targetDocument.testUserPermission !== "function") {
    console.error(`${MODULE_ID} | El documento vinculado no expone testUserPermission().`, targetDocument);
    return false;
  }

  try {
    // OBSERVER is the minimum level required to open and read Journal content.
    return targetDocument.testUserPermission(user, observerPermission);
  } catch (error) {
    console.error(`${MODULE_ID} | Error al comprobar los permisos del Journal`, error);
    return false;
  }
}

async function openLinkedJournal(tile) {
  const now = Date.now();
  if (lastJournalOpen.tileId === tile.id && (now - lastJournalOpen.timestamp) < 750) return;
  lastJournalOpen = { tileId: tile.id, timestamp: now };

  const cfg = configFor(tile);
  if (!cfg.enabled || !cfg.journalUuid?.trim()) return;

  try {
    const document = await fromUuid(cfg.journalUuid.trim());
    if (!document) {
      // Foundry may return null for a document the current user cannot observe.
      // Keep this silent for players; only GMs receive a broken-UUID warning.
      if (game.user?.isGM) ui.notifications.warn(i18n("Warn.PageNotFound"));
      return;
    }

    let journal = document;
    let pageId = null;
    if (document.documentName === "JournalEntryPage") {
      journal = document.parent;
      pageId = document.id;
    } else if (document.documentName !== "JournalEntry") {
      ui.notifications.warn(i18n("Warn.InvalidDocument"));
      return;
    }

    // Permission is validated only after a double-click has resolved the target.
    // Hover visuals are deliberately unaffected: all users can still see title/glow.
    if (!canCurrentUserOpenJournal(document)) return;

    const sheet = journal?.sheet;
    if (!sheet) {
      ui.notifications.warn(i18n("Warn.PageNotFound"));
      return;
    }

    // JournalEntrySheet is ApplicationV2 in Foundry 14. Older/custom V1 sheets
    // still use render(force, options).
    if (sheet.isV2 || sheet.constructor?.BASE_APPLICATION) {
      await sheet.render({ force: true, ...(pageId ? { pageId } : {}) });
    } else {
      sheet.render(true, pageId ? { pageId } : {});
    }
  } catch (error) {
    console.debug(`${MODULE_ID} | No se pudo abrir el Journal`, error);
    // Permission failures are intentionally silent for non-GM users.
    if (game.user?.isGM) ui.notifications.error(i18n("Warn.InvalidUUID"));
  }
}

function getCanvasElement() {
  return canvas?.app?.canvas
    ?? canvas?.app?.renderer?.canvas
    ?? canvas?.app?.view
    ?? null;
}

/**
 * True only when the browser's topmost DOM element at this screen coordinate
 * is the Foundry canvas itself. A Journal sheet, dialog, sidebar, HUD, toolbar,
 * or any other overlay therefore blocks interaction with the scene underneath.
 */
function isClientPointOnCanvas(clientX, clientY) {
  const view = getCanvasElement();
  if (!view || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

  const rect = view.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;

  const topmost = document.elementFromPoint(clientX, clientY);
  return topmost === view || Boolean(topmost && view.contains(topmost));
}

/**
 * Check both the event's composed path and the browser's topmost hit-test.
 * This prevents a document-level capture listener from treating an event
 * addressed to a window above the canvas as a click on the scene below it.
 */
function isPointerEventOnCanvas(event) {
  if (!event || !isClientPointOnCanvas(event.clientX, event.clientY)) return false;

  const view = getCanvasElement();
  const target = event.target;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return target === view || Boolean(target && view.contains(target)) || path.includes(view);
}

function tileGlowFilterId(tile) {
  return `${MODULE_ID}-hover-glow-${tile.id}`;
}

function removeTitle(tile) {
  const label = tile._tjlLabel;
  if (!label) return;
  label.remove();
  tile._tjlLabel = null;
}

function tileCanvasBounds(tile) {
  const bounds = tile.bounds;
  if (bounds) {
    return {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width) || Number(tile.document.width) || 0,
      height: Number(bounds.height) || Number(tile.document.height) || 0
    };
  }
  return {
    x: Number(tile.document.x) || 0,
    y: Number(tile.document.y) || 0,
    width: Number(tile.document.width) || 0,
    height: Number(tile.document.height) || 0
  };
}

function canvasPointToClient(point) {
  if (typeof canvas.clientCoordinatesFromCanvas === "function") {
    return canvas.clientCoordinatesFromCanvas(point);
  }
  const view = getCanvasElement();
  const rect = view?.getBoundingClientRect();
  const scale = canvas.stage?.scale?.x || 1;
  const translation = canvas.stage?.position;
  if (!rect) return point;
  return {
    x: rect.left + (point.x * scale) + (translation?.x || 0),
    y: rect.top + (point.y * scale) + (translation?.y || 0)
  };
}

function positionTitle(tile) {
  const label = tile._tjlLabel;
  if (!label) return;
  const bounds = tileCanvasBounds(tile);
  const anchors = {
    top: { x: bounds.x + bounds.width / 2, y: bounds.y },
    bottom: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
    left: { x: bounds.x, y: bounds.y + bounds.height / 2 },
    right: { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  };
  const point = canvasPointToClient(anchors[tile._tjlTitlePosition] ?? anchors.top);
  label.style.left = `${point.x}px`;
  label.style.top = `${point.y}px`;
  const transforms = {
    top: "translate(-50%, calc(-100% - 8px))",
    bottom: "translate(-50%, 8px)",
    left: "translate(calc(-100% - 8px), -50%)",
    right: "translate(8px, -50%)",
    center: "translate(-50%, -50%)"
  };
  label.style.transform = transforms[tile._tjlTitlePosition] ?? transforms.top;
}

function getTitleOutlineColor(fontColor) {
  let hex = String(fontColor ?? "#FFFFFF").trim().replace("#", "");
  if (hex.length === 3) hex = hex.split("").map(char => char + char).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return "#000000";

  const red = parseInt(hex.slice(0, 2), 16) / 255;
  const green = parseInt(hex.slice(2, 4), 16) / 255;
  const blue = parseInt(hex.slice(4, 6), 16) / 255;
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  return luminance > 0.5 ? "#000000" : "#FFFFFF";
}

function applyTitle(tile, cfg) {
  const text = cfg.title?.trim() || tile.document.name || "";
  if (!text) return;

  const label = document.createElement("div");
  label.className = "tjl-hover-title";
  label.textContent = text;

  const fontColor = /^#[0-9a-fA-F]{6}$/.test(String(cfg.titleColor))
    ? cfg.titleColor
    : "#FFFFFF";
  const outlineColor = getTitleOutlineColor(fontColor);
  const fontFamily = String(cfg.titleFontFamily || "Signika").trim() || "Signika";
  const fontSize = Math.min(96, Math.max(6, Number(cfg.titleFontSize) || 18));

  Object.assign(label.style, {
    position: "fixed",
    zIndex: "100000",
    pointerEvents: "none",
    color: fontColor,
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: "600",
    lineHeight: "1.2",
    textAlign: "center",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxWidth: `${Math.max(120, Math.min(420, Number(tile.document.width) || 200))}px`,
    padding: "0",
    margin: "0",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    boxShadow: "none",
    WebkitTextStroke: `1.5px ${outlineColor}`,
    paintOrder: "stroke fill",
    textShadow: [
      `-1px -1px 0 ${outlineColor}`,
      `0 -1px 0 ${outlineColor}`,
      `1px -1px 0 ${outlineColor}`,
      `-1px 0 0 ${outlineColor}`,
      `1px 0 0 ${outlineColor}`,
      `-1px 1px 0 ${outlineColor}`,
      `0 1px 0 ${outlineColor}`,
      `1px 1px 0 ${outlineColor}`
    ].join(", ")
  });

  document.body.append(label);
  tile._tjlLabel = label;
  tile._tjlTitlePosition = cfg.titlePosition;
  positionTitle(tile);
}

function normalizePixiFilters(filters) {
  if (!filters) return [];
  return Array.isArray(filters) ? [...filters] : [filters];
}

function createLocalGlowFilter(cfg) {
  const PIXIRef = globalThis.PIXI;
  if (!PIXIRef) return null;

  const radius = Math.max(1, Number(cfg.glowWidth) || 7);
  const strength = Math.max(0.1, Number(cfg.glowStrength) || 3);
  const color = colorNumber(cfg.glowColor);

  // Prefer an already-loaded GlowFilter, but do not call Token Magic FX here:
  // its public add/update helpers persist filter data on the Tile document.
  const GlowFilter = PIXIRef.filters?.GlowFilter ?? PIXIRef.GlowFilter;
  if (GlowFilter) {
    const filter = new GlowFilter({
      distance: radius,
      outerStrength: strength,
      innerStrength: 0,
      color,
      quality: 0.5
    });
    filter.padding = radius + 2;
    return filter;
  }

  // Foundry V14 uses PixiJS v8. Build an equivalent local-only edge glow using
  // Pixi's Filter.from API; this changes only the current client's Tile mesh.
  const Filter = PIXIRef.Filter;
  if (typeof Filter?.from !== "function") return null;

  const red = ((color >> 16) & 0xFF) / 255;
  const green = ((color >> 8) & 0xFF) / 255;
  const blue = (color & 0xFF) / 255;
  const fragment = `
    in vec2 vTextureCoord;
    out vec4 finalColor;
    uniform sampler2D uTexture;
    uniform vec4 uInputSize;

    void main(void) {
      vec4 sourceColor = texture(uTexture, vTextureCoord);
      vec2 pixelStep = uInputSize.zw * ${radius.toFixed(2)};
      float surroundingAlpha = sourceColor.a;

      for (int i = 0; i < 8; i++) {
        float angle = 6.28318530718 * float(i) / 8.0;
        vec2 direction = vec2(cos(angle), sin(angle));
        surroundingAlpha = max(surroundingAlpha,
          texture(uTexture, vTextureCoord + direction * pixelStep * 0.5).a);
        surroundingAlpha = max(surroundingAlpha,
          texture(uTexture, vTextureCoord + direction * pixelStep).a);
      }

      float haloAlpha = clamp(
        (surroundingAlpha - sourceColor.a) * ${strength.toFixed(3)},
        0.0,
        1.0
      );
      vec3 glowColor = vec3(${red.toFixed(5)}, ${green.toFixed(5)}, ${blue.toFixed(5)});
      vec3 outputColor = sourceColor.rgb + glowColor * haloAlpha * (1.0 - sourceColor.a);
      float outputAlpha = max(sourceColor.a, haloAlpha);
      finalColor = vec4(outputColor, outputAlpha);
    }
  `;

  try {
    const filter = Filter.from({
      gl: { fragment },
      resources: {}
    });
    filter.padding = radius + 2;
    return filter;
  } catch (error) {
    console.error(`${MODULE_ID} | No se pudo crear el filtro de halo local`, error);
    return null;
  }
}

function applyGlow(tile, cfg) {
  if (!tile.mesh) return false;

  try {
    const filter = createLocalGlowFilter(cfg);
    if (!filter) {
      // Do not generate a UI notification on hover. In particular, do not try
      // Token Magic FX here because its updates require permission to edit Tile.
      if (!tile._tjlGlowWarningShown) {
        console.warn(`${MODULE_ID} | No hay un filtro PIXI Glow disponible para este cliente.`);
        tile._tjlGlowWarningShown = true;
      }
      return false;
    }

    const filters = normalizePixiFilters(tile.mesh.filters);
    tile._tjlLocalGlowFilter = filter;
    tile.mesh.filters = [...filters, filter];
    return true;
  } catch (error) {
    console.error(`${MODULE_ID} | Error al aplicar el halo local`, error);
    return false;
  }
}

function removeGlow(tile) {
  const filter = tile?._tjlLocalGlowFilter;
  if (!filter) return;

  try {
    if (tile.mesh) {
      const filters = normalizePixiFilters(tile.mesh.filters);
      const remaining = filters.filter(existing => existing !== filter);
      tile.mesh.filters = remaining.length ? remaining : null;
    }
    filter.destroy?.();
  } catch (error) {
    console.debug(`${MODULE_ID} | No se pudo retirar el halo local`, error);
  } finally {
    tile._tjlLocalGlowFilter = null;
  }
}

function applyHoverVisuals(tile) {
  const cfg = configFor(tile);
  if (!cfg.enabled || tile._tjlHoverActive) return;
  tile._tjlHoverActive = true;

  if (cfg.titleEnabled) {
    try {
      applyTitle(tile, cfg);
    } catch (error) {
      console.error(`${MODULE_ID} | No se pudo mostrar el título`, error);
    }
  }

  if (cfg.glowEnabled) applyGlow(tile, cfg);
}

function removeVisuals(tile) {
  if (!tile) return;
  tile._tjlHoverActive = false;
  removeTitle(tile);
  removeGlow(tile);
}

function pointInsideTile(tile, point) {
  // canvasCoordinatesFromClient returns scene-space coordinates. Tile.bounds
  // is also scene-space, whereas PIXI.Container.toLocal expects renderer-space.
  const bounds = tileCanvasBounds(tile);
  return point.x >= bounds.x && point.y >= bounds.y
    && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height;
}

function findLinkedTileAtClientPoint(clientX, clientY) {
  if (!canvas?.ready || !canvas.tiles?.placeables || !isClientPointOnCanvas(clientX, clientY)) return null;

  const point = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
  const placeables = [...canvas.tiles.placeables].reverse();
  return placeables.find(tile => {
    const cfg = configFor(tile);
    return cfg.enabled && (cfg.titleEnabled || cfg.glowEnabled)
      && tile.visible !== false && pointInsideTile(tile, point);
  }) ?? null;
}

let activeHoverTile = null;
let lastPointerClient = null;

function refreshTrackedHover(clientX, clientY) {
  lastPointerClient = { x: clientX, y: clientY };
  const next = findLinkedTileAtClientPoint(clientX, clientY);
  if (next === activeHoverTile) {
    if (activeHoverTile?._tjlLabel) positionTitle(activeHoverTile);
    return;
  }
  if (activeHoverTile) removeVisuals(activeHoverTile);
  activeHoverTile = next;
  if (activeHoverTile) applyHoverVisuals(activeHoverTile);
}

function clearTrackedHover() {
  if (activeHoverTile) removeVisuals(activeHoverTile);
  activeHoverTile = null;
}

function findLinkedTileAtCanvasPoint(point) {
  if (!point || !canvas?.ready || !canvas.tiles?.placeables) return null;
  return [...canvas.tiles.placeables].reverse().find(tile => {
    const cfg = configFor(tile);
    return cfg.enabled && Boolean(cfg.journalUuid?.trim())
      && tile.visible !== false && pointInsideTile(tile, point);
  }) ?? null;
}


function installCanvasHoverTracking() {
  if (document.documentElement.dataset.tjlHoverTracking === "true") return;
  document.documentElement.dataset.tjlHoverTracking = "true";

  document.addEventListener("pointermove", event => {
    if (!isPointerEventOnCanvas(event)) return clearTrackedHover();
    refreshTrackedHover(event.clientX, event.clientY);
  }, true);

  document.addEventListener("pointerleave", event => {
    if (event.target === getCanvasElement()) clearTrackedHover();
  }, true);

  Hooks.on("canvasPan", () => {
    if (lastPointerClient) refreshTrackedHover(lastPointerClient.x, lastPointerClient.y);
  });
  Hooks.on("canvasTearDown", clearTrackedHover);
}

function tileAtClientPointForClick(clientX, clientY) {
  if (!canvas?.ready || !canvas.tiles?.placeables || !isClientPointOnCanvas(clientX, clientY)) return null;

  const point = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
  return findLinkedTileAtCanvasPoint(point);
}

function canvasPointFromInteractionEvent(event) {
  const candidates = [
    event?.nativeEvent,
    event?.originalEvent,
    event?.data?.originalEvent,
    event?.data?.nativeEvent
  ];
  const native = candidates.find(candidate =>
    Number.isFinite(candidate?.clientX) && Number.isFinite(candidate?.clientY)
  );
  if (native && typeof canvas?.canvasCoordinatesFromClient === "function") {
    return canvas.canvasCoordinatesFromClient({ x: native.clientX, y: native.clientY });
  }

  // PIXI FederatedPointerEvent fallback: translate renderer-global coordinates
  // into scene coordinates through the canvas stage transform.
  const globalPoint = event?.global ?? event?.data?.global;
  if (globalPoint && canvas?.stage?.toLocal) {
    return canvas.stage.toLocal(globalPoint);
  }
  return null;
}

function stopInteractionEvent(event) {
  try { event?.preventDefault?.(); } catch { /* Read-only federated wrappers */ }
  try { event?.stopPropagation?.(); } catch { /* Optional Pixi method */ }
  try { event?.stopImmediatePropagation?.(); } catch { /* Optional Pixi method */ }
  try { event?.data?.originalEvent?.preventDefault?.(); } catch { /* Optional native event */ }
}

function interceptLayerDoubleClick(layer) {
  const prototype = typeof layer === "function" ? layer.prototype : layer;
  if (!prototype || typeof prototype._onClickLeft2 !== "function" || prototype._tjlDoubleClickPatched) return;

  const original = prototype._onClickLeft2;
  prototype._onClickLeft2 = function(event, ...args) {
    const point = canvasPointFromInteractionEvent(event);
    const tile = point ? findLinkedTileAtCanvasPoint(point) : null;
    if (tile) {
      stopInteractionEvent(event);
      openLinkedJournal(tile);
      return;
    }
    return original.call(this, event, ...args);
  };
  Object.defineProperty(prototype, "_tjlDoubleClickPatched", { value: true });
}

function patchCanvasLayerDoubleClick() {
  const layers = foundry.canvas?.layers ?? {};
  const candidates = [
    layers.InteractionLayer,
    layers.PlaceablesLayer,
    layers.TokenLayer,
    CONFIG.Canvas?.layers?.tokens,
    CONFIG.Canvas?.layers?.tiles
  ];
  for (const layer of candidates) interceptLayerDoubleClick(layer);

  // Patch active runtime layer instances too, including system-replaced layers.
  for (const layer of [canvas?.activeLayer, canvas?.tokens, canvas?.tiles]) {
    if (layer) interceptLayerDoubleClick(layer);
  }
}

function installTokenHudDoubleClick() {
  if (document.documentElement.dataset.tjlHudDoubleClick === "true") return;
  document.documentElement.dataset.tjlHudDoubleClick = "true";

  // Capture canvas double-clicks before the active interaction layer handles them.
  // Events whose topmost DOM target is any overlay/window are ignored above.
  document.addEventListener("dblclick", event => {
    // Critical: do not translate clicks on windows, sheets, dialogs, the HUD,
    // toolbars, or other UI elements into clicks on scene objects behind them.
    if (!isPointerEventOnCanvas(event)) return;

    const tile = tileAtClientPointForClick(event.clientX, event.clientY);
    if (!tile) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openLinkedJournal(tile);
  }, true);
}

function isOurConfigUpdate(changes) {
  const prefix = `flags.${MODULE_ID}.${FLAG}`;
  if (foundry.utils.getProperty(changes, prefix) !== undefined) return true;
  return Object.keys(changes ?? {}).some(key => key.startsWith(`${prefix}.`));
}

function patchTilePlaceableInteractions() {
  const TileClass = CONFIG.Tile?.objectClass ?? foundry.canvas?.placeables?.Tile;
  const prototype = TileClass?.prototype;
  if (!prototype || prototype._tjlInteractionPatched) return;

  const originalDoubleClick = prototype._onClickLeft2;
  prototype._onClickLeft2 = function(event) {
    const cfg = configFor(this);
    if (cfg.enabled && cfg.journalUuid?.trim()) {
      openLinkedJournal(this);
      return false;
    }
    return originalDoubleClick?.call(this, event);
  };

  Object.defineProperty(prototype, "_tjlInteractionPatched", { value: true });
}

function registerGlobalDropHandler() {
  if (document.documentElement.dataset.tjlGlobalDropBound === "true") return;
  document.documentElement.dataset.tjlGlobalDropBound = "true";

  document.addEventListener("dragenter", event => {
    if (!resolveDropTarget(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, true);

  document.addEventListener("dragover", event => {
    if (!resolveDropTarget(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, true);

  document.addEventListener("drop", event => {
    if (!resolveDropTarget(event)) return;
    handleJournalDrop(event);
  }, true);
}


Hooks.once("init", () => {
  registerTileConfigTab();
  installTileConfigClassInterceptor();
  patchTileConfigContext();
  patchTileConfigRenderLifecycle();
  installFontSizeSynchronization();
  patchTilePlaceableInteractions();
  patchCanvasLayerDoubleClick();
  patchJournalDragSources();

  // Run at render time too. This catches config-sheet subclasses introduced by
  // modules which register or replace their TileConfig class after init.
  Hooks.on("renderTileConfig", app => ensureTileJournalTabOnRenderedSheet(app));

  console.log(`${MODULE_ID} | ${i18n("Log.Initialized")}`);
});

Hooks.once("setup", () => {
  registerActiveTileConfigClass();
  installTileConfigClassInterceptor();
  patchTilePlaceableInteractions();
  patchCanvasLayerDoubleClick();
  patchJournalDragSources();
});

Hooks.once("ready", () => {
  // Monk's Active Tile Triggers assigns its derived TileConfig class during ready.
  // This ready callback is registered during init, after module scripts have
  // registered their own ready callbacks, so merge into the final active class.
  registerActiveTileConfigClass();
  installTileConfigClassInterceptor();
});

Hooks.on("canvasReady", () => {
  clearTrackedHover();
  installCanvasHoverTracking();
  installTokenHudDoubleClick();
  patchCanvasLayerDoubleClick();
  for (const tile of canvas.tiles.placeables) removeVisuals(tile);
});

Hooks.on("updateTile", (document, changes) => {
  if (!isOurConfigUpdate(changes)) return;
  const tile = canvas.tiles?.get(document.id);
  if (!tile) return;
  removeVisuals(tile);
  if (activeHoverTile === tile) activeHoverTile = null;
  if (lastPointerClient) refreshTrackedHover(lastPointerClient.x, lastPointerClient.y);
});

Hooks.once("ready", () => {
  registerGlobalDropHandler();
});
