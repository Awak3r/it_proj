import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(root = false, teacher = false): State {
  const me = {
    id: root ? 1001 : teacher ? 2001 : 3001,
    name: "Тестовый пользователь",
    root,
    teacher,
    group_id: teacher ? null : 101,
  };
  return {
    me,
    groups: [{ id: 101, name: "Тестовая группа", archived: false }],
    subjects: [{ id: 201, name: "Тестовый предмет", archived: false }],
    subject_groups: [{ subject_id: 201, group_id: 101 }],
    users: [me],
    assignments: [],
    labs: [],
    grades: [],
    grade_summaries: [],
    events: [],
    entries: [],
    audit: [],
  };
}

declare global {
  interface Window {
    rootRole: {
      state: State;
      commands: Record<string, unknown>[];
      connected: boolean;
      change: () => void;
    };
  }
}

async function open(page: Page, state: State) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
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
    const api: Window["rootRole"] = (window.rootRole = {
      state,
      commands: [],
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
        const command = JSON.parse(String(init.body));
        api.commands.push(command);
        if (command.kind === "profile") {
          api.state.me.name = command.name;
          api.state.me.group_id = command.group_id || null;
        }
        return json({ ok: true });
      }
      throw new Error(`Unmocked API: ${url.pathname}`);
    };
  }, state);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.rootRole.connected))
    .toBe(true);
}

async function noRoleControls(page: Page) {
  await expect(page.locator(".role-card")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /^(Я студент|Я преподаватель|Управление root →|Сменить роль)$/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Вход", exact: true }),
  ).toHaveCount(0);
}

async function chooser(page: Page, teacher = false) {
  await expect(
    page.getByRole("heading", { name: "Вход", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Я студент", exact: true }),
  ).toHaveCount(teacher ? 0 : 1);
  await expect(
    page.getByRole("button", { name: "Я преподаватель", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Управление root →", exact: true }),
  ).toBeVisible();
}

for (const teacher of [false, true]) {
  test(`nonroot automatically enters API ${teacher ? "teacher" : "student"} role without role controls`, async ({
    page,
  }) => {
    await open(page, snapshot(false, teacher));
    await expect(
      page.getByRole("heading", { name: "События", exact: true }),
    ).toBeVisible();
    await noRoleControls(page);
    await expect(
      page
        .locator("nav")
        .getByRole("button", { name: "Мои события", exact: true }),
    ).toHaveCount(teacher ? 1 : 0);
    await expect(
      page
        .locator("nav")
        .getByRole("button", { name: "Моя группа", exact: true }),
    ).toHaveCount(teacher ? 0 : 1);
    await expect(
      page.getByRole("button", { name: "Создать событие", exact: true }),
    ).toHaveCount(teacher ? 1 : 0);
    await page.getByRole("button", { name: "Профиль", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await noRoleControls(page);
    expect(await page.evaluate(() => window.rootRole.commands)).toEqual([]);
  });
}

for (const missing of ["name", "group", "both", "teacher-name"] as const) {
  test(`nonroot ${missing} onboarding opens profile directly without a route back to role selection`, async ({
    page,
  }) => {
    const teacher = missing === "teacher-name";
    const state = snapshot(false, teacher);
    if (missing !== "group") state.me.name = "";
    if (missing === "group" || missing === "both") state.me.group_id = null;
    await open(page, state);
    await expect(
      page.getByRole("heading", { name: "Профиль", exact: true }),
    ).toBeVisible();
    await noRoleControls(page);
    await expect(
      page.getByRole("button", { name: "Назад", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Ваша группа", exact: true }),
    ).toHaveCount(teacher ? 0 : 1);
    await page.getByLabel("Имя и фамилия", { exact: true }).fill("Новое имя");
    if (!teacher && !state.me.group_id)
      await page.getByRole("combobox", { name: "Ваша группа", exact: true }).selectOption("101");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "События", exact: true }),
    ).toBeVisible();
    await noRoleControls(page);
    expect(await page.evaluate(() => window.rootRole.commands)).toEqual([
      { kind: "profile", name: "Новое имя", group_id: teacher ? 0 : 101 },
    ]);
  });
}

for (const teacher of [false, true]) {
  test(`root ${teacher ? "with" : "without"} explicit teacher flag can switch back from every available mode`, async ({
    page,
  }) => {
    await open(page, snapshot(true, teacher));
    await chooser(page, teacher);
    const modes = teacher
      ? ["Я преподаватель", "Управление root →"]
      : ["Я студент", "Я преподаватель", "Управление root →"];
    for (const mode of modes) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "События", exact: true }),
      ).toBeVisible();
      if (mode === "Я студент") {
        // Root privileges are masked in this view, but account-level switching must remain available.
        await expect(
          page
            .locator("nav")
            .getByRole("button", { name: "Управление", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Создать событие", exact: true }),
        ).toHaveCount(0);
      }
      await page
        .getByRole("button", { name: "Сменить роль", exact: true })
        .click();
      await chooser(page, teacher);
    }
    expect(await page.evaluate(() => window.rootRole.commands)).toEqual([]);
  });
}

test("SSE promotion replaces the student view and closes an open student profile form", async ({
  page,
}) => {
  await open(page, snapshot());
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByLabel("Имя и фамилия", { exact: true })
    .fill("Несохранённое имя");
  await page.evaluate(() => {
    window.rootRole.state.me.teacher = true;
    window.rootRole.state.me.group_id = null;
    window.rootRole.change();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Создать событие", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("nav")
      .getByRole("button", { name: "Мои события", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("nav")
      .getByRole("button", { name: "Моя группа", exact: true }),
  ).toHaveCount(0);
  await noRoleControls(page);
  expect(await page.evaluate(() => window.rootRole.commands)).toEqual([]);
});

for (const group of [null, 101]) {
  test(`SSE revocation closes an open teacher form and enters ${group ? "student view" : "group onboarding"}`, async ({
    page,
  }) => {
    await open(page, snapshot(false, true));
    await page
      .getByRole("button", { name: "Создать событие", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate((group) => {
      window.rootRole.state.me.teacher = false;
      window.rootRole.state.me.group_id = group;
      window.rootRole.change();
    }, group);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Создать событие", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .locator("nav")
        .getByRole("button", { name: "Мои события", exact: true }),
    ).toHaveCount(0);
    await noRoleControls(page);
    if (group) {
      await expect(
        page.getByRole("heading", { name: "События", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator("nav")
          .getByRole("button", { name: "Моя группа", exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByRole("heading", { name: "Профиль", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Ваша группа", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Назад", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("combobox", { name: "Ваша группа", exact: true }).selectOption("101");
      await page
        .getByRole("button", { name: "Продолжить", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "События", exact: true }),
      ).toBeVisible();
      await noRoleControls(page);
    }
    expect(await page.evaluate(() => window.rootRole.commands)).toEqual(
      group
        ? []
        : [{ kind: "profile", name: "Тестовый пользователь", group_id: 101 }],
    );
  });
}
