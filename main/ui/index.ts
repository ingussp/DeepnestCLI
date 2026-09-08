/**
 * Main UI Entry Point
 * Orchestrates initialization of all UI modules for DeepNest
 * This file replaces the monolithic page.js with modular TypeScript components
 */

// Type imports
import type {
  UIConfig,
  ConfigObject,
  DeepNestConfig,
  DeepNestInstance,
  SvgParserInstance,
  RactiveInstance,
  NestViewData,
  NestingProgress,
  PartsViewData,
} from "./types/index.js";
import { IPC_CHANNELS } from "./types/index.js";

// Service imports
import { ConfigService, createConfigService, BOOLEAN_CONFIG_KEYS } from "./services/config.service.js";
import { PresetService, createPresetService } from "./services/preset.service.js";
import { ImportService, createImportService } from "./services/import.service.js";
import { ExportService, createExportService } from "./services/export.service.js";
import { NestingService, createNestingService } from "./services/nesting.service.js";

// Component imports
import { NavigationService, createNavigationService } from "./components/navigation.js";
import { PartsViewService, createPartsViewService } from "./components/parts-view.js";
import { NestViewService, createNestViewService } from "./components/nest-view.js";
import { SheetDialogService, createSheetDialogService } from "./components/sheet-dialog.js";

// Utility imports
import { message } from "./utils/ui-helpers.js";
import { getElement, getElements } from "./utils/dom-utils.js";
import {
  debugError,
  debugInfo,
  debugWarn,
  setUiDebugLogger,
  type DebugLoggerLike,
} from "./utils/debug.js";

/**
 * IPC renderer interface for Electron communication
 */
interface IpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/**
 * Helper type for casting getSync() results
 */
type ConfigResult = UIConfig;

/**
 * Window is already augmented in index.d.ts
 * We use type assertion when setting globals that have different types
 */
declare const Ractive: { DEBUG: boolean };
declare const interact: (selector: string) => {
  resizable(options: {
    preserveAspectRatio: boolean;
    edges: { left: boolean; right: boolean; bottom: boolean; top: boolean };
  }): {
    on(event: string, handler: (event: { rect: { width: number } }) => void): void;
  };
};

/**
 * Node.js module interfaces for Electron context
 */
declare function require(module: string): unknown;

interface CreateDebugLoggerModule {
  createDebugLogger: (options?: {
    enabled?: boolean;
    argv?: string[];
    filePath?: string;
    scope?: string;
    isPackaged?: boolean;
  }) => DebugLoggerLike;
}

/**
 * Global DeepNest instance (set by deepnest.js)
 * Access via getDeepNest() helper to get proper typing
 */
declare let DeepNest: DeepNestInstance;

/**
 * Global SvgParser instance
 */
declare let SvgParser: SvgParserInstance;

/**
 * Get the DeepNest global with proper typing
 */
function getDeepNest(): DeepNestInstance {
  return DeepNest;
}

/**
 * Get the SvgParser global with proper typing
 */
function getSvgParser(): SvgParserInstance {
  return SvgParser;
}

/**
 * Execute a callback when the DOM is ready
 * @param fn - The callback function to execute
 */
function ready(fn: () => void | Promise<void>): void {
  if (document.readyState !== "loading") {
    void fn();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      void fn();
    });
  }
}

/**
 * Module instances for cross-module communication
 */
let configService: ConfigService;
let presetService: PresetService;
let importService: ImportService;
let exportService: ExportService;
let nestingService: NestingService;
let navigationService: NavigationService;
let partsViewService: PartsViewService;
let nestViewService: NestViewService;
let sheetDialogService: SheetDialogService;

/**
 * CLI job input types
 */
interface CliPartInput {
  id?: string;
  path?: string;
  points?: CliPointInput[];
  quantity?: number;
  rotations?: number;
  _ip_nesting?: Record<string, unknown>;
}

interface CliPointInput {
  x: number;
  y: number;
}

interface CliRectSheetInput {
  type?: "rect";
  width: number;
  height: number;
  quantity?: number;
  _ip_nesting?: Record<string, unknown>;
}

interface CliPolygonSheetInput {
  type: "polygon";
  outer: CliPointInput[];
  holes?: CliPointInput[][];
  quantity?: number;
  _ip_nesting?: Record<string, unknown>;
}

type CliSheetInput = CliRectSheetInput | CliPolygonSheetInput;

interface CliSettingsInput {
  // Nesting configuration
  units?: "inch" | "mm";
  spacing?: number;
  partToSheet?: number;
  partToHole?: number;
  curveTolerance?: number;
  placementType?: "gravity" | "box" | "convexhull";
  simplify?: boolean;
  threads?: number;

  // Import / Export
  useSvgPreProcessor?: boolean;
  scale?: number;
  endpointTolerance?: number;
  dxfImportScale?: number;
  dxfExportScale?: number;
  exportWithSheetBoundboarders?: boolean;
  exportWithSheetsSpace?: boolean;
  exportWithSheetsSpaceValue?: number;

  // Laser options
  mergeLines?: boolean;
  timeRatio?: number;

  // Meta-heuristic fine tuning
  populationSize?: number;
  mutationRate?: number;

  // Other settings
  useQuantityFromFileName?: boolean;
}

interface CliOutputInput {
  resultJson?: string;
}

interface CliJobInput {
  settings?: CliSettingsInput;
  sheets?: CliSheetInput[];
  parts?: CliPartInput[];
  autoStart?: boolean;
  output?: CliOutputInput;
}

