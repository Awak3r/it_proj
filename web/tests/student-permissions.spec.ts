import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(privilege: "student" | "teacher" | "root"): State {
  const me = {
    id: 3001,
    name: "Permission viewer",
    group_id: 1,
    teacher: privilege === "teacher",
    root: privilege === "root",
  };
  return {
    me,
    groups: [{ id: 1, name: "Test group", archived: false }],
    subjects: [{ id: 1, name: "Test subject", archived: false }],
    users: [me],
    // Retained assignments/event ownership must not grant a student controls.
    assignments: [{ teacher_id: me.id, subject_id: 1, group_id: 1 }],
    labs: [{ id: 1, subject_id: 1, group_id: 1, number: 1, name: "Test lab", archived: false, weight: 1, required: true }],
    grades: [{ student_id: me.id, lab_id: 1, value: 4, version: 1 }],
    grade_summaries: [],
    events: ["planned", "live", "random"].map((state, index) => ({
      id: index + 1,
      name: `Permission event ${state}`,
      subject_id: 1,
      teacher_id: me.id,
      teacher_name: "Permission viewer",
      group_ids: [1],
      starts_at: "2030-01-01T10:00:00Z",
      room: "Test room",
      description: "",
      duration: 10,
      state: state === "random" ? "planned" : state,
      registration_open: true,
      strategy: state === "random" ? "random" : "fifo",
      shuffled: false,
      first_called: false,
      manual_order: false,
      average_minutes: null,
    })),
    entries: [1, 2, 3].flatMap((event_id) => [
      { id: event_id * 10, event_id, user_id: me.id, user_name: me.name, group_id: 1, state: "waiting", position: 2, score: 1, skipped: false, called_at: null, joined_at: "2030-01-01T09:00:00Z" },
      { id: event_id * 10 + 1, event_id, user_id: 3002, user_name: "Other student", group_id: 1, state: "called", position: 1, score: 1, skipped: false, called_at: "2030-01-01T10:00:00Z", joined_at: "2030-01-01T09:00:00Z" },
    ]),
    audit: [],
  };
}

async function open(page: Page, state: State) {
  const commands: unknown[] = [];
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config") return route.fulfill({ json: { dev_auth: false } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (route.request().method() === "POST") commands.push(path);
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Я студент", exact: true }).click();
  await expect(page.getByRole("heading", { name: "События", exact: true })).toBeVisible();
  return commands;
}

async function expectNoPrivilegedControls(page: Page) {
  await expect(page.getByRole("button", {
    name: /^(Добавить работу|Экспорт|Создать событие|Изменить событие|Изменить|Открыть запись|Закрыть запись|Начать приём|Вызвать следующего|Завершить событие|Отменить событие|Пропустить|Завершить приём|Перемешать один раз|Управление|Мои события|Перейти к управлению)$|^(Переместить|Удалить) /,
  })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Управление очередью" })).toHaveCount(0);
  await expect(page.locator("select.grade")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const privilege of ["student", "teacher", "root"] as const) {
  for (const width of [390, 1440]) {
    test(`student view has no privileged controls: ${privilege}, width ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const commands = await open(page, snapshot(privilege));
      await expectNoPrivilegedControls(page);
      for (const state of ["planned", "live", "random"]) {
        await page.getByRole("button").filter({ has: page.getByRole("heading", { name: `Permission event ${state}`, exact: true }) }).click();
        await expect(page.getByRole("heading", { name: "Порядок приёма" })).toBeVisible();
        await expectNoPrivilegedControls(page);
        await expect(page.getByRole("button", { name: "Выйти из очереди" })).toBeVisible();
        await page.getByRole("button", { name: "К событиям", exact: true }).click();
      }
      await page.locator("nav").getByRole("button", { name: "Ведомость", exact: true }).click();
      await expect(page.getByRole("table")).toBeVisible();
      await expectNoPrivilegedControls(page);
      await expect(page.locator("button.lab-heading:not(:disabled)")).toHaveCount(0);
      await page.getByRole("button", { name: "Профиль", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("Имя и фамилия")).toBeVisible();
      await expect(page.getByRole("button", { name: /Назначить|Добавить работу|Удалить|Управление/ })).toHaveCount(0);
      expect(commands).toEqual([]);
    });
  }
}

test("revoking teacher privileges closes an already-open teacher form", async ({ page }) => {
  const state = snapshot("teacher");
  const commands = await open(page, state);
  await page.getByRole("button", { name: "Сменить роль" }).click();
  await page.getByRole("button", { name: "Я преподаватель", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Ведомость", exact: true }).click();
  await page.getByRole("button", { name: "Добавить работу" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  state.me.teacher = false;
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await refreshed;
  await expect(page.getByText("Роль преподавателя выдаёт root.", { exact: false })).toBeVisible();
  await expectNoPrivilegedControls(page);
  expect(commands).toEqual([]);
});

test("ordinary student cannot enter teacher or root management by switching role", async ({ page }) => {
  await open(page, snapshot("student"));
  await page.getByRole("button", { name: "Сменить роль" }).click();
  await expect(page.getByRole("button", { name: "Управление root →" })).toHaveCount(0);
  await page.getByRole("button", { name: "Я преподаватель", exact: true }).click();
  await expect(page.getByText("Роль преподавателя выдаёт root.", { exact: false })).toBeVisible();
  await expect(page.locator("nav")).toHaveCount(0);
  await expectNoPrivilegedControls(page);
});
