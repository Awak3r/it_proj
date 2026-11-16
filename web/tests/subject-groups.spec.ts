import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(): State {
  const me = {
    id: 1001,
    name: "Curriculum root",
    root: true,
    teacher: false,
    group_id: null,
  };
  return {
    me,
    groups: [
      { id: 1, name: "Group A", archived: false },
      { id: 2, name: "Group B", archived: false },
      { id: 3, name: "Empty group", archived: false },
      { id: 4, name: "Old group", archived: true },
    ],
    subjects: [
      { id: 10, name: "Physics", archived: false },
      { id: 20, name: "History", archived: false },
      { id: 30, name: "Unbound subject", archived: false },
    ],
    subject_groups: [
      { subject_id: 10, group_id: 1 },
      { subject_id: 10, group_id: 4 },
      { subject_id: 20, group_id: 2 },
    ],
    users: [me, { id: 3001, name: "Pupil A", group_id: 1, teacher: false }],
    labs: [
      {
        id: 100,
        subject_id: 10,
        group_id: 1,
        number: 1,
        name: "Bound lab",
        weight: 1,
        required: true,
        archived: false,
      },
    ],
    grades: [],
    grade_summaries: [],
    grade_statistics: [],
    lab_statistics: [],
    assignments: [],
    events: [],
    entries: [],
    audit: [],
  };
}

// Audited mock-only spec: all API routes are fulfilled/aborted and Telegram is
// blocked. No request fixture, route.continue(), or backend calls are used.
async function open(page: Page, state: State, mode = "root", reject = false) {
  const commands: Record<string, unknown>[] = [];
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: false } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/command") {
      commands.push(route.request().postDataJSON());
      return reject
        ? route.fulfill({
            status: 400,
            json: {
              error:
                "Сначала архивируйте работы и завершите события удаляемой группы",
            },
          })
        : route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.goto("/");
  if (state.me.root) {
    await page
      .getByRole("button", {
        name:
          mode === "root"
            ? /Управление root/
            : mode === "teacher"
              ? /Я преподаватель/
              : "Я студент",
      })
      .click();
  }
  return commands;
}
async function grades(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
}
async function admin(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
}

test("historical event cannot silently open another subject after unlink", async ({
  page,
}) => {
  const state = snapshot();
  state.events = [
    {
      id: 1,
      name: "Historical unlinked event",
      subject_id: 30,
      teacher_id: 1001,
      teacher_name: "Curriculum root",
      group_ids: [1],
      starts_at: "2026-01-01T10:00:00Z",
      room: "",
      description: "",
      duration: 10,
      state: "completed",
      registration_open: false,
      strategy: "fifo",
      shuffled: false,
      first_called: true,
      manual_order: false,
      average_minutes: null,
    },
  ];
  const commands = await open(page, state);
  await page.getByRole("button", { name: "Все события", exact: true }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Historical unlinked event",
        exact: true,
      }),
    })
    .click();
  await page
    .locator(".controls")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  await expect(
    page.getByText("Ведомость события недоступна:", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Historical unlinked event",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".filters")).toHaveCount(0);
  expect(commands).toEqual([]);
});