interface CliInputEnvelope {
  path: string | null;
  data: unknown;
  error: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCliJobInput(value: unknown): value is CliJobInput {
  if (!isObject(value)) {
    return false;
  }

  const maybeParts = value.parts;
  const maybeSheets = value.sheets;
  const maybeSettings = value.settings;
  const maybeAutoStart = value.autoStart;
  const maybeOutput = value.output;

const validParts =
  maybeParts === undefined ||
  (Array.isArray(maybeParts) && maybeParts.every(isCliPartInput));

  const validSheets =
	  maybeSheets === undefined ||
	  (Array.isArray(maybeSheets) && maybeSheets.every(isCliSheetInput));

  const validSettings =
    maybeSettings === undefined || isObject(maybeSettings);

  const validAutoStart =
    maybeAutoStart === undefined || typeof maybeAutoStart === "boolean";

  const validOutput =
    maybeOutput === undefined ||
    (isObject(maybeOutput) &&
      (maybeOutput.resultJson === undefined ||
        typeof maybeOutput.resultJson === "string"));

  return validParts && validSheets && validSettings && validAutoStart && validOutput;
}

function isCliPartInput(value: unknown): value is CliPartInput {
  if (!isObject(value)) {
    return false;
  }

  const hasPath = typeof value.path === "string" && value.path.trim().length > 0;
  const hasPoints = isPointArray(value.points);

  if (!hasPath && !hasPoints) {
    return false; // vajag vismaz vienu no abiem
  }

  if (
    value.quantity !== undefined &&
    !(typeof value.quantity === "number" && Number.isInteger(value.quantity) && value.quantity > 0)
  ) {
    return false;
  }

  if (
    value.rotations !== undefined &&
    !(typeof value.rotations === "number" &&
      Number.isInteger(value.rotations) &&
      value.rotations > 0 &&
      value.rotations <= 32)
  ) {
    return false;
  }

  return true;
}

function isCliPointInput(value: unknown): value is CliPointInput {
  return (
    isObject(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

function isPointArray(value: unknown): value is CliPointInput[] {
  return Array.isArray(value) && value.length >= 3 && value.every(isCliPointInput);
}

function isHoleArray(value: unknown): value is CliPointInput[][] {
  return Array.isArray(value) && value.every(isPointArray);
}

function isCliRectSheetInput(value: unknown): value is CliRectSheetInput {
  return (
    isObject(value) &&
    (value.type === undefined || value.type === "rect") &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0 &&
    (value.quantity === undefined ||
      (typeof value.quantity === "number" &&
        Number.isInteger(value.quantity) &&
        value.quantity > 0))
  );
}

function isCliPolygonSheetInput(value: unknown): value is CliPolygonSheetInput {
  return (
    isObject(value) &&
    value.type === "polygon" &&
    isPointArray(value.outer) &&
    (value.holes === undefined || isHoleArray(value.holes)) &&
    (value.quantity === undefined ||
      (typeof value.quantity === "number" &&
        Number.isInteger(value.quantity) &&
        value.quantity > 0))
  );
}

function isCliSheetInput(value: unknown): value is CliSheetInput {
  return isCliRectSheetInput(value) || isCliPolygonSheetInput(value);
}

function getCliJobValidationErrors(value: unknown): string[] {
  if (!isObject(value)) {
    return ["CLI payload is not an object"];
  }

  const errors: string[] = [];

  if (value.parts !== undefined) {
    if (!Array.isArray(value.parts)) {
      errors.push("`parts` must be an array when provided");
    } else {
      value.parts.forEach((part, index) => {
        if (!isCliPartInput(part)) {
          errors.push(`parts[${index}] is not a supported part definition`);
        }
      });
    }
  }

  if (value.sheets !== undefined) {
    if (!Array.isArray(value.sheets)) {
      errors.push("`sheets` must be an array when provided");
    } else {
      value.sheets.forEach((sheet, index) => {
        if (!isCliSheetInput(sheet)) {
          errors.push(`sheets[${index}] is not a supported sheet definition`);
        }
      });
    }
  }

  if (value.settings !== undefined && !isObject(value.settings)) {
    errors.push("`settings` must be an object when provided");
  }

  if (value.autoStart !== undefined && typeof value.autoStart !== "boolean") {
    errors.push("`autoStart` must be a boolean when provided");
  }

  if (value.output !== undefined) {
    if (!isObject(value.output)) {
      errors.push("`output` must be an object when provided");
    } else if (
      value.output.resultJson !== undefined &&
      typeof value.output.resultJson !== "string"
    ) {
      errors.push("`output.resultJson` must be a string when provided");
    }
  }

  return errors;
}

function getCliPointsSummary(points: CliPointInput[] | undefined): Record<string, number | null> {
  if (!Array.isArray(points) || points.length === 0) {
    return {
      count: 0,
      minX: null,
      minY: null,
      maxX: null,
      maxY: null,
    };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    count: points.length,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function summarizeDeepNestWorkspace(): Record<string, number> {
  const deepNest = getDeepNest();
  const parts = Array.isArray(deepNest?.parts) ? deepNest.parts : [];
  const sheetParts = parts.filter((part) => part.sheet);
  const nestingParts = parts.filter((part) => !part.sheet);

  return {
    totalEntries: parts.length,
    sheetsCount: sheetParts.length,
    deepNestPartsCount: nestingParts.length,
    sheetQuantitySum: sheetParts.reduce((sum, part) => sum + (part.quantity || 1), 0),
    partQuantitySum: nestingParts.reduce((sum, part) => sum + (part.quantity || 1), 0),
  };
}

async function getCliInput(): Promise<CliInputEnvelope | null> {
  console.log("[cli-input][renderer] getCliInput() called");
  debugInfo("renderer.get-cli-input.requested");

  if (!ipcRenderer) {
    console.warn("[cli-input][renderer] ipcRenderer is not available");
    debugWarn("renderer.get-cli-input.unavailable");
    return null;
  }

  try {
    const result = (await ipcRenderer.invoke("get-cli-input")) as CliInputEnvelope | null;
    console.log("[cli-input][renderer] getCliInput() result:", result);
    debugInfo("renderer.get-cli-input.response", {
      path: result?.path ?? null,
      hasData: Boolean(result?.data),
      error: result?.error ?? null,
    });
    return result;
  } catch (error) {
    console.error("[cli-input][renderer] Failed to fetch CLI input:", error);
    debugError("renderer.get-cli-input.failure", error);
    return null;
  }
}

function normalizeCliSettingsForInternalConfig(
  settings: CliSettingsInput
): Partial<CliSettingsInput> {
  const normalized: Partial<CliSettingsInput> = { ...settings };

  const units = settings.units ?? configService.getSync("units") ?? "inch";

  // GUI shows scale as units per current unit.
  // Internal config stores scale as units per inch.
  if (typeof settings.scale === "number") {
    normalized.scale = units === "mm" ? settings.scale * 25.4 : settings.scale;
  }

  // GUI shows these values in the currently selected units.
  // Internal config stores them in SVG units using current conversion.
  const scaleForConversion =
    typeof normalized.scale === "number"
      ? normalized.scale
      : Number(configService.getSync("scale")) || 72;

  const conversion = units === "mm" ? scaleForConversion / 25.4 : scaleForConversion;

  const convertDistanceSetting = (
    key:
      | "spacing"
	  | "partToSheet"
	  | "partToHole"
      | "curveTolerance"
      | "endpointTolerance"
      | "exportWithSheetsSpaceValue"
  ): void => {
    const value = settings[key];
    if (typeof value === "number") {
      normalized[key] = value * conversion;
    }
  };

  convertDistanceSetting("spacing");
  convertDistanceSetting("partToSheet");
  convertDistanceSetting("partToHole");
  convertDistanceSetting("curveTolerance");
  convertDistanceSetting("endpointTolerance");
  convertDistanceSetting("exportWithSheetsSpaceValue");

  return normalized;
}

function applyCliSettings(settings: CliSettingsInput): void {
  console.log("[cli-input][renderer] applyCliSettings() start", settings);
  debugInfo("renderer.cli.settings.apply-start", {
    input: settings,
  });

  if (!configService) {
    console.warn("[cli-input][renderer] configService is missing");
    debugWarn("renderer.cli.settings.config-missing");
    return;
  }

  const normalizedSettings = normalizeCliSettingsForInternalConfig(settings);

  const allowedKeys: Array<keyof CliSettingsInput> = [
    // Nesting configuration
    "units",
    "spacing",
	"partToSheet",
	"partToHole",
    "curveTolerance",
    "placementType",
    "simplify",
    "threads",

    // Import / Export
    "useSvgPreProcessor",
    "scale",
    "endpointTolerance",
    "dxfImportScale",
    "dxfExportScale",
    "exportWithSheetBoundboarders",
    "exportWithSheetsSpace",
    "exportWithSheetsSpaceValue",

    // Laser options
    "mergeLines",
    "timeRatio",

    // Meta-heuristic fine tuning
    "populationSize",
    "mutationRate",

    // Other settings
    "useQuantityFromFileName",
  ];

  for (const key of allowedKeys) {
    const value = normalizedSettings[key];
    if (value !== undefined) {
      (
        configService as unknown as {
          setSync: (key: string, value: unknown) => void;
        }
      ).setSync(key, value);
    }
  }

  const deepNest = getDeepNest();
  if (deepNest && typeof deepNest.config === "function") {
    deepNest.config(configService.getSync() as Partial<DeepNestConfig>);
  }

  const cfgValues = configService.getSync() as unknown as ConfigResult;
  updateForm(cfgValues);

  console.log(
    "[cli-input][renderer] applyCliSettings() done",
    normalizedSettings
  );
  debugInfo("renderer.cli.settings.apply-done", {
    normalizedSettings,
  });
}

function getCliSheetConversionFactor(): number {
  const units = configService.getSync("units");
  const scale = Number(configService.getSync("scale")) || 72;

  if (units === "mm") {
    return scale / 25.4;
  }

  return scale;
}

function reversePoints(points: CliPointInput[]): CliPointInput[] {
  return [...points].reverse();
}

function polygonSignedArea(points: CliPointInput[]): number {
  let area = 0;

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }

  return area / 2;
}

function ensureClockwise(points: CliPointInput[]): CliPointInput[] {
  return polygonSignedArea(points) < 0 ? [...points] : reversePoints(points);
}

function ensureCounterClockwise(points: CliPointInput[]): CliPointInput[] {
  return polygonSignedArea(points) > 0 ? [...points] : reversePoints(points);
}

function polygonPointsToPath(points: CliPointInput[], conversion: number): string {
  if (!points.length) {
    return "";
  }

  const first = points[0];
  let d = `M ${first.x * conversion} ${first.y * conversion}`;

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    d += ` L ${point.x * conversion} ${point.y * conversion}`;
  }

  d += " Z";
  return d;
}

function createPolygonPartSvg(points: CliPointInput[]): string {
  const conversion = getCliSheetConversionFactor();
  const normalizedOuter = ensureClockwise(points);
  const d = polygonPointsToPath(normalizedOuter, conversion);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg">`,
    `<path d="${d}" fill="#000000" stroke="#000000" />`,
    `</svg>`,
  ].join("");
}

function addCliPolygonPart(points: CliPointInput[]): boolean {
  const deepNest = getDeepNest();

  if (!deepNest || !Array.isArray(deepNest.parts)) {
    console.warn("[cli-input][renderer] deepNest not available for polygon part");
    debugWarn("renderer.cli.part-points.deepnest-missing");
    return false;
  }

  if (!Array.isArray(points) || points.length < 3) {
    console.warn("[cli-input][renderer] Invalid polygon part points");
    debugWarn("renderer.cli.part-points.invalid", {
      summary: getCliPointsSummary(points),
    });
    return false;
  }

  const beforeCount = deepNest.parts.length;
  const svgString = createPolygonPartSvg(points);
  const importedParts = deepNest.importsvg(null, null, svgString);
  debugInfo("renderer.cli.part-points.imported", {
    inputPoints: getCliPointsSummary(points),
    beforeCount,
    addedCount: importedParts.length,
    afterCount: deepNest.parts.length,
    workspace: summarizeDeepNestWorkspace(),
  });

  return importedParts.length > 0;
}

function createPolygonSheetSvg(
  outer: CliPointInput[],
  holes: CliPointInput[][] = []
): string {
  const conversion = getCliSheetConversionFactor();

  // Outer contour one direction, holes opposite direction
  const normalizedOuter = ensureClockwise(outer);
  const normalizedHoles = holes.map((hole) => ensureCounterClockwise(hole));

  const outerPath = polygonPointsToPath(normalizedOuter, conversion);
  const holesPath = normalizedHoles
    .map((hole) => polygonPointsToPath(hole, conversion))
    .join(" ");

  const d = `${outerPath} ${holesPath}`.trim();

  return [
    `<svg xmlns="http://www.w3.org/2000/svg">`,
	`<path d="${d}" class="sheet" fill="#000000" stroke="#000000" fill-rule="evenodd" />`,
    `</svg>`,
  ].join("");
}

function addCliPolygonSheet(
  outer: CliPointInput[],
  holes: CliPointInput[][] = []
): boolean {
  const deepNest = getDeepNest();

  if (!deepNest || !Array.isArray(deepNest.parts)) {
    console.warn("[cli-input][renderer] deepNest not available for polygon sheet");
    debugWarn("renderer.cli.sheet-polygon.deepnest-missing");
    return false;
  }

  if (!Array.isArray(outer) || outer.length < 3) {
    console.warn("[cli-input][renderer] Invalid polygon sheet outer contour");
    debugWarn("renderer.cli.sheet-polygon.invalid-outer", {
      summary: getCliPointsSummary(outer),
    });
    return false;
  }

  if (!Array.isArray(holes)) {
    console.warn("[cli-input][renderer] Invalid polygon sheet holes array");
    debugWarn("renderer.cli.sheet-polygon.invalid-holes");
    return false;
  }

  const beforeCount = deepNest.parts.length;
  const svgString = createPolygonSheetSvg(outer, holes);
  const parts = deepNest.importsvg(null, null, svgString);

  if (parts.length > 0) {
    const sheet = parts[0];
    sheet.sheet = true;
    debugInfo("renderer.cli.sheet-polygon.added", {
      outer: getCliPointsSummary(outer),
      holesCount: holes.length,
      beforeCount,
      afterCount: deepNest.parts.length,
      workspace: summarizeDeepNestWorkspace(),
    });
    return true;
  }

  debugWarn("renderer.cli.sheet-polygon.import-empty", {
    outer: getCliPointsSummary(outer),
    holesCount: holes.length,
  });

  return false;
}

function loadCliSheets(sheets: CliSheetInput[]): void {
  console.log("[cli-input][renderer] loadCliSheets() start", sheets);
  debugInfo("renderer.cli.sheets.load-start", {
    sheetsCount: sheets.length,
  });

  if (!sheetDialogService) {
    console.warn("[cli-input][renderer] sheetDialogService is missing");
    debugWarn("renderer.cli.sheets.sheet-dialog-missing");
    return;
  }

  for (const sheet of sheets) {
    console.log("[cli-input][renderer] Adding sheet:", sheet);

    const quantity =
      typeof sheet.quantity === "number" && sheet.quantity > 0
        ? Math.floor(sheet.quantity)
        : 1;

    if (isCliPolygonSheetInput(sheet)) {
	  for (let i = 0; i < quantity; i++) {
		const ok = addCliPolygonSheet(sheet.outer, sheet.holes ?? []);
        debugInfo("renderer.cli.sheet.processed", {
          type: "polygon",
          quantity,
          iteration: i,
          ok,
          outer: getCliPointsSummary(sheet.outer),
          holesCount: Array.isArray(sheet.holes) ? sheet.holes.length : 0,
        });
		if (!ok) {
		  console.warn("[cli-input][renderer] Failed to add polygon sheet", sheet);
		}
	  }
	  continue;
	}

    if (isCliRectSheetInput(sheet)) {
      for (let i = 0; i < quantity; i++) {
        if (sheet.width > 0 && sheet.height > 0) {
          const ok = sheetDialogService.addSheet(sheet.width, sheet.height);
          debugInfo("renderer.cli.sheet.processed", {
            type: "rect",
            quantity,
            iteration: i,
            ok,
            width: sheet.width,
            height: sheet.height,
          });
        } else {
          console.warn("[cli-input][renderer] Invalid rectangular sheet", sheet);
          debugWarn("renderer.cli.sheet.invalid-rect", sheet);
        }
      }
      continue;
    }

    console.warn("[cli-input][renderer] Unsupported sheet definition", sheet);
    debugWarn("renderer.cli.sheet.unsupported", sheet);
  }

  if (partsViewService) {
    partsViewService.update();
    partsViewService.attachSort?.();
    partsViewService.applyZoom?.();
  }

  resize();

  console.log("[cli-input][renderer] loadCliSheets() done");
  debugInfo("renderer.cli.sheets.load-done", {
    workspace: summarizeDeepNestWorkspace(),
  });
}

async function loadCliParts(parts: CliPartInput[]): Promise<void> {
  console.log("[cli-input][renderer] loadCliParts() start", parts);
  debugInfo("renderer.cli.parts.load-start", {
    partsCount: parts.length,
  });

	for (const part of parts) {
	  if (typeof part.path === "string" && part.path.trim().length > 0) {
		console.log("[cli-input][renderer] Importing file part:", part.path);
		const deepNest = getDeepNest();
		const beforeCount = deepNest.parts.length;

		await importService.processFile(part.path);

		const added = deepNest.parts.slice(beforeCount).filter((p) => !p.sheet);
        debugInfo("renderer.cli.part-file.imported", {
          path: part.path,
          requestedQuantity: part.quantity ?? 1,
          requestedRotations: part.rotations ?? 1,
          addedCount: added.length,
          workspace: summarizeDeepNestWorkspace(),
        });
		added.forEach((p, idx) => {
		  cliImportedPartRefs.push({
			deepNestPartRef: p,
			inputPart: part,
			instanceIndex: idx,
		  });
		});
		continue;
	  }

	  if (Array.isArray(part.points) && part.points.length >= 3) {
		console.log("[cli-input][renderer] Importing polygon points part");
		const deepNest = getDeepNest();
		const beforeCount = deepNest.parts.length;
		const ok = addCliPolygonPart(part.points);

		if (ok) {
		  const added = deepNest.parts.slice(beforeCount).filter((p) => !p.sheet);
          debugInfo("renderer.cli.part-points.processed", {
            ok,
            inputPoints: getCliPointsSummary(part.points),
            requestedQuantity: part.quantity ?? 1,
            requestedRotations: part.rotations ?? 1,
            addedCount: added.length,
            workspace: summarizeDeepNestWorkspace(),
          });
		  added.forEach((p, idx) => {
			cliImportedPartRefs.push({
			  deepNestPartRef: p,
			  inputPart: part,
			  instanceIndex: idx,
			});
		  });
		}
		if (!ok) {
		  console.warn("[cli-input][renderer] Failed to add polygon points part", part);
          debugWarn("renderer.cli.part-points.failed", {
            inputPoints: getCliPointsSummary(part.points),
            requestedQuantity: part.quantity ?? 1,
            requestedRotations: part.rotations ?? 1,
          });
		}
		continue;
	  }

	  console.warn("[cli-input][renderer] Unsupported part definition", part);
      debugWarn("renderer.cli.part.unsupported", part);
	}

  if (partsViewService) {
    partsViewService.update();
    partsViewService.attachSort();
    partsViewService.applyZoom();
  }

  resize();

  console.log("[cli-input][renderer] loadCliParts() done");
  debugInfo("renderer.cli.parts.load-done", {
    importedRefs: cliImportedPartRefs.length,
    workspace: summarizeDeepNestWorkspace(),
  });
}

function applyCliQuantities(parts: CliPartInput[]): void {
  console.log("[cli-input][renderer] applyCliQuantities() start", parts);
  debugInfo("renderer.cli.parts.apply-quantities-start", {
    inputPartsCount: parts.length,
    importedRefs: cliImportedPartRefs.length,
  });

  const deepNest = getDeepNest();
  if (!deepNest || !Array.isArray(deepNest.parts)) {
    console.warn("[cli-input][renderer] deepNest.parts not available");
    debugWarn("renderer.cli.parts.apply-quantities.deepnest-missing");
    return;
  }

  for (const ref of cliImportedPartRefs) {
    const deepNestPart = ref.deepNestPartRef as {
      quantity?: number;
      rotations?: number;
      sheet?: boolean;
    };

    if (deepNestPart.sheet) {
      continue;
    }

    if (typeof ref.inputPart.quantity === "number") {
      deepNestPart.quantity = ref.inputPart.quantity;
    }

    if (typeof ref.inputPart.rotations === "number") {
      deepNestPart.rotations = ref.inputPart.rotations;
    }

    debugInfo("renderer.cli.part.quantity-applied", {
      instanceIndex: ref.instanceIndex,
      quantity: deepNestPart.quantity ?? null,
      rotations: deepNestPart.rotations ?? null,
      sourceType:
        typeof ref.inputPart.path === "string"
          ? "file"
          : Array.isArray(ref.inputPart.points)
            ? "points"
            : "unknown",
      pointsSummary: Array.isArray(ref.inputPart.points)
        ? getCliPointsSummary(ref.inputPart.points)
        : null,
    });
  }

  if (partsViewService) {
    partsViewService.update();
  }

  console.log("[cli-input][renderer] applyCliQuantities() done");
  debugInfo("renderer.cli.parts.apply-quantities-done", {
    workspace: summarizeDeepNestWorkspace(),
  });
}

interface CliNestPlacement {
  x: number;
  y: number;
  id: number;
  rotation: number;
  source: number;
  filename?: string;
  mergedLength?: number;
  mergedSegments?: unknown[];
}

interface CliNestSheetPlacement {
  sheet: number;
  sheetid?: string;
  sheetplacements: CliNestPlacement[];
}

interface CliNestResult {
  placements: CliNestSheetPlacement[];
  fitness?: number;
  area?: number;
  totalarea?: number;
  mergedLength?: number;
  utilisation?: number;
  index?: number;
  selected?: boolean;
}

function normalizeIpNesting(
  ip: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!ip) {
    return null;
  }

  const normalized: Record<string, unknown> = { ...ip };
  const grain = ip.grain;

  if (isObject(grain)) {
    const normalizedGrain: Record<string, unknown> = { ...grain };

    const customAngleEnabled = grain.custom_angle_enabled === true;
    const customAngle = grain.custom_angle_deg;

    if (
      customAngleEnabled &&
      (typeof customAngle !== "number" || !Number.isFinite(customAngle))
    ) {
      normalizedGrain.custom_angle_enabled = false;
      normalizedGrain.custom_angle_deg = null;
    }

    if (
      normalizedGrain.custom_angle_enabled === true &&
      typeof normalizedGrain.custom_angle_deg !== "number"
    ) {
      normalizedGrain.custom_angle_enabled = false;
      normalizedGrain.custom_angle_deg = null;
    }

    normalized.grain = normalizedGrain;
  }

  return normalized;
}

function getPointsBounds(
  points: CliPointInput[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function createGeometryTransform(
  ip: Record<string, unknown> | null,
  points: CliPointInput[]
): Record<string, unknown> {
  const shapeBbox = isObject(ip?.shape_bbox)
    ? ip.shape_bbox
    : null;

  const pointsBounds = getPointsBounds(points);

  const shapeMinX =
    typeof shapeBbox?.min_x === "number" ? shapeBbox.min_x : null;

  const shapeMinY =
    typeof shapeBbox?.min_y === "number" ? shapeBbox.min_y : null;

  const shapeMinZ =
    typeof shapeBbox?.min_z === "number" ? shapeBbox.min_z : 0;

  const offsetX =
    shapeMinX !== null && pointsBounds
      ? shapeMinX - pointsBounds.minX
      : null;

  const offsetY =
    shapeMinY !== null && pointsBounds
      ? shapeMinY - pointsBounds.minY
      : null;

  const sourceShape = typeof ip?.preview_object_name === "string"
    ? "preview_object"
    : "input_points";

  return {
    source_shape_coordinate_system: "freecad_shape_coordinates",
    nesting_coordinate_system: "nesting_local",

    nesting_to_source_shape_offset:
      offsetX !== null && offsetY !== null
        ? {
            x: offsetX,
            y: offsetY,
            z: shapeMinZ,
          }
        : null,

    offset_calculation:
      offsetX !== null && offsetY !== null
        ? "source_shape_bbox_min_xy_minus_nesting_points_min_xy"
        : "unavailable",

    source_shape: sourceShape,
    source_shape_placement: "apply",
    nesting_translation: "apply_after_source_mapping",

    nesting_rotation: {
      axis: "Z",
      direction: "ccw",
      origin: "local_coordinate_origin",
    },

    shape_translation_removed: false,
    shape_rotation_removed: false,
    source_shape_placement_must_be_preserved: true,
    result_import_requires_source_placement: true,
  };
}

function getPartMeta(part: CliPartInput, fallbackSourceIndex: number) {
  const ip = part._ip_nesting as Record<string, unknown> | undefined;

  const sourcePartIndex =
    typeof ip?.source_part_index === "number" ? (ip.source_part_index as number) : fallbackSourceIndex;

  const partId =
    typeof ip?.part_id === "string"
      ? (ip.part_id as string)
      : typeof part.id === "string"
      ? part.id
      : `part_${sourcePartIndex}`;

  const previewObjectName =
    typeof ip?.preview_object_name === "string" ? (ip.preview_object_name as string) : null;

  const sourceType =
    typeof ip?.source_type === "string" ? (ip.source_type as string) : null;

  return { sourcePartIndex, partId, previewObjectName, sourceType };
}

function getSelectedOrBestNestResult(): CliNestResult | null {
  const deepNest = getDeepNest() as unknown as {
    nests?: CliNestResult[];
  };

  if (!deepNest || !Array.isArray(deepNest.nests) || deepNest.nests.length === 0) {
    return null;
  }

  const selected = deepNest.nests.find((nest) => nest.selected);
  if (selected) {
    return selected;
  }

  return deepNest.nests[deepNest.nests.length - 1] || null;
}

let lastResultSignature = "";

let cliJobContext: CliJobInput | null = null;

let cliImportedPartRefs: Array<{
  deepNestPartRef: unknown;
  inputPart: CliPartInput;
  instanceIndex: number;
}> = [];

async function syncSelectedNestToResultJson(
  cliInputPath: string | null,
  requestedOutputPath?: string
): Promise<void> {
  const result = getSelectedOrBestNestResult();
  if (!result) {
    debugWarn("renderer.cli.result-sync.skipped-no-result", {
      cliInputPath,
      requestedOutputPath: requestedOutputPath ?? null,
    });
    return;
  }

  const payload = createCliResultPayload(cliInputPath, result);
  const signature = JSON.stringify(payload);

  if (signature === lastResultSignature) {
    debugInfo("renderer.cli.result-sync.skipped-unchanged", {
      requestedOutputPath: requestedOutputPath ?? null,
    });
    return;
  }

  lastResultSignature = signature;
  debugInfo("renderer.cli.result-sync.write", {
    cliInputPath,
    requestedOutputPath: requestedOutputPath ?? null,
    status: payload["status"] ?? null,
  });
  await writeCliResultJson(requestedOutputPath, payload);
}

function createCliResultPayload(
  cliInputPath: string | null,
  result: CliNestResult
): Record<string, unknown> {

	  const inputTop = (cliJobContext as Record<string, unknown> | null) ?? null;

  const inputParts = cliJobContext?.parts ?? [];
  const inputSheets = cliJobContext?.sheets ?? [];

  // Build sourceParts once (no duplication per instance)
  const sourceParts = inputParts.map((part, idx) => {
    const meta = getPartMeta(part, idx);

    const ip = normalizeIpNesting(
      (part._ip_nesting as Record<string, unknown> | undefined) ??
        undefined
    );

    const points = Array.isArray(part.points)
      ? part.points.map((point) => ({
          x: point.x,
          y: point.y,
        }))
      : [];

    return {
      source_part_index: meta.sourcePartIndex,
      part_id: meta.partId,

      label: typeof ip?.label === "string" ? ip.label : null,
      preview_document:
        typeof ip?.preview_document === "string"
          ? ip.preview_document
          : null,
      preview_object_name: meta.previewObjectName,
      source_type: meta.sourceType,

      quantity:
        typeof part.quantity === "number"
          ? part.quantity
          : 1,

      rotations:
        typeof part.rotations === "number"
          ? part.rotations
          : 1,

      shape_bbox: isObject(ip?.shape_bbox)
        ? ip.shape_bbox
        : null,

      geometry_transform: createGeometryTransform(ip, points),

      points,
    };
  });

	  const sheets = inputSheets.flatMap((sheet, idx) => {
		const anySheet = sheet as unknown as Record<string, unknown>;
		const ip =
		  (anySheet._ip_nesting as Record<string, unknown> | undefined) ??
		  undefined;

		const quantity =
		  typeof anySheet.quantity === "number" && anySheet.quantity > 0
			? Math.floor(anySheet.quantity)
			: 1;

		const sourceSheetIndex =
		  typeof ip?.source_sheet_index === "number"
			? ip.source_sheet_index
			: idx;

		return Array.from({ length: quantity }, (_, instanceIndex) => ({
		  source_sheet_index: sourceSheetIndex,
		  sheet_instance_index: instanceIndex,
		  sheetId: `${String(sourceSheetIndex).padStart(4, "0")}-${String(
			instanceIndex
		  ).padStart(4, "0")}`,
		  type: anySheet.type ?? "rect",
		  width: typeof anySheet.width === "number" ? anySheet.width : null,
		  height: typeof anySheet.height === "number" ? anySheet.height : null,
		  outer: Array.isArray(anySheet.outer) ? anySheet.outer : [],
		  holes: Array.isArray(anySheet.holes) ? anySheet.holes : [],
		  quantity: 1,
		}));
	  });

	   /*
	   * DeepNest placement.source is an index in deepNest.parts.
	   * It is not necessarily the same as input source_part_index because
	   * sheets and imported parts share the same DeepNest parts array.
	   */
	  const sourcePartByDeepNestIndex = new Map<number, CliPartInput>();

	  for (const ref of cliImportedPartRefs) {
		const deepNestPartIndex = getDeepNest().parts.indexOf(
		  ref.deepNestPartRef as DeepNestInstance["parts"][number]
		);

		if (deepNestPartIndex >= 0) {
		  sourcePartByDeepNestIndex.set(deepNestPartIndex, ref.inputPart);
		}
	  }

	  /*
	   * Fallback lookup by the original input part index.
	   * This is useful when a result was generated without a runtime reference.
	   */
	  const sourcePartByInputIndex = new Map<number, CliPartInput>();

	  inputParts.forEach((part, inputIndex) => {
		sourcePartByInputIndex.set(inputIndex, part);
	  });

  // Flatten placements to compact instance records
  const partInstanceCounter = new Map<string, number>();

  const flatPlacements = (result.placements || []).flatMap((sheetPlacement) => {
    const sheetIndex = sheetPlacement.sheet;
    const sheetId = sheetPlacement.sheetid || String(sheetIndex).padStart(4, "0") + "-0000";

    return (sheetPlacement.sheetplacements || []).map((placedPart) => {
      
	   /*
       * Resolve the original input part using the actual DeepNest
       * parts-array index stored in placement.source.
       */
      const sourceInputPart =
        sourcePartByDeepNestIndex.get(placedPart.source) ??
        sourcePartByInputIndex.get(placedPart.source) ??
        null;

      const sourceInputIndex = sourceInputPart
        ? inputParts.indexOf(sourceInputPart)
        : placedPart.source;

        const meta = sourceInputPart
        ? getPartMeta(sourceInputPart, sourceInputIndex)
        : {
            sourcePartIndex: placedPart.source,
            partId: `part_${placedPart.source}`,
            previewObjectName: null,
            sourceType: null,
          };

      const partId = meta.partId;
	  
      const key = `${partId}`;
      const instanceIndex = partInstanceCounter.get(key) ?? 0;
      partInstanceCounter.set(key, instanceIndex + 1);

      return {
        id: `${partId}_instance_${instanceIndex}`,
        source_part_index: meta.sourcePartIndex,
        instance_index: instanceIndex,
        part_id: partId,
        sheetIndex,
        sheetId,
        placed: true,
        x: placedPart.x,
        y: placedPart.y,
        rotation: placedPart.rotation,
        flipped: false,

        coordinate_system: "sheet_xy",
        placement_origin: "local_coordinate_origin",
        rotation_origin: "local_coordinate_origin",
        rotation_direction: "ccw",
		placement_coordinates_are: "translation_of_nesting_local_points",
        rotation_applied_around: "local_coordinate_origin",
      };
    });
  });

		const placedCount = flatPlacements.length;
	  const expectedCount = sourceParts.reduce(
		(sum, part) => sum + (part.quantity ?? 0),
		0
	  );
	  const unplacedCount = Math.max(0, expectedCount - placedCount);
	  
	  const status =
		expectedCount === 0
		  ? "failed"
		  : unplacedCount === 0
			? "success"
			: placedCount > 0
			  ? "partial"
			  : "failed";

	  const placedBySourceIndex = new Map<number, number>();

	  for (const placement of flatPlacements) {
		const currentCount =
		  placedBySourceIndex.get(placement.source_part_index) ?? 0;

		placedBySourceIndex.set(
		  placement.source_part_index,
		  currentCount + 1
		);
	  }

	  const unplaced = sourceParts.flatMap((sourcePart) => {
		const placedForPart =
		  placedBySourceIndex.get(sourcePart.source_part_index) ?? 0;

		const missingCount = Math.max(
		  0,
		  sourcePart.quantity - placedForPart
		);

		return Array.from({ length: missingCount }, (_, instanceIndex) => {
		  const actualInstanceIndex = placedForPart + instanceIndex;

		  return {
			id: `${sourcePart.part_id}_instance_${actualInstanceIndex}`,
			source_part_index: sourcePart.source_part_index,
			part_id: sourcePart.part_id,
			instance_index: actualInstanceIndex,
			placed: false,
			reason: "No available space",
			coordinate_system: "sheet_xy",
			placement_origin: "local_coordinate_origin",
			rotation_origin: "local_coordinate_origin",
			rotation_direction: "ccw",
			placement_coordinates_are: "translation_of_nesting_local_points",
			rotation_applied_around: "local_coordinate_origin",
		  };
		});
	  });

    return {
		schema_version: (inputTop?.schema_version as number | undefined) ?? 1,
		job_id: (inputTop?.job_id as string | undefined) ?? null,
		success: status === "success",
		status,
		generatedAt: new Date().toISOString(),
		inputPath: cliInputPath,

		summary: {
		  fitness: result.fitness ?? null,
		  area: result.area ?? null,
		  totalarea: result.totalarea ?? null,
		  mergedLength: result.mergedLength ?? 0,
		  utilisation: result.utilisation ?? null,
		  index: result.index ?? null,
		  sheets_used: new Set(flatPlacements.map((p) => p.sheetId)).size,
		  placed_count: placedCount,
		  unplaced_count: unplacedCount,
		},

		sourceParts,
		sheets,
		placements: flatPlacements,
		unplaced,
	};
}

async function writeCliResultJson(
  outputPath: string | undefined,
  payload: Record<string, unknown>
): Promise<void> {
  if (!ipcRenderer) {
    debugError("renderer.cli.write-result.ipc-missing");
    throw new Error("ipcRenderer is not available");
  }

  const result = (await ipcRenderer.invoke(
    "write-cli-result",
    outputPath ?? null,
    payload
  )) as { success: boolean; error?: string; outputPath?: string };

  if (!result?.success) {
    debugError("renderer.cli.write-result.failure", {
      requestedOutputPath: outputPath ?? null,
      error: result?.error ?? "Unknown error while writing result JSON",
    });
    throw new Error(result?.error || "Unknown error while writing result JSON");
  }

  console.log("[cli-output][renderer] Result JSON synced:", result.outputPath);
  debugInfo("renderer.cli.write-result.success", {
    requestedOutputPath: outputPath ?? null,
    actualOutputPath: result.outputPath ?? null,
  });
}



async function bootstrapCliJob(): Promise<void> {
  console.log("[cli-input][renderer] bootstrapCliJob() entered");
  debugInfo("renderer.cli.bootstrap.entered");

  const cliInput = await getCliInput();
  console.log("[cli-input][renderer] bootstrapCliJob() envelope:", cliInput);
  debugInfo("renderer.cli.bootstrap.envelope", {
    path: cliInput?.path ?? null,
    hasData: Boolean(cliInput?.data),
    error: cliInput?.error ?? null,
  });

  if (!cliInput) {
    console.log("[cli-input][renderer] No CLI envelope returned");
    debugWarn("renderer.cli.bootstrap.no-envelope");
    return;
  }

  if (cliInput.error) {
    console.error("[cli-input][renderer] CLI input error:", cliInput.error);
    debugError("renderer.cli.bootstrap.input-error", {
      path: cliInput.path,
      error: cliInput.error,
    });
    return;
  }

  if (!cliInput.data) {
    console.log("[cli-input][renderer] CLI envelope has no data");
    debugInfo("renderer.cli.bootstrap.no-data", {
      path: cliInput.path,
    });
    return;
  }

  console.log("[cli-input][renderer] Raw CLI payload:", cliInput.data);

  const validationErrors = getCliJobValidationErrors(cliInput.data);
  if (validationErrors.length > 0 || !isCliJobInput(cliInput.data)) {
    console.warn(
      "[cli-input][renderer] CLI JSON is present but not a supported job format:",
      cliInput.data
    );
    debugWarn("renderer.cli.bootstrap.validation-rejected", {
      reasons: validationErrors,
      path: cliInput.path,
    });
    return;
  }

  const job = cliInput.data;
  console.log("[cli-input][renderer] Parsed CLI job:", job);
  debugInfo("renderer.cli.bootstrap.valid-job", {
    path: cliInput.path,
    sheetsCount: Array.isArray(job.sheets) ? job.sheets.length : 0,
    partsCount: Array.isArray(job.parts) ? job.parts.length : 0,
    autoStart: job.autoStart !== false,
    requestedOutputPath: job.output?.resultJson ?? null,
  });
  
  cliJobContext = job;
  cliImportedPartRefs = [];
  lastResultSignature = "";

  if (job.settings) {
    console.log("[cli-input][renderer] Applying settings");
    applyCliSettings(job.settings);
  }

  if (job.sheets && job.sheets.length > 0) {
    console.log("[cli-input][renderer] Loading sheets");
    loadCliSheets(job.sheets);
  }

  if (job.parts && job.parts.length > 0) {
    console.log("[cli-input][renderer] Loading parts");
    await loadCliParts(job.parts);
    console.log("[cli-input][renderer] Applying quantities");
    applyCliQuantities(job.parts);
  }

  console.log("[cli-input][renderer] autoStart:", job.autoStart);
  debugInfo("renderer.cli.bootstrap.workspace-ready", {
    workspace: summarizeDeepNestWorkspace(),
    importedRefs: cliImportedPartRefs.length,
  });

  if (job.autoStart !== false) {
    console.log("[cli-input][renderer] Starting nesting automatically");
    const started = nestingService.startNesting();
    debugInfo("renderer.cli.bootstrap.autostart", {
      started,
      workspace: summarizeDeepNestWorkspace(),
    });

    const outputPath = job.output?.resultJson;
	if (outputPath) {
	  (window as unknown as {
		__cliResultSync?: { inputPath: string | null; outputPath?: string };
	  }).__cliResultSync = {
		inputPath: cliInput.path,
		outputPath,
	  };

	  void syncSelectedNestToResultJson(cliInput.path, outputPath).catch((error) => {
		console.error("[cli-output][renderer] Initial result sync failed:", error);
        debugError("renderer.cli.bootstrap.initial-result-sync-failed", error);
	  });
	}
  } else {
    debugInfo("renderer.cli.bootstrap.autostart-disabled");
  }
}

function triggerCliResultSync(): void {
  console.log("[cli-output][renderer] triggerCliResultSync() called");
  debugInfo("renderer.cli.result-sync.triggered");

  const syncState = (window as unknown as {
    __cliResultSync?: { inputPath: string | null; outputPath?: string };
  }).__cliResultSync;

  console.log("[cli-output][renderer] syncState:", syncState);

  if (!syncState) {
    debugWarn("renderer.cli.result-sync.no-state");
    return;
  }

  void syncSelectedNestToResultJson(
    syncState.inputPath,
    syncState.outputPath
  ).catch((error) => {
    console.error("[cli-output][renderer] Result sync failed:", error);
    debugError("renderer.cli.result-sync.failure", error);
  });
}

/**
 * Electron and Node.js module references
 */
let ipcRenderer: IpcRenderer;
let electronRemote: {
  dialog: { showOpenDialog: unknown; showSaveDialogSync: unknown };
  getGlobal: (name: string) => string | undefined;
};
let fs: unknown;
let FormData: new () => unknown;
let axios: { default: { post: unknown } };
let path: {
  extname: (p: string) => string;
  basename: (p: string) => string;
  dirname: (p: string) => string;
};
let svgPreProcessor: {
  loadSvgString: (svg: string, scale: number) => { success: boolean; result: string };
};

/**
 * Resize function for parts list
 * Adjusts the parts table headers when resizing
 */
function resize(event?: { rect: { width: number } }): void {
  const parts = getElement<HTMLElement>("#parts");

  if (event && parts) {
    parts.style.width = event.rect.width + "px";
  }

  const headers = getElements<HTMLTableCellElement>("#parts table th");
  headers.forEach((th) => {
    const span = th.querySelector("span");
    if (span) {
      (span as HTMLElement).style.width = th.offsetWidth + "px";
    }
  });
}

/**
 * Update the config form UI with current values
 * @param c - The configuration object
 */
function updateForm(c: UIConfig): void {
  // Update unit radio buttons
  let unitInput: HTMLInputElement | null;
  if (c.units === "inch") {
    unitInput = document.querySelector('#configform input[value=inch]');
  } else {
    unitInput = document.querySelector('#configform input[value=mm]');
  }

  if (unitInput) {
    unitInput.checked = true;
  }

  // Update unit labels
  const labels = document.querySelectorAll("span.unit-label");
  labels.forEach((l) => {
    (l as HTMLElement).innerText = c.units;
  });

  // Update scale input
  const scaleInput = document.querySelector<HTMLInputElement>("#inputscale");
  if (scaleInput) {
    if (c.units === "inch") {
      scaleInput.value = String(c.scale);
    } else {
      // mm
      scaleInput.value = String(c.scale / 25.4);
    }
  }

  // Update all other config inputs
  const inputs = document.querySelectorAll("#config input, #config select");
  inputs.forEach((i) => {
    const inputElement = i as HTMLInputElement | HTMLSelectElement;
    const inputId = inputElement.getAttribute("id");

    // Skip preset-related inputs
    if (inputId && ["presetSelect", "presetName"].includes(inputId)) {
      return;
    }

    const key = inputElement.getAttribute("data-config") as keyof UIConfig | null;
    if (!key) {
      return;
    }

    if (key === "units" || key === "scale") {
      return;
    }

    const value = c[key];
	
	if (key === "partToHole" && value === null) {
	  inputElement.value = "";
	  return;
	}

    if (inputElement.getAttribute("data-conversion") === "true") {
      const scaleValue = scaleInput ? Number(scaleInput.value) : c.scale;
      inputElement.value = String((value as number) / scaleValue);
    } else if (BOOLEAN_CONFIG_KEYS.includes(key)) {
      (inputElement as HTMLInputElement).checked = value as boolean;
    } else if (value !== undefined) {
      inputElement.value = String(value);
    }
  });
}

/**
 * Load presets into the dropdown
 */
async function loadPresetList(): Promise<void> {
  const presets = await presetService.loadPresets();
  const presetSelect = getElement<HTMLSelectElement>("#presetSelect");

  if (!presetSelect) {
    return;
  }

  // Clear dropdown (except first option)
  while (presetSelect.options.length > 1) {
    presetSelect.remove(1);
  }

  // Add presets to dropdown
  for (const name in presets) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    presetSelect.appendChild(option);
  }
}

/**
 * Initialize preset modal functionality
 */
function initializePresetModal(): void {
  const savePresetBtn = getElement<HTMLElement>("#savePresetBtn");
  const loadPresetBtn = getElement<HTMLElement>("#loadPresetBtn");
  const deletePresetBtn = getElement<HTMLElement>("#deletePresetBtn");
  const presetSelect = getElement<HTMLSelectElement>("#presetSelect");
  const presetModal = getElement<HTMLElement>("#preset-modal");
  const confirmSavePresetBtn = getElement<HTMLElement>("#confirmSavePreset");
  const presetNameInput = getElement<HTMLInputElement>("#presetName");

  if (!presetModal) {
    return;
  }

  const closeModalBtn = presetModal.querySelector(".close");

  // Save preset button click - opens modal
  if (savePresetBtn) {
    savePresetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (presetNameInput) {
        presetNameInput.value = "";
      }
      presetModal.style.display = "block";
      document.body.classList.add("modal-open");
      if (presetNameInput) {
        presetNameInput.focus();
      }
    });
  }

  // Close modal when clicking X
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", (e) => {
      e.preventDefault();
      presetModal.style.display = "none";
      document.body.classList.remove("modal-open");
    });
  }

  // Close modal when clicking outside
  window.addEventListener("click", (event) => {
    if (event.target === presetModal) {
      presetModal.style.display = "none";
      document.body.classList.remove("modal-open");
    }
  });

  // Confirm save preset
  if (confirmSavePresetBtn) {
    confirmSavePresetBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const name = presetNameInput?.value.trim() || "";
      if (!name) {
        alert("Please enter a preset name");
        return;
      }

      try {
        await presetService.savePreset(name, configService.getSync() as unknown as ConfigResult);
        presetModal.style.display = "none";
        document.body.classList.remove("modal-open");
        await loadPresetList();
        if (presetSelect) {
          presetSelect.value = name;
        }
        message("Preset saved successfully!");
      } catch {
        message("Error saving preset", true);
      }
    });
  }

  // Load preset button click
  if (loadPresetBtn) {
    loadPresetBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const selectedPreset = presetSelect?.value || "";
      if (!selectedPreset) {
        message("Please select a preset to load");
        return;
      }

      try {
        const presetConfig = await presetService.getPreset(selectedPreset);

        if (presetConfig) {
          // Preserve user profile
          const tempAccess = configService.getSync("access_token") as string | undefined;
          const tempId = configService.getSync("id_token") as string | undefined;

          // Apply preset settings
          configService.setSync(presetConfig);

          // Restore user profile
          if (tempAccess !== undefined) {
            configService.setSync("access_token", tempAccess);
          }
          if (tempId !== undefined) {
            configService.setSync("id_token", tempId);
          }

          // Update UI and notify DeepNest
          const cfgValues = configService.getSync() as unknown as ConfigResult;
          getDeepNest().config(cfgValues);
          updateForm(cfgValues);

          message("Preset loaded successfully!");
        } else {
          message("Selected preset not found", true);
        }
      } catch {
        message("Error loading preset", true);
      }
    });
  }

  // Delete preset button click
  if (deletePresetBtn) {
    deletePresetBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const selectedPreset = presetSelect?.value || "";
      if (!selectedPreset) {
        message("Please select a preset to delete");
        return;
      }

      if (confirm(`Are you sure you want to delete the preset "${selectedPreset}"?`)) {
        try {
          await presetService.deletePreset(selectedPreset);
          await loadPresetList();
          if (presetSelect) {
            presetSelect.selectedIndex = 0;
          }
          message("Preset deleted successfully!");
        } catch {
          message("Error deleting preset", true);
        }
      }
    });
  }
}

