import { z } from "zod";

export const itemSchema = z.object({
  jan_code: z.string(),
  name: z.string(),
  price: z.number().positive(),
});

export type Item = z.infer<typeof itemSchema>;
