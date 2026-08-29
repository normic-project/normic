import { z } from "zod";
import { API_SCOPES } from "./types.js";
import { DomainError } from "./errors.js";

export function parseSafeJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new DomainError(
        "Reserved JSON keys are not allowed.",
        "INVALID_INPUT",
      );
    return value;
  });
}

const slug = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const identifier = z.string().trim().min(1).max(100);
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 10_000 && value.every((item) => safeJson(item, depth + 1))
    );
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return Object.entries(value).every(
    ([key, item]) =>
      !["__proto__", "prototype", "constructor"].includes(key) &&
      safeJson(item, depth + 1),
  );
}
const jsonObject = (maxBytes: number) =>
  z
    .record(
      z
        .string()
        .max(100)
        .refine(
          (key) => !["__proto__", "constructor", "prototype"].includes(key),
          "Reserved JSON keys are not allowed.",
        ),
      z.unknown(),
    )
    .refine(
      (value) => safeJson(value),
      "JSON must have safe keys, finite values, and at most 20 levels of nesting.",
    )
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes,
      `JSON payload must not exceed ${maxBytes} bytes.`,
    );

export const idempotencyKeySchema = z.string().trim().min(8).max(128);
export const apiScopeSchema = z.enum(API_SCOPES);
export const registerAgentSchema = z
  .object({
    creatorEmail: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    creatorName: z.string().trim().min(2).max(80),
    agentName: z.string().trim().min(2).max(80),
    handle: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9_]+$/),
    framework: z.enum(["claude-code", "hermes", "openclaw", "codex", "custom"]),
    companyName: z.string().trim().min(2).max(100),
    companySlug: slug,
    description: z.string().trim().min(10).max(500),
    industry: z.string().trim().min(2).max(80),
    website: z
      .url()
      .max(2048)
      .refine(
        (value) => ["https:", "http:"].includes(new URL(value).protocol),
        "Only HTTP(S) website URLs are supported.",
      )
      .nullable()
      .default(null),
  })
  .strict();
export const bootstrapRegistrationSchema = registerAgentSchema.extend({
  credentialLabel: z.string().trim().min(2).max(80).default("Primary agent"),
});

export const pricingModelSchema = z.enum([
  "free",
  "fixed",
  "quote",
  "unavailable",
]);
export const serviceStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "archived",
]);
export const createServiceSchema = z
  .object({
    companyId: z.uuid(),
    name: z.string().trim().min(3).max(100),
    slug,
    description: z.string().trim().min(10).max(2_000),
    category: z.string().trim().min(2).max(60),
    inputSchema: jsonObject(32_768),
    outputSchema: jsonObject(32_768),
    status: serviceStatusSchema.default("active"),
    pricingModel: pricingModelSchema.default("unavailable"),
    quotedPrice: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .max(40)
      .nullable()
      .default(null),
    quotedCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,12}$/)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.pricingModel === "fixed" &&
      (!value.quotedPrice || !value.quotedCurrency)
    ) {
      context.addIssue({
        code: "custom",
        message: "Fixed pricing requires quotedPrice and quotedCurrency.",
      });
    }
    if (value.pricingModel === "free" && value.quotedPrice !== null) {
      context.addIssue({
        code: "custom",
        message: "Free services cannot include a quoted price.",
      });
    }
  });
export const updateServiceSchema = z
  .object({
    serviceId: z.uuid(),
    name: createServiceSchema.shape.name.optional(),
    description: createServiceSchema.shape.description.optional(),
    category: createServiceSchema.shape.category.optional(),
    inputSchema: createServiceSchema.shape.inputSchema.optional(),
    outputSchema: createServiceSchema.shape.outputSchema.optional(),
    status: serviceStatusSchema.optional(),
    pricingModel: pricingModelSchema.optional(),
    quotedPrice: createServiceSchema.shape.quotedPrice.unwrap().optional(),
    quotedCurrency: createServiceSchema.shape.quotedCurrency
      .unwrap()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.pricingModel === "fixed" &&
      (!value.quotedPrice || !value.quotedCurrency)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Changing to fixed pricing requires quotedPrice and quotedCurrency.",
      });
    }
  });
export const searchServicesSchema = z
  .object({
    keyword: z.string().trim().min(1).max(100).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    companyId: z.uuid().optional(),
    providerAgentId: z.uuid().optional(),
    status: serviceStatusSchema.optional(),
    pricingModel: pricingModelSchema.optional(),
    cursor: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    sort: z
      .enum(["created_desc", "created_asc", "name_asc"])
      .default("created_desc"),
  })
  .strict();
export const getServiceSchema = z.object({ serviceId: z.uuid() }).strict();

export const requestServiceSchema = z
  .object({
    serviceId: z.uuid(),
    input: jsonObject(65_536),
  })
  .strict();
export const invocationIdSchema = z.object({ invocationId: z.uuid() }).strict();
export const jobIdSchema = z.object({ jobId: z.uuid() }).strict();
export const submitResultSchema = z
  .object({ jobId: z.uuid(), output: jsonObject(262_144) })
  .strict();
export const failJobSchema = z
  .object({
    jobId: z.uuid(),
    failureReason: z.string().trim().min(2).max(1_000),
  })
  .strict();
export const cancelInvocationSchema = z
  .object({
    invocationId: z.uuid(),
    reason: z.string().trim().min(2).max(500).optional(),
  })
  .strict();

export const createCredentialSchema = z
  .object({
    label: z.string().trim().min(2).max(80),
    scopes: z.array(apiScopeSchema).min(1),
    expiresAt: z.coerce.date().nullable().default(null),
  })
  .strict();
export const identifierSchema = z.object({ identifier }).strict();

export type RegisterAgentInput = z.input<typeof registerAgentSchema>;
export type BootstrapRegistrationInput = z.input<
  typeof bootstrapRegistrationSchema
>;
export type CreateServiceInput = z.input<typeof createServiceSchema>;
export type UpdateServiceInput = z.input<typeof updateServiceSchema>;
export type SearchServicesInput = z.input<typeof searchServicesSchema>;
export type RequestServiceInput = z.input<typeof requestServiceSchema>;
export type SubmitResultInput = z.input<typeof submitResultSchema>;
export type FailJobInput = z.input<typeof failJobSchema>;
export type CancelInvocationInput = z.input<typeof cancelInvocationSchema>;
export type CreateCredentialInput = z.input<typeof createCredentialSchema>;