/**
 * Initialize config form change handlers
 */
function initializeConfigForm(): void {
  const inputs = document.querySelectorAll("#config input, #config select");

  inputs.forEach((i) => {
    const inputElement = i as HTMLInputElement | HTMLSelectElement;
    const inputId = inputElement.getAttribute("id");

    // Skip preset-related inputs
    if (inputId && ["presetSelect", "presetName"].includes(inputId)) {
      return;
    }

    inputElement.addEventListener("change", () => {
      let val: string | number | boolean | null = inputElement.value;
      const key = inputElement.getAttribute("data-config") as keyof UIConfig | null;

      if (!key) {
        return;
      }

      // Handle scale conversion
      if (key === "scale") {
        if (configService.getSync("units") === "mm") {
          val = Number(val) * 25.4; // Store scale config in inches
        }
      }

      // Handle boolean inputs (checkboxes)
      if (BOOLEAN_CONFIG_KEYS.includes(key)) {
        val = (inputElement as HTMLInputElement).checked;
      }

      // Handle unit conversion
      if (inputElement.getAttribute("data-conversion") === "true") {
	  if (key === "partToHole" && inputElement.value.trim() === "") {
		// An empty partToHole value means: use partToSheet.
		val = null;
	  } else {
		let conversion = configService.getSync("scale");

		if (configService.getSync("units") === "mm") {
		  conversion /= 25.4;
		}

		val = Number(val) * conversion;
	  }
	}

      // Show spinner during save
      if (inputElement.parentNode) {
        (inputElement.parentNode as HTMLElement).className = "progress";
      }

      // Update config
      configService.setSync(key, val as UIConfig[typeof key]);
      const cfgValues = configService.getSync() as unknown as ConfigResult;
      getDeepNest().config(cfgValues);
      updateForm(cfgValues);

      // Remove spinner
      if (inputElement.parentNode) {
        (inputElement.parentNode as HTMLElement).className = "";
      }

      // Update unit-related Ractive bindings
      if (key === "units" && partsViewService) {
        partsViewService.updateUnits();
      }
    });

    // Config explanation hover handlers
    inputElement.onmouseover = () => {
      const configKey = inputElement.getAttribute("data-config");
      if (configKey) {
        document.querySelectorAll(".config_explain").forEach((el) => {
          el.className = "config_explain";
        });

        const selected = document.querySelector("#explain_" + configKey);
        if (selected) {
          selected.className = "config_explain active";
        }
      }
    };

    inputElement.onmouseleave = () => {
      document.querySelectorAll(".config_explain").forEach((el) => {
        el.className = "config_explain";
      });
    };
  });

  // Reset to defaults button
  const setDefaultBtn = getElement<HTMLElement>("#setdefault");
  if (setDefaultBtn) {
    setDefaultBtn.onclick = (e) => {
      e.preventDefault();

      // Preserve user profile
      const tempAccess = configService.getSync("access_token") as string | undefined;
      const tempId = configService.getSync("id_token") as string | undefined;

      configService.resetToDefaultsSync();

      // Restore user profile
      if (tempAccess !== undefined) {
        configService.setSync("access_token", tempAccess);
      }
      if (tempId !== undefined) {
        configService.setSync("id_token", tempId);
      }

      const cfgValues = configService.getSync() as unknown as ConfigResult;
      getDeepNest().config(cfgValues);
      updateForm(cfgValues);

      return false;
    };
  }

  // Add spinner elements to each form dd
  const ddElements = document.querySelectorAll("#configform dd");
  ddElements.forEach((d) => {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    d.appendChild(spinner);
  });
}

