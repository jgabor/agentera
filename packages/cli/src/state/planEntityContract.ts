export const ARTIFACT = "plan";
export const PLAN = "plan";
export const TASK = "plan_task";
export const ID = /^[a-z]{10}$/;
export const OPEN = new Set(["open"]);
export const ORDER = "created_desc_then_id_asc";
export const TASK_ORDER = "id_asc";

export interface PlanEntityContract {
  authorityPath: string;
  entityRoot: string;
  defaultLimit: number;
  maximumLimit: number;
  maxUtf8Bytes: number;
  openPlanConflictLimit: number;
}
