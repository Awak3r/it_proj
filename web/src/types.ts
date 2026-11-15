export type Group = { id: number; name: string; archived: boolean };
export type User = {
  id: number;
  name: string;
  group_id: number | null;
  teacher: boolean;
  root?: boolean;
};
export type Lab = {
  id: number;
  subject_id: number;
  group_id: number;
  number: number;
  name: string;
  archived: boolean;
  weight: number;
  weight_text?: string;
  required: boolean;
};
export type GradeSummary = {
  student_id: number;
  subject_id: number;
  group_id: number;
  average: number | null;
  final_hint: number | null;
  required_total: number;
  required_passed: number;
};
export type Grade = {
  student_id: number;
  lab_id: number;
  value: number | null;
  version: number;
};
export type Event = {
  id: number;
  name: string;
  subject_id: number;
  teacher_id: number;
  teacher_name: string;
  group_ids: number[];
  starts_at: string;
  room: string;
  description: string;
  duration: number;
  state: string;
  registration_open: boolean;
  strategy: string;
  shuffled: boolean;
  first_called: boolean;
  manual_order: boolean;
  average_minutes: number | null;
};
export type Entry = {
  id: number;
  event_id: number;
  user_id: number;
  user_name: string;
  group_id: number;
  state: string;
  position: number;
  score: number;
  skipped: boolean;
  called_at: string | null;
  joined_at: string;
};
export type Assignment = {
  subject_id: number;
  group_id: number;
  teacher_id: number;
};
export type State = {
  me: User;
  groups: Group[];
  subjects: Group[];
  users: User[];
  labs: Lab[];
  grades: Grade[];
  grade_summaries: GradeSummary[];
  events: Event[];
  entries: Entry[];
  assignments: Assignment[];
  audit: {
    id: number;
    actor_id: number;
    action: string;
    at: string;
    payload: unknown;
  }[];
};
export const strategies: Record<string, string> = {
  fifo: "По времени записи",
  asc: "Меньше сдано — раньше",
  desc: "Больше сдано — раньше",
  random: "Колесо фортуны",
};
export const statuses: Record<string, string> = {
  planned: "Запланировано",
  live: "Идёт приём",
  completed: "Завершено",
  cancelled: "Отменено",
};
