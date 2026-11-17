import { z } from 'zod';

const point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
export const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pointer'), action: z.enum(['move', 'down', 'up']), button: z.enum(['left', 'middle', 'right']).default('left'), ...point }).strict(),
  z.object({ type: z.literal('key'), action: z.enum(['down', 'up']), key: z.string().min(1).max(40) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(4096) }).strict(),
  z.object({ type: z.literal('wheel'), deltaX: z.number().min(-2000).max(2000), deltaY: z.number().min(-2000).max(2000), ...point }).strict(),
]);