test("root creates subject with explicit nonempty multi-group payload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const commands = await open(page, snapshot());
  await admin(page);
  await page
    .getByRole("button", { name: "Добавить предмет", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("New subject");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(commands).toHaveLength(0);
  await dialog.getByRole("checkbox", { name: "Group A", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Group B", exact: true }).check();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toEqual([
    { kind: "subject", name: "New subject", group_ids: [1, 2] },
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
});

test("root rename and group edit retain archived bindings and list assigned groups", async ({
  page,
}) => {
  const commands = await open(page, snapshot());
  await admin(page);
  const row = page.getByRole("button", {
    name: /Physics.*Group A.*Old group \(архив\)/,
  });
  await expect(row).toBeVisible();
  await row.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(/Связи с архивными группами сохраняются/),
  ).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  await expect(
    dialog.getByRole("checkbox", { name: "Group A", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Old group" })).toHaveCount(
    0,
  );
  await dialog.getByLabel("Название", { exact: true }).fill("Renamed physics");
  await dialog.getByRole("checkbox", { name: "Group B", exact: true }).check();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands[0]).toEqual({
    kind: "subject",
    id: 10,
    name: "Renamed physics",
    enabled: false,
    group_ids: [1, 2, 4],
  });
});

test("explicit empty active bindings are submitted and actionable server errors remain visible", async ({
  page,
}) => {
  const state = snapshot();
  state.subject_groups = [{ subject_id: 10, group_id: 1 }];
  const commands = await open(page, state, "root", true);
  await admin(page);
  await page.getByRole("button", { name: /Physics/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", { name: "Group A", exact: true })
    .uncheck();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Сначала архивируйте работы",
  );
  expect(commands[0].group_ids).toEqual([]);
});

test("subject creation without active groups explains that a group must be created first", async ({
  page,
}) => {
  const state = snapshot();
  state.groups = state.groups.filter((g) => g.archived);
  const commands = await open(page, state);
  await admin(page);
  await page
    .getByRole("button", { name: "Добавить предмет", exact: true })
    .click();
  await expect(
    page.getByText(
      "Сначала создайте действующую группу, затем добавьте предмет.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(commands).toHaveLength(0);
});

for (const mode of ["root", "teacher"]) {
  test(`${mode} sees all bound pairs without assignments and group changes reset stale subjects`, async ({
    page,
  }) => {
    const state = snapshot();
    if (mode === "teacher")
      state.me = { ...state.me, root: false, teacher: true };
    await open(page, state, mode);
    await grades(page);
    await expect(
      page.getByLabel("Предмет", { exact: true }).locator("option"),
    ).toHaveText(["Physics"]);
    await expect(
      page.getByRole("button", { name: "Добавить работу", exact: true }),
    ).toBeEnabled();
    await page.getByLabel("Группа", { exact: true }).selectOption("2");
    await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("20");
    await expect(
      page.getByLabel("Предмет", { exact: true }).locator("option"),
    ).toHaveText(["History"]);
    await page.getByRole("button", { name: "Статистика", exact: true }).click();
    await page.getByLabel("Группа", { exact: true }).selectOption("3");
    await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("0");
    await expect(
      page.getByText("Нет предметов для этой группы", { exact: true }),
    ).toBeVisible();
    for (const name of ["Добавить работу", "Экспорт", "К оценкам"]) {
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    }
    await expect(page.getByRole("table")).toHaveCount(0);
    if (mode === "teacher")
      await expect(
        page
          .locator("nav")
          .getByRole("button", { name: "Управление", exact: true }),
      ).toHaveCount(0);
  });
}

test("missing mapping fails closed even with legacy labs and assignments", async ({
  page,
}) => {
  const state = snapshot();
  delete (state as Partial<State>).subject_groups;
  state.assignments = [{ subject_id: 10, group_id: 1, teacher_id: 1001 }];
  await open(page, state);
  await grades(page);
  await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("0");
  await expect(
    page.getByRole("button", { name: "Добавить работу", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("select.grade")).toHaveCount(0);
});

test("event subject change removes unrelated selected groups from choices and payload", async ({
  page,
}) => {
  const commands = await open(page, snapshot());
  await page
    .getByRole("button", { name: "Создать событие", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Предмет", { exact: true }).locator("option"),
  ).toHaveText(["Physics", "History"]);
  const groups = dialog.getByLabel("Группы (можно выбрать несколько)");
  await expect(groups.locator("option")).toHaveText(["Group A"]);
  await groups.selectOption("1");
  await dialog.getByLabel("Предмет", { exact: true }).selectOption("20");
  await expect(groups.locator("option")).toHaveText(["Group B"]);
  await expect(groups.locator("option:checked")).toHaveCount(0);
  await dialog.getByLabel("Название события").fill("History event");
  await dialog.getByLabel("Начало · московское время").fill("2030-01-01T12:00");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(commands).toHaveLength(0);
  await groups.selectOption("2");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands[0]).toMatchObject({
    kind: "event_create",
    subject_id: 20,
    group_ids: [2],
  });
});

test("SSE reconciles selections, invalidates open forms and never exports or creates on the old pair", async ({
  page,
}) => {
  const state = snapshot();
  const commands = await open(page, state);
  await grades(page);
  await page
    .getByRole("button", { name: "Добавить работу", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Reconnect to a synthetic SSE frame; every API request remains intercepted.
  await page.route("**/api/updates", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: change\ndata: {}\n\n",
    }),
  );
  state.subject_groups = [
    { subject_id: 20, group_id: 1 },
    { subject_id: 10, group_id: 2 },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("20");
  await expect(page.locator(".lab-heading")).toHaveCount(0);
  const exports: string[] = [];
  await page.route("**/api/export?**", (route) => {
    exports.push(route.request().url());
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Экспорт", exact: true }).click();
  await expect.poll(() => exports.length).toBe(1);
  expect(new URL(exports[0]).searchParams.get("subject_id")).toBe("20");
  expect(new URL(exports[0]).searchParams.get("group_id")).toBe("1");
  await page
    .getByRole("button", { name: "Добавить работу", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название", { exact: true })
    .fill("New board lab");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(commands[0]).toMatchObject({
    kind: "lab",
    subject_id: 20,
    group_id: 1,
  });
  state.subject_groups = [];
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Экспорт", exact: true }),
  ).toBeDisabled();
});

test("no active groups cannot leak a fallback board", async ({ page }) => {
  const state = snapshot();
  state.groups.forEach((g) => {
    g.archived = true;
  });
  await open(page, state);
  await grades(page);
  await expect(page.getByLabel("Группа", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Предмет", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Добавить работу", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Экспорт", exact: true }),
  ).toBeDisabled();
});

test("root keeps teaching controls when using teacher mode without a teacher grant", async ({
  page,
}) => {
  await open(page, snapshot(), "teacher");
  await expect(
    page.getByRole("button", { name: "Создать событие", exact: true }),
  ).toBeVisible();
  await grades(page);
  for (const name of ["Добавить работу", "Экспорт", "Статистика"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  }
});

test("rename and archive preserve all checked subject groups", async ({
  page,
}) => {
  const commands = await open(page, snapshot());
  await admin(page);
  await page.getByRole("button", { name: /Physics/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("Archived physics");
  await dialog.getByLabel("Статус").selectOption("true");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands[0]).toMatchObject({
    kind: "subject",
    id: 10,
    enabled: true,
    group_ids: [1, 4],
  });
});

test("student sees only own bound subjects and no privileged controls", async ({
  page,
}) => {
  const state = snapshot();
  state.me = { ...state.me, group_id: 1, root: false, teacher: false };
  await open(page, state, "student");
  await grades(page);
  await expect(
    page.getByLabel("Предмет", { exact: true }).locator("option"),
  ).toHaveText(["Physics"]);
  await expect(
    page.getByLabel("Группа", { exact: true }).locator("option"),
  ).toHaveText(["Group A"]);
  await expect(page.locator("select.grade")).toHaveCount(0);
  for (const name of ["Добавить работу", "Экспорт", "Статистика"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  }
});
