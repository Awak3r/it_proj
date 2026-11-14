import { test, expect, Page } from "@playwright/test";
async function login(page: Page, id: string, role: string) {
  await page.addInitScript((id) => localStorage.setItem("dev-user", id), id);
  await page.goto("/");
  await page.getByRole("button", { name: role, exact: false }).click();
}
test("student desktop navigation and grade permissions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "3001", "Я студент");
  await expect(
    page.getByRole("heading", { name: "Привет, Михаил." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ближайшие события" }),
  ).toBeVisible();
  await page.screenshot({
    path: process.env.SCREENSHOT_DIR
      ? process.env.SCREENSHOT_DIR + "/labturn-desktop.png"
      : "test-results/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Ведомость", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить работу" }),
  ).toHaveCount(0);
  await expect(page.locator("td select")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Мои очереди", exact: false })
    .first()
    .click();
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name: "Лабораторные № 1–3" }) })
    .click();
  await expect(
    page.getByRole("heading", { name: "Очередь", exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Пульт преподавателя" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("student mobile has no horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "3001", "Я студент");
  await expect(
    page.getByRole("heading", { name: "Привет, Михаил." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: process.env.SCREENSHOT_DIR
      ? process.env.SCREENSHOT_DIR + "/labturn-mobile.png"
      : "test-results/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Сменить роль", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Как вы входите?" }),
  ).toBeVisible();
});
async function api(page: Page, user: number, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", {
    headers: {
      "X-Dev-User": String(user),
      "Idempotency-Key": crypto.randomUUID(),
    },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function createTestEvent(page: Page, strategy: string) {
  const name = "Проверка UI " + Date.now();
  await api(page, 2001, {
    kind: "event_create",
    name,
    subject_id: 1,
    group_ids: [1],
    starts_at: new Date(Date.now() + 3600000).toISOString(),
    strategy,
    duration: 10,
  });
  const response = await page.request.get("/api/state", {
    headers: { "X-Dev-User": "2001" },
  });
  const state = await response.json();
  const event = state.events.find((e: { name: string }) => e.name === name);
  await api(page, 2001, {
    kind: "event_action",
    event_id: event.id,
    action: "open",
  });
  await api(page, 3002, { kind: "join", event_id: event.id });
  await api(page, 2001, {
    kind: "event_action",
    event_id: event.id,
    action: "start",
  });
  return event;
}
test("teacher grade autosave keeps student in queue and finish is separate", async ({
  page,
}) => {
  const event = await createTestEvent(page, "fifo");
  await login(page, "2001", "Я преподаватель");
  const card = () =>
    page
      .getByRole("button")
      .filter({
        has: page.getByRole("heading", { name: event.name, exact: true }),
      });
  await card().click();
  await page.getByRole("button", { name: "Вызвать следующего" }).click();
  await expect(page.getByText("СЕЙЧАС ПРИНИМАЕТЕ")).toBeVisible();
  await page
    .getByRole("button", { name: "Ведомость", exact: true })
    .last()
    .click();
  const cell = page.getByLabel("Анна Морозова, ЛР 2");
  const value = (await cell.inputValue()) === "5" ? "4" : "5";
  await cell.selectOption(value);
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue(value);
  await page.getByRole("button", { name: "События", exact: true }).click();
  await card().click();
  await expect(page.getByText("СЕЙЧАС ПРИНИМАЕТЕ")).toBeVisible();
  await page
    .getByRole("button", { name: "Завершить приём", exact: true })
    .click();
  await expect(page.getByText("СЕЙЧАС ПРИНИМАЕТЕ")).toHaveCount(0);
  await api(page, 2001, {
    kind: "event_action",
    event_id: event.id,
    action: "complete",
  });
});
test("student cannot select teacher to gain privileges", async ({ page }) => {
  await login(page, "3001", "Я преподаватель");
  await expect(
    page.getByText("Роль преподавателя выдаёт root.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать событие" }),
  ).toHaveCount(0);
});
test("root has management and a single manual shuffle", async ({ page }) => {
  const event = await createTestEvent(page, "random");
  await api(page, 3003, { kind: "join", event_id: event.id });
  await login(page, "1001", "Управление root");
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Назначения" })).toBeVisible();
  await page.getByRole("button", { name: "События", exact: true }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: event.name, exact: true }),
    })
    .click();
  page.on("dialog", (d) => d.accept());
  const shuffle = page.getByRole("button", { name: "Перемешать один раз" });
  await expect(shuffle).toBeVisible();
  await shuffle.click();
  await expect(shuffle).toHaveCount(0);
  await expect(
    page.getByText("Порядок перемешивания сохранён.", { exact: false }),
  ).toBeVisible();
  await api(page, 2001, {
    kind: "event_action",
    event_id: event.id,
    action: "complete",
  });
});
