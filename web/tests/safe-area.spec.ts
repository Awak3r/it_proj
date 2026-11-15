import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Geometry-only fixtures: real stylesheet, no Telegram credentials, API or database.
const css = readFileSync(
  process.env.SAFE_AREA_BASELINE_CSS || new URL("../src/style.css", import.meta.url),
  "utf8",
);
const markup = `
<div id="root">
  <main class="welcome">
    <h1 class="brand">LabTurn</h1>
    <section class="welcome-panel">
      <h2>Вход</h2>
      <button class="role-card">Я студент</button>
      <button class="role-card">Я преподаватель</button>
      <button class="link">Управление root →</button>
    </section>
  </main>
  <div class="shell" style="display:none">
    <aside class="sidebar">
      <div class="app-header">
        <button class="brand">LabTurn</button>
        <div class="account-actions"><button class="profile">Профиль</button><button class="switch-role">Сменить роль</button></div>
      </div>
      <nav>${["События", "Мои очереди", "Ведомость", "Мои события", "Управление"].map((text) => `<button><svg width="20" height="20" viewBox="0 0 20 20"></svg><span>${text}</span></button>`).join("")}</nav>
    </aside>
    <main class="content"><h1>События</h1><p>Нет событий</p></main>
  </div>
  <div class="modal-backdrop" style="display:none">
    <section class="modal"><h2>Диалог</h2><form>
      ${[1, 2, 3, 4, 5, 6].map((i) => `<label>Поле ${i}<input value="Проверка размеров"></label>`).join("")}
      <button type="button">Сохранить</button>
    </form></section>
  </div>
</div>`;

type Insets = { top: number; right: number; bottom: number; left: number };
const zero: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

async function insets(page: Page, device: Insets, controls: Insets) {
  await page.evaluate(({ device, controls }) => {
    const style = document.documentElement.style;
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      style.setProperty(`--tg-safe-area-inset-${edge}`, `${device[edge]}px`);
      style.setProperty(`--tg-content-safe-area-inset-${edge}`, `${controls[edge]}px`);
    }
    style.setProperty("--tg-viewport-stable-height", `${innerHeight}px`);
  }, { device, controls });
}

async function showShell(page: Page) {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".welcome")!.style.display = "none";
    document.querySelector<HTMLElement>(".shell")!.style.removeProperty("display");
  });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

test.setTimeout(120_000);
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"><style>${css}</style>${markup}`);
});

for (const size of [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test(`welcome stays below Telegram controls at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await insets(page, { ...zero, top: 24, bottom: 24 }, { ...zero, top: 56, bottom: 12 });
    const brand = page.locator(".welcome > .brand");
    expect((await brand.boundingBox())!.y).toBeGreaterThanOrEqual(125);
    await noOverflow(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(size.height);
    if (size.width === 390) {
      await page.screenshot({ path: "test-results/safe-area-portrait.png", fullPage: true });
    }
  });
}

test("header and mobile navigation avoid Telegram and gesture areas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await insets(page, { top: 24, right: 8, bottom: 24, left: 8 }, { ...zero, top: 56, bottom: 12 });
  await showShell(page);
  expect((await page.locator(".app-header").boundingBox())!.y).toBe(80);
  for (const button of await page.locator("nav button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 36);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 8);
  }
  await noOverflow(page);
});

test("landscape notches and Telegram controls leave dialogs accessible", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await insets(page, { top: 0, right: 44, bottom: 24, left: 44 }, { ...zero, top: 44 });
  await showShell(page);
  const header = (await page.locator(".app-header").boundingBox())!;
  expect(header.y).toBeGreaterThanOrEqual(44);
  expect(header.x).toBeGreaterThanOrEqual(44);
  await page.locator(".modal-backdrop").evaluate((modal: HTMLElement) => modal.style.removeProperty("display"));
  const modal = (await page.locator(".modal").boundingBox())!;
  expect(modal.y).toBeGreaterThanOrEqual(44 + 20);
  expect(modal.y + modal.height).toBeLessThanOrEqual(390 - 24 - 20);
  expect(modal.x).toBeGreaterThanOrEqual(44 + 20);
  expect(modal.x + modal.width).toBeLessThanOrEqual(844 - 44 - 20);
  await noOverflow(page);
  await page.screenshot({ path: "test-results/safe-area-landscape-dialog.png", fullPage: true });
});

test("late safe-area changes update layout and reset without a double inset", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const brand = page.locator(".welcome > .brand");
  expect((await brand.boundingBox())!.y).toBe(45);
  await insets(page, { ...zero, top: 24 }, { ...zero, top: 56 });
  expect((await brand.boundingBox())!.y).toBe(125);
  await insets(page, { ...zero, top: 48 }, { ...zero, top: 56 });
  expect((await brand.boundingBox())!.y).toBe(149);
  await insets(page, zero, zero);
  expect((await brand.boundingBox())!.y).toBe(45);
  await noOverflow(page);
});

test("desktop browser keeps its original spacing without Telegram insets", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect((await page.locator(".welcome > .brand").boundingBox())!.y).toBe(65);
  await showShell(page);
  expect((await page.locator(".app-header").boundingBox())!.y).toBe(0);
  expect(await page.locator("nav").evaluate((nav) => getComputedStyle(nav).position)).toBe("static");
  await noOverflow(page);
});
