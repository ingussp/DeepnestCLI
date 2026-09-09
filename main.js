const { app, ipcMain, BrowserWindow, screen, shell, crashReporter  } = require("electron");
const remote = require("@electron/remote/main");
const fs = require("graceful-fs");
const path = require("path");
const os = require("os");
const url = require("url");
const { createDebugLogger, isDebugEnabled, resolveDebugFilePath } = require("./main/debug");
const { loadPresets, savePreset, deletePreset } = require("./presets");
const NotificationService = require('./notification-service');
require("events").EventEmitter.defaultMaxListeners = 30;

const cliDebugEnabled = isDebugEnabled(process.argv);
const mainDebugLogger = createDebugLogger({
  app,
  argv: process.argv,
  enabled: cliDebugEnabled,
  filePath: resolveDebugFilePath({ app, argv: process.argv }),
  isPackaged: app.isPackaged,
  scope: "main",
});

global.CLI_DEBUG_MODE = cliDebugEnabled;
global.CLI_DEBUG_PATH = mainDebugLogger.filePath;
process.env.DEEPNEST_DEBUG_ACTIVE = cliDebugEnabled ? "1" : "0";
if (!process.env.DEEPNEST_DEBUG_PATH) {
  process.env.DEEPNEST_DEBUG_PATH = mainDebugLogger.filePath;
}

mainDebugLogger.startSession({ processType: "browser" });
mainDebugLogger.info("main.argv.received", {
  argv: process.argv,
  cwd: process.cwd(),
  execPath: process.execPath,
});

app.on('render-process-gone', (event, webContents, details) => {
  console.error('Render process gone:', event, webContents, details);
  mainDebugLogger.error("main.render-process-gone", {
    senderId: webContents?.id,
    reason: details?.reason,
    exitCode: details?.exitCode,
  });
});

process.on("uncaughtException", (error) => {
  mainDebugLogger.error("main.uncaught-exception", error);
});

process.on("unhandledRejection", (reason) => {
  mainDebugLogger.error("main.unhandled-rejection", reason);
});

remote.initialize();

app.commandLine.appendSwitch("--enable-precise-memory-info");
crashReporter.start({ uploadToServer : false });
console.log(crashReporter.getLastCrashReport());

/*
// main menu for mac
const template = [
{
    label: 'Deepnest',
    submenu: [
      {
        role: 'about'
      },
      {
        type: 'separator'
      },
      {
        role: 'services',
        submenu: []
      },
      {
        type: 'separator'
      },
      {
        role: 'hide'
      },
      {
        role: 'hideothers'
      },
      {
        role: 'unhide'
      },
      {
        type: 'separator'
      },
      {
        role: 'quit'
      }
    ]
  }
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
*/

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow = null;
let notificationWindow = null;
var backgroundWindows = [];
const notificationService = new NotificationService();

// CLI JSON bootstrap state
global.CLI_INPUT_JSON = null;
global.CLI_INPUT_JSON_PATH = null;
global.CLI_INPUT_JSON_ERROR = null;

function summarizeCliInput(data) {
  if (!data || typeof data !== "object") {
    return { type: typeof data };
  }

  const parts = Array.isArray(data.parts) ? data.parts : [];
  const sheets = Array.isArray(data.sheets) ? data.sheets : [];

  return {
    keys: Object.keys(data),
    autoStart: data.autoStart,
    requestedOutputPath:
      data.output && typeof data.output.resultJson === "string"
        ? data.output.resultJson
        : null,
    sheetsCount: sheets.length,
    sheetQuantitySum: sheets.reduce(
      (sum, sheet) => sum + (Number.isInteger(sheet?.quantity) && sheet.quantity > 0 ? sheet.quantity : 1),
      0
    ),
    partsCount: parts.length,
    partQuantitySum: parts.reduce(
      (sum, part) => sum + (Number.isInteger(part?.quantity) && part.quantity > 0 ? part.quantity : 1),
      0
    ),
    pointsPartsCount: parts.filter((part) => Array.isArray(part?.points)).length,
    filePartsCount: parts.filter((part) => typeof part?.path === "string").length,
  };
}

