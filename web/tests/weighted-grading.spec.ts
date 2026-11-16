import { test, expect, type Page } from "@playwright/test";
import type { GradeSummary, State } from "../src/types";

const studentName = "Weighted student";
const summary = (patch: Partial<GradeSummary> = {}): GradeSummary => ({
  student_id: 3001,
  subject_id: 1,
  group_id: 1,
  average: 3.67,
  final_hint: 4,
  required_total: 1,
  required_passed: 1,
  ...patch,
});

function snapshot(student = false): State {
  const teacher = {
    id: 2001,
    name: "Weighted teacher",
    group_id: null,
    teacher: true,
  };
  const pupil = { id: 3001, name: studentName, group_id: 1, teacher: false };
  return {
    me: student ? pupil : teacher,
    users: [teacher, pupil],
    groups: [{ id: 1, name: "Weighted group", archived: false }],
    subjects: [{ id: 1, name: "Weighted subject", archived: false }],
    subject_groups: [{ subject_id: 1, group_id: 1 }],
    assignments: [{ teacher_id: 2001, subject_id: 1, group_id: 1 }],
    labs: [
      {
        id: 1,
        subject_id: 1,
        group_id: 1,
        number: 1,
        name: "Required lab",
        weight: 2,
        required: true,
        archived: false,
      },
      {
        id: 2,
        subject_id: 1,
        group_id: 1,
        number: 2,
        name: "Optional lab",
        weight: 1,
        required: false,
        archived: false,
      },
    ],
    // Intentionally not sufficient to reproduce the server's summary. These
    // tests verify the API projection, not a second implementation of its math.
    grades: [{ student_id: 3001, lab_id: 1, value: 5, version: 1 }],
    grade_summaries: [summary()],
    events: [],
    entries: [],
    audit: [],
  };
}

type LabCommand = {
  kind: "lab";
  id: number;
  subject_id: number;
  group_id: number;
  number: number;
  name: string;
  enabled: boolean;
  weight: string;
  required: boolean;
};
type GradeCommand = {
  kind: "grade";
  user_id: number;
  lab_id: number;
  value: number | null;
  version: number;
};

async function openSynthetic(page: Page, state: State, rejectGrade = false, studentMode = false) {
  const commands: (LabCommand | GradeCommand)[] = [];
  let releaseGrade!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGrade = resolve;
  });
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path !== "/api/command") return route.abort();
    const command = route.request().postDataJSON() as LabCommand | GradeCommand;
    commands.push(command);
    if (command.kind === "grade") {
      await gate;
      if (rejectGrade)
        return route.fulfill({
          status: 409,
          json: { error: "Weighted grade rejected" },
        });
      const grade = state.grades.find(
        (g) => g.student_id === command.user_id && g.lab_id === command.lab_id,
      );
      if (!grade) throw new Error("Missing synthetic grade");
      grade.value = command.value;
      grade.version++;
    } else if (command.kind === "lab") {
      const lab = state.labs.find((l) => l.id === command.id);
      const metadata = {
        subject_id: command.subject_id,
        group_id: command.group_id,
        number: command.number,
        name: command.name,
        archived: command.enabled,
        weight: Number(command.weight),
        weight_text: String(command.weight),
        required: command.required ?? lab?.required ?? true,
      };
      if (lab) Object.assign(lab, metadata);
      else
        state.labs.push({
          id: Math.max(0, ...state.labs.map((l) => l.id)) + 1,
          ...metadata,
        });
    } else
      throw new Error(
        `Unexpected weighted command: ${JSON.stringify(command)}`,
      );
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(
    (id) => localStorage.setItem("dev-user", String(id)),
    state.me.id,
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: !studentMode && state.me.teacher ? "Я преподаватель" : "Я студент",
      exact: true,
    })
    .click();
  await openGrades(page);
  return { commands, releaseGrade };
}