/**
 * Initialize background progress handler
 */
function initializeBackgroundProgress(): void {
  ipcRenderer.on(IPC_CHANNELS.BACKGROUND_PROGRESS, (_event: unknown, ...args: unknown[]) => {
    const p = args[0] as NestingProgress;
    debugInfo("renderer.background-progress.received", p);
    const bar = getElement<HTMLElement>("#progressbar");
    if (bar) {
      const progress = p.progress;
      const style = `width: ${parseInt(String(progress * 100))}%${progress < 0.01 ? "; transition: none" : ""}`;
      bar.setAttribute("style", style);
    }
  });
}

/**
 * Initialize drag/drop prevention
 */
function initializeDragDropPrevention(): void {
  document.ondragover = document.ondrop = (ev) => {
    ev.preventDefault();
  };

  document.body.ondrop = (ev) => {
    ev.preventDefault();
  };
}

/**
 * Initialize message close handler
 */
function initializeMessageClose(): void {
  const messageClose = getElement<HTMLAnchorElement>("#message a.close");
  if (messageClose) {
    messageClose.onclick = () => {
      const wrapper = getElement<HTMLElement>("#messagewrapper");
      if (wrapper) {
        wrapper.className = "";
      }
      return false;
    };
  }
}

/**
 * Initialize parts list resize functionality
 */
