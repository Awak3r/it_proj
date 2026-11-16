import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(privilege: "student" | "teacher" | "root"): State {
  const me = {
    id: 3001,
    name: "Permission viewer",
    group_id: privilege === "teacher" ? null : 1,
    teacher: privilege === "teacher",
    root: privilege === "root",
  };
  return {
    me,
    groups: [{ id: 1, name: "Test group", archived: false }],
    subjects: [{ id: 1, name: "Test subject", archived: false }],
    subject_groups: [{ subject_id: 1, group_id: 1 }],
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
      { id: event_id * 10 + 2, event_id, user_id: 3003, user_name: "Historical participant", group_id: 1, state: "completed", position: 3, score: 1, skipped: false, called_at: "2030-01-01T10:00:00Z", joined_at: "2030-01-01T09:00:00Z" },
    ]),
    audit: [{ id: 1, actor_id: 3001, action: "grade_change", at: "2030-01-01T10:00:00Z", payload: {} }],
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
  await page.getByRole("button", { name: state.me.teacher ? "Я преподаватель" : "Я студент", exact: true }).click();
  await expect(page.getByRole("heading", { name: "События", exact: true })).toBeVisible();
  return commands;
}

async function expectNoPrivilegedControls(page: Page) {
  await expect(page.getByRole("button", {
    name: /^(Добавить работу|Экспорт|Создать событие|Изменить событие|Изменить|Открыть запись|Закрыть запись|Начать приём|Вызвать следующего|Завершить событие|Отменить событие|Пропустить|Завершить приём|Перемешать один раз|Управление|Мои события|Перейти к управлению)$|^(Переместить|Удалить) /,
  })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Управление очередью" })).toHaveCount(0);
  await expect(page.locator(".audit")).toHaveCount(0);
  await expect(page.locator("select.grade")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const privilege of ["student", "root"] as const) {
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

for (const privilege of ["student", "teacher", "root"] as const) {
  test(`audit is root-only and participation history remains available for ${privilege} account`, async ({ page }) => {
    await open(page, snapshot(privilege));
    if (privilege !== "student") {
      await page.getByRole("button", { name: "Сменить роль" }).click();
      await page.getByRole("button", {
        name: privilege === "root" ? "Управление root →" : "Я преподаватель",
        exact: true,
      }).click();
    }
    await page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Permission event live", exact: true }) }).click();
    await expect(page.getByRole("heading", { name: "Порядок приёма" })).toBeVisible();
    await expect(page.locator(".history")).toHaveCount(1);
    if (privilege === "root") {
      await page.locator(".history summary").click();
      await expect(page.locator(".history .admin-row")).toContainText("Historical participant");
      await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Последние изменения" })).toBeVisible();
      await expect(page.locator(".audit")).toContainText("grade_change");
    } else {
      await expect(page.locator(".audit")).toHaveCount(0);
      await expect(page.locator("nav").getByRole("button", { name: "Управление", exact: true })).toHaveCount(0);
    }
  });
}

test("teacher can use every bound group and subject without assignments", async ({ page }) => {
  const state = snapshot("teacher");
  state.assignments = [];
  state.groups.push({ id: 2, name: "Other group", archived: false });
  state.subjects.push({ id: 2, name: "Other subject", archived: false });
  state.subject_groups!.push({ subject_id: 2, group_id: 2 });
  state.users.push({ id: 4001, name: "Other group student", group_id: 2, teacher: false });
  state.labs.push({ ...state.labs[0], id: 2, group_id: 2, subject_id: 2, name: "Other lab" });
  await open(page, state);
  await page.getByRole("button", { name: "Сменить роль" }).click();
  await page.getByRole("button", { name: "Я преподаватель", exact: true }).click();
  await page.getByRole("button", { name: "Создать событие" }).click();
  const eventForm = page.getByRole("dialog");
  await expect(eventForm.getByLabel("Предмет").getByRole("option")).toHaveText(["Test subject", "Other subject"]);
  await expect(eventForm.getByLabel("Группы (можно выбрать несколько)").getByRole("option")).toHaveText(["Test group"]);
  await eventForm.getByLabel("Предмет").selectOption("2");
  await expect(eventForm.getByLabel("Группы (можно выбрать несколько)").getByRole("option")).toHaveText(["Other group"]);
  await eventForm.locator(".icon-button").click();
  await page.locator("nav").getByRole("button", { name: "Ведомость", exact: true }).click();
  await page.locator(".filters select").nth(0).selectOption("2");
  await page.locator(".filters select").nth(1).selectOption("2");
  await expect(page.getByRole("row").filter({ hasText: "Other group student" }).locator("select.grade")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Экспорт", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Добавить работу" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Добавить преподавателя", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Добавить назначение", exact: true })).toHaveCount(0);
  await expect(page.locator("nav").getByRole("button", { name: "Управление", exact: true })).toHaveCount(0);
});

test("root manages separate teacher and student lists without assignments", async ({ page }) => {
  const state = snapshot("root");
  state.users.push({ id: 2001, name: "Existing teacher", teacher: true, group_id: null });
  const commands: Record<string, unknown>[] = [];
  await open(page, state);
  await page.route("**/api/command", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    expect(command.kind).toBe("role");
    const user = state.users.find((u) => u.id === command.user_id);
    if (user) user.teacher = command.enabled;
    else state.users.push({ id: command.user_id, name: "", teacher: command.enabled, group_id: null });
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Сменить роль" }).click();
  await page.getByRole("button", { name: "Управление root →", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
  const teachers = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Преподаватели", exact: true }) });
  const students = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Студенты", exact: true }) });
  await expect(teachers).toContainText("Existing teacher");
  await expect(teachers).not.toContainText("Permission viewer");
  await expect(students).toContainText("Permission viewer");
  await expect(students).not.toContainText("Existing teacher");
  await expect(page.getByRole("heading", { name: "Назначения", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Добавить преподавателя", exact: true }).click();
  await page.getByLabel("Telegram ID", { exact: true }).fill("2002");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(teachers).toContainText("2002");
  expect(commands).toEqual([{ kind: "role", user_id: 2002, enabled: true }]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Отозвать роль преподавателя 2002", exact: true }).click();
  await expect(teachers).not.toContainText("2002");
  expect(commands).toEqual([
    { kind: "role", user_id: 2002, enabled: true },
    { kind: "role", user_id: 2002, enabled: false },
  ]);
});

for (const teacherFlag of [false, true]) {
  test(`teacher mode retains management but hides only audit (teacher=${teacherFlag})`, async ({ page }) => {
    const state = snapshot("root");
    state.me.teacher = teacherFlag;
    if (teacherFlag) {
      state.me.group_id = null;
      state.users.push({ id: 3002, name: "Other student", group_id: 1, teacher: false });
    }
    await open(page, state);
    await page.getByRole("button", { name: "Сменить роль" }).click();
    await page.getByRole("button", { name: "Управление root →", exact: true }).click();
    await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Последние изменения" })).toBeVisible();

    await page.getByRole("button", { name: "Сменить роль" }).click();
    await page.getByRole("button", { name: "Я преподаватель", exact: true }).click();
    await expect(page.locator("nav").getByRole("button", { name: "Управление", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Создать событие" })).toBeVisible();
    await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Группы", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Преподаватели", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Добавить преподавателя", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Назначения", exact: true })).toHaveCount(0);
    await expect(page.locator(".audit")).toHaveCount(0);
    await page.locator("nav").getByRole("button", { name: "События", exact: true }).click();
    await page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Permission event live", exact: true }) }).click();
    await expect(page.getByRole("heading", { name: "Управление очередью" })).toBeVisible();
    await expect(page.locator(".history")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Переместить Permission viewer", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Удалить Other student", exact: true })).toBeVisible();
    await page.locator("nav").getByRole("button", { name: "Ведомость", exact: true }).click();
    await expect(page.getByRole("button", { name: "Добавить работу" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Экспорт", exact: true })).toBeVisible();
    await expect(page.locator("select.grade")).toHaveCount(1);

    await page.getByRole("button", { name: "Сменить роль" }).click();
    await page.getByRole("button", { name: "Управление root →", exact: true }).click();
    await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Последние изменения" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Преподаватели", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Студенты", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Добавить преподавателя", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Назначения", exact: true })).toHaveCount(0);
  });
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
