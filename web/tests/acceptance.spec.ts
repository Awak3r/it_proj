import { test, expect, type Page } from "@playwright/test";
import type { State } from "../src/types";

// Browser rendering/interaction coverage only. Every API request is intercepted;
// command effects below are synthetic, not proof of backend persistence,
// authorization, queue sorting, or production SSE delivery.
const studentName = "Acceptance student";
const eventName = "Acceptance reception";
const gradeError = "Synthetic grade save rejected";

function snapshot(): State {
  const me = {
    id: 2001,
    name: "Acceptance teacher",
    group_id: null,
    teacher: true,
  };
  return {
    me,
    groups: [{ id: 1, name: "Acceptance group", archived: false }],
    subjects: [{ id: 1, name: "Acceptance subject", archived: false }],
    subject_groups: [{ subject_id: 1, group_id: 1 }],
    users: [me, { id: 3001, name: studentName, group_id: 1, teacher: false }],
    assignments: [{ subject_id: 1, group_id: 1, teacher_id: me.id }],
    labs: [1, 2, 3, 4].map((id) => ({
      id,
      subject_id: 1,
      group_id: 1,
      number: id,
      name: `Acceptance lab ${id}`,
      weight: 1,
      required: true,
      archived: false,
    })),
    grades: [4, 5, 2, null].map((value, i) => ({
      student_id: 3001,
      lab_id: i + 1,
      value,
      version: 1,
    })),
    grade_summaries: [],
    events: [
      {
        id: 1,
        name: eventName,
        subject_id: 1,
        teacher_id: me.id,
        teacher_name: me.name,
        group_ids: [1],
        starts_at: "2026-11-15T10:00:00Z",
        room: "404",
        description: "",
        duration: 10,
        state: "live",
        registration_open: true,
        strategy: "fifo",
        shuffled: false,
        first_called: true,
        manual_order: false,
        average_minutes: null,
      },
    ],
    entries: [
      {
        id: 1,
        event_id: 1,
        user_id: 3001,
        user_name: studentName,
        group_id: 1,
        state: "called",
        position: 1,
        score: 2,
        skipped: false,
        called_at: "2026-11-15T10:00:00Z",
        joined_at: "2026-11-15T09:00:00Z",
      },
    ],
    audit: [],
  };
}

type Command =
  | {
      kind: "grade";
      user_id: number;
      lab_id: number;
      value: number | null;
      version: number;
    }
  | { kind: "finish"; event_id: number; id: number }
  | {
      kind: "lab";
      id: number;
      subject_id: number;
      group_id: number;
      number: number;
      name: string;
      enabled: boolean;
      weight?: number | string;
      required?: boolean;
    };

async function openApp(page: Page, state: State, rejectGrade = false) {
  const commands: Command[] = [];
  let releaseGrade!: () => void;
  const gradeGate = new Promise<void>((resolve) => {
    releaseGrade = resolve;
  });
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (path === "/api/state") return route.fulfill({ json: state });
    // A finite synthetic SSE frame also exercises snapshot refresh on reconnect.
    if (path === "/api/updates")
      return route.fulfill({
        contentType: "text/event-stream",
        body: "event: change\ndata: {}\n\n",
      });
    if (path !== "/api/command") return route.abort();
    const command = route.request().postDataJSON() as Command;
    commands.push(command);
    switch (command.kind) {
      case "grade": {
        if (rejectGrade) {
          await gradeGate;
          return route.fulfill({ status: 409, json: { error: gradeError } });
        }
        const grade = state.grades.find(
          (g) =>
            g.student_id === command.user_id && g.lab_id === command.lab_id,
        );
        if (!grade) throw new Error("Missing synthetic grade");
        expect(command.version).toBe(grade.version);
        grade.value = command.value;
        grade.version++;
        break;
      }
      case "finish": {
        const entry = state.entries.find(
          (e) => e.id === command.id && e.event_id === command.event_id,
        );
        if (!entry) throw new Error("Missing synthetic entry");
        entry.state = "completed";
        break;
      }
      case "lab": {
        const lab = state.labs.find((l) => l.id === command.id);
        if (command.id && !lab) throw new Error("Missing synthetic lab");
        if (lab)
          Object.assign(lab, {
            number: command.number,
            name: command.name,
            archived: command.enabled,
            weight: Number(command.weight ?? lab.weight ?? 1),
            weight_text: String(
              command.weight ?? lab.weight_text ?? lab.weight ?? 1,
            ),
            required: command.required ?? lab.required ?? true,
          });
        else
          state.labs.push({
            id: Math.max(0, ...state.labs.map((l) => l.id)) + 1,
            subject_id: command.subject_id,
            group_id: command.group_id,
            number: command.number,
            name: command.name,
            archived: command.enabled,
            weight: Number(command.weight ?? 1),
            weight_text: String(command.weight ?? 1),
            required: command.required ?? true,
          });
        break;
      }
      default:
        throw new Error(
          `Unexpected synthetic command: ${JSON.stringify(command)}`,
        );
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => localStorage.setItem("dev-user", "2001"));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Я преподаватель", exact: true })
    .click();
  await expect(page.locator("nav")).toBeVisible();
  return { commands, releaseGrade };
}

