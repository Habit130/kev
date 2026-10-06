import { WorkbenchError } from "@/lib/workbench/errors";
import {
  cloneJson,
  isJsonObject,
  orderedEntries,
  orderedObject,
  type JsonObject,
  type JsonValue,
} from "@/lib/workbench/json";

export const MODEL_CHOICES = [
  { id: "kev-4b", label: "Kev 4B", base: "Qwen/Qwen3.5-4B-Base" },
  { id: "kev-0.8b", label: "Kev 0.8B", base: "Qwen/Qwen3.5-0.8B-Base" },
] as const;

export type ModelId = (typeof MODEL_CHOICES)[number]["id"];

export type WorkbenchTemplate = {
  id: string;
  taskId: string;
  name: string;
  description?: string;
  questions: JsonObject;
};

export type ImportedProjectTasks = {
  model: ModelId;
  description?: string;
  templates: Omit<WorkbenchTemplate, "id">[];
};

const PROJECT_KEYS = new Set(["schema", "model", "tasks", "description"]);
const TASK_KEYS = new Set(["questions", "description"]);
const QUESTION_KEYS = new Set(["type", "instructions", "criteria"]);
const MAX_OPTIONS = 255;

export function isModelId(value: unknown): value is ModelId {
  return MODEL_CHOICES.some((model) => model.id === value);
}

export function modelChoice(modelId: ModelId) {
  return MODEL_CHOICES.find((model) => model.id === modelId)!;
}

function fail(message: string): never {
  throw new WorkbenchError(message, "invalid_input", 400);
}

function exactKeys(object: JsonObject, allowed: Set<string>, location: string) {
  const unknown = orderedEntries(object).map(([key]) => key).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${location} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function validateContent(value: JsonValue, location: string, depth = 0): void {
  if (depth > 100) fail(`${location} is nested too deeply`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${location} must contain finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateContent(item, `${location}[${index}]`, depth + 1));
    return;
  }
  for (const [key, item] of orderedEntries(value)) {
    if (typeof key !== "string") fail(`${location} contains a non-string object key`);
    validateContent(item, `${location}.${key}`, depth + 1);
  }
}

export function validateQuestions(value: unknown, location = "questions"): asserts value is JsonObject {
  if (!isJsonObject(value) || orderedEntries(value).length === 0) {
    fail(`${location} must be a non-empty object of questions`);
  }
  for (const [questionId, rawQuestion] of orderedEntries(value)) {
    if (!questionId.trim()) fail(`${location} contains an empty question id`);
    if (!isJsonObject(rawQuestion)) fail(`${location}[${JSON.stringify(questionId)}] must be an object`);
    exactKeys(rawQuestion, QUESTION_KEYS, `${location}[${JSON.stringify(questionId)}]`);
    const type = rawQuestion.type;
    if (type !== "choice" && type !== "noul" && type !== "score") {
      fail(`${location}[${JSON.stringify(questionId)}].type must be choice, noul, or score`);
    }
    if ("instructions" in rawQuestion) {
      validateContent(rawQuestion.instructions, `${location}[${JSON.stringify(questionId)}].instructions`);
    }
    if (type === "choice") {
      const criteria = rawQuestion.criteria;
      if (!isJsonObject(criteria)) fail(`${location}[${JSON.stringify(questionId)}].criteria must be an object`);
      const options = orderedEntries(criteria);
      if (options.length < 1 || options.length > MAX_OPTIONS) {
        fail(`${location}[${JSON.stringify(questionId)}].criteria must contain 1..${MAX_OPTIONS} options`);
      }
      for (const [optionId, description] of options) {
        if (!optionId.trim()) fail(`${location}[${JSON.stringify(questionId)}] contains an empty option id`);
        validateContent(description, `${location}[${JSON.stringify(questionId)}].criteria[${JSON.stringify(optionId)}]`);
      }
    } else if (type === "noul") {
      if (rawQuestion.criteria !== undefined && rawQuestion.criteria !== null) {
        if (!isJsonObject(rawQuestion.criteria)) {
          fail(`${location}[${JSON.stringify(questionId)}].criteria must be an object when supplied`);
        }
        for (const [criterionId, description] of orderedEntries(rawQuestion.criteria)) {
          validateContent(description, `${location}[${JSON.stringify(questionId)}].criteria[${JSON.stringify(criterionId)}]`);
        }
      }
    } else {
      const criteria = rawQuestion.criteria;
      if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > MAX_OPTIONS) {
        fail(`${location}[${JSON.stringify(questionId)}].criteria must contain 1..${MAX_OPTIONS} ordered levels`);
      }
      criteria.forEach((level, index) => validateContent(level, `${location}[${JSON.stringify(questionId)}].criteria[${index}]`));
    }
  }
}

