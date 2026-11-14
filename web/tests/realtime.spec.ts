import { test, expect, Page } from "@playwright/test";
import { State } from "../src/types";

async function openGradebook(page: Page) {
  await page.addInitScript(() => localStorage.setItem("dev-user", "2001"));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Я преподаватель", exact: false })
    .click();
  await page.getByRole("button", { name: "Ведомость", exact: true }).click();
  await page.getByRole("combobox", { name: /^Предмет/ }).selectOption("1");
  return page.getByLabel("Анна Морозова, ЛР 2");
}

async function remoteGrade(page: Page) {
  const headers = { "X-Dev-User": "2001" };
  const state: State = await (
    await page.request.get("/api/state", { headers })
  ).json();
  const grade = state.grades.find(
    (g) => g.student_id === 3002 && g.lab_id === 2,
  );
  const value = grade?.value === 5 ? 4 : 5;
  const response = await page.request.post("/api/command", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: {
      kind: "grade",
      user_id: 3002,
      lab_id: 2,
      value,
      version: grade?.version || 0,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return String(value);
}

test("startup recovers when the first configuration request fails", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/config", (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, json: { error: "Temporary failure" } })
      : route.continue(),
  );
  const stream = page.waitForResponse(
    (r) => r.url().endsWith("/api/updates") && r.ok(),
  );
  await openGradebook(page);
  await stream;
  expect(attempts).toBe(2);
});

test("SSE updates another open gradebook without navigation or polling", async ({
  page,
  browser,
}) => {
  // Disable only the 3-second fallback: this test must depend on the real stream.
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: any[]
    ) =>
      timeout === 3000
        ? 0
        : original(handler, timeout, ...args)) as typeof window.setInterval;
  });
  const stream = page.waitForResponse((r) => r.url().endsWith("/api/updates"));
  const viewer = await openGradebook(page);
  expect((await stream).headers()["content-type"]).toContain(
    "text/event-stream",
  );
  const streamRequest = (await stream).request();
  expect(streamRequest.headers()["x-dev-user"]).toBe("2001");
  expect(streamRequest.url()).not.toContain("?");
  await page.evaluate(
    () => ((window as any).__realtimeDocument = "same-document"),
  );
  const other = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const editor = await other.newPage();
  try {
    const cell = await openGradebook(editor);
    const value = (await cell.inputValue()) === "5" ? "4" : "5";
    await cell.selectOption(value);
    await expect(cell).toBeEnabled();
    await expect(viewer).toHaveValue(value, { timeout: 2000 });
    expect(await page.evaluate(() => (window as any).__realtimeDocument)).toBe(
      "same-document",
    );
  } finally {
    await other.close();
  }
});

test("unavailable SSE falls back to polling", async ({ page }) => {
  await page.route("**/api/updates", (route) => route.fulfill({ status: 503 }));
  const cell = await openGradebook(page);
  const value = await remoteGrade(page);
  await expect(cell).toHaveValue(value, { timeout: 5000 });
});

test("returning online reconnects and catches up after a missed change", async ({
  page,
  context,
  browser,
}) => {
  const cell = await openGradebook(page);
  await context.setOffline(true);
  const other = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  const remote = await other.newPage();
  try {
    const value = await remoteGrade(remote);
    const reconnected = page.waitForResponse(
      (r) => r.url().endsWith("/api/updates") && r.ok(),
    );
    await context.setOffline(false);
    await reconnected;
    await expect(cell).toHaveValue(value, { timeout: 2000 });
    // The same handler also runs on Telegram activation / visibility restoration.
    const resumed = page.waitForResponse(
      (r) => r.url().endsWith("/api/updates") && r.ok(),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await resumed;
    await expect(cell).toHaveValue(value);
  } finally {
    await context.setOffline(false);
    await other.close();
  }
});