function initializePartsResize(): void {
  interact(".parts-drag")
    .resizable({
      preserveAspectRatio: false,
      edges: { left: false, right: true, bottom: false, top: false },
    })
    .on("resizemove", resize);

  window.addEventListener("resize", () => {
    resize();
  });

  // Initial resize
  resize();
}

/**
 * Initialize version info display
 */
function initializeVersionInfo(): void {
  try {
    const pjson = require("../package.json") as { version: string };
    const versionElement = getElement<HTMLElement>("#package-version");
    if (versionElement) {
      versionElement.innerText = pjson.version;
    }
  } catch {
    // Ignore if package.json is not accessible
  }
}

/**
 * Initialize all services
 */
async function initializeServices(): Promise<void> {
  // Create config service and set up window.config
  configService = await createConfigService(ipcRenderer);
  (window as unknown as { config: unknown; nest: unknown; loginWindow: unknown }).config =
    configService as unknown as ConfigObject;

  // Create preset service
  presetService = createPresetService(ipcRenderer);

  // Get config values and configure DeepNest
  const cfgValues = configService.getSync() as unknown as ConfigResult;
  getDeepNest().config(cfgValues);
  updateForm(cfgValues);
}

/**
 * Initialize all components
 */
function initializeComponents(): void {
  // Initialize navigation with dark mode
  navigationService = createNavigationService({ resizeCallback: resize });
  navigationService.initialize();

  // Initialize parts view
  partsViewService = createPartsViewService({
    deepNest: getDeepNest(),
    config: configService as unknown as ConfigObject,
    resizeCallback: resize,
  });
  partsViewService.initialize();

  // Initialize nest view
  nestViewService = createNestViewService({
    deepNest: getDeepNest(),
    config: configService as unknown as ConfigObject,
  });
  nestViewService.initialize();

  // Set window.nest reference for backward compatibility
  (window as unknown as { config: unknown; nest: unknown; loginWindow: unknown }).nest =
    nestViewService.getRactive();

  // Initialize sheet dialog
  sheetDialogService = createSheetDialogService({
    deepNest: getDeepNest(),
    config: configService as unknown as ConfigObject,
    updatePartsCallback: () => partsViewService.update(),
    resizeCallback: resize,
  });
  sheetDialogService.initialize();

  // Initialize import service
  importService = createImportService({
    dialog: electronRemote.dialog as unknown as {
      showOpenDialog: (
        options: unknown
      ) => Promise<{ canceled: boolean; filePaths: string[] }>;
    },
    remote: electronRemote as unknown as {
      getGlobal: (name: string) => string | undefined;
    },
    fs: fs as unknown as {
      readFileSync: (path: string) => Buffer;
      readFile: (
        path: string,
        encoding: string,
        callback: (err: Error | null, data: string) => void
      ) => void;
      readdirSync: (path: string) => string[];
    },
    path: path,
    httpClient: axios.default as unknown as {
      post: (
        url: string,
        data: Buffer,
        options: { headers: Record<string, string>; responseType: string }
      ) => Promise<{ data: string }>;
    },
    FormData: FormData as unknown as new () => {
      append: (
        name: string,
        value: Buffer | string,
        options?: { filename?: string; contentType?: string }
      ) => void;
      getBuffer: () => Buffer;
      getHeaders: () => Record<string, string>;
    },
    svgPreProcessor: svgPreProcessor,
    config: configService as unknown as {
      getSync: <K extends keyof UIConfig>(
        key?: K
      ) => K extends keyof UIConfig ? UIConfig[K] : UIConfig;
    },
    deepNest: getDeepNest(),
    ractive: partsViewService.getRactive() as unknown as RactiveInstance<PartsViewData>,
    attachSortCallback: () => partsViewService.attachSort(),
    applyZoomCallback: () => partsViewService.applyZoom(),
    resizeCallback: resize,
  });

  // Initialize export service
  exportService = createExportService({
    dialog: electronRemote.dialog as unknown as {
      showSaveDialogSync: (options: {
        title: string;
        filters: { name: string; extensions: string[] }[];
      }) => string | undefined;
    },
    remote: electronRemote as unknown as {
      getGlobal: (name: string) => string | undefined;
    },
    fs: fs as unknown as {
      writeFileSync: (path: string, data: string) => void;
    },
    httpClient: axios.default as unknown as {
      post: (
        url: string,
        data: Buffer,
        options: { headers: Record<string, string>; responseType: string }
      ) => Promise<{ data: string }>;
    },
    FormData: FormData as unknown as new () => {
      append: (
        name: string,
        value: Buffer | string,
        options?: { filename?: string; contentType?: string }
      ) => void;
      getBuffer: () => Buffer;
      getHeaders: () => Record<string, string>;
    },
    config: configService as unknown as {
      getSync: <K extends keyof UIConfig>(
        key?: K
      ) => K extends keyof UIConfig ? UIConfig[K] : UIConfig;
    },
    deepNest: getDeepNest(),
    svgParser: getSvgParser(),
  });

  // Set export button after creation
  const exportButton = getElement<HTMLElement>("#export");
  if (exportButton) {
    exportService.setExportButton(exportButton as HTMLElement & { className: string });
  }

  // Initialize nesting service
  nestingService = createNestingService({
    fs: fs as unknown as {
      existsSync: (path: string) => boolean;
      readdirSync: (path: string) => string[];
      lstatSync: (path: string) => { isDirectory: () => boolean };
      unlinkSync: (path: string) => void;
      rmdirSync: (path: string) => void;
    },
    ipcRenderer: ipcRenderer as unknown as {
      send: (channel: string, ...args: unknown[]) => void;
    },
    deepNest: getDeepNest(),
    displayNestFn: nestViewService.getDisplayNestCallback(),
    saveJsonFn: () => exportService.exportToJson(),
  });

  // Set nestRactive separately to avoid type conflicts
  const nestRactive = nestViewService.getRactive();
  if (nestRactive) {
    nestingService.setNestRactive(
      nestRactive as unknown as RactiveInstance<NestViewData>
    );
  }

  nestingService.bindEventHandlers();
}

