import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

const blocks = [
  ["Группы", "Поиск групп", "Название или ID", 12],
  ["Предметы", "Поиск предметов", "Название, ID или группа", 12],
  ["Преподаватели", "Поиск преподавателей", "Фамилия, имя или Telegram ID", 12],
  ["Студенты", "Поиск студентов", "Фамилия, имя, группа или Telegram ID", 12],
  [
    "Последние изменения",
    "Поиск изменений",
    "Действие, пользователь или дата",
    100,
  ],
] as const;

function snapshot(): State {
  const me = {
    id: 1001,
    name: "Администратор",
    root: true,
    teacher: false,
    group_id: null,
  };
  return {
    me,
    groups: Array.from({ length: 12 }, (_, i) => ({
      id: 101 + i,
      name: i === 11 ? "Группа Ёлка" : `Группа ${i + 1}`,
      archived: i === 11,
    })),
    subjects: Array.from({ length: 12 }, (_, i) => ({
      id: 201 + i,
      name: i === 11 ? "Предмет Ёмкость" : `Предмет ${i + 1}`,
      archived: i === 11,
    })),
    subject_groups: Array.from({ length: 12 }, (_, i) => ({
      subject_id: 201 + i,
      group_id: 101 + i,
    })),
    users: [
      me,
      ...Array.from({ length: 12 }, (_, i) => ({
        id: 2001 + i,
        name: i === 11 ? "Семён Учитель" : `Преподаватель ${i + 1}`,
        teacher: true,
        group_id: null,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        id: 3001 + i,
        name: i === 11 ? "Семён Студент" : `Студент ${i + 1}`,
        teacher: false,
        group_id: 101,
      })),
    ],
    audit: Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      actor_id: i === 99 ? 2012 : 1001,
      action: i === 99 ? "Редкое изменение" : `Изменение ${i + 1}`,
      at: i === 99 ? "2030-06-17T10:23:00Z" : "2030-01-01T10:00:00Z",
      payload: {},
    })),
    assignments: [],
    labs: [],
    grades: [],
    grade_summaries: [],
    events: [],
    entries: [],
  };
}

declare global {
  interface Window {
    adminDirectory: {
      state: State;
      commands: Record<string, unknown>[];
      connected: boolean;
      change: () => void;
    };
  }
}

async function open(
  page: Page,
  state = snapshot(),
  mode = "Управление root →",
) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  // Only this origin's static files can reach the network, never a backend or Telegram.
  await page.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin && !/^\/api(?:\/|$)/.test(url.pathname)
      ? route.continue()
      : route.abort();
  });
  await page.addInitScript((state) => {
    localStorage.setItem("dev-user", String(state.me.id));
    const originalFetch = window.fetch.bind(window);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const api: Window["adminDirectory"] = (window.adminDirectory = {
      state,
      commands: [] as Record<string, unknown>[],
      connected: false,
      change: () =>
        stream?.enqueue(
          new TextEncoder().encode("event: change\ndata: {}\n\n"),
        ),
    });
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    window.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (url.origin !== location.origin)
        throw new Error("External fetch blocked");
      if (!/^\/api(?:\/|$)/.test(url.pathname))
        return originalFetch(input, init);
      if (url.pathname === "/api/config") return json({ dev_auth: true });
      if (url.pathname === "/api/state") return json(api.state);
      if (url.pathname === "/api/updates") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              api.connected = true;
              api.change();
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/api/command" && init?.method === "POST") {
        api.commands.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      throw new Error(`Unmocked API: ${url.pathname}`);
    };
  }, state);
  await page.goto("/");
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
}