function validateTemplate(template: WorkbenchTemplate, location: string): WorkbenchTemplate {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(template.id)) fail(`${location}.id is invalid`);
  if (typeof template.taskId !== "string" || template.taskId.length === 0 || template.taskId.length > 200) {
    fail(`${location}.taskId must be a non-empty string of at most 200 characters`);
  }
  if (typeof template.name !== "string" || !template.name.trim()) fail(`${location}.name must not be empty`);
  if (template.description !== undefined && typeof template.description !== "string") {
    fail(`${location}.description must be a string when given`);
  }
  validateQuestions(template.questions, `${location}.questions`);
  return template;
}

export function validateTemplateList(value: unknown): asserts value is WorkbenchTemplate[] {
  if (!Array.isArray(value)) fail("Saved templates must be an array");
  const ids = new Set<string>();
  const taskIds = new Set<string>();
  value.forEach((template, index) => {
    if (!isJsonObject(template)) fail(`templates[${index}] must be an object`);
    const candidate = template as unknown as WorkbenchTemplate;
    validateTemplate(candidate, `templates[${index}]`);
    if (ids.has(candidate.id)) fail(`Template id ${candidate.id} is duplicated`);
    if (taskIds.has(candidate.taskId)) fail(`Export task id ${candidate.taskId} is duplicated`);
    ids.add(candidate.id);
    taskIds.add(candidate.taskId);
  });
}

export function parseProjectTasks(value: unknown): ImportedProjectTasks {
  if (!isJsonObject(value)) fail("Import must be a JSON object");
  exactKeys(value, PROJECT_KEYS, "project configuration");
  if (value.schema !== "kev-project-tasks/1") fail("schema must be 'kev-project-tasks/1'");
  if (!isModelId(value.model)) fail("model must be one of the registered logical models: kev-4b or kev-0.8b");
  if (value.description !== undefined && typeof value.description !== "string") {
    fail("description must be a string when given");
  }
  if (!isJsonObject(value.tasks) || orderedEntries(value.tasks).length === 0) {
    fail("tasks must be a non-empty object");
  }

  const taskIds = new Set<string>();
  const templates = orderedEntries(value.tasks).map(([taskId, rawTask]) => {
    if (!taskId || taskId.length > 200) fail("task ids must contain 1..200 characters");
    if (taskIds.has(taskId)) fail(`task id ${JSON.stringify(taskId)} is duplicated`);
    taskIds.add(taskId);
    if (!isJsonObject(rawTask)) fail(`tasks[${JSON.stringify(taskId)}] must be an object`);
    exactKeys(rawTask, TASK_KEYS, `tasks[${JSON.stringify(taskId)}]`);
    if (rawTask.description !== undefined && typeof rawTask.description !== "string") {
      fail(`tasks[${JSON.stringify(taskId)}].description must be a string when given`);
    }
    validateQuestions(rawTask.questions, `tasks[${JSON.stringify(taskId)}].questions`);
    return {
      taskId,
      name: (rawTask.description as string | undefined) ?? taskId,
      ...(rawTask.description === undefined ? {} : { description: rawTask.description as string }),
      questions: cloneJson(rawTask.questions),
    };
  });

  return {
    model: value.model,
    ...(value.description === undefined ? {} : { description: value.description as string }),
    templates,
  };
}