function countPolygonPoints(polygon) {
  if (!Array.isArray(polygon)) {
    return 0;
  }

  return polygon.reduce((sum, point) => {
    return sum + (point && typeof point.x === "number" && typeof point.y === "number" ? 1 : 0);
  }, 0);
}

function summarizeBackgroundStartPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { type: typeof payload };
  }

  const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
  const placement = Array.isArray(payload.individual?.placement)
    ? payload.individual.placement
    : [];

  return {
    index: payload.index,
    sheetsCount: sheets.length,
    sheetPointCount: sheets.reduce((sum, sheet) => sum + countPolygonPoints(sheet), 0),
    placementsCount: placement.length,
    placementPointCount: placement.reduce((sum, part) => sum + countPolygonPoints(part), 0),
    rotationsCount: Array.isArray(payload.rotations) ? payload.rotations.length : 0,
    populationSize: payload.config?.populationSize,
    threads: payload.config?.threads,
  };
}

function summarizeBackgroundResponse(payload) {
  if (!payload || typeof payload !== "object") {
    return { type: typeof payload };
  }

  return {
    index: payload.index,
    fitness: payload.fitness,
    area: payload.area,
    totalarea: payload.totalarea,
    sheetPlacementsCount: Array.isArray(payload.placements) ? payload.placements.length : 0,
    placedPartsCount: Array.isArray(payload.placements)
      ? payload.placements.reduce(
          (sum, placement) =>
            sum + (Array.isArray(placement?.sheetplacements) ? placement.sheetplacements.length : 0),
          0
        )
      : 0,
  };
}

/**
 * Extract CLI JSON input file path from argv.
 * Supported forms:
 *   deepnest.exe C:\path\input.json
 *   deepnest.exe --input C:\path\input.json
 *   deepnest.exe -i C:\path\input.json
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function extractCliInputPath(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg || typeof arg !== "string") {
      continue;
    }

    if ((arg === "--input" || arg === "-i") && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }

    if (arg.toLowerCase().endsWith(".json")) {
      return path.resolve(arg);
    }
  }

  return null;
}

/**
 * Load and parse CLI JSON input file.
 *
 * @param {string[]} argv
 * @returns {{ path: string | null, data: any, error: string | null }}
 */
function loadCliInputJson(argv) {
  const inputPath = extractCliInputPath(argv);
  mainDebugLogger.info("main.cli-input.load-start", {
    argv,
    inputPath,
    debugEnabled: cliDebugEnabled,
  });

  global.CLI_INPUT_JSON = null;
  global.CLI_INPUT_JSON_PATH = null;
  global.CLI_INPUT_JSON_ERROR = null;

  if (!inputPath) {
    mainDebugLogger.info("main.cli-input.no-input-path", { argv });
    return {
      path: null,
      data: null,
      error: null,
    };
  }

  try {
    const raw = fs.readFileSync(inputPath, "utf8");
    const parsed = JSON.parse(raw);

    global.CLI_INPUT_JSON = parsed;
    global.CLI_INPUT_JSON_PATH = inputPath;
    global.CLI_INPUT_JSON_ERROR = null;

    console.log("[cli-input] Loaded JSON from:", inputPath);
    console.log("[cli-input] Parsed value:", parsed);
    mainDebugLogger.info("main.cli-input.load-success", {
      inputPath,
      rawLength: raw.length,
      summary: summarizeCliInput(parsed),
    });

    return {
      path: inputPath,
      data: parsed,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    global.CLI_INPUT_JSON = null;
    global.CLI_INPUT_JSON_PATH = inputPath;
    global.CLI_INPUT_JSON_ERROR = message;

    console.error("[cli-input] Failed to load JSON from:", inputPath);
    console.error("[cli-input] Error:", message);
    mainDebugLogger.error("main.cli-input.load-failure", {
      inputPath,
      error: message,
    });

    return {
      path: inputPath,
      data: null,
      error: message,
    };
  }
}

// Load CLI input as early as possible on first app start
loadCliInputJson(process.argv);

// single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  mainDebugLogger.warn("main.single-instance.lock-denied");
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    mainDebugLogger.info("main.second-instance", {
      commandLine,
      workingDirectory,
    });
    // Reload CLI JSON when a second instance is attempted
    loadCliInputJson(commandLine);

    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Create myWindow, load the rest of the app, etc...
  app.whenReady().then(() => {
    //myWindow = createWindow()
    mainDebugLogger.info("main.when-ready");
  });
}

