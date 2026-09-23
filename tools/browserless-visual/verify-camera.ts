import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const token = process.env.BROWSERLESS_API;
if (!token) throw new Error("BROWSERLESS_API is missing");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(process.cwd(), "debug-shots", `browserless-camera-${stamp}`);
await mkdir(outputDir, { recursive: true });

const browser = await puppeteer.connect({
  browserWSEndpoint: `wss://production-sfo.browserless.io?token=${encodeURIComponent(token)}&timeout=300000`,
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240_000);
  await page.goto("https://kj.zo.space/tinyworld?debugWorld=1&terrain=synthetic", { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => typeof (window as any).__tw?.setPilotMode === "function", { timeout: 240_000 });

  const capture = async (mode: "third" | "drone", name: string) => {
    await page.evaluate((nextMode) => (window as any).__tw.setPilotMode(nextMode), mode);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const report = await page.evaluate(() => (window as any).__tw.framingReport());
    const target = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: target, type: "png" });
    return { target, report };
  };

  const sentinel = await capture("third", "sentinel");
  const drone = await capture("drone", "drone");
  console.log(JSON.stringify({ outputDir, sentinel, drone }, null, 2));
} finally {
  await browser.close();
}