async function openGrades(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ведомость", exact: true }),
  ).toBeVisible();
}

async function openReception(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "События", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: eventName, exact: true }),
    })
    .click();
}

function gradeCell(page: Page, number: number) {
  return page.getByRole("combobox", {
    name: `${studentName}, ЛР ${number}`,
    exact: true,
  });
}

async function expectProgress(page: Page, passed: number, total: number) {
  const progress = page
    .getByRole("row")
    .filter({ hasText: studentName })
    .locator(".progress-label");
  await expect(progress).toHaveText(
    `${passed} / ${total}осталось ${total - passed}`,
  );
}

test("AC17 rendering: pending and rejected grade block finish; explicit cancel restores committed value and permits finish", async ({
  page,
}) => {
  const state = snapshot();
  const { commands, releaseGrade } = await openApp(page, state, true);
  await openGrades(page);
  await gradeCell(page, 1).selectOption("2");
  await expect(gradeCell(page, 1)).toBeDisabled();
  await expect(
    page.getByText("Сохраняем оценку…", { exact: true }),
  ).toBeVisible();
  await expectProgress(page, 2, 4); // The uncommitted failing grade must not alter progress.
  await openReception(page);
  await expect(
    page.getByRole("button", { name: "Завершить приём", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Завершить событие", exact: true }),
  ).toBeDisabled();
  expect(commands.map((c) => c.kind)).toEqual(["grade"]);

  releaseGrade();
  await openGrades(page);
  await expect(
    page.locator(".alert").filter({ hasText: gradeError }),
  ).toBeVisible();
  await expect(gradeCell(page, 1)).toHaveValue("2");
  await expect(gradeCell(page, 1)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Повторить", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".save-hint")).toHaveText(
    "Есть несохранённые изменения",
  );
  await expectProgress(page, 2, 4);
  await openReception(page);
  await expect(
    page.getByRole("button", { name: "Завершить приём", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Сохраните или отмените правки в ведомости перед завершением приёма.",
    ),
  ).toBeVisible();

  await openGrades(page);
  await page
    .getByRole("button", { name: "Отменить правку", exact: true })
    .click();
  await expect(gradeCell(page, 1)).toHaveValue("4");
  await expect(gradeCell(page, 1)).toBeEnabled();
  await expect(page.getByText(gradeError, { exact: false })).toHaveCount(0);
  await expect(page.locator(".save-hint")).toHaveText("Сохранено");
  await expectProgress(page, 2, 4);
  await openReception(page);
  await expect(
    page.getByRole("button", { name: "Завершить событие", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Завершить приём", exact: true })
    .click();
  await expect(page.locator(".current-student")).toHaveCount(0);
  expect(commands).toEqual([
    { kind: "grade", user_id: 3001, lab_id: 1, value: 2, version: 1 },
    { kind: "finish", event_id: 1, id: 1 },
  ]);
  expect(state.grades[0].value).toBe(4);
});

for (const value of [4, 5, 2, null]) {
  test(`AC14/15/26/28 rendering: grade ${value} counts as ${value !== null && value >= 3 ? "passed" : "remaining"} after save`, async ({
    page,
  }) => {
    const state = snapshot();
    // Start the first lab at 2, or at 4 when testing a non-passing edit.
    state.grades[0].value = value !== null && value >= 3 ? 2 : 4;
    const before = state.grades[0].value >= 3 ? 2 : 1;
    const { commands } = await openApp(page, state);
    await openGrades(page);
    await expectProgress(page, before, 4);
    await gradeCell(page, 1).selectOption(value === null ? "" : String(value));
    await expect(page.locator(".save-hint")).toHaveText("Сохранено");
    await expect(gradeCell(page, 1)).toBeEnabled();
    await expect(gradeCell(page, 1)).toHaveValue(
      value === null ? "" : String(value),
    );
    await expectProgress(page, value !== null && value >= 3 ? 2 : 1, 4);
    expect(commands).toEqual([
      { kind: "grade", user_id: 3001, lab_id: 1, value, version: 1 },
    ]);
  });
}

test("AC14/15/26/28 rendering: mixed 4/5/2/null grades use only active labs in the selected subject and group", async ({
  page,
}) => {
  const state = snapshot();
  state.labs.push(
    { ...state.labs[0], id: 5, number: 5, archived: true },
    { ...state.labs[0], id: 6, subject_id: 2 },
    { ...state.labs[0], id: 7, group_id: 2 },
  );
  state.grades.push(
    ...[5, 6, 7].map((lab_id) => ({
      student_id: 3001,
      lab_id,
      value: 5,
      version: 1,
    })),
  );
  await openApp(page, state);
  await openGrades(page);
  for (const [i, value] of ["4", "5", "2", ""].entries())
    await expect(gradeCell(page, i + 1)).toHaveValue(value);
  await expect(page.locator(".lab-heading")).toHaveCount(4);
  await expectProgress(page, 2, 4);
});

test("AC14/15/26/28 rendering: adding and archiving labs immediately updates passed and remaining arithmetic", async ({
  page,
}) => {
  const state = snapshot();
  const { commands } = await openApp(page, state);
  await openGrades(page);
  await expectProgress(page, 2, 4);
  await page
    .getByRole("button", { name: "Добавить работу", exact: true })
    .click();
  const add = page.getByRole("dialog", {
    name: "Новая лабораторная",
    exact: true,
  });
  await add.getByLabel("Номер", { exact: true }).fill("5");
  await add.getByLabel("Название", { exact: true }).fill("Live added lab");
  await add.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(add).toHaveCount(0);
  await expect(gradeCell(page, 5)).toHaveValue("");
  await expectProgress(page, 2, 5);

  // Archiving a passed lab removes both a numerator and denominator unit.
  await page
    .getByRole("button", { name: /^ЛР 1 Acceptance lab 1(?:\s|$)/ })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Редактировать работу",
    exact: true,
  });
  await edit
    .getByRole("combobox", { name: "Статус", exact: true })
    .selectOption("true");
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(gradeCell(page, 1)).toHaveCount(0);
  await expectProgress(page, 1, 4);

  // Archiving an ungraded lab removes only a denominator unit.
  await page
    .getByRole("button", { name: /^ЛР 5 Live added lab(?:\s|$)/ })
    .click();
  await edit
    .getByRole("combobox", { name: "Статус", exact: true })
    .selectOption("true");
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(gradeCell(page, 5)).toHaveCount(0);
  await expectProgress(page, 1, 3);
  expect(commands).toEqual([
    {
      kind: "lab",
      id: 0,
      subject_id: 1,
      group_id: 1,
      number: 5,
      name: "Live added lab",
      enabled: false,
      weight: "1",
      required: true,
    },
    {
      kind: "lab",
      id: 1,
      subject_id: 1,
      group_id: 1,
      number: 1,
      name: "Acceptance lab 1",
      enabled: true,
      weight: "1",
      required: true,
    },
    {
      kind: "lab",
      id: 5,
      subject_id: 1,
      group_id: 1,
      number: 5,
      name: "Live added lab",
      enabled: true,
      weight: "1",
      required: true,
    },
  ]);
});

test("AC14/15/26/28 rendering: remote lab snapshots update progress on live reconnect without navigation", async ({
  page,
}) => {
  const state = snapshot();
  const { commands } = await openApp(page, state);
  await openGrades(page);
  await expectProgress(page, 2, 4);
  // The online event invokes the real live.ts reconnect/invalidation path.
  // This simulates remote snapshots, not delivery by a real SSE server.
  state.labs.push({ ...state.labs[0], id: 5, number: 5, name: "Remote lab" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(gradeCell(page, 5)).toHaveValue("");
  await expectProgress(page, 2, 5);
  state.labs[0].archived = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(gradeCell(page, 1)).toHaveCount(0);
  await expectProgress(page, 1, 4);
  expect(commands).toEqual([]);
});
