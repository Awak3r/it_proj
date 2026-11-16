import { expect, test, type Page } from "@playwright/test";
import type { GradeStatistics, LabStatistics, State } from "../src/types";

type StatisticsState = State & {
  grade_statistics?: GradeStatistics[];
  lab_statistics?: LabStatistics[];
};

function snapshot(): StatisticsState {
  const teacher = {
    id: 2001,
    name: "Преподаватель статистики",
    group_id: null,
    teacher: true,
  };
  return {
    me: teacher,
    groups: [1, 2].map((id) => ({ id, name: `Группа ${id}`, archived: false })),
    subjects: [1, 2].map((id) => ({
      id,
      name: `Предмет ${id}`,
      archived: false,
    })),
    subject_groups: [
      { subject_id: 1, group_id: 1 },
      { subject_id: 2, group_id: 1 },
      { subject_id: 1, group_id: 2 },
    ],
    users: [
      teacher,
      { id: 3001, name: "Анна Готовая", group_id: 1, teacher: false },
      { id: 3002, name: "Борис Должник", group_id: 1, teacher: false },
      { id: 3003, name: "Вера Готовая", group_id: 1, teacher: false },
      { id: 4001, name: "Другая Группа", group_id: 2, teacher: false },
    ],
    labs: [
      {
        id: 11,
        subject_id: 1,
        group_id: 1,
        number: 1,
        name: "Основы",
        weight: 1,
        weight_text: "1",
        required: true,
        archived: false,
      },
      {
        id: 12,
        subject_id: 1,
        group_id: 1,
        number: 2,
        name: "Дополнительная",
        weight: 1.25,
        weight_text: "1.25",
        required: false,
        archived: false,
      },
      {
        id: 21,
        subject_id: 2,
        group_id: 1,
        number: 1,
        name: "Другой предмет",
        weight: 2,
        required: true,
        archived: false,
      },
      {
        id: 31,
        subject_id: 1,
        group_id: 2,
        number: 1,
        name: "Другая работа",
        weight: 1,
        required: true,
        archived: false,
      },
    ],
    grades: [
      { student_id: 3001, lab_id: 11, value: 5, version: 1 },
      { student_id: 3001, lab_id: 12, value: 2, version: 1 },
      { student_id: 3002, lab_id: 12, value: 4, version: 1 },
      { student_id: 3003, lab_id: 11, value: 3, version: 1 },
    ],
    grade_summaries: [
      {
        student_id: 3001,
        subject_id: 1,
        group_id: 1,
        average: 3.33,
        final_hint: 3,
        required_total: 1,
        required_passed: 1,
      },
      {
        student_id: 3002,
        subject_id: 1,
        group_id: 1,
        average: 3.11,
        final_hint: null,
        required_total: 1,
        required_passed: 0,
      },
      {
        student_id: 3003,
        subject_id: 1,
        group_id: 1,
        average: 3,
        final_hint: 3,
        required_total: 1,
        required_passed: 1,
      },
      {
        student_id: 3001,
        subject_id: 2,
        group_id: 1,
        average: 2,
        final_hint: null,
        required_total: 1,
        required_passed: 0,
      },
      {
        student_id: 4001,
        subject_id: 1,
        group_id: 2,
        average: 4.44,
        final_hint: 4,
        required_total: 1,
        required_passed: 1,
      },
    ],
    grade_statistics: [
      {
        subject_id: 1,
        group_id: 1,
        students_count: 3,
        labs_count: 2,
        required_labs_count: 1,
        debtors_count: 1,
        final_ready_count: 2,
        average: 3.15,
        distribution: { missing: 2, "2": 1, "3": 1, "4": 1, "5": 1 },
      },
      {
        subject_id: 2,
        group_id: 1,
        students_count: 3,
        labs_count: 1,
        required_labs_count: 1,
        debtors_count: 3,
        final_ready_count: 0,
        average: 2,
        distribution: { missing: 3, "2": 0, "3": 0, "4": 0, "5": 0 },
      },
      {
        subject_id: 1,
        group_id: 2,
        students_count: 1,
        labs_count: 1,
        required_labs_count: 1,
        debtors_count: 0,
        final_ready_count: 1,
        average: 4.44,
        distribution: { missing: 0, "2": 0, "3": 0, "4": 1, "5": 0 },
      },
    ],
    lab_statistics: [
      {
        lab_id: 11,
        subject_id: 1,
        group_id: 1,
        students_count: 3,
        graded_count: 2,
        passed_count: 2,
        missing_count: 1,
        failed_count: 0,
        average: 4,
      },
      {
        lab_id: 12,
        subject_id: 1,
        group_id: 1,
        students_count: 3,
        graded_count: 2,
        passed_count: 1,
        missing_count: 1,
        failed_count: 1,
        average: 3,
      },
      {
        lab_id: 31,
        subject_id: 1,
        group_id: 2,
        students_count: 1,
        graded_count: 1,
        passed_count: 1,
        missing_count: 0,
        failed_count: 0,
        average: 4.44,
      },
    ],
    assignments: [],
    events: [],
    entries: [],
    audit: [],
  };
}

