import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type CliInput = {
  settings?: Record<string, unknown>;
  sheets?: unknown[];
  parts?: unknown[];
  autoStart?: boolean;
  output?: { resultJson?: string };
};

async function launchWithCliInput(
  cliInput: CliInput,
  debugPath: string,
  extraArgs: string[] = [],
) {
  const inputPath = path.join(path.dirname(debugPath), "cli-input.json");
  await writeFile(inputPath, JSON.stringify(cliInput, null, 2), "utf8");

  const electronApp = await electron.launch({
    args: ["main.js", inputPath, ...extraArgs],
    env: {
      ...process.env,
      DEEPNEST_DEBUG_PATH: debugPath,
      ELECTRON_DISABLE_SANDBOX: "1",
    },
  });
  return { electronApp, inputPath };
}

test("CLI debug mode stays disabled without deug token", async ({}, testInfo) => {
  const debugPath = testInfo.outputPath("no-debug.txt");

  const { electronApp } = await launchWithCliInput(
    {
      autoStart: false,
      sheets: [{ type: "rect", width: 100, height: 100, quantity: 1 }],
      parts: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 20 },
            { x: 0, y: 20 },
          ],
          quantity: 2,
          rotations: 4,
        },
      ],
    },
    debugPath,
  );

  await expect
    .poll(async () => electronApp.evaluate(() => global.CLI_DEBUG_MODE))
    .toBe(false);

  await electronApp.close();
  expect(existsSync(debugPath)).toBeFalsy();
});

test("CLI debug mode writes main-process bootstrap diagnostics for points parts", async ({}, testInfo) => {
  const debugPath = testInfo.outputPath("debug.txt");
  const requestedResultPath = testInfo.outputPath("requested-result.json");

  await rm(debugPath, { force: true });

  const { electronApp } = await launchWithCliInput(
    {
      autoStart: false,
      output: { resultJson: requestedResultPath },
      sheets: [{ type: "rect", width: 200, height: 150, quantity: 1 }],
      parts: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 20 },
            { x: 0, y: 20 },
          ],
          quantity: 300,
          rotations: 8,
        },
      ],
    },
    debugPath,
    ["deug"],
  );

  await expect.poll(async () => existsSync(debugPath)).toBe(true);
  await expect
    .poll(async () => (await readFile(debugPath, "utf8")).toString(), {
      timeout: 10000,
    })
    .toContain("main.cli-input.load-success");

  const debugContents = await readFile(debugPath, "utf8");
  expect(debugContents).toContain("session-start");
  expect(debugContents).toContain("\"partQuantitySum\": 300");
  expect(debugContents).toContain("\"pointsPartsCount\": 1");
  expect(debugContents).toContain("\"requestedOutputPath\"");

  await electronApp.close();
});
