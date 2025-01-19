import { z } from "zod";

export const createTransactionApiRequestSchema = z.object({
  totalAmount: z.number().int().nonnegative(),
  details: z
    .array(
      z.object({
        productId: z.string().nonempty(),
        name: z.string(),
        price: z.number().int().nonnegative(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  paymentMethod: z.enum(["cash", "prepaid"]),
});