/**
 * Initialize import button handler
 */
function initializeImportButton(): void {
  const importButton = getElement<HTMLElement>("#import");
  if (importButton) {
    importButton.onclick = async () => {
      if (
        importButton.className.includes("disabled") ||
        importButton.className.includes("spinner")
      ) {
        return false;
      }

      importButton.className = "button import disabled";

      try {
        importButton.className = "button import spinner";
        await importService.showImportDialog();
      } finally {
        importButton.className = "button import";
      }

      return false;
    };
  }
}

/**
 * Initialize export button handlers
 */
function initializeExportButtons(): void {
  // JSON export
  const exportJsonBtn = getElement<HTMLElement>("#exportjson");
  if (exportJsonBtn) {
    exportJsonBtn.onclick = () => {
      exportService.exportToJson();
      return false;
    };
  }

  // SVG export
  const exportSvgBtn = getElement<HTMLElement>("#exportsvg");
  if (exportSvgBtn) {
    exportSvgBtn.onclick = () => {
      exportService.exportToSvg();
      return false;
    };
  }

  // DXF export
  const exportDxfBtn = getElement<HTMLElement>("#exportdxf");
  if (exportDxfBtn) {
    exportDxfBtn.onclick = async () => {
      await exportService.exportToDxf();
      return false;
    };
  }
}