for (const root of [false, true]) {
  test(`student mode hides teaching controls (root=${root}, teacher=false)`, async ({ page }) => {
    const state = snapshot(true);
    state.me = { ...state.me, root };
    await openSynthetic(page, state, false, true);
    await expect(page.getByRole("button", { name: "Добавить работу" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Экспорт", exact: true })).toHaveCount(0);
    await expect(page.locator("select.grade")).toHaveCount(0);
    await expect(page.locator("nav").getByRole("button", { name: "Управление", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Сменить роль" }).click();
    await page.getByRole("button", { name: "Я преподаватель", exact: true }).click();
    if (root) {
      await openGrades(page);
      await expect(page.getByRole("button", { name: "Добавить работу" })).toBeVisible();
      await expect(page.locator("select.grade").first()).toBeEnabled();
    } else {
      await expect(page.getByText("Роль преподавателя выдаёт root.", { exact: false })).toBeVisible();
      await expect(page.locator("nav")).toHaveCount(0);
    }
  });
}

async function openGrades(page: Page) {
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
}
const row = (page: Page) =>
  page.getByRole("row").filter({ hasText: studentName });
async function expectSummary(page: Page, average: string, final: string) {
  await expect(row(page).locator(".grade-average")).toHaveText(average);
  await expect(row(page).locator(".grade-final")).toHaveText(final);
}
async function refresh(page: Page) {
  const loaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/state",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await loaded;
}

for (const scenario of [
  {
    name: "formats the authoritative average with two Russian decimals",
    data: summary(),
    average: "3,67",
    final: "4",
  },
  {
    name: "does not double-round the server final hint",
    data: summary({ average: 4.5, final_hint: 4 }),
    average: "4,50",
    final: "4",
  },
  {
    name: "allows an ungraded optional lab when required work is passed",
    data: summary({ average: 4.25, final_hint: 4 }),
    average: "4,25",
    final: "4",
  },
  {
    name: "uses server required counts instead of inferring completion from visible grades",
    data: summary({
      average: 3,
      final_hint: null,
      required_total: 2,
      required_passed: 1,
    }),
    average: "3,00",
    final: "Не все обязательные работы сданы",
  },
  {
    name: "shows no data when the server has no average",
    data: summary({
      average: null,
      final_hint: null,
      required_total: 0,
      required_passed: 0,
    }),
    average: "—",
    final: "Нет данных",
  },
]) {
  test(`weighted rendering: ${scenario.name}`, async ({ page }) => {
    const state = snapshot();
    state.grade_summaries = [scenario.data];
    await openSynthetic(page, state);
    await expect(
      page.getByRole("columnheader", { name: "Средний балл", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Итог (подсказка)", exact: true }),
    ).toBeVisible();
    await expectSummary(page, scenario.average, scenario.final);
  });
}

test("weighted rendering: summaries must match student, subject AND group; absent summary is not calculated locally", async ({
  page,
}) => {
  const state = snapshot();
  state.grade_summaries = [
    summary({ student_id: 3002, average: 2, final_hint: 2 }),
    summary({ subject_id: 2, average: 3, final_hint: 3 }),
    summary({ group_id: 2, average: 5, final_hint: 5 }),
  ];
  await openSynthetic(page, state);
  await expectSummary(page, "—", "Нет данных");
  state.grade_summaries.push(summary());
  await refresh(page);
  await expectSummary(page, "3,67", "4");
});

test("weighted rendering: pending and rejected grades withhold both summaries until cancelled", async ({
  page,
}) => {
  const state = snapshot();
  // Another student's summary remains usable while this student's edit is pending.
  state.users.push({
    id: 3002,
    name: "Unaffected student",
    group_id: 1,
    teacher: false,
  });
  state.grade_summaries.push(
    summary({ student_id: 3002, average: 4.5, final_hint: 4 }),
  );
  const { releaseGrade } = await openSynthetic(page, state, true);
  await expectSummary(page, "3,67", "4");
  try {
    await page
      .getByRole("combobox", { name: `${studentName}, ЛР 1`, exact: true })
      .selectOption("2");
    await expectSummary(page, "—", "Есть несохранённые оценки");
    const other = page
      .getByRole("row")
      .filter({ hasText: "Unaffected student" });
    await expect(other.locator(".grade-average")).toHaveText("4,50");
    await expect(other.locator(".grade-final")).toHaveText("4");
    // Even a fresh committed snapshot cannot confirm an in-flight edit.
    await refresh(page);
    await expectSummary(page, "—", "Есть несохранённые оценки");
    releaseGrade();
    await expect(
      page.locator(".alert").filter({ hasText: "Weighted grade rejected" }),
    ).toBeVisible();
    await expectSummary(page, "—", "Есть несохранённые оценки");
    await page
      .getByRole("button", { name: "Отменить правку", exact: true })
      .click();
    await expectSummary(page, "3,67", "4");
  } finally {
    releaseGrade();
  }
});

test("weighted rendering: a confirmed grade displays the fresh server summary", async ({
  page,
}) => {
  const state = snapshot();
  const { releaseGrade } = await openSynthetic(page, state);
  try {
    const cell = page.getByRole("combobox", {
      name: `${studentName}, ЛР 1`,
      exact: true,
    });
    await cell.selectOption("4");
    await expectSummary(page, "—", "Есть несохранённые оценки");
    state.grade_summaries = [summary({ average: 4.5, final_hint: 4 })];
    releaseGrade();
    await expect(cell).toBeEnabled();
    await expectSummary(page, "4,50", "4");
  } finally {
    releaseGrade();
  }
});

test("weighted rendering: lab form defaults, decimal-string payload, positive validation and existing controls", async ({
  page,
}) => {
  const { commands } = await openSynthetic(page, snapshot());
  await page
    .getByRole("button", { name: "Добавить работу", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Новая лабораторная",
    exact: true,
  });
  await expect(dialog.getByLabel("Номер", { exact: true })).toHaveValue("3");
  const weight = dialog.getByLabel("Вес работы", { exact: true });
  await expect(weight).toHaveValue("1");
  await expect(weight).toHaveAttribute("type", "number");
  await expect(weight).toHaveAttribute("step", "any");
  await expect(weight).toHaveAttribute("max", "1000000");
  const required = dialog.getByRole("combobox", {
    name: "Обязательность",
    exact: true,
  });
  await expect(required).toHaveValue("true");
  await expect(required.getByRole("option")).toHaveText([
    "Обязательная",
    "Необязательная",
  ]);
  await expect(dialog.getByLabel("Статус", { exact: true })).toHaveCount(0);
  await dialog
    .getByLabel("Название", { exact: true })
    .fill("Fractional optional lab");
  await weight.fill("0");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(commands).toHaveLength(0);
  await weight.fill("1.25");
  await required.selectOption("false");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toEqual([
    {
      kind: "lab",
      id: 0,
      subject_id: 1,
      group_id: 1,
      number: 3,
      name: "Fractional optional lab",
      enabled: false,
      weight: "1.25",
      required: false,
    },
  ]);
  await expect(
    page.locator(".lab-heading").filter({ hasText: "Fractional optional lab" }),
  ).toContainText("Вес: 1.25 · необязательная");
});

test("weighted rendering: editing weight and required updates metadata and fresh authoritative summary", async ({
  page,
}) => {
  const state = snapshot();
  const { commands } = await openSynthetic(page, state);
  const heading = page
    .locator(".lab-heading")
    .filter({ hasText: "Required lab" });
  await expect(heading).toContainText("Вес: 2 · обязательная");
  await expect(
    page.locator(".lab-heading").filter({ hasText: "Optional lab" }),
  ).toContainText("Вес: 1 · необязательная");
  await heading.click();
  const dialog = page.getByRole("dialog", {
    name: "Редактировать работу",
    exact: true,
  });
  await expect(dialog.getByLabel("Вес работы", { exact: true })).toHaveValue(
    "2",
  );
  await expect(
    dialog.getByLabel("Обязательность", { exact: true }),
  ).toHaveValue("true");
  await expect(dialog.getByLabel("Номер", { exact: true })).toHaveValue("1");
  await expect(dialog.getByLabel("Название", { exact: true })).toHaveValue(
    "Required lab",
  );
  await expect(dialog.getByLabel("Статус", { exact: true })).toHaveValue(
    "false",
  );
  await dialog.getByLabel("Вес работы", { exact: true }).fill("3");
  await dialog
    .getByLabel("Обязательность", { exact: true })
    .selectOption("false");
  state.grade_summaries = [
    summary({
      average: 4.5,
      final_hint: 4,
      required_total: 0,
      required_passed: 0,
    }),
  ];
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toEqual([
    {
      kind: "lab",
      id: 1,
      subject_id: 1,
      group_id: 1,
      number: 1,
      name: "Required lab",
      enabled: false,
      weight: "3",
      required: false,
    },
  ]);
  await expect(heading).toContainText("Вес: 3 · необязательная");
  await expectSummary(page, "4,50", "4");
});

test("weighted rendering: renaming a high-precision required lab preserves its exact decimal weight", async ({
  page,
}) => {
  const state = snapshot();
  const exactWeight = "0.500000000000000000001";
  state.labs[0] = { ...state.labs[0], weight: 0.5, weight_text: exactWeight };
  state.grade_summaries = [summary({ average: 4.5, final_hint: 4 })];
  const { commands } = await openSynthetic(page, state);
  await expectSummary(page, "4,50", "4");
  const heading = page
    .locator(".lab-heading")
    .filter({ hasText: "Required lab" });
  await expect(heading).toContainText(`Вес: ${exactWeight} · обязательная`);
  await heading.click();
  const dialog = page.getByRole("dialog", {
    name: "Редактировать работу",
    exact: true,
  });
  await expect(dialog.getByLabel("Вес работы", { exact: true })).toHaveValue(
    exactWeight,
  );
  await expect(
    dialog.getByLabel("Обязательность", { exact: true }),
  ).toHaveValue("true");
  await dialog
    .getByLabel("Название", { exact: true })
    .fill("Renamed precise lab");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toEqual([
    {
      kind: "lab",
      id: 1,
      subject_id: 1,
      group_id: 1,
      number: 1,
      name: "Renamed precise lab",
      enabled: false,
      weight: exactWeight,
      required: true,
    },
  ]);
  expect(state.labs[0]).toMatchObject({
    weight: 0.5,
    weight_text: exactWeight,
    required: true,
  });
  const renamed = page
    .locator(".lab-heading")
    .filter({ hasText: "Renamed precise lab" });
  await expect(renamed).toContainText(`Вес: ${exactWeight} · обязательная`);
  await expectSummary(page, "4,50", "4");
  await renamed.click();
  await expect(dialog.getByLabel("Вес работы", { exact: true })).toHaveValue(
    exactWeight,
  );
});

test("weighted rendering: student sees summaries and metadata read-only", async ({
  page,
}) => {
  const { commands } = await openSynthetic(page, snapshot(true));
  await expectSummary(page, "3,67", "4");
  await expect(
    page.locator(".lab-heading").filter({ hasText: "Required lab" }),
  ).toContainText("Вес: 2 · обязательная");
  await expect(
    page.locator(".lab-heading").filter({ hasText: "Required lab" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Добавить работу", exact: true }),
  ).toHaveCount(0);
  await expect(row(page).getByRole("combobox")).toHaveCount(0);
  expect(commands).toEqual([]);
});
