import { z } from 'zod';
import path from 'node:path';

const mediaRowSchema = z.object({ unique_id: z.string().min(1).max(128), path: z.string().max(4096),
  name: z.string().max(4096).optional(), folder: z.string().max(4096).optional(),
  properties_status: z.enum(['KNOWN', 'UNAVAILABLE']).optional(),
  properties: z.record(z.string().max(128), z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]))
    .refine(value => Object.keys(value).length <= 100) }).passthrough();
// The SDK does not enumerate Type values. Only Timeline has proven empty-path pool
// semantics; unknown empty-path entities fail closed until their wire class is proven.
// Non-files still belong to full inventory ID/digest consistency, never artifact access.
export const mediaInventoryRowSchema = mediaRowSchema.refine(row => row.path.length > 0 ||
  (row.properties_status === 'KNOWN' && row.properties.Type === 'Timeline'),
  { message: 'Media inventory empty path lacks proven non-file semantics' });
// A path is only a file candidate: approved canonicalization, readable regular-file
// acquisition and streamed hash must still establish backing. Missing Type retains
// the existing unknown-property policy; a Timeline cannot become a source with a path.
export const selectedFileMediaSchema = mediaRowSchema.extend({ path: z.string().min(1).max(4096)
  .refine(value => path.isAbsolute(value) || path.win32.isAbsolute(value), { message: 'Selected file source path must be absolute' }) })
  .refine(row => row.unique_id.trim() === row.unique_id && row.properties.Type !== 'Timeline',
    { message: 'Selected media is not a file-backed source' });