function createMainWindow() {
  // Create the browser window.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  var frameless = process.platform == "darwin";
  //var frameless = true;

  mainWindow = new BrowserWindow({
    width: Math.ceil(width * 0.9),
    height: Math.ceil(height * 0.9),
    frame: !frameless,
    show: false,
    webPreferences: {
      contextIsolation: false,
      enableRemoteModule: true,
      nodeIntegration: true,
      nativeWindowOpen: true,
    },
  });

  mainDebugLogger.info("main.window.created", {
    width: Math.ceil(width * 0.9),
    height: Math.ceil(height * 0.9),
    frameless,
  });

  remote.enable(mainWindow.webContents);

  mainWindow.webContents.on("did-finish-load", () => {
    mainDebugLogger.info("main.window.did-finish-load");
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      mainDebugLogger.error("main.window.did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    }
  );
  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      mainDebugLogger.info("main.window.console-message", {
        level,
        message,
        line,
        sourceId,
      });
    }
  );

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' }
  })

  // and load the index.html of the app.
  mainWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, "./main/index.html"),
      protocol: "file:",
      slashes: true,
    })
  );

  mainWindow.setMenu(null);

  // Open the DevTools.
  if (process.env["deepnest_debug"] === "1")
    mainWindow.webContents.openDevTools();

  // Emitted when the window is closed.
  mainWindow.on("closed", function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
    mainDebugLogger.info("main.window.closed");
  });

  if (process.env.SAVE_PLACEMENTS_PATH !== undefined) {
    global.NEST_DIRECTORY = process.env.SAVE_PLACEMENTS_PATH;
  } else {
    global.NEST_DIRECTORY = path.join(os.tmpdir(), "nest");
  }
  // make sure the export directory exists
  if (!fs.existsSync(global.NEST_DIRECTORY))
    fs.mkdirSync(global.NEST_DIRECTORY);

  mainDebugLogger.info("main.nest-directory.ready", {
    nestDirectory: global.NEST_DIRECTORY,
  });
}

function createNotificationWindow(notification) {
  if (notificationWindow) {
    notificationWindow.close();
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  notificationWindow = new BrowserWindow({
    width: 750,
    height: 500,
    parent: mainWindow,
    alwaysOnTop: true,
    type: "notification",
    center: true,
    maximizable: false,
    minimizable: false,
    resizable: false,
    modal: true,
    show: false,
    webPreferences: {
      contextIsolation: false,
      enableRemoteModule: true,
      nodeIntegration: true
    }
  });

  remote.enable(notificationWindow.webContents);
  notificationWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' }
  })

  notificationWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, "./main/notification.html"),
      protocol: "file:",
      slashes: true
    })
  );

  notificationWindow.setMenu(null);
  // Open the DevTools.
  if (process.env["deepnest_debug"] === "1")
    notificationWindow.webContents.openDevTools();

  notificationWindow.once("ready-to-show", () => {
    notificationWindow.show();
  });

  notificationWindow.on("closed", () => {
    notificationWindow = null;
  });

  // Store the notification data for access by the renderer
  notificationWindow.notificationData = notification;
}

async function runNotificationCheck() {
  const notification = await notificationService.checkForNotifications();
  mainDebugLogger.info("main.notification-check.complete", {
    hasNotification: Boolean(notification),
  });
  if (notification) {
    createNotificationWindow(notification);
  }
}

let winCount = 0;