export function projectTasksConfig(model: ModelId, description: string | undefined, templates: WorkbenchTemplate[]): JsonObject {
  validateTemplateList(templates);
  const tasks = orderedObject(
    templates.map((template) => [
      template.taskId,
      orderedObject([
        ...(template.description === undefined ? [] : [["description", template.description] as const]),
        ["questions", cloneJson(template.questions)],
      ]),
    ]),
  );
  return orderedObject([
    ["schema", "kev-project-tasks/1"],
    ...(description === undefined ? [] : [["description", description] as const]),
    ["model", model],
    ["tasks", tasks],
  ]);
}

const choiceQuestion = (instructions: string, options: readonly (readonly [string, string | null])[]) =>
  orderedObject([
    ["type", "choice"],
    ["instructions", instructions],
    ["criteria", orderedObject(options.map(([id, value]) => [id, value]))],
  ]);

export function defaultTemplates(): WorkbenchTemplate[] {
  const questions = orderedObject([
    [
      "category",
      choiceQuestion("Which category best matches this synthetic request?", [
        ["billing", "A charge, invoice, or payment question"],
        ["delivery", "A shipment, delay, or missing package"],
        ["returns", "A refund, exchange, or damaged item"],
      ]),
    ],
    [
      "needs_review",
      orderedObject([
        ["type", "noul"],
        ["instructions", "Does this synthetic request need a person to review it?"],
        [
          "criteria",
          orderedObject([
            ["true", "The request needs individual attention"],
            ["false", "The standard process is enough"],
          ]),
        ],
      ]),
    ],
    [
      "urgency",
      orderedObject([
        ["type", "score"],
        ["instructions", "How soon should this synthetic request be reviewed?"],
        ["criteria", ["When convenient", "Within a few days", "Today"]],
      ]),
    ],
  ]);

  return [
    {
      id: "template-support-review",
      taskId: "support-review",
      name: "支持请求",
      description: "合成示例，包含 Choice、Noul 和 Score。",
      questions,
    },
  ];
}

export function cloneTemplate(template: WorkbenchTemplate): WorkbenchTemplate {
  return {
    ...template,
    questions: cloneJson(template.questions),
  };
}

export function stableModelIdentity(value: unknown): StableModelIdentity | null {
  if (!isJsonObject(value)) return null;
  const modelId = value.model_id ?? value.modelId;
  const checkpoint = value.checkpoint;
  const base = value.base;
  const checkpointPin = isJsonObject(checkpoint) && isJsonObject(checkpoint.pin) ? checkpoint.pin : checkpoint;
  const basePin = isJsonObject(base) && isJsonObject(base.pin) ? base.pin : base;
  const backend = value.backend;
  const dtype = value.dtype;
  const device = value.device;
  if (
    typeof modelId !== "string" ||
    !isJsonObject(checkpointPin) ||
    !isJsonObject(basePin) ||
    typeof checkpointPin.source !== "string" ||
    typeof checkpointPin.revision !== "string" ||
    typeof basePin.source !== "string" ||
    typeof basePin.revision !== "string" ||
    typeof backend !== "string" ||
    typeof dtype !== "string" ||
    typeof device !== "string"
  ) {
    return null;
  }
  return {
    modelId,
    checkpoint: { source: checkpointPin.source, revision: checkpointPin.revision },
    base: { source: basePin.source, revision: basePin.revision },
    backend,
    dtype,
    device,
  };
}

export type StableModelIdentity = {
  modelId: string;
  checkpoint: { source: string; revision: string };
  base: { source: string; revision: string };
  backend: string;
  dtype: string;
  device: string;
};

export function sameModelIdentity(left: StableModelIdentity, right: StableModelIdentity): boolean {
  return (
    left.modelId === right.modelId &&
    left.checkpoint.source === right.checkpoint.source &&
    left.checkpoint.revision === right.checkpoint.revision &&
    left.base.source === right.base.source &&
    left.base.revision === right.base.revision &&
    left.backend === right.backend &&
    left.dtype === right.dtype &&
    left.device === right.device
  );
}

export function jsonValue(value: unknown, location: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${location}[${index}]`));
  if (isJsonObject(value)) {
    return orderedObject(orderedEntries(value).map(([key, item]) => [key, jsonValue(item, `${location}.${key}`)]));
  }
  fail(`${location} must be valid JSON content`);
}
