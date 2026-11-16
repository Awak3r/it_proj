import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(role: "student" | "teacher" | "root" = "student"): State {
  const me = {
    id: role === "student" ? 3001 : role === "teacher" ? 2001 : 1001,
    name: role === "student" ? "Анна Студентова" : "Проверяющий",
    group_id: role === "teacher" ? null : 1,
    teacher: role === "teacher",
    root: role === "root",
  };
  return {
    me,
    users: [
      me,
      { id: 3002, name: "Семён Ёлкин", group_id: 1, teacher: false },
      { id: 4001, name: "Чужой Студент", group_id: 2, teacher: false },
      // Deliberately stale group membership must not leak a teacher into rosters.
      { id: 2002, name: "Скрытый Преподаватель", group_id: 1, teacher: true },
    ],
    groups: [
      { id: 1, name: "ИВТ-Ё01", archived: false },
      { id: 2, name: "ПИ-202", archived: false },
    ],
    subjects: [{ id: 1, name: "Программирование", archived: false }],
    subject_groups: [1, 2].map((group_id) => ({ subject_id: 1, group_id })),
    assignments: [],
    labs: [
      {
        id: 1,
        subject_id: 1,
        group_id: 1,
        number: 1,
        name: "Основы",
        archived: false,
        weight: 1,
        required: true,
      },
    ],
    grades: [],
    grade_summaries: [],
    events: [
      {
        id: 1,
        name: "Случайная очередь",
        strategy: "random",
        registration_open: true,
        group_ids: [1],
        teacher_id: 2001,
      },
      {
        id: 2,
        name: "Закрытая запись",
        strategy: "fifo",
        registration_open: false,
        group_ids: [1],
        teacher_id: 2001,
      },
      {
        id: 3,
        name: "Другая группа",
        strategy: "fifo",
        registration_open: true,
        group_ids: [2],
        teacher_id: 2002,
      },
    ].map((event) => ({
      ...event,
      subject_id: 1,
      teacher_name: "Преподаватель очереди",
      starts_at: "2030-01-01T10:00:00Z",
      room: "101",
      description: "",
      duration: 10,
      state: event.id === 2 ? "live" : "planned",
      shuffled: false,
      first_called: false,
      manual_order: false,
      average_minutes: null,
    })),
    entries: [],
    audit: [],
  };
}

async function open(
  page: Page,
  state: State,
  mode?: "student" | "teacher" | "root",
) {
  const commands: Record<string, unknown>[] = [];
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  // Only local static assets may reach the network; every API response is synthetic.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (url.pathname === "/api/state") return route.fulfill({ json: state });
    if (
      url.pathname === "/api/command" &&
      route.request().method() === "POST"
    ) {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.kind === "profile") state.me.name = command.name;
      return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.addInitScript(
    (id) => localStorage.setItem("dev-user", String(id)),
    state.me.id,
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Вход", exact: true }),
  ).toBeVisible();
  if (mode) {
    await page
      .getByRole("button", {
        name:
          mode === "root"
            ? "Управление root →"
            : mode === "teacher"
              ? "Я преподаватель"
              : "Я студент",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "События", exact: true }),
    ).toBeVisible();
  }
  return commands;
}

async function event(page: Page, name: string) {
  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .click();
  await expect(
    page.getByRole("heading", { name: "Порядок приёма", exact: true }),
  ).toBeVisible();
}

for (const root of [false, true]) {
  test(`teacher role screen excludes student even when root=${root}`, async ({
    page,
  }) => {
    const state = snapshot("teacher");
    state.me.root = root;
    await open(page, state);
    await expect(
      page.getByRole("button", { name: "Я студент", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Я преподаватель", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Управление root →", exact: true }),
    ).toHaveCount(root ? 1 : 0);
  });
}