function createBackgroundWindows() {
  //busyWindows = [];
  // used to have 8, now just 1 background window
  if (winCount < 1) {
    var back = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: false,
        enableRemoteModule: true,
        nodeIntegration: true,
        nativeWindowOpen: true,
      },
    });

    remote.enable(back.webContents);

    back.webContents.on("did-finish-load", () => {
      mainDebugLogger.info("main.background-window.did-finish-load", {
        index: winCount,
      });
    });
    back.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        mainDebugLogger.error("main.background-window.did-fail-load", {
          index: winCount,
          errorCode,
          errorDescription,
          validatedURL,
        });
      }
    );
    back.webContents.on(
      "console-message",
      (_event, level, message, line, sourceId) => {
        mainDebugLogger.info("main.background-window.console-message", {
          index: winCount,
          level,
          message,
          line,
          sourceId,
        });
      }
    );

    if (process.env["deepnest_debug"] === "1") back.webContents.openDevTools();

    back.loadURL(
      url.format({
        pathname: path.join(__dirname, "./main/background.html"),
        protocol: "file:",
        slashes: true,
      })
    );

    backgroundWindows[winCount] = back;

    back.once("ready-to-show", () => {
      //back.show();
      winCount++;
      mainDebugLogger.info("main.background-window.ready", {
        index: winCount - 1,
      });
      createBackgroundWindows();
    });
    back.webContents.on('render-process-gone', (event, details) => { console.error('Render process gone:', event, details); });
    back.on('render-process-gone', (event) => { console.error('Render process gone:', event); });
    mainDebugLogger.info("main.background-window.created", {
      index: winCount,
    });
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  mainDebugLogger.info("main.app.ready");
  createMainWindow();
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    createBackgroundWindows();
    mainDebugLogger.info("main.window.ready-to-show");
    
    // Check for notifications after a short delay to ensure the app is fully loaded
    setTimeout(async () => {
      runNotificationCheck();
    }, 3000); // 3 seconds

    setInterval(async () => {
      runNotificationCheck();
    }, 30*60*1000); // every 30 minutes
  });
  mainWindow.on("closed", () => {
    mainDebugLogger.info("main.app.quit-on-main-window-close");
    app.quit();
  });
});

// Quit when all windows are closed.
app.on("window-all-closed", function () {
  mainDebugLogger.info("main.window-all-closed");
  app.quit();
});

app.on("activate", function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    mainDebugLogger.info("main.app.activate");
    createMainWindow();
  }
});

app.on("before-quit", function () {
  mainDebugLogger.info("main.before-quit");
  var p = path.join(__dirname, "./nfpcache");
  if (fs.existsSync(p)) {
    fs.readdirSync(p).forEach(function (file, index) {
      var curPath = p + "/" + file;
      fs.unlinkSync(curPath);
    });
  }
});

//ipcMain.on('background-response', (event, payload) => mainWindow.webContents.send('background-response', payload));
//ipcMain.on('background-start', (event, payload) => backgroundWindows[0].webContents.send('background-start', payload));

ipcMain.on("background-start", function (event, payload) {
  console.log("starting background!");
  mainDebugLogger.info("main.background-start.received", summarizeBackgroundStartPayload(payload));
  for (var i = 0; i < backgroundWindows.length; i++) {
    if (backgroundWindows[i] && !backgroundWindows[i].isBusy) {
      backgroundWindows[i].isBusy = true;
      backgroundWindows[i].webContents.send("background-start", payload);
      mainDebugLogger.info("main.background-start.dispatched", {
        workerIndex: i,
        summary: summarizeBackgroundStartPayload(payload),
      });
      break;
    }
  }
});

ipcMain.on("background-response", function (event, payload) {
  mainDebugLogger.info("main.background-response.received", summarizeBackgroundResponse(payload));
  for (var i = 0; i < backgroundWindows.length; i++) {
    // todo: hack to fix errors on app closing - should instead close workers when window is closed
    try {
      if (backgroundWindows[i].webContents == event.sender) {
        mainWindow.webContents.send("background-response", payload);
        backgroundWindows[i].isBusy = false;
        mainDebugLogger.info("main.background-response.forwarded", {
          workerIndex: i,
          summary: summarizeBackgroundResponse(payload),
        });
        break;
      }
    } catch (ex) {
      // ignore errors, as they can reference destroyed objects during a window close event
      mainDebugLogger.warn("main.background-response.forward-failed", {
        workerIndex: i,
        error: ex instanceof Error ? ex.message : String(ex),
      });
    }
  }
});

