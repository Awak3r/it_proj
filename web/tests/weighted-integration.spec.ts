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
    await command({ kind: "subject", name, group_ids: [group!.id] });
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

test("statistics local API: isolated weighted board matches the root panel and hides aggregates from students", async ({
  page,
  baseURL,
}) => {
  const target = new URL(baseURL!);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
  const config = await page.request.get("/api/config");
  expect(config.ok(), await config.text()).toBeTruthy();
  expect(await config.json()).toMatchObject({ dev_auth: true });

  const command = async (data: Record<string, unknown>, userId = 1001) => {
    const response = await page.request.post("/api/command", {
      headers: {
        "X-Dev-User": String(userId),
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const read = async (userId = 1001): Promise<State> => {
    const response = await page.request.get("/api/state", {
      headers: { "X-Dev-User": String(userId) },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const initial = await read();
  expect(initial.me.root).toBe(true);
  // UUID-derived 48-bit IDs remain safe JS integers and never reuse seeded users.
  const existingIds = new Set(initial.users.map((user) => user.id));
  let studentA: number;
  let studentB: number;
  do {
    studentA =
      Number.parseInt(
        crypto.randomUUID().replaceAll("-", "").slice(0, 12),
        16,
      ) + 1_000_000_000_000;
    studentB = studentA + 1;
  } while (existingIds.has(studentA) || existingIds.has(studentB));
  expect(Number.isSafeInteger(studentA) && Number.isSafeInteger(studentB)).toBe(
    true,
  );

  const name = `Statistics API UI ${crypto.randomUUID()}`;
  const nameA = `${name} A`;
  const nameB = `${name} B`;
  let group: State["groups"][number] | undefined;
  let subject: State["subjects"][number] | undefined;
  try {
    await command({ kind: "group", name });
    group = (await read()).groups.find((item) => item.name === name);
    expect(group).toBeDefined();
    await command({ kind: "subject", name, group_ids: [group!.id] });
    subject = (await read()).subjects.find((item) => item.name === name);
    expect(subject).toBeDefined();
    await command(
      { kind: "profile", name: nameA, group_id: group!.id },
      studentA,
    );
    await command(
      { kind: "profile", name: nameB, group_id: group!.id },
      studentB,
    );
    for (const [number, required, weight] of [
      [1, true, "2"],
      [2, false, "1"],
    ] as const) {
      await command({
        kind: "lab",
        subject_id: subject!.id,
        group_id: group!.id,
        number,
        name: `${name} ${required ? "required" : "optional"}`,
        required,
        weight,
      });
    }
    const fixtureLabs = (await read()).labs.filter(
      (lab) =>
        lab.group_id === group!.id &&
        lab.subject_id === subject!.id &&
        !lab.archived,
    );
    expect(fixtureLabs).toHaveLength(2);
    const required = fixtureLabs.find((lab) => lab.required)!;
    const optional = fixtureLabs.find((lab) => !lab.required)!;
    expect(required).toBeDefined();
    expect(optional).toBeDefined();
    await command({
      kind: "grade",
      user_id: studentA,
      lab_id: required.id,
      value: 5,
      version: 0,
    });
    await command({
      kind: "grade",
      user_id: studentA,
      lab_id: optional.id,
      value: 2,
      version: 0,
    });

    const state = await read();
    const board = { group_id: group!.id, subject_id: subject!.id };
    expect(
      state.grade_statistics?.filter(
        (stats) =>
          stats.group_id === board.group_id &&
          stats.subject_id === board.subject_id,
      ),
    ).toEqual([
      {
        ...board,
        students_count: 2,
        labs_count: 2,
        required_labs_count: 1,
        debtors_count: 1,
        final_ready_count: 1,
        average: 3,
        distribution: { missing: 2, "2": 1, "3": 0, "4": 0, "5": 1 },
      },
    ]);
    expect(
      state.lab_statistics
        ?.filter(
          (stats) =>
            stats.group_id === board.group_id &&
            stats.subject_id === board.subject_id,
        )
        .sort((a, b) => a.lab_id - b.lab_id),
    ).toEqual(
      [
        {
          ...board,
          lab_id: required.id,
          students_count: 2,
          graded_count: 1,
          passed_count: 1,
          missing_count: 1,
          failed_count: 0,
          average: 5,
        },
        {
          ...board,
          lab_id: optional.id,
          students_count: 2,
          graded_count: 1,
          passed_count: 0,
          missing_count: 1,
          failed_count: 1,
          average: 2,
        },
      ].sort((a, b) => a.lab_id - b.lab_id),
    );
    for (const [student_id, average, final_hint, required_passed] of [
      [studentA, 4, 4, 1],
      [studentB, 2, null, 0],
    ] as const) {
      expect(
        state.grade_summaries.find(
          (summary) =>
            summary.student_id === student_id &&
            summary.group_id === board.group_id &&
            summary.subject_id === board.subject_id,
        ),
      ).toMatchObject({
        ...board,
        student_id,
        average,
        final_hint,
        required_total: 1,
        required_passed,
      });
      const studentState = await read(student_id);
      expect(studentState.grade_statistics).toEqual([]);
      expect(studentState.lab_statistics).toEqual([]);
    }

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
    await page.getByRole("button", { name: "Статистика", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "Статистика ведомости",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect(
      panel
        .locator(".statistics-cards > div")
        .filter({ has: page.getByText("Средний балл группы", { exact: true }) })
        .locator("dd"),
    ).toHaveText("3,00");
    await expect(
      panel.getByRole("progressbar", {
        name: `Сдано ЛР 1: ${required.name}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-valuenow", "50");
    await expect(
      panel.getByRole("progressbar", {
        name: `Сдано ЛР 1: ${required.name}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-valuetext", "1 из 2, 50%");
    const rows = panel.getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: nameA }).locator("th, td")).toHaveText([
      nameA,
      "1 / 1",
      "4,00",
      "4",
    ]);
    await expect(rows.filter({ hasText: nameB }).locator("th, td")).toHaveText([
      nameB,
      "0 / 1",
      "2,00",
      "Долг по обязательным",
    ]);
  } finally {
    // Archive only this UUID board; leave all seeded identities and data alone.
    if (group && subject) {
      for (const lab of (await read()).labs.filter(
        (lab) =>
          lab.group_id === group!.id &&
          lab.subject_id === subject!.id &&
          lab.name.startsWith(name) &&
          !lab.archived,
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
