import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

function snapshot(root = false): State {
  return {
    me: {
      id: root ? 1001 : 3001,
      name: "Test user",
      group_id: null,
      teacher: false,
      root,
    },
    groups: [],
    subjects: [],
    assignments: [],
    users: [],
    labs: [],
    grades: [],
    grade_summaries: [],
    events: [],
    entries: [],
    audit: [],
  };
}

// Exercise the real onboarding UI without changing any application database.
async function openProfile(page: Page, state: State) {
  const commands: Record<string, unknown>[] = [];
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/command") {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.kind !== "profile")
        throw new Error("Unexpected onboarding command");
      state.me.name = command.name;
      state.me.group_id = command.group_id || null;
      return route.fulfill({ json: { ok: true } });
    }
    return route.abort();
  });
  await page.addInitScript(
    (id) => localStorage.setItem("dev-user", String(id)),
    state.me.id,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Я студент", exact: true }).click();
  return commands;
}

for (const archivedOnly of [false, true]) {
  test(`student sees an explanation instead of an empty group selector (archived only: ${archivedOnly})`, async ({
    page,
  }) => {
    const state = snapshot();
    if (archivedOnly)
      state.groups.push({ id: 1, name: "Archived group", archived: true });
    const commands = await openProfile(page, state);
    await expect(page.getByRole("status")).toContainText("Групп пока нет.");
    await expect(page.getByRole("status")).toContainText(
      "Обратитесь к администратору",
    );
    await expect(
      page.getByRole("combobox", { name: "Ваша группа" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Перейти к управлению" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Продолжить" }),
    ).toBeDisabled();
    await page.getByLabel("Имя и фамилия").press("Enter");
    expect(commands).toHaveLength(0);
    await page.getByRole("button", { name: "Назад", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Я студент", exact: true }),
    ).toBeVisible();
  });
}

test("root must leave student mode before opening management", async ({
  page,
}) => {
  const commands = await openProfile(page, snapshot(true));
  await expect(page.getByRole("status")).toContainText("Обратитесь к администратору");
  await expect(page.getByRole("button", { name: "Перейти к управлению" })).toHaveCount(0);
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page.getByRole("button", { name: "Управление root →", exact: true }).click();
  await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Группы", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Назначения", exact: true }),
  ).toBeVisible();
  expect(commands).toHaveLength(0);
});

test("root without a saved name can complete the profile before opening management", async ({
  page,
}) => {
  const state = snapshot(true);
  state.me.name = "";
  const commands = await openProfile(page, state);
  await page.getByLabel("Имя и фамилия").fill("New root");
  await expect(page.getByRole("button", { name: "Перейти к управлению" })).toHaveCount(0);
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page.getByRole("button", { name: "Управление root →", exact: true }).click();
  await page.getByLabel("Имя и фамилия").fill("New root");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.locator("nav").getByRole("button", { name: "Управление", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Группы", exact: true }),
  ).toBeVisible();
  expect(commands).toEqual([
    { kind: "profile", name: "New root", group_id: 0 },
  ]);
});

test("student can select an active group and continue normally", async ({
  page,
}) => {
  const state = snapshot();
  state.groups = [
    { id: 1, name: "Archived group", archived: true },
    { id: 2, name: "Active group", archived: false },
  ];
  const commands = await openProfile(page, state);
  await expect(page.getByRole("status")).toHaveCount(0);
  const select = page.getByRole("combobox", { name: "Ваша группа" });
  await expect(select).toHaveValue("");
  await expect(select.getByRole("option")).toHaveText([
    "Выберите группу",
    "Active group",
  ]);
  await expect(page.getByRole("button", { name: "Продолжить" })).toBeDisabled();
  await select.selectOption("2");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(
    page.getByRole("heading", { name: "События", exact: true }),
  ).toBeVisible();
  expect(commands).toEqual([
    { kind: "profile", name: "Test user", group_id: 2 },
  ]);
});