test("root without a teacher grant can still select student", async ({
  page,
}) => {
  await open(page, snapshot("root"));
  await page.getByRole("button", { name: "Я студент", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "События", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать событие", exact: true }),
  ).toHaveCount(0);
});

test("teacher has no own-group navigation or queue join but retains teaching actions", async ({
  page,
}) => {
  await open(page, snapshot("teacher"), "teacher");
  await expect(
    page
      .locator("nav")
      .getByRole("button", { name: "Моя группа", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать событие", exact: true }),
  ).toBeEnabled();
  for (const name of [
    "Случайная очередь",
    "Закрытая запись",
    "Другая группа",
  ]) {
    await event(page, name);
    await expect(
      page.getByRole("button", { name: "Записаться", exact: true }),
    ).toHaveCount(0);
    if (name === "Случайная очередь") {
      await expect(
        page.getByRole("heading", { name: "Управление очередью", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Закрыть запись", exact: true }),
      ).toBeEnabled();
    }
    await page.getByRole("button", { name: "К событиям", exact: true }).click();
  }
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Добавить работу", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Экспорт", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Семён Ёлкин" })
      .locator("select.grade"),
  ).toBeEnabled();
  await expect(page.getByRole("table")).not.toContainText("Скрытый Преподаватель");
});

test("teacher profile omits group selection and saves group_id zero", async ({
  page,
}) => {
  const commands = await open(page, snapshot("teacher"), "teacher");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Преподаватель не состоит в студенческой группе.",
  );
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByLabel("Имя и фамилия").fill("Новое Имя");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toEqual([
    { kind: "profile", name: "Новое Имя", group_id: 0 },
  ]);
});

test("eligible ordinary student joins a random event before root shuffle", async ({
  page,
}) => {
  const state = snapshot();
  const commands = await open(page, state, "student");
  await event(page, "Случайная очередь");
  const join = page.getByRole("button", { name: "Записаться", exact: true });
  await expect(join).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Перемешать один раз", exact: true }),
  ).toHaveCount(0);
  await join.click();
  await expect.poll(() => commands).toEqual([{ kind: "join", event_id: 1 }]);
  expect(state.events[0].shuffled).toBe(false);
});

for (const [name, reason] of [
  ["Закрытая запись", "Запись закрыта преподавателем."],
  ["Другая группа", "Событие недоступно вашей группе."],
]) {
  test(`student cannot join ${name} and sees the reason`, async ({ page }) => {
    const commands = await open(page, snapshot(), "student");
    await event(page, name);
    await expect(
      page.getByRole("button", { name: "Записаться", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#join-reason")).toBeVisible();
    await expect(page.locator("#join-reason")).toContainText(reason);
    await expect(
      page.getByRole("button", { name: "Записаться", exact: true }),
    ).toHaveAttribute("aria-describedby", "join-reason");
    expect(commands).toEqual([]);
  });
}

function directoryState() {
  const state = snapshot("root");
  state.me.group_id = null;
  state.users = [
    state.me,
    ...Array.from({ length: 53 }, (_, index) => ({
      id: 5000 + index,
      name:
        index === 0
          ? "Семён Ёлкин"
          : `Студент ${String(index).padStart(2, "0")}`,
      group_id: index < 30 ? 1 : 2,
      teacher: false,
    })),
    { id: 2002, name: "Скрытый Преподаватель", group_id: 1, teacher: true },
  ];
  return state;
}

async function directory(page: Page) {
  await open(page, directoryState(), "root");
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
  return page.locator("section.panel").filter({
    has: page.getByRole("heading", { name: "Студенты", exact: true }),
  });
}

test("admin directory paginates 5 students and excludes teachers on every page", async ({
  page,
}) => {
  const panel = await directory(page);
  const rows = panel.locator(".admin-row");
  const names: string[] = [];
  await expect(panel.getByRole("status")).toHaveText("Найдено: 53");
  await expect(
    panel.getByRole("button", { name: "Предыдущая", exact: true }),
  ).toBeDisabled();
  for (const [index, count] of [...Array(10).fill(5), 3].entries()) {
    await expect(rows).toHaveCount(count);
    await expect(panel).toContainText(`Страница ${index + 1} из 11`);
    await expect(panel).not.toContainText("Скрытый Преподаватель");
    names.push(...(await rows.allTextContents()));
    if (index < 10)
      await panel
        .getByRole("button", { name: "Следующая", exact: true })
        .click();
  }
  expect(new Set(names).size).toBe(53);
  await expect(
    panel.getByRole("button", { name: "Следующая", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Предыдущая", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(panel).toContainText("Страница 10 из 11");
});

test("admin directory searches normalized name, group, ID and no-match, resetting paging", async ({
  page,
}) => {
  const panel = await directory(page);
  const search = panel.getByLabel("Поиск студентов", { exact: true });
  await expect(search).toHaveAttribute(
    "placeholder",
    "Фамилия, имя, группа или Telegram ID",
  );
  await panel.getByRole("button", { name: "Следующая", exact: true }).click();
  for (const query of [
    "  сЕМЕН еЛКИН  ",
    "СЕМЁН ЁЛКИН",
    "5000",
    "елкин ивт-е01",
  ]) {
    await search.fill(query);
    await expect(panel.locator(".admin-row")).toHaveCount(1);
    await expect(panel.locator(".admin-row")).toContainText("Семён Ёлкин");
    await expect(panel.getByRole("status")).toHaveText("Найдено: 1");
  }
  await search.fill("пи-202");
  await expect(panel.locator(".admin-row")).toHaveCount(5);
    await expect(panel.getByRole("status")).toHaveText("Найдено: 23");
    await expect(panel).toContainText("Страница 1 из 5");
  await expect(
    panel.locator(".admin-row").filter({ hasText: "ИВТ-Ё01" }),
  ).toHaveCount(0);
  await search.fill("Никого не существует");
  await expect(panel.locator(".admin-row")).toHaveCount(0);
  await expect(
    panel.getByText("Студенты не найдены", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText("Найдено: 0");
  await search.fill("");
  await expect(panel.locator(".admin-row")).toHaveCount(5);
  await expect(panel).toContainText("Страница 1 из 11");
});

for (const width of [390, 1440]) {
  test(`student own group is a read-only scoped roster at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const commands = await open(page, snapshot(), "student");
    await page
      .locator("nav")
      .getByRole("button", { name: "Моя группа", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Моя группа", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".page-title")).toContainText("ИВТ-Ё01");
    const roster = page.locator("section.panel").filter({
      has: page.getByRole("heading", {
        name: "Студенты группы",
        exact: true,
      }),
    });
    await expect(roster.locator(".admin-row")).toHaveCount(2);
    await expect(roster).toContainText("Анна Студентова (вы)");
    await expect(roster).toContainText("Семён Ёлкин");
    await expect(roster).not.toContainText(
      /Скрытый Преподаватель|Чужой Студент|ПИ-202/,
    );
    await expect(roster.getByRole("button")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /^(Управление|Добавить преподавателя|Создать событие|Добавить работу|Экспорт)$/,
      }),
    ).toHaveCount(0);
    await expect(page.locator("select.grade, .audit")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Профиль", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "Ваша группа: ИВТ-Ё01.",
    );
    await expect(page.getByRole("dialog").getByRole("combobox")).toHaveCount(0);
    expect(commands).toEqual([]);
  });
}