/**
 * Load initial SVG files from nest directory
 */
async function loadInitialFiles(): Promise<void> {
  await importService.loadNestDirectoryFiles();
}

/**
 * Main initialization function
 * Called when the DOM is ready
 */
async function initialize(): Promise<void> {
  console.log("[init] initialize() start");

  try {
    // Load required Electron and Node.js modules
    const electron = require("electron") as { ipcRenderer: IpcRenderer };
    const { createDebugLogger } = require("../build/debug.js") as CreateDebugLoggerModule;
    ipcRenderer = electron.ipcRenderer;
    electronRemote = require("@electron/remote") as typeof electronRemote;
    fs = require("graceful-fs");
    FormData = require("form-data") as typeof FormData;
    axios = require("axios") as typeof axios;
    path = require("path") as typeof path;
    svgPreProcessor = require("@deepnest/svg-preprocessor") as typeof svgPreProcessor;

    const debugLogger = createDebugLogger({
      argv: process.argv,
      scope: "renderer",
    });
    setUiDebugLogger(debugLogger);
    debugLogger.startSession({ processType: "renderer" });
    debugInfo("renderer.initialize.start", {
      argv: process.argv,
      cwd: process.cwd(),
    });

    // Disable Ractive debug mode
    Ractive.DEBUG = false;

    // Initialize services first
    await initializeServices();

    // Initialize preset list
    await loadPresetList();

    // Initialize UI components
    initializeComponents();
	
	(window as unknown as { triggerCliResultSync?: () => void }).triggerCliResultSync =
  triggerCliResultSync;

    // Initialize UI handlers
    initializePresetModal();
    initializeConfigForm();
    initializeBackgroundProgress();
    initializeDragDropPrevention();
    initializeMessageClose();
    initializePartsResize();
    initializeVersionInfo();
    initializeImportButton();
    initializeExportButtons();
    debugInfo("renderer.initialize.ui-ready");

    // Load initial files from nest directory
    await loadInitialFiles();
    debugInfo("renderer.initialize.initial-files-loaded", {
      workspace: summarizeDeepNestWorkspace(),
    });

    // Bootstrap CLI-driven job if provided
    console.log("[cli-input][renderer] About to bootstrap CLI job");
    try {
      await bootstrapCliJob();
      console.log("[cli-input][renderer] CLI bootstrap finished");
      debugInfo("renderer.initialize.cli-bootstrap-finished", {
        workspace: summarizeDeepNestWorkspace(),
      });
    } catch (error) {
      console.error("[cli-input][renderer] CLI bootstrap failed:", error);
      debugError("renderer.initialize.cli-bootstrap-failed", error);
    }

    // Set up loginWindow reference
    (window as unknown as { config: unknown; nest: unknown; loginWindow: unknown }).loginWindow =
      null;

    console.log("[init] initialize() done");
    debugInfo("renderer.initialize.done");
  } catch (error) {
    console.error("[init] initialize() failed:", error);
    debugError("renderer.initialize.failed", error);
  }
}

// Start initialization when DOM is ready
ready(initialize);

/**
 * Export service instances for external access if needed
 */
export {
  configService,
  presetService,
  importService,
  exportService,
  nestingService,
  navigationService,
  partsViewService,
  nestViewService,
  sheetDialogService,
};