function panel(page: Page, title: string) {
  return page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

for (const width of [320, 390, 1440]) {
  test(`all five paginators center their rows and align text with buttons at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await expect(page.locator(".directory-pagination")).toHaveCount(5);
    for (const [title, label] of blocks) {
      const block = panel(page, title);
      await expect(block.locator(".admin-row")).toHaveCount(5);
      const pagination = block.getByLabel(`${label}: страницы`, {
        exact: true,
      });
      await pagination.scrollIntoViewIfNeeded();
      const geometry = await pagination.evaluate((element) => {
        const panel = element.closest(".panel")!;
        const bounds = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const left =
          bounds.left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.paddingLeft);
        const right =
          bounds.right -
          parseFloat(style.borderRightWidth) -
          parseFloat(style.paddingRight);
        const children = Array.from(element.children).map((child) => {
          const rect = child.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            centerY: (rect.top + rect.bottom) / 2,
          };
        });
        const rows: (typeof children)[] = [];
        for (const child of children) {
          const row = rows.find((row) =>
            row.some(
              (item) =>
                Math.min(item.bottom, child.bottom) >
                Math.max(item.top, child.top),
            ),
          );
          if (row) row.push(child);
          else rows.push([child]);
        }
        return { left, right, rows };
      });
      if (width !== 320) expect(geometry.rows, title).toHaveLength(1);
      for (const row of geometry.rows) {
        const left = Math.min(...row.map((item) => item.left));
        const right = Math.max(...row.map((item) => item.right));
        expect(
          Math.abs((left + right) / 2 - (geometry.left + geometry.right) / 2),
          `${title}: centered line`,
        ).toBeLessThanOrEqual(1);
        expect(left, `${title}: no left overflow`).toBeGreaterThanOrEqual(
          geometry.left - 1,
        );
        expect(right, `${title}: no right overflow`).toBeLessThanOrEqual(
          geometry.right + 1,
        );
        expect(
          Math.max(...row.map((item) => item.centerY)) -
            Math.min(...row.map((item) => item.centerY)),
          `${title}: vertically centered text and buttons`,
        ).toBeLessThanOrEqual(1);
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const width of [390, 1440]) {
  test(`all five directories paginate at five rows independently at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    for (const [title, label, placeholder, total] of blocks) {
      const block = panel(page, title);
      await expect(block.getByLabel(label, { exact: true })).toHaveAttribute(
        "placeholder",
        placeholder,
      );
      await expect(block.getByRole("status")).toHaveText(`Найдено: ${total}`);
      await expect(block.locator(".admin-row")).toHaveCount(5);
      await expect(block).toContainText(
        `Страница 1 из ${Math.ceil(total / 5)}`,
      );
      await expect(
        block.getByRole("button", { name: "Предыдущая", exact: true }),
      ).toBeDisabled();
      await block
        .getByRole("button", { name: "Следующая", exact: true })
        .click();
      await expect(block).toContainText(
        `Страница 2 из ${Math.ceil(total / 5)}`,
      );
      await expect(block.locator(".admin-row")).toHaveCount(5);
    }
    await panel(page, "Группы")
      .getByLabel("Поиск групп", { exact: true })
      .fill("елка");
    await expect(panel(page, "Группы").locator(".admin-row")).toHaveCount(1);
    for (const [title, , , total] of blocks.slice(1)) {
      await expect(panel(page, title)).toContainText(
        `Страница 2 из ${Math.ceil(total / 5)}`,
      );
      await expect(panel(page, title).getByRole("status")).toHaveText(
        `Найдено: ${total}`,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("each directory searches off-page records with normalized AND terms and clears to page one", async ({
  page,
}) => {
  await open(page);
  const queries = [
    "  ЕЛКА 112 архив ",
    "ЕМКОСТЬ елка 212 архив",
    "сЕМЕН УЧИТЕЛЬ 2012",
    "семен студент 3012",
    "редкое 2012",
  ];
  for (const [i, [title, label, , total]] of blocks.entries()) {
    const block = panel(page, title);
    const search = block.getByLabel(label, { exact: true });
    await block.getByRole("button", { name: "Следующая", exact: true }).click();
    await search.fill(queries[i]);
    await expect(block.locator(".admin-row")).toHaveCount(1);
    await expect(block.getByRole("status")).toHaveText("Найдено: 1");
    await search.fill(`${queries[i]} несовпадение`);
    await expect(block.locator(".admin-row")).toHaveCount(0);
    await expect(block.getByRole("status")).toHaveText("Найдено: 0");
    await search.fill("");
    await expect(block.locator(".admin-row")).toHaveCount(5);
    await expect(block).toContainText(`Страница 1 из ${Math.ceil(total / 5)}`);
  }
});

test("audit searches all 100 API records by actor name, action and displayed Moscow date", async ({
  page,
}) => {
  await open(page);
  const block = panel(page, "Последние изменения");
  const search = block.getByLabel("Поиск изменений", { exact: true });
  for (const query of [
    "семен учитель редкое",
    "2012 редкое",
    "17 июн",
    "13:23",
  ]) {
    await search.fill(query);
    await expect(block.getByRole("status")).toHaveText("Найдено: 1");
    await expect(block.locator(".admin-row")).toContainText("Редкое изменение");
  }
});

for (const kind of ["group", "subject"] as const) {
  test(`filtered ${kind} edit retains the off-page target ID`, async ({
    page,
  }) => {
    await open(page);
    const block = panel(page, kind === "group" ? "Группы" : "Предметы");
    await block.getByRole("searchbox").fill(kind === "group" ? "112" : "212");
    await block.locator(".admin-row").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Название", { exact: true })).toHaveValue(
      kind === "group" ? "Группа Ёлка" : "Предмет Ёмкость",
    );
    await dialog.getByLabel("Название", { exact: true }).fill("Новое название");
    await dialog
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.adminDirectory.commands))
      .toEqual([
        kind === "group"
          ? { kind, id: 112, name: "Новое название", enabled: true }
          : {
              kind,
              id: 212,
              name: "Новое название",
              enabled: true,
              group_ids: [112],
            },
      ]);
  });
}

test("filtered teacher revoke and student transfer submit the intended users", async ({
  page,
}) => {
  await open(page);
  const teachers = panel(page, "Преподаватели");
  await teachers.getByRole("searchbox").fill("2012");
  page.once("dialog", (dialog) => dialog.accept());
  await teachers.getByRole("button", { name: /Отозвать роль/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.adminDirectory.commands.length))
    .toBe(1);
  const students = panel(page, "Студенты");
  await students.getByRole("searchbox").fill("3012");
  await students.getByRole("button", { name: "Группа", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Новая группа").selectOption("102");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.adminDirectory.commands))
    .toEqual([
      { kind: "role", user_id: 2012, enabled: false },
      { kind: "transfer", user_id: 3012, group_id: 102 },
    ]);
});

test("SSE snapshot shrink clamps every directory without an empty final page", async ({
  page,
}) => {
  await open(page);
  await expect
    .poll(() => page.evaluate(() => window.adminDirectory.connected))
    .toBe(true);
  for (const [title] of blocks) {
    const block = panel(page, title);
    await block.getByRole("button", { name: "Следующая", exact: true }).click();
    await block.getByRole("button", { name: "Следующая", exact: true }).click();
  }
  await page.evaluate(() => {
    const api = window.adminDirectory;
    api.state.groups = api.state.groups.slice(0, 6);
    api.state.subjects = api.state.subjects.slice(0, 6);
    api.state.users = [
      api.state.me,
      ...api.state.users.filter((u) => u.teacher).slice(0, 6),
      ...api.state.users.filter((u) => u.group_id !== null).slice(0, 6),
    ];
    api.state.audit = api.state.audit.slice(0, 6);
    api.change();
  });
  for (const [title] of blocks) {
    const block = panel(page, title);
    await expect(block.getByRole("status")).toHaveText("Найдено: 6");
    await expect(block).toContainText("Страница 2 из 2");
    await expect(block.locator(".admin-row")).toHaveCount(1);
    await expect(
      block.getByRole("button", { name: "Следующая", exact: true }),
    ).toBeDisabled();
    await block
      .getByRole("button", { name: "Предыдущая", exact: true })
      .click();
    await expect(block.locator(".admin-row")).toHaveCount(5);
  }
});

test("root teaching mode keeps catalog search but hides privileged directories", async ({
  page,
}) => {
  await open(page, snapshot(), "Я преподаватель");
  for (const title of ["Группы", "Предметы"]) {
    await expect(panel(page, title).getByRole("searchbox")).toBeVisible();
    await expect(panel(page, title).locator(".admin-row")).toHaveCount(5);
  }
  for (const title of ["Преподаватели", "Студенты", "Последние изменения"]) {
    await expect(panel(page, title)).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "Добавить преподавателя", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.adminDirectory.commands)).toEqual([]);
});
