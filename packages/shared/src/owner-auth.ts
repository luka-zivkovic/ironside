import { z } from "zod";

export const ownerUsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "use letters, numbers, dots, underscores, or hyphens");

// Cap by characters at the wire boundary as well as bytes in the password
// helper. This prevents accidentally feeding unbounded attacker input into
// the deliberately expensive password KDF.
export const ownerPasswordSchema = z.string().min(12).max(256);

export const setupTokenSchema = z.string().regex(/^ironside_setup_[A-Za-z0-9_-]{43}$/);
export const recoveryTokenSchema = z.string().regex(/^ironside_recovery_[A-Za-z0-9_-]{43}$/);

export const ownerSetupRequestSchema = z.object({
  token: setupTokenSchema,
  username: ownerUsernameSchema,
  password: ownerPasswordSchema
});
export type OwnerSetupRequest = z.infer<typeof ownerSetupRequestSchema>;

export const ownerLoginRequestSchema = z.object({
  username: ownerUsernameSchema,
  password: ownerPasswordSchema
});
export type OwnerLoginRequest = z.infer<typeof ownerLoginRequestSchema>;

export const ownerRecoveryRequestSchema = z.object({
  token: recoveryTokenSchema,
  password: ownerPasswordSchema
});
export type OwnerRecoveryRequest = z.infer<typeof ownerRecoveryRequestSchema>;

export const ownerSessionSchema = z.object({
  principalId: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  username: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  idleExpiresAt: z.iso.datetime({ offset: true }),
  absoluteExpiresAt: z.iso.datetime({ offset: true })
});
export type OwnerSessionResponse = z.infer<typeof ownerSessionSchema>;

export const ownerAuthStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("setup") }),
  z.object({ state: z.literal("login"), organizationName: z.string(), username: z.string() })
]);
export type OwnerAuthStatus = z.infer<typeof ownerAuthStatusSchema>;