async function openSynthetic(
  page: Page,
  state: StatisticsState,
  studentMode = false,
) {
  let releaseGrade!: () => void;
  const gradeGate = new Promise<void>((resolve) => {
    releaseGrade = resolve;
  });
  // Block every non-local resource too: Telegram and any unexpected third-party script.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !==
      new URL(
        page.url() === "about:blank"
          ? (test.info().project.use.baseURL as string)
          : page.url(),
      ).origin
    )
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    return route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({ json: { dev_auth: true } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (
      path === "/api/command" &&
      route.request().postDataJSON().kind === "grade"
    ) {
      await gradeGate;
      return route.fulfill({
        status: 409,
        json: { error: "Synthetic grade rejected" },
      });
    }
    return route.abort();
  });
  await page.addInitScript(
    (id) => localStorage.setItem("dev-user", String(id)),
    state.me.id,
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: studentMode ? "Я студент" : "Я преподаватель",
      exact: true,
    })
    .click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Ведомость", exact: true })
    .click();
  return releaseGrade;
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "Статистика ведомости", exact: true });
async function openStatistics(page: Page) {
  await page.getByRole("button", { name: "Статистика", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
const studentRow = (page: Page, name: string) =>
  panel(page).getByRole("row").filter({ hasText: name });

test("statistics renders authoritative averages, accessible actual-grade chart and lab percentages", async ({
  page,
}) => {
  await openSynthetic(page, snapshot());
  await openStatistics(page);
  await expect(
    page.getByRole("heading", { name: "Ведомость", exact: true }),
  ).toBeVisible();
  await expect(panel(page).locator(".statistics-cards")).toContainText("3,15");
  await expect(
    panel(page).getByRole("meter", { name: "Оценка 2", exact: true }),
  ).toHaveAttribute("aria-valuenow", "1");
  await expect(
    panel(page).getByRole("meter", { name: "Оценка 2", exact: true }),
  ).toHaveAttribute("aria-valuetext", "1 из 4 выставленных оценок");
  await expect(panel(page).getByRole("meter")).toHaveCount(4);
  await expect(panel(page).locator(".statistics-missing")).toContainText(
    "Без оценки: 2",
  );
  await expect(
    panel(page).getByRole("progressbar", {
      name: "Сдано ЛР 1: Основы",
      exact: true,
    }),
  ).toHaveAttribute("aria-valuenow", "67");
  const optional = panel(page)
    .locator(".statistics-labs li")
    .filter({ hasText: "Дополнительная" });
  await expect(optional).toContainText("Необязательная · Вес: 1.25");
  await expect(optional).toContainText("Средний: 3,00");
  await expect(optional).toContainText("Оценка 2: 1");
  await expect(studentRow(page, "Анна Готовая")).toContainText("3,33");
  await expect(panel(page).locator("select.grade, button")).toHaveCount(0);
  await page.getByRole("button", { name: "К оценкам", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("select.grade").first()).toBeVisible();
});

test("statistics search and mandatory-debt filter do not count optional failures", async ({
  page,
}) => {
  await openSynthetic(page, snapshot());
  await openStatistics(page);
  await panel(page).getByLabel("Показать студентов").selectOption("debtors");
  await expect(studentRow(page, "Борис Должник")).toContainText("0 / 1");
  await expect(studentRow(page, "Анна Готовая")).toHaveCount(0);
  await panel(page).getByLabel("Показать студентов").selectOption("ready");
  await expect(studentRow(page, "Анна Готовая")).toBeVisible();
  await expect(studentRow(page, "Борис Должник")).toHaveCount(0);
  await panel(page).getByLabel("Поиск студента").fill("  вЕрА  ");
  await expect(studentRow(page, "Вера Готовая")).toBeVisible();
  await expect(studentRow(page, "Анна Готовая")).toHaveCount(0);
  await panel(page).getByLabel("Поиск студента").fill("Нет такого имени");
  await expect(panel(page).getByRole("status")).toHaveText(
    "Студенты не найдены.",
  );
});

test("statistics follows both group and subject selectors without leaking another board", async ({
  page,
}) => {
  await openSynthetic(page, snapshot());
  await openStatistics(page);
  await page.getByLabel("Предмет", { exact: true }).selectOption("2");
  await expect(panel(page).locator(".statistics-cards")).toContainText("2,00");
  await expect(studentRow(page, "Анна Готовая")).toContainText(
    "Долг по обязательным",
  );
  await expect(panel(page)).not.toContainText("Основы");
  await expect(panel(page)).not.toContainText("3,33");
  await page.getByLabel("Предмет", { exact: true }).selectOption("1");
  await page.getByLabel("Группа", { exact: true }).selectOption("2");
  await expect(panel(page).locator(".statistics-cards")).toContainText("4,44");
  await expect(studentRow(page, "Другая Группа")).toBeVisible();
  await expect(studentRow(page, "Анна Готовая")).toHaveCount(0);
  await expect(panel(page)).not.toContainText("Основы");
});

test("statistics handles an empty board and zero denominators", async ({
  page,
}) => {
  const state = snapshot();
  state.users = [state.me];
  state.labs = [];
  state.grades = [];
  state.grade_summaries = [];
  state.lab_statistics = [];
  state.grade_statistics = [
    {
      subject_id: 1,
      group_id: 1,
      students_count: 0,
      labs_count: 0,
      required_labs_count: 0,
      debtors_count: 0,
      final_ready_count: 0,
      average: null,
      distribution: { missing: 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    },
  ];
  await openSynthetic(page, state);
  await openStatistics(page);
  await expect(panel(page).locator(".statistics-cards")).toContainText(
    "Нет данных",
  );
  await expect(
    panel(page).getByText("Нет студентов.", { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("meter", { name: "Оценка 2", exact: true }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(panel(page)).not.toContainText(/NaN|Infinity/);
});

test("statistics tolerates absent optional state fields and missing student summaries", async ({
  page,
}) => {
  const state = snapshot();
  delete state.grade_statistics;
  delete state.lab_statistics;
  state.grade_summaries = [];
  await openSynthetic(page, state);
  await openStatistics(page);
  await expect(
    panel(page).getByText(
      "Нет данных статистики для выбранной группы и предмета.",
    ),
  ).toBeVisible();
  await expect(
    studentRow(page, "Анна Готовая").getByRole("cell", {
      name: "Нет данных",
      exact: true,
    }),
  ).toHaveCount(3);
  await expect(panel(page).getByRole("meter")).toHaveCount(0);
  await expect(panel(page).getByRole("progressbar")).toHaveCount(0);
  await expect(panel(page)).not.toContainText(/NaN|Infinity/);
});

test("pending grades either block panel entry or hide every stale metric", async ({
  page,
}) => {
  const releaseGrade = await openSynthetic(page, snapshot());
  try {
    const row = page.getByRole("row").filter({ hasText: "Анна Готовая" });
    await row.locator("select.grade").first().selectOption("4");
    const button = page.getByRole("button", {
      name: "Статистика",
      exact: true,
    });
    if (await button.isDisabled()) {
      await expect(button).toBeDisabled();
      await expect(panel(page)).toHaveCount(0);
    } else {
      await openStatistics(page);
      await expect(panel(page).getByRole("status")).toContainText(
        "Статистика скрыта",
      );
      await expect(
        panel(page).locator(
          ".statistics-cards, table, [role=meter], [role=progressbar]",
        ),
      ).toHaveCount(0);
      await expect(panel(page)).not.toContainText("3,15");
      await expect(panel(page)).not.toContainText("3,33");
    }
  } finally {
    releaseGrade();
  }
});

test("committed grades keep statistics hidden until cancellation refresh succeeds", async ({
  page,
}) => {
  // Freeze background polling so only the explicit save/cancel snapshots run.
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const state = snapshot();
  await openSynthetic(page, state);
  await openStatistics(page);
  await expect(panel(page).locator(".statistics-cards")).toContainText("3,15");
  await page.getByRole("button", { name: "К оценкам", exact: true }).click();

  let phase: "post-save" | "cancel-held" | "retry" = "post-save";
  let gradeCommands = 0;
  const snapshots: string[] = [];
  let releaseCancellation!: () => void;
  let cancellationStarted!: () => void;
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const cancellationRequest = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  await page.route("**/api/command", async (route) => {
    const command = route.request().postDataJSON();
    expect(command).toMatchObject({
      kind: "grade",
      user_id: 3001,
      lab_id: 11,
      value: 4,
      version: 1,
    });
    gradeCommands++;
    const grade = state.grades.find(
      (item) => item.student_id === 3001 && item.lab_id === 11,
    )!;
    grade.value = 4;
    grade.version = 2;
    const summary = state.grade_summaries.find(
      (item) =>
        item.student_id === 3001 &&
        item.subject_id === 1 &&
        item.group_id === 1,
    )!;
    summary.average = 2.89;
    summary.final_hint = 3;
    const statistics = state.grade_statistics!.find(
      (item) => item.subject_id === 1 && item.group_id === 1,
    )!;
    statistics.average = 3;
    statistics.distribution = { missing: 2, "2": 1, "3": 1, "4": 2, "5": 0 };
    state.lab_statistics!.find((item) => item.lab_id === 11)!.average = 3.5;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/state", async (route) => {
    const requestPhase = phase;
    snapshots.push(requestPhase);
    if (requestPhase === "cancel-held") {
      cancellationStarted();
      await cancellationGate;
    }
    if (requestPhase !== "retry")
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic snapshot unavailable" },
      });
    return route.fulfill({ json: state });
  });
  const backToGrades = () =>
    page.getByRole("button", { name: "К оценкам", exact: true }).click();
  const expectHidden = async () => {
    await openStatistics(page);
    await expect(panel(page).getByRole("status")).toContainText(
      "Статистика скрыта",
    );
    await expect(
      panel(page).locator(
        ".statistics-cards, table, [role=meter], [role=progressbar]",
      ),
    ).toHaveCount(0);
    await expect(panel(page)).not.toContainText(/3,15|3,33|3,00|2,89/);
  };
  const cancel = () =>
    page.getByRole("button", { name: "Отменить правку", exact: true });
  try {
    await page
      .getByRole("row")
      .filter({ hasText: "Анна Готовая" })
      .locator("select.grade")
      .first()
      .selectOption("4");
    await expect(
      page.getByText(
        "Оценка сохранена, но ведомость не обновилась. Повторите проверку.",
        { exact: false },
      ),
    ).toBeVisible();
    expect(gradeCommands).toBe(1);
    expect(snapshots).toEqual(["post-save"]);
    await expectHidden();
    await backToGrades();

    phase = "cancel-held";
    await cancel().click();
    await cancellationRequest;
    await expectHidden();
    releaseCancellation();
    await backToGrades();
    await expect(
      page.getByText(
        "Не удалось обновить ведомость. Повторите отмену правки.",
        { exact: false },
      ),
    ).toBeVisible();
    await expectHidden();
    await backToGrades();

    phase = "retry";
    await cancel().click();
    await expect(cancel()).toHaveCount(0);
    await expect(page.locator(".save-hint")).toHaveText("Сохранено");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "Анна Готовая" })
        .locator("select.grade")
        .first(),
    ).toHaveValue("4");
    await openStatistics(page);
    await expect(panel(page).locator(".statistics-cards")).toContainText(
      "3,00",
    );
    await expect(studentRow(page, "Анна Готовая")).toContainText("2,89");
    await expect(
      panel(page).getByRole("meter", { name: "Оценка 4", exact: true }),
    ).toHaveAttribute("aria-valuenow", "2");
    await expect(
      panel(page).getByRole("meter", { name: "Оценка 5", exact: true }),
    ).toHaveAttribute("aria-valuenow", "0");
    await expect(
      panel(page).locator(".statistics-labs li").filter({ hasText: "Основы" }),
    ).toContainText("Средний: 3,50");
    await expect(panel(page)).not.toContainText(/3,15|3,33|Статистика скрыта/);
    expect(gradeCommands).toBe(1);
    expect(snapshots).toEqual(["post-save", "cancel-held", "retry"]);
  } finally {
    releaseCancellation();
  }
});

for (const privileged of [false, true]) {
  test(`student mode has no statistics entry (privileged=${privileged})`, async ({
    page,
  }) => {
    const state = snapshot();
    state.me = privileged
      ? { ...state.me, group_id: 1, root: true }
      : state.users[1];
    await openSynthetic(page, state, true);
    await expect(
      page.getByRole("button", { name: "Статистика", exact: true }),
    ).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
  });
}

test("mobile statistics contains horizontal scrolling inside the progress table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = snapshot();
  state.users[1].name = "ОченьДлинноеИмяСтудентаБезПробелов".repeat(5);
  state.labs[0].name = "ОченьДлинноеНазваниеРаботы".repeat(5);
  await openSynthetic(page, state);
  await openStatistics(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  const table = panel(page).getByRole("region", {
    name: "Таблица прогресса студентов",
    exact: true,
  });
  await expect(table).toHaveAttribute("tabindex", "0");
  await expect
    .poll(() =>
      table.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => table.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});