ipcMain.on("background-progress", function (event, payload) {
  // todo: hack to fix errors on app closing - should instead close workers when window is closed
  try {
    mainWindow.webContents.send("background-progress", payload);
    mainDebugLogger.info("main.background-progress.forwarded", payload);
  } catch (ex) {
    // when shutting down while processes are running, this error can occur so ignore it for now.
    mainDebugLogger.warn("main.background-progress.forward-failed", {
      error: ex instanceof Error ? ex.message : String(ex),
      payload,
    });
  }
});

ipcMain.on("background-stop", function (event) {
  mainDebugLogger.info("main.background-stop.received", {
    workerCount: backgroundWindows.length,
  });
  for (var i = 0; i < backgroundWindows.length; i++) {
    if (backgroundWindows[i]) {
      backgroundWindows[i].destroy();
      backgroundWindows[i] = null;
    }
  }
  winCount = 0;

  createBackgroundWindows();

  console.log("stopped!", backgroundWindows);
  mainDebugLogger.info("main.background-stop.completed", {
    workerCount: backgroundWindows.filter(Boolean).length,
  });
});

// Backward compat with https://electron-settings.js.org/index.html#configure
const configPath = path.resolve(app.getPath("userData"), "settings.json");
ipcMain.handle("read-config", () => {
  return fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath).toString().replaceAll("http://convert.deepnest.io", "https://converter.deepnest.app/convert").replaceAll("https://convert.deepnest.io", "https://converter.deepnest.app/convert"))
    : {};
});
ipcMain.handle("write-config", (event, stringifiedConfig) => {
  fs.writeFileSync(configPath, stringifiedConfig);
});

ipcMain.handle("get-cli-input", () => {
  const response = {
    path: global.CLI_INPUT_JSON_PATH,
    data: global.CLI_INPUT_JSON,
    error: global.CLI_INPUT_JSON_ERROR,
  };
  mainDebugLogger.info("main.get-cli-input", {
    path: response.path,
    hasData: Boolean(response.data),
    error: response.error,
    summary: summarizeCliInput(response.data),
  });
  return response;
});

ipcMain.handle("write-cli-result", (_event, _requestedOutputPath, payload) => {
  try {
    const baseDir = app.isPackaged
      ? path.dirname(process.execPath)
      : process.cwd();

    const outputPath = path.join(baseDir, "result.json");

    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
    console.log("[cli-output] Wrote result JSON to:", outputPath);
    mainDebugLogger.info("main.write-cli-result.success", {
      requestedOutputPath: _requestedOutputPath,
      actualOutputPath: outputPath,
      payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    });

    return { success: true, outputPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cli-output] Failed to write result JSON:", message);
    mainDebugLogger.error("main.write-cli-result.failure", {
      requestedOutputPath: _requestedOutputPath,
      error: message,
    });
    return { success: false, error: message };
  }
});

ipcMain.on("login-success", function (event, payload) {
  mainWindow.webContents.send("login-success", payload);
});

ipcMain.on("purchase-success", function (event) {
  mainWindow.webContents.send("purchase-success");
});

ipcMain.on("setPlacements", (event, payload) => {
  global.exportedPlacements = payload;
});

ipcMain.on("test", (event, payload) => {
  global.test = payload;
});

ipcMain.handle("load-presets", () => {
  return loadPresets();
});

ipcMain.handle("save-preset", (event, name, config) => {
  savePreset(name, config);
});

ipcMain.handle("delete-preset", (event, name) => {
  deletePreset(name);
});

// Handle notification window events
ipcMain.on('get-notification-data', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win.notificationData) {
    event.reply('notification-data', {
      title: win.notificationData.title,
      content: win.notificationData.content
    });
  }
});

ipcMain.on('close-notification', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win.notificationData && win.notificationData.markAsSeen) {
    win.notificationData.markAsSeen();
  }
  
  // Close the current notification window
  if (win) {
    win.close();
  }
  
  // Check for additional notifications and show them if they exist
  setTimeout(async () => {
    const nextNotification = await notificationService.checkForNotifications();
    if (nextNotification) {
      createNotificationWindow(nextNotification);
    }
  }, 500); // Small delay to ensure clean transition
});