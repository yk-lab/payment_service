import { z } from "zod";

export const adminPrepaidChargeApiRequestSchema = z.object({
  uid: z.string().nonempty(),
  amount: z.number().int().positive(),
});

export type AdminPrepaidChargeApiRequest = z.infer<
  typeof adminPrepaidChargeApiRequestSchema
>;
