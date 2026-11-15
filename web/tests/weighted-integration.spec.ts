import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

async function openGrades(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
}

// This is intentionally a real API/browser integration, not a route mock. Run
// with the full fresh local seed (normal BASE_URL); never the persistent sandbox.
test("weighted local API: UI creates, persists, edits and archives an isolated lab", async ({
  page,
  baseURL,
}) => {
  const target = new URL(baseURL!);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);

  const headers = { "X-Dev-User": "1001" };
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const read = async (): Promise<State> => {
    const response = await page.request.get("/api/state", { headers });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const name = `Weighted UI ${crypto.randomUUID()}`;
  let group: State["groups"][number] | undefined;
  let subject: State["subjects"][number] | undefined;
  try {
    await command({ kind: "group", name });
    group = (await read()).groups.find((g) => g.name === name);
    expect(group).toBeDefined();
    await command({ kind: "subject", name });
    subject = (await read()).subjects.find((s) => s.name === name);
    expect(subject).toBeDefined();
    await page.route("https://telegram.org/**", (route) => route.abort());
    await page.addInitScript(() => localStorage.setItem("dev-user", "1001"));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Управление root", exact: false })
      .click();
    await openGrades(page);
    await page
      .getByRole("combobox", { name: /^Группа/ })
      .selectOption(String(group!.id));
    await page
      .getByRole("combobox", { name: /^Предмет/ })
      .selectOption(String(subject!.id));
    await page
      .getByRole("button", { name: "Добавить работу", exact: true })
      .click();
    const add = page.getByRole("dialog", {
      name: "Новая лабораторная",
      exact: true,
    });
    await add.getByLabel("Номер", { exact: true }).fill("101");
    await add.getByLabel("Название", { exact: true }).fill(name);
    await add.getByLabel("Вес работы", { exact: true }).fill("2.5");
    await add
      .getByLabel("Обязательность", { exact: true })
      .selectOption("false");
    await add.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(add).toHaveCount(0);
    const heading = page.locator(".lab-heading").filter({ hasText: name });
    await expect(heading).toContainText("необязательная");
    let lab = (await read()).labs.find(
      (l) =>
        l.group_id === group!.id &&
        l.subject_id === subject!.id &&
        l.number === 101,
    );
    expect(lab).toMatchObject({
      name,
      weight: 2.5,
      required: false,
      archived: false,
    });
    if (lab?.weight_text !== undefined) expect(lab.weight_text).toBe("2.5");
    await heading.click();
    const edit = page.getByRole("dialog", {
      name: "Редактировать работу",
      exact: true,
    });
    await expect(edit.getByLabel("Вес работы", { exact: true })).toHaveValue(
      "2.5",
    );
    await expect(
      edit.getByLabel("Обязательность", { exact: true }),
    ).toHaveValue("false");
    await edit.getByLabel("Вес работы", { exact: true }).fill("2");
    await edit
      .getByLabel("Обязательность", { exact: true })
      .selectOption("true");
    await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(heading).toContainText("Вес: 2 · обязательная");
    const labId = lab!.id;
    lab = (await read()).labs.find((l) => l.id === labId);
    expect(lab).toMatchObject({ weight: 2, required: true, archived: false });
    if (lab?.weight_text !== undefined) expect(lab.weight_text).toBe("2");
    await heading.click();
    await edit.getByLabel("Статус", { exact: true }).selectOption("true");
    await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(heading).toHaveCount(0);
    expect((await read()).labs.find((l) => l.id === lab!.id)).toMatchObject({
      weight: 2,
      required: true,
      archived: true,
    });
  } finally {
    // Also cleans up partial failures; no seeded identities, memberships, grades
    // or assignments are modified by this fixture.
    if (group && subject) {
      for (const lab of (await read()).labs.filter(
        (l) =>
          l.group_id === group!.id &&
          l.subject_id === subject!.id &&
          !l.archived,
      )) {
        await command({
          kind: "lab",
          ...lab,
          weight: lab.weight_text ?? String(lab.weight),
          enabled: true,
        });
      }
    }
    if (subject)
      await command({ kind: "subject", id: subject.id, name, enabled: true });
    if (group)
      await command({ kind: "group", id: group.id, name, enabled: true });
  }
});
