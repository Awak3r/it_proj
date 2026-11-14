import { test, expect, Page } from "@playwright/test";
import { State } from "../src/types";

async function gradebook(page: Page) {
  // These scenarios deliberately exercise fallback polling and delayed reads.
  // Real streaming is covered separately in realtime.spec.ts.
  await page.route("**/api/updates", (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem("dev-user", "2001"));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Я преподаватель", exact: false })
    .click();
  await page.getByRole("button", { name: "Ведомость", exact: true }).click();
  await page.getByRole("combobox", { name: /^Предмет/ }).selectOption("1");
}

test("stale snapshot cannot roll back a saved grade", async ({ page }) => {
  await gradebook(page);
  const cell = page.getByLabel("Анна Морозова, ЛР 2");
  const value = (await cell.inputValue()) === "5" ? "4" : "5";
  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (captured = resolve));
  let first = true;
  await page.route("**/api/state", async (route) => {
    if (!first) return route.continue();
    first = false;
    const old = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response: old });
  });
  try {
    await ready;
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/command"));
    await cell.selectOption(value);
    expect((await saved).ok()).toBeTruthy();
    await expect(cell).toHaveValue(value, { timeout: 1000 });
    await expect(cell).toBeEnabled({ timeout: 1000 });
    const late = page.waitForResponse((r) => r.url().endsWith("/api/state"));
    release();
    await late;
    // A second write proves that the new version survived the late response.
    const next = value === "5" ? "4" : "5";
    await cell.selectOption(next);
    await expect(cell).toBeEnabled();
    await expect(cell).toHaveValue(next);
    const response = await page.request.get("/api/state", {
      headers: { "X-Dev-User": "2001" },
    });
    const state: State = await response.json();
    expect(
      state.grades.find((g) => g.student_id === 3002 && g.lab_id === 2)?.value,
    ).toBe(Number(next));
  } finally {
    release();
  }
});

test("lost response retries the same grade without a second write", async ({
  page,
}) => {
  const headers = { "X-Dev-User": "2001" };
  const before: State = await (
    await page.request.get("/api/state", { headers })
  ).json();
  const old = before.grades.find(
    (g) => g.student_id === 3002 && g.lab_id === 2,
  );
  const value = old?.value === 5 ? "4" : "5";
  const name = "QA recovery " + crypto.randomUUID();
  const command = async (user: number, data: object) => {
    const r = await page.request.post("/api/command", {
      headers: {
        "X-Dev-User": String(user),
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  await command(2001, {
    kind: "event_create",
    name,
    subject_id: 1,
    group_ids: [1],
    starts_at: new Date().toISOString(),
    strategy: "fifo",
    duration: 10,
  });
  const state: State = await (
    await page.request.get("/api/state", { headers })
  ).json();
  const event = state.events.find((e) => e.name === name)!;
  try {
    await command(2001, {
      kind: "event_action",
      event_id: event.id,
      action: "open",
    });
    await command(3002, { kind: "join", event_id: event.id });
    await command(2001, {
      kind: "event_action",
      event_id: event.id,
      action: "start",
    });
    await command(2001, { kind: "next", event_id: event.id });
    await gradebook(page);
    const keys: string[] = [];
    await page.route("**/api/command", async (route) => {
      if (route.request().postDataJSON().kind !== "grade")
        return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length !== 1) return route.continue();
      expect((await route.fetch()).ok()).toBeTruthy();
      await route.abort("failed");
    });
    const cell = page.getByLabel("Анна Морозова, ЛР 2");
    await cell.selectOption(value);
    await expect(
      page.getByRole("button", { name: "Повторить", exact: true }),
    ).toBeVisible();
    await expect(cell).toHaveValue(value);
    await page.getByRole("button", { name: "События", exact: true }).click();
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .click();
    await expect(
      page.getByRole("button", { name: "Завершить приём", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Ведомость", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(cell).toBeEnabled();
    await expect(cell).toHaveValue(value);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const after: State = await (
      await page.request.get("/api/state", { headers })
    ).json();
    const grade = after.grades.find(
      (g) => g.student_id === 3002 && g.lab_id === 2,
    )!;
    expect(grade.version).toBe((old?.version || 0) + 1);
    expect(grade.value).toBe(Number(value));
    expect(
      after.entries.filter(
        (e) => e.event_id === event.id && e.state === "called",
      ),
    ).toHaveLength(1);
  } finally {
    await command(2001, {
      kind: "event_action",
      event_id: event.id,
      action: "complete",
    });
  }
});

test("failed refresh keeps a committed grade pending until retry confirms it", async ({
  page,
}) => {
  await gradebook(page);
  const cell = page.getByLabel("Анна Морозова, ЛР 2");
  const value = (await cell.inputValue()) === "5" ? "4" : "5";
  let unavailable = true;
  await page.route("**/api/state", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: "QA: state unavailable" } })
      : route.continue(),
  );
  await cell.selectOption(value);
  await expect(
    page.getByText("Оценка сохранена, но ведомость не обновилась.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(cell).toHaveValue(value);
  await expect(cell).toBeDisabled();
  const headers = { "X-Dev-User": "2001" };
  const committed: State = await (
    await page.request.get("/api/state", { headers })
  ).json();
  const grade = committed.grades.find(
    (g) => g.student_id === 3002 && g.lab_id === 2,
  )!;
  expect(grade.value).toBe(Number(value));
  unavailable = false;
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue(value);
  const confirmed: State = await (
    await page.request.get("/api/state", { headers })
  ).json();
  expect(
    confirmed.grades.find((g) => g.student_id === 3002 && g.lab_id === 2)
      ?.version,
  ).toBe(grade.version);
});
